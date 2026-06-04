// Ejecuta los E2E generados contra DEV y recoge resultados. Antes de ejecutar
// persiste los artefactos (suite de regresión). El runner se inyecta: el
// default usa Playwright (side-effecting, no cubierto por tests unitarios); en
// tests se stubbea. El output de ejecución se SANITIZA antes de devolverse
// (puede contener PII/datos de DEV que luego alimentarían al LLM).

import { spawn } from "node:child_process";
import { AgentResult, QaRunResult } from "../types";
import { saveArtifacts } from "./store";
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
  cleanup?(namespace: string): Promise<void>;
}

export async function runE2E(
  result: AgentResult,
  opts: ExecuteOptions,
  deps: ExecuteDeps,
): Promise<QaRunResult> {
  const { dir } = await saveArtifacts(result.artifacts, opts.namespace);

  const { report, logs } = await deps.runSuite({
    dir,
    baseUrl: opts.baseUrl,
    namespace: opts.namespace,
  });
  const parsed = parsePlaywrightReport(report);

  // Limpieza best-effort de los datos namespaced del run.
  if (deps.cleanup) {
    try {
      await deps.cleanup(opts.namespace);
    } catch {
      /* no bloquea el reporte */
    }
  }

  return {
    sha: opts.namespace,
    passed: parsed.passed,
    cases: parsed.cases,
    logs: sanitizeText(logs),
  };
}

// Runner por defecto: ejecuta Playwright en `dir` con reporter JSON. Playwright
// NO es dependencia del template (arrastraría navegadores): debe estar
// disponible en el entorno donde corra el servicio. PW_BASE_URL apunta a DEV.
export const defaultExecuteDeps: ExecuteDeps = {
  runSuite: ({ dir, baseUrl }) =>
    new Promise((resolve, reject) => {
      const child = spawn("npx", ["playwright", "test", "--reporter=json"], {
        cwd: dir,
        env: { ...process.env, PW_BASE_URL: baseUrl },
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
