import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { capabilitiesForRole } from "./types";
import type {
  AgentModelInfo,
  AgentProviderHealth,
  AgentRole,
  AgentRuntimeSession,
  AgentRuntimeStrategy,
} from "./types";

// Codex's translation of the provider-agnostic capability policy: filesystem write maps to the
// `codex exec --sandbox` mode. Read-only roles (the judge, the reflector) cannot write the workspace.
function codexSandboxForRole(role: AgentRole): "read-only" | "workspace-write" {
  return capabilitiesForRole(role).canWrite ? "workspace-write" : "read-only";
}

export interface CodexTransportStartInput {
  role: AgentRole;
  cwd: string;
  model?: string;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export interface CodexTransportSession {
  id: string;
  prompt(text: string): Promise<string>;
  dispose(): Promise<void>;
}

export interface CodexHeadlessTransport {
  start(input: CodexTransportStartInput): Promise<CodexTransportSession>;
  health(): Promise<AgentProviderHealth>;
  listModels(): Promise<AgentModelInfo[]>;
  restart?(opts?: { apiKey?: string; reason?: string; env?: Record<string, string> }): Promise<AgentProviderHealth>;
}

interface CodexRuntimeStrategyOptions {
  env?: Record<string, string | undefined>;
  transport?: CodexHeadlessTransport;
  promptRoot?: string;
}

// Codex execution is split exactly like OpenCode's: the orchestrator image ships
// no `codex` binary, so when a supervisor is configured we run `codex exec` inside
// the agent container over HTTP (SupervisorExecTransport) instead of spawning it
// locally. Without a supervisor (host/dev) we fall back to the local CLI.
export function defaultCodexTransport(env: Record<string, string | undefined> = process.env): CodexHeadlessTransport {
  const base = env.AGENT_SUPERVISOR_URL;
  return base ? new SupervisorExecTransport({ baseUrl: base, env }) : new CodexExecTransport(env);
}

const CODEX_MODELS: AgentModelInfo[] = [
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
];

const CODEX_EXEC_ENV_EXACT = new Set([
  "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "TMPDIR", "TEMPDIR", "TMP", "TEMP",
  "CI", "NO_COLOR", "FORCE_COLOR", "DEBUG", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
  "https_proxy", "http_proxy", "no_proxy", "CODEX_API_KEY", "OPENAI_API_KEY", "CODEX_HOME", "CODEX_BIN",
]);
const CODEX_EXEC_ENV_PREFIX = /^(?:DEV_|AGENT_)/;

export function codexExecEnv(env: Record<string, string | undefined> = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (CODEX_EXEC_ENV_EXACT.has(key) || CODEX_EXEC_ENV_PREFIX.test(key)) out[key] = value;
  }
  return out;
}

// Builds the `codex exec` argv for a session. The sandbox is derived from the role's capability
// policy (read-only roles cannot write the workspace) — the Codex-side equivalent of OpenCode's
// per-agent tools.write flag, so a reviewer/reflector is structurally read-only, not prompt-only.
export function codexExecArgs(input: { role: AgentRole; cwd: string; model?: string }): string[] {
  return [
    "exec",
    "--json",
    "--cd",
    input.cwd,
    "--skip-git-repo-check",
    "--sandbox",
    codexSandboxForRole(input.role),
    "--color",
    "never",
    ...(input.model ? ["--model", input.model] : []),
    "-",
  ];
}

export class CodexRuntimeStrategy implements AgentRuntimeStrategy {
  readonly provider = "codex" as const;
  private readonly env: Record<string, string | undefined>;
  private readonly transport: CodexHeadlessTransport;
  private readonly promptRoot: string;

  constructor(opts: CodexRuntimeStrategyOptions = {}) {
    this.env = opts.env ?? process.env;
    this.transport = opts.transport ?? defaultCodexTransport(this.env);
    this.promptRoot = opts.promptRoot ?? this.env.AGENT_PROMPT_DIR ?? join(process.cwd(), "agent");
  }

  async health(): Promise<AgentProviderHealth> {
    if (!this.env.CODEX_API_KEY) return { provider: this.provider, status: "needs_config", configured: false };
    const supervised = await supervisorHealth(this.env, this.provider);
    if (supervised) return supervised;
    return this.transport.health();
  }

  async listModels(): Promise<AgentModelInfo[]> {
    return this.transport.listModels();
  }

  async openSession(
    role: AgentRole,
    cwd: string,
    opts?: { signal?: AbortSignal; timeoutMs?: number; model?: string },
  ): Promise<AgentRuntimeSession> {
    const session = await this.transport.start({ role, cwd, model: opts?.model, signal: opts?.signal, timeoutMs: opts?.timeoutMs });
    return {
      id: session.id,
      prompt: (text) => session.prompt(withCodexRolePreamble(role, text, this.promptRoot)),
      dispose: () => session.dispose(),
    };
  }

  async restart(opts?: { apiKey?: string; reason?: string; env?: Record<string, string> }): Promise<AgentProviderHealth> {
    if (opts?.apiKey) this.env.CODEX_API_KEY = opts.apiKey;
    const supervised = await supervisorRestart(this.env, this.provider, opts?.apiKey, opts?.env);
    if (supervised) return supervised;
    if (this.transport.restart) return this.transport.restart(opts);
    return this.health();
  }
}

export class CodexExecTransport implements CodexHeadlessTransport {
  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly command = process.env.CODEX_BIN ?? "codex",
  ) {}

  async start(input: CodexTransportStartInput): Promise<CodexTransportSession> {
    const id = randomUUID();
    return {
      id,
      prompt: (text) => this.runExec(text, input),
      dispose: async () => {},
    };
  }

  async health(): Promise<AgentProviderHealth> {
    if (!this.env.CODEX_API_KEY) return { provider: "codex", status: "needs_config", configured: false };
    return { provider: "codex", status: "healthy", configured: true };
  }

  async listModels(): Promise<AgentModelInfo[]> {
    return CODEX_MODELS;
  }

  async restart(opts?: { apiKey?: string }): Promise<AgentProviderHealth> {
    if (opts?.apiKey) this.env.CODEX_API_KEY = opts.apiKey;
    return this.health();
  }

  private runExec(prompt: string, input: CodexTransportStartInput): Promise<string> {
    const args = codexExecArgs(input);
    return new Promise((resolve, reject) => {
      const child = spawn(this.command, args, {
        cwd: input.cwd,
        env: codexExecEnv({ ...process.env, ...this.env }),
        stdio: ["pipe", "pipe", "pipe"],
        signal: input.signal,
      });
      let stdout = "";
      let stderr = "";
      const timeout = input.timeoutMs ? setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Codex prompt: timed out after ${input.timeoutMs}ms`));
      }, input.timeoutMs) : undefined;

      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      child.on("error", (err) => {
        if (timeout) clearTimeout(timeout);
        reject(err);
      });
      child.on("close", (code) => {
        if (timeout) clearTimeout(timeout);
        if (code === 0) resolve(extractCodexLastMessage(stdout) || stdout.trim());
        else reject(new Error(`codex exec exited ${code}: ${stderr.trim() || stdout.trim()}`));
      });
      child.stdin.end(prompt);
    });
  }
}

type FetchInit = { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal };
type FetchLike = (input: string, init?: FetchInit) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

// Runs `codex exec` inside the agent container via the supervisor's HTTP boundary,
// mirroring how the orchestrator reaches `opencode serve`. Each prompt is one
// long-held request that resolves with Codex's final assistant message.
export class SupervisorExecTransport implements CodexHeadlessTransport {
  private readonly baseUrl: string;
  private readonly env: Record<string, string | undefined>;
  private readonly fetchImpl: FetchLike;

  constructor(opts: { baseUrl: string; env?: Record<string, string | undefined>; fetchImpl?: FetchLike }) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, "");
    this.env = opts.env ?? process.env;
    this.fetchImpl = opts.fetchImpl ?? (fetch as unknown as FetchLike);
  }

  async start(input: CodexTransportStartInput): Promise<CodexTransportSession> {
    const id = randomUUID();
    return {
      id,
      prompt: (text) => this.runExec(text, input),
      dispose: async () => {},
    };
  }

  async health(): Promise<AgentProviderHealth> {
    if (!this.env.CODEX_API_KEY) return { provider: "codex", status: "needs_config", configured: false };
    try {
      const res = await this.fetchImpl(`${this.baseUrl}/providers`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) throw new Error(`supervisor returned ${res.status}`);
      const body = (await res.json()) as { providers?: Record<string, AgentProviderHealth> };
      return body.providers?.codex ?? { provider: "codex", status: "failed", configured: true, error: "codex not reported by supervisor" };
    } catch (err) {
      return { provider: "codex", status: "failed", configured: true, error: err instanceof Error ? err.message : String(err) };
    }
  }

  async listModels(): Promise<AgentModelInfo[]> {
    return CODEX_MODELS;
  }

  private async runExec(prompt: string, input: CodexTransportStartInput): Promise<string> {
    const res = await this.fetchImpl(`${this.baseUrl}/codex/exec`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // `sandbox` is per-role (read-only roles cannot write): the supervisor must pass it through to
      // `codex exec --sandbox`. Sent unconditionally so a read-only role is never silently elevated.
      body: JSON.stringify({ cwd: input.cwd, prompt, sandbox: codexSandboxForRole(input.role), ...(input.model ? { model: input.model } : {}), ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}) }),
      ...(input.signal ? { signal: input.signal } : {}),
    });
    const body = (await res.json().catch(() => ({}))) as { message?: string; error?: string };
    if (!res.ok) throw new Error(`codex exec via supervisor failed (${res.status}): ${body.error ?? "unknown"}`);
    return body.message ?? "";
  }
}

function withCodexRolePreamble(role: AgentRole, text: string, promptRoot: string): string {
  const shared = readPrompt(join(promptRoot, "AGENTS.md"));
  const rolePrompt = readPrompt(join(promptRoot, "roles", `${rolePromptName(role)}.md`));
  return [
    `Agent role: ${role}`,
    "",
    "Follow the same provider-neutral Panchito prompts and verdict contracts used by the OpenCode runtime.",
    "All authoritative decisions must be returned in the blocking final response; live events are observational only.",
    "",
    shared ? `## Shared prompt\n${shared}` : "",
    rolePrompt ? `## Role prompt\n${rolePrompt}` : "",
    shared || rolePrompt ? "## Task" : "",
    text,
  ].join("\n");
}

function rolePromptName(role: AgentRole): string {
  if (role === "primary") return "qa-generator";
  if (role === "reviewer") return "qa-reviewer";
  if (role === "chat") return "qa-assistant";
  if (role === "worker") return "qa-worker";
  if (role === "workerCode") return "qa-worker";
  if (role === "reflector") return "qa-reflector";
  if (role === "explorer") return "qa-explorer";
  return "qa-maintainer";
}

function readPrompt(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

function extractCodexLastMessage(jsonl: string): string {
  let last = "";
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      const message = event.msg ?? event.message ?? event.text ?? event.content;
      if (typeof message === "string" && message.trim()) last = message;
    } catch {
      // Keep scanning: `codex exec --json` should be JSONL, but stderr-like lines
      // from wrapped launchers should not throw away a completed response.
    }
  }
  return last;
}

async function supervisorHealth(env: Record<string, string | undefined>, provider: "codex"): Promise<AgentProviderHealth | undefined> {
  const base = env.AGENT_SUPERVISOR_URL;
  if (!base) return undefined;
  try {
    const res = await fetch(`${base}/providers`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) throw new Error(`supervisor returned ${res.status}`);
    const body = await res.json() as { providers?: Record<string, AgentProviderHealth> };
    return body.providers?.[provider];
  } catch (err) {
    return { provider, status: "failed", configured: true, error: err instanceof Error ? err.message : String(err) };
  }
}

async function supervisorRestart(
  env: Record<string, string | undefined>,
  provider: "codex",
  apiKey?: string,
  runtimeEnv?: Record<string, string>,
): Promise<AgentProviderHealth | undefined> {
  const base = env.AGENT_SUPERVISOR_URL;
  if (!base) return undefined;
  const res = await fetch(`${base}/restart`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ provider, ...(apiKey ? { apiKey } : {}), ...(runtimeEnv ? { env: runtimeEnv } : {}) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`supervisor restart failed (${res.status})`);
  const body = await res.json() as { health?: AgentProviderHealth };
  return body.health;
}
