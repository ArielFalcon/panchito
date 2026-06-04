import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runE2E, ExecuteDeps } from "./execute";
import { AgentResult } from "../types";

process.env.QA_STORE_DIR = mkdtempSync(join(tmpdir(), "qa-store-"));

const result: AgentResult = {
  output: "spec",
  artifacts: [{ path: "login.spec.ts", content: "test('x', () => {})", kind: "e2e" }],
  reviewed: true,
  approved: true,
};

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

  const run = await runE2E(result, { baseUrl: "https://dev", namespace: "qa-bot-abc1234" }, deps);

  assert.equal(run.passed, false);
  assert.equal(run.cases.length, 2);
  assert.doesNotMatch(run.logs, /ghs_aaaa/); // secreto redactado
  assert.match(run.logs, /\[REDACTED_SECRET\]/);
  assert.equal(cleaned, "qa-bot-abc1234"); // cleanup invocado con el namespace
});

test("la limpieza es best-effort: un fallo en cleanup no rompe el resultado", async () => {
  const deps: ExecuteDeps = {
    runSuite: async () => ({ report: { stats: { unexpected: 0 } }, logs: "ok" }),
    cleanup: async () => {
      throw new Error("cleanup falló");
    },
  };
  const run = await runE2E(result, { baseUrl: "https://dev", namespace: "qa-bot-zzz" }, deps);
  assert.equal(run.passed, true);
});
