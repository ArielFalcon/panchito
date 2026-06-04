// Ejecuta los E2E generados contra DEV y recoge resultados. Antes de ejecutar
// persiste los artefactos en el volumen (suite de regresión).
//
// M0 (template, sin app acoplada): el runner real (p. ej. Playwright) se
// cablea en M1 junto con la primera app. Aquí dejamos la forma estable del
// resultado y la persistencia, con la ejecución marcada como pendiente.

import { AgentResult, QaRunResult } from "../types";
import { saveArtifacts } from "./store";

export interface ExecuteOptions {
  baseUrl: string;
  namespace: string;
}

export async function runE2E(
  result: AgentResult,
  opts: ExecuteOptions,
): Promise<QaRunResult> {
  await saveArtifacts(result.artifacts, opts.namespace);

  // TODO(M1): ejecutar result.artifacts con un runner real contra opts.baseUrl,
  // usando datos namespaced opts.namespace, y mapear cada caso a cases[].
  return {
    sha: opts.namespace,
    passed: result.approved,
    cases: [],
    logs: "[M0] persistido. Ejecución E2E real pendiente de acoplar runner + app (M1).",
  };
}
