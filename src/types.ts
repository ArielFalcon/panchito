// Contratos compartidos por todo el sistema. AgentContext es la única
// entrada del núcleo: cualquier disparador (webhook, manual, cron, chat)
// construye uno de estos y se lo pasa a runAgent.

export type TriggerSource = "webhook" | "manual" | "cron" | "chat";

export interface AgentContext {
  source: TriggerSource;
  task: string; // instrucción de alto nivel (proviene de config)
  repo?: string;
  sha?: string; // commit a verificar — clave para el gate de deploy
  diff?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

export interface AgentResult {
  output: string; // texto principal / propuesta del primario
  artifacts: Artifact[]; // los tests E2E generados
  reviewed: boolean; // si pasó por el revisor
  approved: boolean; // veredicto del revisor (true si no se revisó)
  note?: string; // motivo de cierre cuando no se aprobó (no convergió, etc.)
}

export interface Artifact {
  path: string; // ruta sugerida del fichero (vacío => se autogenera al persistir)
  content: string;
  kind: "e2e" | "doc" | "other";
}

// Resultado de EJECUTAR los E2E contra DEV.
export interface QaRunResult {
  sha: string;
  passed: boolean;
  cases: Array<{ name: string; status: "pass" | "fail"; detail?: string }>;
  logs: string; // sanitizado antes de cualquier reuso por el LLM
}
