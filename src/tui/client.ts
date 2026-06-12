// Typed client for the orchestrator control API. The TUI talks to a RUNNING service
// over HTTP and shares the orchestrator's own types (RunRecord, RunMode) — so there
// is no parsing drift (the bash bin/qa re-parsed JSON with jq). `fetch` is injected
// so the client is unit-tested without a network. Connection failures and HTTP errors
// are distinguished and surfaced with precise messages (the bug bin/qa originally had).

import { RunRecord, RunMode, TestTarget } from "../types";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface AppView {
  name: string;
  repo: string;
  baseUrl: string;
  versionUrl: string;
  code: boolean;
  shadow: boolean;
  needsReview: boolean;
  testDataPrefix: string;
  services: Array<{ repo: string; openapi?: string; versionUrl?: string }>;
}

export interface QueueStatus {
  pending: number;
  running: { id: string; app: string } | null;
}

export interface CreateRunResult {
  id: string;
  app: string;
  sha: string;
  target: TestTarget;
  mode: RunMode;
  status: string;
}

export interface CreateRunInput {
  app: string;
  target: TestTarget;
  mode: RunMode;
  sha?: string;
  ref?: string;
  guidance?: string;
  shadow?: boolean;
}

export interface OnboardServiceInput {
  repo: string;
  openapi?: string;
  versionUrl?: string;
}

export interface CreateAppRequest {
  repo: string;
  name?: string;
  baseUrl?: string;
  versionUrl?: string;
  target?: "e2e" | "code";
  needsReview?: boolean;
  shadow?: boolean;
  testDataPrefix?: string;
  services?: OnboardServiceInput[];
  env?: Record<string, string>;
  dryRun?: boolean;
  validateOnly?: boolean;
}

export interface CreateAppResponse {
  ok: boolean;
  errors?: string[];
  repoInfo?: { name: string; fullName: string; private: boolean; defaultBranch: string; description: string | null };
  yaml?: string;
  name?: string;
  path?: string;
  envApplied?: string[];
  warnings?: string[];
}

export type AgentProvider = "opencode" | "codex";
export type AgentMode = "single" | "dual";
export type AgentRuntimeStatus = "stopped" | "starting" | "healthy" | "degraded" | "failed" | "needs_config";

export interface RoleAssignment {
  provider: AgentProvider;
  model: string;
}

export interface PublicAgentConfig {
  mode: AgentMode;
  singleProvider: AgentProvider;
  assignments: {
    primary: RoleAssignment;
    reviewer: RoleAssignment;
    chat: RoleAssignment;
  };
  keys: Record<AgentProvider, boolean>;
  validation: {
    ok: boolean;
    errors: string[];
    requiresSingleDowngradeConfirmation?: boolean;
    downgradeProvider?: AgentProvider;
  };
  health?: Partial<Record<AgentProvider, { provider: AgentProvider; status: AgentRuntimeStatus; configured: boolean; error?: string }>>;
}

export interface AgentConfigUpdate {
  mode?: AgentMode;
  singleProvider?: AgentProvider;
  assignments?: Partial<PublicAgentConfig["assignments"]>;
  apiKeys?: Partial<Record<AgentProvider, string>>;
  confirmSingleDowngrade?: boolean;
}

export interface AgentModelInfo {
  id: string;
  label?: string;
  provider?: AgentProvider;
}

export interface AgentConfigApplyResult {
  config: PublicAgentConfig;
  restarted: AgentProvider[];
  downgraded?: boolean;
}

export class QaApiError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "QaApiError";
  }
}

// Read the auto-generated token from config/.api_token (created by the orchestrator
// on first start when QA_API_TOKEN is not set in .env).
function readTokenFile(): string | undefined {
  const path = join(process.env.AI_PIPELINE_ROOT ?? process.cwd(), "config", ".api_token");
  try {
    if (!existsSync(path)) return undefined;
    const token = readFileSync(path, "utf8").trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

export interface ClientOptions {
  host?: string; // default: QA_HOST env or localhost:8080
  token?: string; // default: QA_API_TOKEN env
  fetchImpl?: typeof fetch; // injected in tests
}

export interface ChatEntry {
  role: string;
  text: string;
}

export interface QaClient {
  createRun(input: CreateRunInput): Promise<CreateRunResult>;
  getRun(id: string): Promise<RunRecord>;
  listRuns(app: string, limit?: number): Promise<RunRecord[]>;
  getQueue(): Promise<QueueStatus>;
  listApps(): Promise<AppView[]>;
  getApp(name: string): Promise<AppView>;
  ask(id: string, question: string, history?: Array<{ role: string; text: string }>): Promise<{ answer: string }>;
  help(question: string, history?: ChatEntry[]): Promise<{ answer: string }>;
  continueRun(id: string, cases: string[], guidance?: string): Promise<{ id: string; parentRunId: string }>;
  cancelRun(id: string): Promise<void>;
  listRepos(owner: string, page?: number): Promise<{ repos: Array<{ fullName: string; private: boolean; description: string | null }>; hasMore: boolean }>;
  validateRepo(repo: string): Promise<CreateAppResponse>;
  createApp(input: CreateAppRequest): Promise<CreateAppResponse>;
  updateApp(name: string, input: Omit<CreateAppRequest, "repo" | "name"> & { repo?: string }): Promise<CreateAppResponse>;
  deleteApp(name: string, purge: boolean): Promise<{ removed: string[] }>;
  getAgentConfig(): Promise<PublicAgentConfig>;
  updateAgentConfig(input: AgentConfigUpdate): Promise<AgentConfigApplyResult>;
  listAgentModels(provider: AgentProvider): Promise<{ provider: AgentProvider; models: AgentModelInfo[] }>;
  restartAgentProvider(provider: AgentProvider): Promise<{ health: NonNullable<PublicAgentConfig["health"]>[AgentProvider] }>;
}

export function createClient(opts: ClientOptions = {}): QaClient {
  const host = opts.host ?? process.env.QA_HOST ?? "localhost:8080";
  const base = `http://${host}`;
  const token = opts.token ?? process.env.QA_API_TOKEN ?? readTokenFile();
  const f = opts.fetchImpl ?? fetch;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (token) headers["authorization"] = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";

    let res: Response;
    try {
      res = await f(`${base}${path}`, { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    } catch {
      throw new QaApiError(`cannot reach ${host} — is the service running? (docker compose up)`);
    }

    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401) throw new QaApiError("unauthorized — set QA_API_TOKEN to match the service", 401);
      let msg = `request failed (HTTP ${res.status})`;
      try {
        const j = JSON.parse(text) as { error?: string; message?: string };
        msg = j.error ?? j.message ?? msg;
      } catch {
        /* non-JSON error body */
      }
      throw new QaApiError(msg, res.status);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  return {
    createRun: (input) => request<CreateRunResult>("POST", "/api/runs", input),
    getRun: (id) => request<RunRecord>("GET", `/api/runs/${encodeURIComponent(id)}`),
    listRuns: (app, limit = 10) => request<RunRecord[]>("GET", `/api/runs?app=${encodeURIComponent(app)}&limit=${limit}`),
    getQueue: () => request<QueueStatus>("GET", "/api/queue"),
    listApps: () => request<AppView[]>("GET", "/api/apps"),
    getApp: (name) => request<AppView>("GET", `/api/apps/${encodeURIComponent(name)}`),
    ask: (id, question, history) => request<{ answer: string }>("POST", `/api/runs/${encodeURIComponent(id)}/ask`, { question, history }),
    help: (question, history) => request<{ answer: string }>("POST", "/api/help", { question, history }),
    continueRun: (id, cases, guidance) =>
      request<{ id: string; parentRunId: string }>("POST", `/api/runs/${encodeURIComponent(id)}/continue`, { cases, guidance }),
    cancelRun: (id) => request<void>("DELETE", `/api/runs/${encodeURIComponent(id)}`),
    listRepos: (owner, page = 1) => request<{ repos: Array<{ fullName: string; private: boolean; description: string | null }>; hasMore: boolean }>("GET", `/api/repos?owner=${encodeURIComponent(owner)}&page=${page}`),
    validateRepo: (repo) => request<CreateAppResponse>("POST", "/api/apps", { repo, validateOnly: true }),
    createApp: (input) => request<CreateAppResponse>("POST", "/api/apps", input),
    updateApp: (name, input) => request<CreateAppResponse>("PUT", `/api/apps/${encodeURIComponent(name)}`, input),
    deleteApp: (name, purge) =>
      request<{ removed: string[] }>("DELETE", `/api/apps/${encodeURIComponent(name)}${purge ? "?purge=1" : ""}`),
    getAgentConfig: () => request<PublicAgentConfig>("GET", "/api/agent/config"),
    updateAgentConfig: (input) => request<AgentConfigApplyResult>("PUT", "/api/agent/config", input),
    listAgentModels: (provider) => request<{ provider: AgentProvider; models: AgentModelInfo[] }>("GET", `/api/agent/models?provider=${provider}`),
    restartAgentProvider: (provider) => request<{ health: NonNullable<PublicAgentConfig["health"]>[AgentProvider] }>("POST", "/api/agent/restart", { provider }),
  };
}
