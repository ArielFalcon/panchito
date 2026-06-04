// Contratos compartidos por todo el sistema. El disparador (webhook, manual,
// cron) construye el contexto del run y la orquestación vive en pipeline.ts.

export type TriggerSource = "webhook" | "manual" | "cron" | "chat";

// Resultado de una corrida del agente OpenCode: los E2E que escribió + el
// veredicto del subagente revisor (resuelto DENTRO de OpenCode).
export interface AgentResult {
  output: string; // texto final del agente (incl. su veredicto de cierre)
  artifacts: Artifact[]; // los tests E2E generados
  reviewed: boolean; // si la revisión estaba activada
  approved: boolean; // veredicto del revisor (true si no se revisó)
  note?: string; // motivo cuando no se aprobó (no convergió, etc.)
}

export interface Artifact {
  path: string; // ruta sugerida del fichero (vacío => se autogenera al persistir)
  content: string;
  kind: "e2e" | "doc" | "other";
}

// Resultado de EJECUTAR los E2E contra DEV.
//   pass    → todo verde y estable
//   fail    → al menos un caso falla de forma consistente (Issue real)
//   flaky   → casos inestables (pasan unas veces y otras no) → cuarentena
//   invalid → los specs generados no superaron el gate estático (no compilan,
//             lint o no cargan): no se llegaron a ejecutar
export type RunVerdict = "pass" | "fail" | "flaky" | "invalid";
export type CaseStatus = "pass" | "fail" | "flaky";

export interface QaCase {
  name: string;
  status: CaseStatus;
  detail?: string;
}

export interface QaRunResult {
  sha: string;
  verdict: RunVerdict;
  passed: boolean; // atajo: verdict === "pass"
  cases: QaCase[];
  logs: string; // sanitizado antes de cualquier reuso por el LLM
}
