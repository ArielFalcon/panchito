// Contratos compartidos por todo el sistema. El disparador (webhook, manual,
// cron) construye el contexto del run y la orquestación vive en pipeline.ts.

export type TriggerSource = "webhook" | "manual";

// Resultado de una corrida del agente OpenCode. El agente escribe los E2E
// DIRECTAMENTE en `e2e/` del espejo (la fuente de verdad es git, no este
// objeto); aquí solo viaja el veredicto del subagente revisor (resuelto DENTRO
// de OpenCode) y el texto final.
export interface AgentResult {
  output: string; // texto final del agente (incl. su veredicto de cierre)
  specs: string[]; // nombres de specs que dijo haber escrito/actualizado
  reviewed: boolean; // si la revisión estaba activada
  approved: boolean; // veredicto del revisor (true si no se revisó)
  note?: string; // motivo cuando no se aprobó (no convergió, etc.)
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
