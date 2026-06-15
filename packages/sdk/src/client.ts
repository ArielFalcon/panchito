// One typed client over the orchestrator control API, shared by every TS consumer (the web
// dashboard today; any future TS client tomorrow). Methods mirror the /api/v1 surface;
// streamRunEvents wraps the SSE live feed. Same-origin clients pass baseUrl "" so the browser
// carries the operator's existing credentials.
import { createTransport, type TransportOptions } from "./transport";
import { streamRunEvents, type StreamOptions } from "./sse";
import type {
  VersionInfo,
  CreateRunInput,
  CreateRunResult,
  RunRecord,
  QueueStatus,
  AppView,
  IntelligenceView,
  SignalsView,
  TrendsView,
  ReportView,
  RunReportView,
  AskResponse,
  ChatEntry,
  ContinueResult,
  RepoListResponse,
  CreateAppInput,
  CreateAppResult,
  UpdateAppInput,
  DeleteAppResult,
  PublicAgentConfig,
  AgentConfigUpdate,
  AgentConfigApplyResult,
  AgentModelsResponse,
  AgentRestartResponse,
} from "./types";

export type ClientOptions = TransportOptions;

export function createClient(opts: ClientOptions) {
  const t = createTransport(opts);
  const { request } = t;
  const q = encodeURIComponent;

  return {
    getVersion: (client?: string) =>
      request<VersionInfo>("GET", `/api/v1/version${client ? `?client=${q(client)}` : ""}`),

    createRun: (input: CreateRunInput) => request<CreateRunResult>("POST", "/api/v1/runs", input),
    getRun: (id: string) => request<RunRecord>("GET", `/api/v1/runs/${q(id)}`),
    listRuns: (app: string, limit = 20) =>
      request<RunRecord[]>("GET", `/api/v1/runs?app=${q(app)}&limit=${limit}`),
    cancelRun: (id: string) => request<void>("DELETE", `/api/v1/runs/${q(id)}`),
    continueRun: (id: string, cases?: string[], guidance?: string) =>
      request<ContinueResult>("POST", `/api/v1/runs/${q(id)}/continue`, { cases, guidance }),
    streamRunEvents: (id: string, sopts: StreamOptions = {}) => streamRunEvents(t, id, sopts),

    getQueue: () => request<QueueStatus>("GET", "/api/v1/queue"),
    getSignals: () => request<SignalsView>("GET", "/api/v1/signals"),

    listApps: () => request<AppView[]>("GET", "/api/v1/apps"),
    getApp: (name: string) => request<AppView>("GET", `/api/v1/apps/${q(name)}`),
    getIntelligence: (app: string) =>
      request<IntelligenceView>("GET", `/api/v1/apps/${q(app)}/intelligence`),
    getTrends: (app: string) => request<TrendsView>("GET", `/api/v1/apps/${q(app)}/trends`),
    getReport: (app: string) => request<ReportView>("GET", `/api/v1/apps/${q(app)}/report`),
    getRunReport: (runId: string) => request<RunReportView>("GET", `/api/v1/runs/${q(runId)}/report`),
    createApp: (input: CreateAppInput) => request<CreateAppResult>("POST", "/api/v1/apps", input),
    updateApp: (name: string, input: UpdateAppInput) =>
      request<CreateAppResult>("PUT", `/api/v1/apps/${q(name)}`, input),
    deleteApp: (name: string, purge = false) =>
      request<DeleteAppResult>("DELETE", `/api/v1/apps/${q(name)}${purge ? "?purge=1" : ""}`),

    ask: (id: string, question: string, history?: ChatEntry[]) =>
      request<AskResponse>("POST", `/api/v1/runs/${q(id)}/ask`, { question, history }),
    help: (question: string, history?: ChatEntry[]) =>
      request<AskResponse>("POST", "/api/v1/help", { question, history }),

    listRepos: (owner: string, page = 1) =>
      request<RepoListResponse>("GET", `/api/v1/repos?owner=${q(owner)}&page=${page}`),

    getAgentConfig: () => request<PublicAgentConfig>("GET", "/api/v1/agent/config"),
    updateAgentConfig: (input: AgentConfigUpdate) =>
      request<AgentConfigApplyResult>("PUT", "/api/v1/agent/config", input),
    listAgentModels: (provider: string) =>
      request<AgentModelsResponse>("GET", `/api/v1/agent/models?provider=${q(provider)}`),
    restartAgentProvider: (provider: string) =>
      request<AgentRestartResponse>("POST", "/api/v1/agent/restart", { provider }),
  };
}

export type Client = ReturnType<typeof createClient>;
