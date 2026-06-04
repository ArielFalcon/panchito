import { test } from "node:test";
import assert from "node:assert/strict";
import { runE2E, ExecuteDeps } from "./execute";

test("ejecuta, mapea casos y SANITIZA los logs", async () => {
  let cleaned = "";
  const deps: ExecuteDeps = {
    runSuite: async () => ({
      report: {
        suites: [
          {
            title: "login.spec.ts",
            specs: [
              { title: "ok", ok: true },
              {
                title: "rota",
                ok: false,
                tests: [{ results: [{ status: "failed", error: { message: "boom" } }] }],
              },
            ],
          },
        ],
      },
      // log con un secreto que NO debe salir hacia el LLM/Issue
      logs: "corriendo... token: ghs_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa fin",
    }),
    cleanup: async (ns) => {
      cleaned = ns;
    },
  };

  const run = await runE2E("/mirrors/org__app/e2e", { baseUrl: "https://dev", namespace: "qa-bot-abc1234" }, deps);

  assert.equal(run.verdict, "fail");
  assert.equal(run.passed, false);
  assert.equal(run.cases.length, 2);
  assert.doesNotMatch(run.logs, /ghs_aaaa/); // secreto redactado
  assert.match(run.logs, /\[REDACTED_SECRET\]/);
  assert.equal(cleaned, "qa-bot-abc1234"); // cleanup invocado con el namespace
});

test("clasifica flaky cuando hay casos inestables y ninguno falla", async () => {
  const deps: ExecuteDeps = {
    runSuite: async () => ({
      report: { suites: [{ specs: [{ title: "x", tests: [{ status: "flaky" }] }] }] },
      logs: "ok",
    }),
  };
  const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-f" }, deps);
  assert.equal(run.verdict, "flaky");
  assert.equal(run.passed, false);
});

test("la limpieza es best-effort: un fallo en cleanup no rompe el resultado", async () => {
  const deps: ExecuteDeps = {
    runSuite: async () => ({ report: { stats: { unexpected: 0 } }, logs: "ok" }),
    cleanup: async () => {
      throw new Error("cleanup falló");
    },
  };
  const run = await runE2E("/dir", { baseUrl: "https://dev", namespace: "qa-bot-zzz" }, deps);
  assert.equal(run.passed, true);
  assert.equal(run.verdict, "pass");
});
