import { test } from "node:test";
import assert from "node:assert/strict";
import { parsePlaywrightReport } from "./playwright-report";

test("mapea specs anidados a casos pass/fail", () => {
  const report = {
    suites: [
      {
        title: "login.spec.ts",
        specs: [
          { title: "entra con credenciales válidas", ok: true },
          {
            title: "rechaza credenciales inválidas",
            ok: false,
            tests: [{ results: [{ status: "failed", error: { message: "esperaba 401" } }] }],
          },
        ],
      },
    ],
  };
  const parsed = parsePlaywrightReport(report);
  assert.equal(parsed.cases.length, 2);
  assert.equal(parsed.passed, false);
  const failed = parsed.cases.find((c) => c.status === "fail");
  assert.match(failed!.name, /rechaza credenciales/);
  assert.equal(failed!.detail, "esperaba 401");
});

test("todo en verde => passed true", () => {
  const report = {
    suites: [{ title: "s", specs: [{ title: "a", ok: true }, { title: "b", ok: true }] }],
  };
  const parsed = parsePlaywrightReport(report);
  assert.equal(parsed.passed, true);
  assert.equal(parsed.cases.length, 2);
});

test("sin specs cae a stats.unexpected", () => {
  assert.equal(parsePlaywrightReport({ stats: { unexpected: 0 } }).passed, true);
  assert.equal(parsePlaywrightReport({ stats: { unexpected: 2 } }).passed, false);
});

test("marca flaky cuando un test pasó tras reintento (status flaky)", () => {
  const report = {
    suites: [
      {
        title: "checkout.spec.ts",
        specs: [
          { title: "estable", tests: [{ status: "expected" }] },
          { title: "inestable", tests: [{ status: "flaky" }] },
        ],
      },
    ],
  };
  const parsed = parsePlaywrightReport(report);
  assert.equal(parsed.verdict, "flaky"); // ningún fail, pero hay flaky
  assert.equal(parsed.passed, false);
  assert.equal(parsed.cases.find((c) => c.status === "flaky")?.name.includes("inestable"), true);
});

test("un fail consistente gana sobre un flaky", () => {
  const report = {
    suites: [
      {
        specs: [
          { title: "a", tests: [{ status: "flaky" }] },
          { title: "b", tests: [{ status: "unexpected", results: [{ error: { message: "boom" } }] }] },
        ],
      },
    ],
  };
  assert.equal(parsePlaywrightReport(report).verdict, "fail");
});

test("deriva ok desde results cuando no hay spec.ok", () => {
  const report = {
    suites: [
      {
        specs: [{ title: "c", tests: [{ results: [{ status: "passed" }] }] }],
      },
    ],
  };
  assert.equal(parsePlaywrightReport(report).passed, true);
});
