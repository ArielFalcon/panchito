import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { capabilitiesForRole } from "./types";
import { AgentUnavailableError } from "../errors";
import { sanitizeText } from "../orchestrator/sanitizer";
import { saveAgentTurn } from "../server/history";
import {
  checkCodexCircuit,
  recordCodexCircuitFailure,
  recordCodexCircuitSuccess,
  resetCodexCircuit,
} from "../integrations/codex-circuit-breaker";
import type { AgentOpenDescriptor, AgentTurnEvent, LiveActivity } from "../integrations/opencode-client";
import { REVIEWER_TIMEOUT_MS, EXPLORER_TIMEOUT_MS } from "../integrations/opencode-client";
import { extractJsonObjects } from "../integrations/verdict-parse";
import type { RunEventBody } from "../contract/events";
import type {
  AgentModelInfo,
  AgentProviderHealth,
  AgentRole,
  AgentRuntimeSession,
  AgentRuntimeStrategy,
} from "./types";

// WS9.3 — default per-role deadlines. The rewritten (qa-engine) path never sets opts.timeoutMs
// on openSession, and facades.ts marks every Codex session `selfTimed` (the inactivity stall
// watchdog explicitly skips it, since exec-per-prompt Codex gives no mid-turn activity signal to
// watch) — so without a default here, a wedged `codex exec` is unbounded except by external abort.
//
// migration-tier-4c Slice 2 (D-4c ride-along): the reviewer/explorer FALLBACK values are now
// IMPORTED DIRECTLY from opencode-client.ts's own REVIEWER_TIMEOUT_MS/EXPLORER_TIMEOUT_MS (this
// comment previously claimed that but the code kept a locally hardcoded duplicate — dissolved).
// The env var NAMES stay the same (OPENCODE_REVIEWER_TIMEOUT_MS / OPENCODE_EXPLORER_TIMEOUT_MS /
// OPENCODE_TIMEOUT_MS) so a single operator-set override tunes both providers at once.
//
// The env LOOKUP itself still reads from the STRATEGY's injected `env` (not opencode-client.ts's own
// frozen module constants used AS THE FALLBACK NUMBER only) — this stays independently
// unit-testable without waiting out multi-minute real defaults, while the fallback NUMBER can no
// longer drift between the two providers.
const DEFAULT_DIFF_GENERATOR_TIMEOUT_MS = 5 * 60 * 1000;

function envNumber(env: Record<string, string | undefined>, key: string, fallback: number): number {
  return Number(env[key]) || fallback;
}

// The default deadline for a Codex session that received NO explicit timeoutMs from its caller.
// Keyed by role, mirroring how opencode-client.ts budgets each role: the reviewer and the explorer
// get their OWN (smaller) ceilings; every other role (the write-capable primary/maintainer/worker/
// proposer, plus the read-only chat/reflector which have no dedicated OpenCode-side constant
// either) falls back to the generator's diff-mode budget — the smallest generator ceiling, and a
// strictly-bounded floor where today there is none at all.
export function defaultCodexTimeoutMs(role: AgentRole, env: Record<string, string | undefined>): number {
  if (role === "reviewer") return envNumber(env, "OPENCODE_REVIEWER_TIMEOUT_MS", REVIEWER_TIMEOUT_MS);
  if (role === "explorer") return envNumber(env, "OPENCODE_EXPLORER_TIMEOUT_MS", EXPLORER_TIMEOUT_MS);
  return envNumber(env, "OPENCODE_TIMEOUT_MS", DEFAULT_DIFF_GENERATOR_TIMEOUT_MS);
}

// T-P3-3 — onUsage honesty / PENDING_USAGE_HOOK.
//
// `codex exec --json` does NOT expose token usage in the JSONL schema currently verified
// (pending the T-P1-0 image-gated fixture from the real @openai/codex@0.139.0 binary).
//
// CONTRACT (AC3.3.1):
//   - openSession intentionally does NOT accept an `onUsage` callback: emitting null snapshots
//     would look like real data. See AgentRuntimeStrategy.openSession comment in types.ts.
//   - All token fields in AgentTurnEvent are set to null (see the prompt() funnel below).
//   - pipeline.ts:937 already yields `usageComplete = false` for codex — honest, not fabricated.
//
// PENDING HOOK — activate this when the T-P1-0 real-fixture capture proves the JSONL schema:
//   1. Set CODEX_USAGE_AVAILABLE = true
//   2. Parse the relevant usage field from the JSONL (e.g. event.usage.input_tokens)
//   3. Emit a UsageSnapshot via the caller-supplied onUsage callback in openSession opts
//   4. Update the agentTurnEvent token fields from the parsed values
//   5. Wire `onUsage` into openSession's opts type (matching OpenCodeRuntimeStrategy)
//
// Until those steps are done, CODEX_USAGE_AVAILABLE must remain false. This flag is exported
// so the unit test can assert the pending hook is NOT yet activated (T-P3-3).
export const CODEX_USAGE_AVAILABLE = false as boolean;

// ROOT-CAUSE classifier for Codex: mirrors agentErrorToInfra (opencode-client.ts:1754) for the
// Codex path. Maps `codex exec` non-zero exit / auth / out-of-credits / timeout to
// AgentUnavailableError (infra-error) so billing/auth failures never surface as false `fail`/`invalid`
// verdicts that open a spurious GitHub Issue. Returns null for non-infra outcomes (real test failures).
//
// IMPORTANT: This classifier operates on a plain Error — `codex exec` (or the supervisor transport)
// throws bare Error objects; the classification inspects the message for known infra signals.
// Do NOT extend this to substring-match test-output prose: only known provider/infra error patterns
// belong here. Any non-matching error returns null (caller decides the verdict).
export function codexErrorToInfra(error: unknown): AgentUnavailableError | null {
  if (!(error instanceof Error)) return null;
  const msg = error.message.toLowerCase();
  const tail = "INCONCLUSIVE (infrastructure), not a test failure";

  // Timeout is the highest-priority check: it's the controlled case (CodexExecTransport fires SIGTERM).
  if (/timed out after \d+ms/.test(msg)) {
    return new AgentUnavailableError(`Codex prompt timed out. ${tail}.`, { cause: error });
  }

  // Auth / credits / billing signals in stderr surfaced through the exit-code path.
  if (
    /\b(401|403|unauthorized|authentication failed|forbidden)\b/.test(msg) ||
    /\b(402|out of credits|payment required|billing|quota|insufficient_quota)\b/.test(msg) ||
    /\b(429|too many requests|rate.?limit)\b/.test(msg)
  ) {
    return new AgentUnavailableError(
      `Codex provider rejected the request (auth / credits / rate-limit): ${error.message}. ${tail}.`,
      { cause: error },
    );
  }

  // Abort/SIGTERM from an external AbortSignal (not our internal timeout).
  if (/\b(aborted|sigterm|abort)\b/.test(msg)) {
    return new AgentUnavailableError(`Codex exec was aborted. ${tail}.`, { cause: error });
  }

  // Not an infra error — a genuine non-infra outcome (real test failure, script error, etc.).
  return null;
}

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
  // WS9.3: the signal sent to the child when timeoutMs elapses. Defaults to "SIGTERM" (the
  // existing, pinned behavior for a CALLER-supplied timeoutMs — a caller who set their own budget
  // gets a graceful-first termination attempt). The strategy passes "SIGKILL" only for its OWN
  // default deadline (no caller budget at all): Codex is self-timed with no mid-turn activity
  // signal, so a hard wall-clock kill is the correct mechanism there, not a gentler signal that
  // assumes the process might still cooperate.
  killSignal?: NodeJS.Signals;
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

export const CODEX_MODELS: AgentModelInfo[] = [
  { id: "gpt-5.4", label: "GPT-5.4" },
  { id: "gpt-5.4-mini", label: "GPT-5.4 Mini" },
  { id: "gpt-5.5", label: "GPT-5.5" },
];

const CODEX_EXEC_ENV_EXACT = new Set([
  "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "TMPDIR", "TEMPDIR", "TMP", "TEMP",
  "CI", "NO_COLOR", "FORCE_COLOR", "DEBUG", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
  "https_proxy", "http_proxy", "no_proxy", "CODEX_API_KEY", "OPENAI_API_KEY", "CODEX_HOME", "CODEX_BIN",
]);
const CODEX_EXEC_ENV_PREFIX = /^(?:DEV_|AGENT_)/;

// Subscription-vs-API-key precedence (prefer a ChatGPT login over a stale/quota'd env key) is handled
// on the Docker/supervisor path (agents/agent-supervisor.mjs codexHasStoredAuth) — the path the engine
// actually runs. It is intentionally NOT replicated here: this orchestrator-side builder must stay a
// pure, filesystem-independent env projection so it is deterministic under test.
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
    opts?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      model?: string;
      descriptor?: AgentOpenDescriptor;
      onTurn?: (t: AgentTurnEvent) => void;
    },
  ): Promise<AgentRuntimeSession> {
    // WS9.3: an explicit caller timeoutMs always wins (caller intent is never overridden); when
    // absent (the rewritten qa-engine path's actual shape today), fall back to the per-role
    // default so a Codex turn is NEVER unbounded on the live path. The default deadline kills with
    // SIGKILL (a hard wall-clock guarantee — the caller opted into no budget of its own, so a
    // gentler SIGTERM that assumes a cooperating process is the wrong assumption); a caller-
    // supplied timeoutMs keeps the existing SIGTERM behavior (caller chose a graceful budget).
    const usingDefault = opts?.timeoutMs === undefined;
    const timeoutMs = opts?.timeoutMs ?? defaultCodexTimeoutMs(role, this.env);
    const session = await this.transport.start({
      role,
      cwd,
      model: opts?.model,
      signal: opts?.signal,
      timeoutMs,
      ...(usingDefault ? { killSignal: "SIGKILL" as const } : {}),
    });
    // Default turn sink, mirroring defaultAgentDeps.open: persist to agent_turns when a runId is
    // available and no caller-supplied onTurn overrides it. Best-effort — a storage failure must
    // not break the agent session. The OpenCode runtime builds this sink at the SDK funnel; for
    // Codex this strategy IS the funnel (it never goes through defaultAgentDeps), so the default
    // sink lives here so Codex roles persist with a real run_id even when no onTurn is injected.
    const defaultOnTurn = opts?.descriptor?.runId
      ? (t: AgentTurnEvent) => {
          try {
            saveAgentTurn({
              runId: t.runId,
              sessionId: t.sessionId,
              role: t.role,
              round: t.round,
              isRepair: t.isRepair,
              ts: t.ts,
              objective: t.objective ?? null,
              promptText: t.promptText,
              outputText: t.outputText,
              promptBytes: t.promptBytes,
              tokensInput: t.tokensInput,
              tokensOutput: t.tokensOutput,
              tokensReasoning: t.tokensReasoning,
              tokensCacheRead: t.tokensCacheRead,
              tokensCacheWrite: t.tokensCacheWrite,
              cost: t.cost,
            });
          } catch (err) {
            console.warn(`[qa] agent_turns persist failed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      : undefined;
    // Caller-supplied onTurn wins; otherwise the default sink fires when runId is present.
    const effectiveOnTurn = opts?.onTurn ?? defaultOnTurn;
    // Per-session round index, mirroring the OpenCode funnel: 0 for the first prompt() on this
    // session, +1 per call (see opencode-client `_round`). Cross-session regeneration ordering is
    // reconstructed from `ts`, not from this counter.
    let round = 0;
    return {
      id: session.id,
      // Codex's turn-telemetry funnel — the Codex-side equivalent of defaultAgentDeps.open's
      // OpenCode funnel. We emit an AgentTurnEvent per prompt so Codex roles persist agent_turns
      // rows with a real run_id. Token/cost fields are null: `codex exec` does not surface usage
      // here (AgentTurnRecord documents nulls as acceptable). outputText is sanitized BEFORE the
      // event fires (same as OpenCode), so any DEV-environment data is redacted before storage.
      prompt: async (text, promptOpts) => {
        const thisRound = round++;
        // Circuit breaker guard (mirrors checkCircuit() in opencode-client.ts:1607).
        // If the codex circuit is open (repeated infra failures), reject immediately
        // without spending a codex exec — the error surfaces as infra-error via codexErrorToInfra.
        checkCodexCircuit();
        let rawOutput: string;
        try {
          rawOutput = await session.prompt(withCodexRolePreamble(role, text, this.promptRoot));
          recordCodexCircuitSuccess();
        } catch (err) {
          recordCodexCircuitFailure();
          throw err;
        }
        // textOnly: strip chain-of-thought reasoning wrappers (<think>…</think> etc.) from the
        // output, mirroring OpenCode's extractText({textOnly:true}) path (opencode-client.ts:1811).
        // Used by chat/Q&A so the operator receives only the final answer without reasoning traces.
        const output = promptOpts?.textOnly ? stripCodexReasoningWrappers(rawOutput) : rawOutput;
        if (effectiveOnTurn) {
          effectiveOnTurn({
            runId: opts?.descriptor?.runId ?? null,
            sessionId: session.id,
            role: opts?.descriptor?.role ?? role,
            objective: opts?.descriptor?.objective,
            round: promptOpts?.round ?? thisRound,
            isRepair: promptOpts?.isRepair ?? false,
            promptText: text,
            promptBytes: Buffer.byteLength(text, "utf8"),
            outputText: sanitizeText(output).text,
            tokensInput: null,
            tokensOutput: null,
            tokensReasoning: null,
            tokensCacheRead: null,
            tokensCacheWrite: null,
            cost: null,
            ts: new Date().toISOString(),
            sectionSizes: promptOpts?.sectionSizes ?? null,
          });
        }
        return output;
      },
      dispose: () => session.dispose(),
    };
  }

  async restart(opts?: { apiKey?: string; reason?: string; env?: Record<string, string> }): Promise<AgentProviderHealth> {
    if (opts?.apiKey) this.env.CODEX_API_KEY = opts.apiKey;
    // Clear the circuit breaker on restart so the operator's recovery action (rotate API key)
    // is not blocked by stale failures — mirrors resetCircuit() in opencode-client.ts.
    resetCodexCircuit();
    const supervised = await supervisorRestart(this.env, this.provider, opts?.apiKey, opts?.env);
    if (supervised) return supervised;
    if (this.transport.restart) return this.transport.restart(opts);
    return this.health();
  }

  // startEventStream for Codex (C1.4 / AC1.4.3).
  //
  // ARCHITECTURAL NOTE — Codex is exec-per-prompt (no global SSE server):
  // Unlike OpenCode's persistent session server, `codex exec` is a one-shot process per prompt.
  // There is no global event bus to subscribe to. The stream here is a no-op registration
  // that provides structural parity with the OpenCode strategy's optional method. Live events
  // for individual codex prompts are emitted via the JSONL mapper (mapCodexExecEvent) inside
  // runExec when a caller supplies an onRunEvent hook — that per-exec streaming is separate from
  // this session-lifetime subscription.
  //
  // PROVISIONAL: the exact `codex exec --json` JSONL event shape is UNVERIFIED (T-P1-0 image-gated
  // fixture not yet captured). The mapper in activity-mapper.ts uses the same defensive probe
  // (event.msg ?? event.message ?? event.text ?? event.content) as extractCodexLastMessage.
  // This MUST be re-validated once the real fixture is committed from the built agents image.
  async startEventStream(
    _onActivity: (a: LiveActivity) => void,
    _signal?: AbortSignal,
    _onRunEvent?: (runId: string, body: RunEventBody) => void,
  ): Promise<void> {
    // No persistent event stream for exec-per-prompt Codex sessions.
    // Per-exec activity is emitted inline during runExec (see CodexExecTransport).
    return;
  }
}

// Dependency type for the spawn side-effect in CodexExecTransport.
// Injected so tests can supply a fake child-process stub without spawning a real binary.
export type SpawnFn = typeof spawn;

export class CodexExecTransport implements CodexHeadlessTransport {
  private readonly spawnFn: SpawnFn;
  constructor(
    private readonly env: Record<string, string | undefined> = process.env,
    private readonly command = process.env.CODEX_BIN ?? "codex",
    spawnFn?: SpawnFn,
  ) {
    this.spawnFn = spawnFn ?? spawn;
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
      const child = this.spawnFn(this.command, args, {
        cwd: input.cwd,
        env: codexExecEnv({ ...process.env, ...this.env }),
        stdio: ["pipe", "pipe", "pipe"],
        signal: input.signal,
      });
      let stdout = "";
      let stderr = "";
      const timeout = input.timeoutMs ? setTimeout(() => {
        child.kill(input.killSignal ?? "SIGTERM");
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
        else {
          const raw = new Error(`codex exec exited ${code}: ${stderr.trim() || stdout.trim()}`);
          // Classify the exit error: infra faults (auth/credits/timeout/abort) become
          // AgentUnavailableError so the pipeline surfaces infra-error, never a false Issue.
          const infra = codexErrorToInfra(raw);
          reject(infra ?? raw);
        }
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
    if (!res.ok) {
      const raw = new Error(`codex exec via supervisor failed (${res.status}): ${body.error ?? "unknown"}`);
      // Classify infra errors (auth/credits/rate-limit) so the pipeline can surface infra-error.
      const infra = codexErrorToInfra(raw);
      throw infra ?? raw;
    }
    return body.message ?? "";
  }
}

// Strips chain-of-thought reasoning wrappers that models may include in their output.
// Mirrors OpenCode's stripReasoningWrappers (opencode-client.ts:1790) — used on the textOnly
// path so a leaked <think>…</think> block is removed before the text reaches the operator.
function stripCodexReasoningWrappers(s: string): string {
  return s.replace(/<(think|thought|reasoning)>[\s\S]*?<\/\1>/gi, "").trim();
}

// WS9.2 — role → skill names it references. Must stay in sync with the "Consult the `<skill>`
// skill" callouts in agent/roles/<role>.md (verified against the live prompts at slice time:
// qa-generator references architecture-mapping, playwright-authoring, test-value-review;
// qa-reviewer references test-value-review; qa-worker references playwright-authoring). Kept
// as an explicit map rather than parsing the prompt text for skill-name mentions: the prompts
// are hand-authored prose, not a machine-readable manifest, so a regex scrape would be exactly
// the kind of fragile heuristic CLAUDE.md warns against — an explicit, reviewable map is the
// honest cost of provider parity here. A role with no entry ships no skill content (matches
// today's OpenCode behavior for roles that reference no skill).
const ROLE_SKILLS: Partial<Record<AgentRole, readonly string[]>> = {
  primary: ["architecture-mapping", "playwright-authoring", "test-value-review"],
  reviewer: ["test-value-review"],
  worker: ["playwright-authoring"],
  workerCode: ["playwright-authoring"],
};

function withCodexRolePreamble(role: AgentRole, text: string, promptRoot: string): string {
  const shared = readPrompt(join(promptRoot, "AGENTS.md"));
  const rolePrompt = readPrompt(join(promptRoot, "roles", `${rolePromptName(role)}.md`));
  // WS9.2: inline the SKILL.md content for every skill this role references — the same assembly
  // point that already inlines AGENTS.md and the role prompt. Without this, "Consult the
  // `playwright-authoring` skill" is a dangling reference on Codex (the agents image ships only
  // the supervisor, never agent/skills/, into a codex turn). A skill file that fails to resolve
  // is omitted (readPrompt degrades to ""), matching the fail-open posture of the shared/role
  // prompt reads above — a missing skill must never crash a turn — but LOUDLY: the warn below
  // names the missing path so a renamed/moved SKILL.md cannot silently ship an impoverished
  // preamble run after run.
  const skillBlocks = (ROLE_SKILLS[role] ?? [])
    .map((name) => {
      const path = join(promptRoot, "skills", name, "SKILL.md");
      const body = readPrompt(path);
      if (!body) console.warn(`[qa] codex preamble: skill '${name}' referenced by role '${role}' did not resolve at ${path} — inlining without it.`);
      return { name, body };
    })
    .filter(({ body }) => body.length > 0)
    .map(({ name, body }) => `## Skill: ${name}\n${body}`);
  return [
    `Agent role: ${role}`,
    "",
    "Follow the same provider-neutral Panchito prompts and verdict contracts used by the OpenCode runtime.",
    "All authoritative decisions must be returned in the blocking final response; live events are observational only.",
    "",
    shared ? `## Shared prompt\n${shared}` : "",
    rolePrompt ? `## Role prompt\n${rolePrompt}` : "",
    ...skillBlocks,
    shared || rolePrompt || skillBlocks.length > 0 ? "## Task" : "",
    text,
  ].join("\n");
}

export function rolePromptName(role: AgentRole): string {
  if (role === "primary") return "qa-generator";
  if (role === "reviewer") return "qa-reviewer";
  if (role === "chat") return "qa-assistant";
  if (role === "worker") return "qa-worker";
  if (role === "workerCode") return "qa-worker";
  if (role === "reflector") return "qa-reflector";
  if (role === "explorer") return "qa-explorer";
  if (role === "proposer") return "qa-proposer";
  return "qa-maintainer";
}

function readPrompt(path: string): string {
  try {
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  } catch {
    return "";
  }
}

// WS9.4(a): a verdict-shaped JSON object — reused to detect whether an agent_message CONTAINS a
// closing verdict block, mirroring the two discriminators the caller-side parsers already use
// (isClosingVerdict for the generator's specs[]/approved shape; the reviewer's looser "approved
// in x" check in verdict-validate.ts). A message qualifies if EITHER shape is present anywhere in
// its text — this function does not know which role's turn it is reading, so it accepts both.
function containsVerdictBlock(text: string): boolean {
  return extractJsonObjects(text).some(
    (o) => o !== null && typeof o === "object" && (Array.isArray((o as Record<string, unknown>).specs) || "approved" in (o as Record<string, unknown>)),
  );
}

export function extractCodexLastMessage(jsonl: string): string {
  const messages: string[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      // codex exec --json (0.139.0) emits the assistant turn as
      // {"type":"item.completed","item":{"type":"agent_message","text":"..."}}.
      // Keep the older flat shapes as fallbacks for forward/backward compatibility.
      const item = event.item as { type?: string; text?: string } | undefined;
      const message =
        (event.type === "item.completed" && item?.type === "agent_message" ? item.text : undefined) ??
        event.msg ?? event.message ?? event.text ?? event.content;
      if (typeof message === "string" && message.trim()) messages.push(message);
    } catch {
      // Keep scanning: `codex exec --json` should be JSONL, but stderr-like lines
      // from wrapped launchers should not throw away a completed response.
    }
  }
  if (messages.length === 0) return "";
  // WS9.4(a): prefer the LAST message that itself contains a parseable verdict block. A verdict
  // emitted before a trailing courtesy remark ("Done! Anything else?") must not be lost — OpenCode
  // never has this problem because its extractText concatenates ALL messages, but Codex's
  // exec-per-prompt output is read message-by-message here. Scanning in reverse and falling back
  // to the true last message when none carries a verdict preserves every plain-text/chat case
  // (no verdict ever expected) exactly as before.
  for (let i = messages.length - 1; i >= 0; i--) {
    const candidate = messages[i]!;
    if (containsVerdictBlock(candidate)) return candidate;
  }
  return messages[messages.length - 1]!;
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
