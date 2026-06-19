// Friendly type aliases over the generated OpenAPI types. types.gen.ts is produced by
// `npm run sdk:gen` (openapi-typescript) from contract/openapi.json — the single source of
// truth — so these never drift from the server: tsc fails if a wire shape changes. Consumers
// import these names; the raw `components`/`paths` are re-exported for anything not aliased.
import type { components } from "./types.gen";

type S = components["schemas"];

export type RunRecord = S["RunRecord"];
export type QaCase = S["QaCase"];
export type SpecRecord = S["SpecRecord"];
export type AgentActivity = S["AgentActivity"];
export type AppView = S["AppView"];
export type QueueStatus = S["QueueStatus"];
export type VersionInfo = S["VersionInfo"];
export type CreateRunInput = S["CreateRunInput"];
export type CreateRunResult = S["CreateRunResult"];
export type AskRequest = S["AskRequest"];
export type AskResponse = S["AskResponse"];
export type ChatEntry = S["ChatEntry"];
export type ContinueRequest = S["ContinueRequest"];
export type ContinueResult = S["ContinueResult"];
export type CreateAppInput = S["CreateAppInput"];
export type CreateAppResult = S["CreateAppResult"];
export type UpdateAppInput = S["UpdateAppInput"];
export type DeleteAppResult = S["DeleteAppResult"];
export type RepoListResponse = S["RepoListResponse"];
export type IntelligenceView = S["IntelligenceView"];
export type SignalsView = S["SignalsView"];
export type TrendsView = S["TrendsView"];
export type ReportView = S["ReportView"];
export type RunReportView = S["RunReportView"];
export type ReportInsight = S["ReportInsight"];
export type PublicAgentConfig = S["PublicAgentConfig"];
export type AgentConfigUpdate = S["AgentConfigUpdate"];
export type AgentConfigApplyResult = S["AgentConfigApplyResult"];
export type AgentModelsResponse = S["AgentModelsResponse"];
export type AgentRestartResponse = S["AgentRestartResponse"];

// The live event body (discriminated on `type`) is a generated schema. The wire envelope
// the SSE gateway stamps around it is not a JSON response body, so it is composed here from
// the generated body — the one small shape the SDK owns rather than generates.
export type RunEventBody = S["RunEventBody"];
export interface RunEvent {
  seq: number;
  runId: string;
  ts: number;
  body: RunEventBody;
}

export type { components, paths } from "./types.gen";
