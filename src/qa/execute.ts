// Filtro C del harness: ejecuta los E2E ya persistidos contra DEV y clasifica
// el resultado (pass/fail/flaky). El runner se inyecta: el default usa
// Playwright con la config base (retries → detección de flakiness, trace
// on-first-retry); en tests se stubbea. El output se SANITIZA antes de
// devolverse (puede traer PII/datos de DEV que luego irían a un Issue).

import { spawn } from "node:child_process";
import { QaRunResult } from "../types";
import { parsePlaywrightReport } from "./playwright-report";
import { sanitizeText } from "../orchestrator/sanitizer";

export interface ExecuteOptions {
  baseUrl: string;
  namespace: string;
}

export interface RunOutput {
  report: unknown; // reporte JSON de Playwright
  logs: string;
}

export interface ExecuteDeps {
  runSuite(args: { dir: string; baseUrl: string; namespace: string }): Promise<RunOutput>;
}

// La limpieza de los datos namespaced NO vive aquí: cada test la hace en su
// teardown vía el fixture `cleanup` (config/e2e/fixtures.ts), que es donde se
// conoce cómo deshacer cada entidad. Aquí solo se ejecuta y se clasifica.
export async function runE2E(
  specDir: string,
  opts: ExecuteOptions,
  deps: ExecuteDeps,
): Promise<QaRunResult> {
  const { report, logs } = await deps.runSuite({
    dir: specDir,
    baseUrl: opts.baseUrl,
    namespace: opts.namespace,
  });
  const parsed = parsePlaywrightReport(report);

  return {
    sha: opts.namespace,
    verdict: parsed.verdict,
    passed: parsed.passed,
    cases: parsed.cases,
    logs: sanitizeText(logs),
  };
}

// Runner por defecto: ejecuta Playwright en el proyecto `e2e/` del repo (con su
// propia config/fixtures) y reporter JSON. Playwright NO es dependencia del
// template (arrastraría navegadores): vive en el entorno donde corre el servicio
// (la imagen del orchestrator se basa en la de Playwright). PW_BASE_URL apunta a
// DEV; PW_NAMESPACE es el prefijo de datos del run (lo leen las fixtures).
export const defaultExecuteDeps: ExecuteDeps = {
  runSuite: ({ dir, baseUrl, namespace }) =>
    new Promise((resolve, reject) => {
      const child = spawn("npx", ["playwright", "test", "--reporter=json"], {
        cwd: dir,
        env: { ...process.env, PW_BASE_URL: baseUrl, PW_NAMESPACE: namespace },
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.stderr.on("data", (d) => (stderr += d));
      child.on("error", reject);
      child.on("close", () => {
        let report: unknown = {};
        try {
          report = JSON.parse(stdout);
        } catch {
          /* stdout no era JSON parseable */
        }
        resolve({ report, logs: stderr || stdout });
      });
    }),
};
