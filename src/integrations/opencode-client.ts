// Trigger for the OpenCode agentic engine. Generation, review (subagent) and
// access to serena/engram all live INSIDE OpenCode (see opencode/opencode.json).
// Here we only open a session against `opencode serve`, pass it the change
// context, and the agent writes/updates the tests in the working copy's `e2e/`
// folder (a git repo: the source of truth). We collect no artifacts: the harness
// runs over `e2e/` and publishing commits the git diff.
//
// The SDK is injected via AgentDeps: the verifiable logic (prompt building,
// verdict parsing, orchestration) is tested with stubs; the real connection to
// `opencode serve` is the boundary not covered by unit tests.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { AgentResult, QaCase, RunMode, TestTarget, SpecMeta, ActivityKind } from "../types";
import { CommitIntent } from "../qa/commit-classify";
import type { ArchitectureContext } from "../qa/context";
import { coerceExplorationBrief, parseExplorationBrief, type ExplorationBrief } from "../qa/exploration-brief";
import { sanitizeText } from "../orchestrator/sanitizer";
import { ActivityRouter } from "./agent-activity";
import { mapOpencodeEvent, eventRunId } from "./activity-mapper";
import type { RunEventBody } from "../contract/events";
import { appendLog } from "../server/history";
import { installHttpDispatcher } from "../util/net";

interface SessionEntry {
  id: string;
  agent: string;
  cwd: string;
  openedAt: number;
}

const sessionRegistry = new Map<string, SessionEntry>();

// Circuit breaker (extracted to ./circuit-breaker, BND-08). Re-exported so existing importers of
// resetCircuit keep working.
import { checkCircuit, recordCircuitFailure, recordCircuitSuccess, resetCircuit } from "./circuit-breaker";
export { resetCircuit };
// Verdict/JSON parsing (extracted to ./verdict-parse, BND-08). Re-exported so existing importers
// (and tests) keep resolving extractJsonObjects/parseVerdict from this module.
import { type FinalVerdict, extractJsonObjects, lastJsonMatching, parseVerdict } from "./verdict-parse";
export { extractJsonObjects, parseVerdict };
// Prompt/task assembly (extracted to ./prompts, BND-08). Re-exported so existing importers (runtime
// + tests) keep resolving them from this module. The input types are shared via a type-only import
// on the prompts side, so there is no runtime import cycle.
import { specFileForFlow, buildWorkerPrompt, buildPlanPrompt, buildPrompt, buildExplorerPrompt, buildContextTask, renderArchitectureContext } from "./prompts";
export { specFileForFlow, buildWorkerPrompt, buildPlanPrompt, buildPrompt, buildExplorerPrompt, buildContextTask, renderArchitectureContext };
// Typed verdict contract + bounded repair (post-ADR-001, Phase 1 / 3.1). Schema validation of
// the agent's generator + reviewer output, and the targeted re-prompt used on a contract miss.
import { checkGeneratorVerdict, repairInstruction, parseReviewerVerdict } from "./verdict-validate";
import { ManifestEntrySchema } from "../orchestrator/schemas";
import { AgentUnavailableError } from "../errors";

// Read fallback model mapping from opencode.json (root-level key). Keeps the
// fallback logic in one place so the orchestrator can retry with a different
// model when the primary is unavailable. Opt-in: absent `model_fallback` key
// (the default) means no fallback — the primary error propagates unchanged.
function getFallbackModel(agent: string): string | undefined {
  try {
    const configPath = join(process.cwd(), "agents", "opencode.json");
    if (!existsSync(configPath)) return undefined;
    const raw = JSON.parse(readFileSync(configPath, "utf8"));
    return raw.model_fallback?.[agent] as string | undefined;
  } catch {
    return undefined;
  }
}

// The session.prompt SDK takes a structured model override ({providerID, modelID}),
// not the "provider/model" string opencode.json uses. Parse it; an unparseable ref
// (no provider segment) yields undefined so the override is skipped rather than sent
// malformed.
export function parseModelRef(ref: string): { providerID: string; modelID: string } | undefined {
  const i = ref.indexOf("/");
  if (i <= 0 || i >= ref.length - 1) return undefined;
  return { providerID: ref.slice(0, i), modelID: ref.slice(i + 1) };
}

// Shared OpenCode SDK client — lazy-initialised once, reused by SSE stream AND
// session operations. This avoids creating two independent HTTP connections to
// the OpenCode server (official best practice: one client, many operations).
let sharedClient: Awaited<ReturnType<typeof import("@opencode-ai/sdk").createOpencodeClient>> | undefined;

async function getSharedClient() {
  checkCircuit();
  if (sharedClient) return sharedClient;
  const { createOpencodeClient } = await import("@opencode-ai/sdk");
  const serverPassword = process.env.OPENCODE_SERVER_PASSWORD;
  try {
    sharedClient = createOpencodeClient({
      baseUrl: process.env.OPENCODE_SERVE_URL ?? "http://agents:4096",
      ...(serverPassword
        ? { headers: { Authorization: `Basic ${Buffer.from(`opencode:${serverPassword}`).toString("base64")}` } }
        : {}),
    });
    recordCircuitSuccess();
  } catch (err) {
    recordCircuitFailure();
    throw err;
  }
  return sharedClient;
}

// Separate v2 SDK client, used ONLY for the live event subscription (observability
// path). Sessions/verdict stay on the v1 blocking client above — the deliberate
// split (docs/tui-vnext.md §5 D5): events→v2 scoped subscribe (advisory-only, zero
// verdict risk), generation/verdict→v1 blocking prompt (the determinism keystone).
let sharedEventClient: ReturnType<typeof import("@opencode-ai/sdk/v2").createOpencodeClient> | undefined;

async function getEventClient() {
  checkCircuit();
  if (sharedEventClient) return sharedEventClient;
  const { createOpencodeClient } = await import("@opencode-ai/sdk/v2");
  const serverPassword = process.env.OPENCODE_SERVER_PASSWORD;
  try {
    sharedEventClient = createOpencodeClient({
      baseUrl: process.env.OPENCODE_SERVE_URL ?? "http://agents:4096",
      ...(serverPassword
        ? { headers: { Authorization: `Basic ${Buffer.from(`opencode:${serverPassword}`).toString("base64")}` } }
        : {}),
    });
    recordCircuitSuccess();
  } catch (err) {
    recordCircuitFailure();
    throw err;
  }
  return sharedEventClient;
}

export function disposeSharedClient(): void {
  sharedClient = undefined;
  sharedEventClient = undefined;
  // The breaker is process-global and decoupled from the client lifecycle; reset it here
  // so a restart-to-recover does not immediately re-throw "circuit breaker is OPEN".
  resetCircuit();
}

// SSE live activity: routes OpenCode events to RunRecord logs in real time.
export const activityRouter = new ActivityRouter();

// Maps an OpenCode session to a run so SSE events are routed to the correct RunRecord.
export function registerRunSession(sessionId: string, runId: string, directory: string, workerId?: string): void {
  activityRouter.register(sessionId, runId, workerId);
  eventStreams.attach(sessionId, directory);
}

export function unregisterRunSession(sessionId: string): void {
  activityRouter.unregister(sessionId);
  eventStreams.detach(sessionId);
}

// One routed, display-ready activity handed to the SSE consumer: the structured
// fields (for the live panel) plus a human-readable `display` line (for the log
// feed the chat assistant reads).
export interface LiveActivity {
  runId: string;
  kind: ActivityKind;
  text: string;
  status?: "pending" | "in_progress" | "completed";
  display: string;
}

// One scoped v2 subscription for a single run directory. v2 has NO global firehose:
// event.subscribe({directory}) yields ONLY that workspace's events, each DIRECTLY
// ({ id, type, properties } — no v1 GlobalEvent { directory, payload } wrapper).
// Returns on stream close/error; the manager's reconnect loop reopens it.
export async function startScopedEventStream(
  directory: string,
  onActivity: (a: LiveActivity) => void,
  signal?: AbortSignal,
  // Contract RunEvent stream: each raw event is mapped (preserving ToolState.title/
  // callID, all tools, todos) and published to the run it belongs to. Advisory —
  // never authoritative, never allowed to break the stream loop.
  onRunEvent?: (runId: string, body: RunEventBody) => void,
): Promise<void> {
  const client = await getEventClient();
  const result = await client.event.subscribe({ directory });
  const stream = result.stream;
  if (!stream) {
    console.warn(`[qa] SSE event stream returned no stream (${directory})`);
    return;
  }

  try {
    for await (const event of stream) {
      if (signal?.aborted) break;

      const evt = event as { type?: string; properties?: Record<string, unknown> };
      if (!evt.type) continue;

      const raw = { type: evt.type, properties: evt.properties };

      // Rich contract RunEvents (agent.activity/plan.updated/…) from the RAW event,
      // so ToolState.title/callID survive. Published to the owning run; a malformed
      // body must never break the loop.
      if (onRunEvent) {
        const rid = eventRunId(raw, activityRouter.sessionMap());
        if (rid) {
          for (const body of mapOpencodeEvent(raw, activityRouter.sessionMap(), activityRouter.workerMap())) {
            try { onRunEvent(rid, body); } catch { /* advisory */ }
          }
        }
      }

      const activities = activityRouter.route(raw);

      for (const activity of activities) {
        // Build a concise display line for the human log feed (chat-assistant context).
        // The structured fields below feed the live TUI panel; the text is already clean.
        let shown = activity.text;
        if (activity.kind === "command") {
          const parts = shown.split(/\s+/);
          if (parts.length > 4) shown = parts.slice(0, 4).join(" ") + " …";
        }
        // Match the TUI's visual identity: ✓/✗/·/⚠/⚙ — no emoji.
        const icon = activity.kind === "file" ? "✎" : activity.kind === "command" ? "⚙" : activity.kind === "error" ? "⚠" : "▸";
        const label = activity.kind === "file" ? `wrote ${shown}` : shown;
        onActivity({
          runId: activity.runId,
          kind: activity.kind,
          text: activity.text,
          ...(activity.status ? { status: activity.status } : {}),
          display: `[qa] ${icon} ${label}`,
        });
      }
    }
  } catch (err) {
    if (!signal?.aborted) {
      console.warn(`[qa] SSE event stream error (${directory}): ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    console.log(`[qa] SSE event stream closed (${directory})`);
  }
}

// Opens (and keeps reconnecting) ONE scoped stream for a directory until `signal`
// aborts. Injectable so the manager is unit-testable without the SDK.
export type OpenStreamFn = (
  directory: string,
  onActivity: (a: LiveActivity) => void,
  signal: AbortSignal,
  onRunEvent?: (runId: string, body: RunEventBody) => void,
) => void;

const defaultOpenStream: OpenStreamFn = (directory, onActivity, signal, onRunEvent) => {
  void startEventStreamWithReconnect(onActivity, signal, {
    onRunEvent,
    start: (oa, sig, ore) => startScopedEventStream(directory, oa, sig, ore),
    log: (m) => console.log(m),
  });
};

// Refcounted per-directory scoped subscriptions. v2 forces per-workspace streams,
// so the orchestrator opens one scoped stream per run directory (parallelDiff
// sessions in the same mirror share it) and closes it when the directory's last
// session unregisters. The sink (set once at boot via startActivitySink) is the
// same callback pair the single v1 global stream used.
export class EventStreamManager {
  private onActivity?: (a: LiveActivity) => void;
  private onRunEvent?: (runId: string, body: RunEventBody) => void;
  private shutdown?: AbortSignal;
  private readonly dirs = new Map<string, { refs: number; abort: AbortController; started: boolean }>();
  private readonly sessionDir = new Map<string, string>();

  constructor(private readonly openStream: OpenStreamFn = defaultOpenStream) {}

  setSink(onActivity: (a: LiveActivity) => void, shutdown?: AbortSignal, onRunEvent?: (runId: string, body: RunEventBody) => void): void {
    this.onActivity = onActivity;
    this.onRunEvent = onRunEvent;
    this.shutdown = shutdown;
    shutdown?.addEventListener("abort", () => this.closeAll(), { once: true });
    // Open any directory attached before the sink was set.
    for (const dir of this.dirs.keys()) this.ensureStream(dir);
  }

  attach(sessionId: string, directory: string): void {
    if (this.shutdown?.aborted) return;
    this.sessionDir.set(sessionId, directory);
    const existing = this.dirs.get(directory);
    if (existing) { existing.refs++; return; }
    this.dirs.set(directory, { refs: 1, abort: new AbortController(), started: false });
    this.ensureStream(directory);
  }

  detach(sessionId: string): void {
    const directory = this.sessionDir.get(sessionId);
    if (!directory) return;
    this.sessionDir.delete(sessionId);
    const entry = this.dirs.get(directory);
    if (!entry) return;
    entry.refs--;
    if (entry.refs <= 0) {
      entry.abort.abort();
      this.dirs.delete(directory);
    }
  }

  private ensureStream(directory: string): void {
    if (!this.onActivity) return; // sink not set yet — opened in setSink
    const entry = this.dirs.get(directory);
    if (!entry || entry.started) return;
    entry.started = true;
    this.openStream(directory, this.onActivity, entry.abort.signal, this.onRunEvent);
  }

  private closeAll(): void {
    for (const entry of this.dirs.values()) entry.abort.abort();
    this.dirs.clear();
    this.sessionDir.clear();
  }
}

const eventStreams = new EventStreamManager();

// Boot entry (called once by the facade): register the live-activity sink. v2 has
// no global stream to open here — per-directory streams start lazily as runs
// register sessions. Resolves when `signal` aborts, mirroring the old long-lived
// stream's lifetime so the facade's fire-and-forget call stays pending until shutdown.
export function startActivitySink(
  onActivity: (a: LiveActivity) => void,
  signal?: AbortSignal,
  opts: { onRunEvent?: (runId: string, body: RunEventBody) => void } = {},
): Promise<void> {
  eventStreams.setSink(onActivity, signal, opts.onRunEvent);
  return new Promise<void>((resolve) => {
    if (!signal) return; // boot always passes the shutdown signal; without it, stay pending
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

export interface EventStreamReconnectOptions {
  // The scoped stream opener to keep alive. Required: there is no global default
  // anymore (v2 has no global firehose). The manager closes over the directory.
  start: (onActivity: (a: LiveActivity) => void, signal?: AbortSignal, onRunEvent?: (runId: string, body: RunEventBody) => void) => Promise<void>;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  initialDelayMs?: number;
  maxDelayMs?: number;
  log?: (msg: string) => void;
  onRunEvent?: (runId: string, body: RunEventBody) => void;
}

function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => done();
    function done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Keeps the OpenCode SSE bridge alive for the lifetime of the orchestrator. The
// underlying SDK stream can fail during startup or after a transient network blip;
// without this wrapper the TUI silently loses live activity until process restart.
export async function startEventStreamWithReconnect(
  onActivity: (a: LiveActivity) => void,
  signal?: AbortSignal,
  opts: EventStreamReconnectOptions = { start: () => { throw new Error("startEventStreamWithReconnect requires a scoped `start`"); } },
): Promise<void> {
  const start = opts.start;
  const sleep = opts.sleep ?? sleepWithAbort;
  const initialDelayMs = opts.initialDelayMs ?? 1_000;
  const maxDelayMs = opts.maxDelayMs ?? 30_000;
  let delayMs = initialDelayMs;

  while (!signal?.aborted) {
    try {
      await start(onActivity, signal, opts.onRunEvent);
      delayMs = initialDelayMs;
      if (!signal?.aborted) opts.log?.(`[qa] OpenCode event stream closed; reconnecting in ${delayMs}ms`);
    } catch (err) {
      if (signal?.aborted) break;
      opts.log?.(`[qa] OpenCode event stream failed: ${err instanceof Error ? err.message : String(err)}; reconnecting in ${delayMs}ms`);
    }
    if (signal?.aborted) break;
    await sleep(delayMs, signal);
    delayMs = Math.min(delayMs * 2, maxDelayMs);
  }
}

export function getOpenSessions(): SessionEntry[] {
  return [...sessionRegistry.values()];
}

export function getOpenSessionCount(): number {
  return sessionRegistry.size;
}

// Read-only Q&A about a run. Opens a short-lived session as the requested role.
export async function askAssistant(
  // `agent` selects the role this Q&A runs as. It defaults to the read-only chat assistant; the
  // reflection path passes "qa-reflector" — a tool-less role (no MCP) — so a one-shot reflection
  // cannot touch engram or the filesystem the way the chat assistant (which keeps engram memory) can.
  input: { context: string; question: string; instruction?: string; agent?: string },
  deps: AgentDeps,
  cwd: string,
): Promise<string> {
  const instruction = input.instruction ??
    [
      `Answer the operator's question about this QA run using ONLY the run context below.`,
      ``,
      `RESPONSE STRUCTURE (for questions about a test failure or run status):`,
      `  1. One-line summary of what happened (verdict, phase, key numbers)`,
      `  2. Key detail: what failed and why (1-3 sentences, root cause in plain language)`,
      `  3. What to do next (if applicable: wait, re-run, check the issue, continue)`,
      ``,
      `OUTPUT:`,
      `- Reply with the ANSWER ONLY. Never include your reasoning, planning, or thought`,
      `  process — no "Let me look at…", no step-by-step deliberation. Just the answer.`,
      `- Respond in the SAME language as the question (Spanish → Spanish, English → English),`,
      `  in neutral, standard language — no regional slang. Never use emojis.`,
      ``,
      `FORMATTING — your answer is rendered as Markdown in the terminal, so use it:`,
      `  · **bold** for emphasis and key numbers.`,
      `  · \`inline code\` for file names, commands, selectors and identifiers.`,
      `  · "-" bullet lists for enumerations; short "##" headings when the answer spans topics.`,
      `  Keep it concise and scannable — a few short paragraphs, not a wall of text.`,
      ``,
      `PLAIN LANGUAGE — talk about the user's tests, not the tool's internals:`,
      `  · Say what the agent is DOING (generating tests, exploring the page), not phase`,
      `    names (classify/generate/validate/execute) or pipeline mechanics.`,
      `  · Never mention "heartbeat"; say "the agent is still active" instead.`,
      `  · Describe outcomes in plain words rather than raw step/status/verdict tokens.`,
      ``,
      `- If the context lacks the answer, reply (in the question's language): "No tengo suficiente información para responder eso."`,
    ].join("\n");
  const session = await deps.open(input.agent ?? "qa-assistant", cwd);
  try {
    // textOnly drops the model's reasoning parts: the assistant's return value is shown
    // verbatim to the operator, so a leaked chain-of-thought would surface in the chat.
    return await session.prompt([
      instruction,
      `Do not use any tools.`,
      `---`,
      input.context,
      `---`,
      `Question: ${input.question}`,
    ].join("\n"), { textOnly: true });
  } finally {
    await session.dispose().catch((err) => {
      console.warn(`[qa] session dispose failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

export interface OpencodeRunInput {
  repo: string;
  sha: string;
  diff: string;
  mirrorDir: string; // the agent's cwd: working copy of the repo (holds `e2e/`)
  e2eRelDir: string; // tests folder relative to mirrorDir (e.g. "e2e")
  namespace: string; // test-data prefix (qa-bot-<sha>)
  needsReview: boolean;
  target: TestTarget; // "e2e" or "code" — what KIND of tests to generate
  mode: RunMode;
  appName: string; // engram project — scopes all memory to this app
  baseUrl?: string; // e2e: the LIVE DEV URL the agent must navigate to (Playwright MCP)
  intent?: CommitIntent; // diff mode: commit intent (type + message + files)
  guidance?: string; // manual mode: user instructions
  openapi?: string | string[]; // optional hint (from app config): where the repo's OpenAPI contract(s) live
  fixCases?: QaCase[]; // re-generation: failed cases from a previous execution to fix
  reviewCorrections?: string[]; // re-generation: actionable corrections from a reviewer rejection
  coverageGap?: string; // re-generation: changed lines not yet exercised (change-coverage gap)
  learnedRules?: string; // retrieval: rules from past runs injected into the agent prompt
  runId?: string; // maps the session to a RunRecord for SSE live activity
  contextMap?: ArchitectureContext; // cross-cutting: the FE↔BE map, injected by the orchestrator
  explorer?: boolean; // Fase 3: run a read-only explorer pass before the generator (diff single-agent, opt-in)
  contextBrief?: ExplorationBrief; // the distilled blast radius from the explorer pass (set internally → buildPrompt)
  service?: { repo: string; mirrorDir: string; openapi?: string | string[] }; // cross-repo: the triggering microservice (read-only working copy)
  services?: Array<{ repo: string; mirrorDir: string; openapi?: string | string[] }>; // context mode: every declared service, mirrored read-only
}

// A session opened against `opencode serve`. prompt() sends the message to the
// `qa-generator` agent and returns its final text (including the closing JSON).
// dispose() cleans up the session; call it when the session is no longer needed
// to avoid memory leaks on the server (sessions are never auto-cleaned).
export interface AgentSession {
  id: string;
  // textOnly returns only the model's final answer (type:"text" parts), excluding
  // reasoning parts. Default (false) concatenates every text-bearing part — the
  // generator/reviewer need that so a closing JSON emitted in a reasoning part survives.
  prompt(text: string, opts?: { textOnly?: boolean }): Promise<string>;
  dispose(): Promise<void>;
}

export interface AgentDeps {
  open(agent: string, cwd: string, opts?: { signal?: AbortSignal; timeoutMs?: number; model?: string }): Promise<AgentSession>;
  cleanupOrphans?(maxAgeMs: number): Promise<number>;
}

// Runs the read-only explorer ONCE for a first-pass diff e2e generation when opted in, returning the
// distilled brief (or null to degrade silently). Gated tightly: never on code mode, never on a
// re-generation pass (fix/review/coverage already carry context), and only when input.explorer is set.
async function maybeExplore(
  input: OpencodeRunInput,
  deps: AgentDeps,
  opts?: { signal?: AbortSignal; onProgress?: (msg: string) => void },
): Promise<ExplorationBrief | null> {
  const isReGen = Boolean(input.fixCases?.length || input.reviewCorrections?.length || input.coverageGap);
  if (!input.explorer || input.mode !== "diff" || input.target === "code" || isReGen) return null;
  let session: AgentSession | undefined;
  try {
    session = await deps.open("qa-explorer", input.mirrorDir, { signal: opts?.signal, timeoutMs: EXPLORER_TIMEOUT_MS });
    if (input.runId) registerRunSession(session.id, input.runId, input.mirrorDir, "explorer");
    const text = await session.prompt(buildExplorerPrompt(input));
    const brief = parseExplorationBrief(text);
    // An empty blast radius carries no signal: treat it as no brief, so the generator explores inline
    // rather than being told "don't re-read the code" with nothing to go on.
    const usable = brief && brief.blastRadius.length > 0 ? brief : null;
    opts?.onProgress?.(
      usable
        ? `[qa] explorer: distilled ${usable.blastRadius.length} symbol(s) — generator gets a clean window`
        : `[qa] explorer: no usable brief — generator will explore inline`,
    );
    return usable;
  } catch (err) {
    console.warn(`[qa] explorer pass failed (${err instanceof Error ? err.message : String(err)}) — generator will explore inline.`);
    return null;
  } finally {
    if (session) {
      if (input.runId) unregisterRunSession(session.id);
      await session.dispose().catch(() => {});
    }
  }
}

export async function runOpencode(
  input: OpencodeRunInput,
  deps: AgentDeps,
  opts?: { signal?: AbortSignal; onProgress?: (msg: string) => void },
): Promise<AgentResult> {
  const timeoutMs = agentTimeout(input.mode);
  // Fase 3: optional read-only explorer pass — distill the blast radius in an isolated session so the
  // generator gets a clean window. Best-effort: a failure/unparseable brief degrades to the generator
  // exploring inline (never fails the run).
  const explorerBrief = await maybeExplore(input, deps, opts);
  const effectiveInput = explorerBrief ? { ...input, contextBrief: explorerBrief } : input;
  const session = await deps.open("qa-generator", input.mirrorDir, { signal: opts?.signal, timeoutMs });

  // Register this session for SSE live activity so the agent's real-time events
  // (tool calls, file edits, streaming text) are routed to the RunRecord logs.
  if (input.runId) {
    registerRunSession(session.id, input.runId, input.mirrorDir);
  }

  // Heartbeat: while the agent prompt is blocking, emit periodic progress logs so
  // the TUI and chat assistant have live feedback during the (potentially long)
  // generation phase instead of complete silence.
  const startedAt = Date.now();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  if (opts?.onProgress) {
    heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      opts.onProgress?.(`[qa] agent is working... (${elapsed}s elapsed)`);
    }, 15_000);
  }

  try {
    let finalText = await session.prompt(buildPrompt(effectiveInput));

    // Typed-contract guard (post-ADR-001, Phase 1): if the generator's closing JSON does not
    // satisfy the contract (missing specs array, malformed specMetas, …), re-prompt ONCE with
    // the specific issues before accepting it. Recovers good runs otherwise lost to a
    // formatting slip; bounded to a single retry so a confused agent cannot stall the queue.
    // Cost note: the repair spends a second prompt under the SAME per-call timeout, so a
    // persistently-malformed generator can at most ~double this run's worst-case duration
    // before the sequential queue frees — acceptable on the (rare) error path only.
    const genCheck = checkGeneratorVerdict(finalText);
    if (!genCheck.valid) {
      console.warn(`[qa] generator verdict failed the typed contract (${genCheck.issues.join("; ")}); requesting one repair.`);
      finalText = await session.prompt(repairInstruction("generator", genCheck.issues));
      if (!checkGeneratorVerdict(finalText).valid) {
        console.warn("[qa] generator verdict still invalid after repair — proceeding with best-effort parse (disk reconciliation still applies).");
      }
    }

    const verdict = parseVerdict(finalText);
    // Surface a parse miss loudly: a good run must not be silently turned into a
    // rejection because we failed to read the agent's closing JSON (the #1 invariant).
    if (!verdict.parsed && input.needsReview) {
      console.warn(
        "[qa] WARNING: the agent emitted no parseable verdict JSON — failing closed " +
          "(treated as NOT approved). This is a parse miss, not necessarily a rejection.",
      );
    }
    // When review is disabled, the subagent verdict does not apply: approve.
    const approved = input.needsReview ? verdict.approved : true;

    // Deterministic manifest upsert: when the agent provides specMetas (flow,
    // objective, targets per spec), the orchestrator writes the manifest — not
    // the agent. This closes the non-determinism gap where the agent could
    // forget, write corrupted entries, or use different ids across runs.
    // e2e-only: the manifest is an e2e-suite artifact under e2e/.qa/. In code mode the repo
    // has no e2e/ dir and publishCode would commit a phantom e2e/.qa/manifest.json into the
    // watched repo (same reason measured.json is gated to e2e — M1/D1).
    if (input.target !== "code" && verdict.specMetas && verdict.specMetas.length > 0) {
      const changeType = input.intent?.type ?? "unknown";
      // Reconcile the agent's self-reported specMetas against DISK before writing the manifest
      // ("disk over the agent's word", the same invariant reconcileSpecs and the parallel path
      // enforce): a meta whose file is NOT on disk is a PHANTOM (the agent named a spec it never
      // wrote) — drop it instead of committing a metadata entry for a non-existent test. A
      // present file always yields a sha256, so its absence is the on-disk check AND guarantees
      // every committed entry carries an integrity checksum.
      const entries: ManifestEntry[] = verdict.specMetas
        .map((m) => ({ m, sha256: sha256File(join(input.mirrorDir, input.e2eRelDir, m.file)) }))
        .filter(({ m, sha256 }) => {
          if (!sha256) {
            console.warn(`[qa] WARNING: agent reported spec '${m.file}' in its manifest metadata but it is not on disk — dropping the phantom manifest entry.`);
            return false;
          }
          return true;
        })
        .map(({ m, sha256 }) => ({
          id: m.flow,
          objective: m.objective,
          flow: m.flow,
          targets: m.targets,
          changeRef: { sha: input.sha, type: changeType },
          sha256: sha256!,
        }));
      // Validate each entry against the SAME schema the read path uses, before writing
      // (post-ADR-001, Phase 3.1): the orchestrator must never emit a manifest that its own
      // read-validation would later reject (e.g. an entry whose `targets` are empty — a
      // deliberate manifest invariant the generator's lenient specMetas can still produce).
      // The bad entry is dropped here with a warning rather than corrupting the whole
      // manifest. Complements the on-disk reconciliation above: disk proves the test exists,
      // this proves its metadata is well-formed.
      const validEntries = entries.filter((e) => {
        const r = ManifestEntrySchema.safeParse(e);
        if (!r.success) {
          console.warn(`[qa] WARNING: dropping manifest entry '${e.id}' — it fails the manifest schema: ${r.error.issues.map((i) => i.message).join("; ")}`);
          return false;
        }
        return true;
      });
      if (validEntries.length > 0) {
        upsertManifest(
          realManifestFs,
          join(input.mirrorDir, input.e2eRelDir, ".qa", "manifest.json"),
          validEntries,
        );
      }
    }

    return {
      output: finalText,
      specs: verdict.specs,
      specMetas: verdict.specMetas,
      reviewed: input.needsReview,
      approved,
      note: approved ? undefined : verdict.note ?? "the reviewer did not approve the E2E tests",
    };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (input.runId) unregisterRunSession(session.id);
    await session.dispose().catch((err) => {
      console.warn(`[qa] session dispose failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

// Independent reviewer invocation. Opens a SEPARATE qa-reviewer session (NOT a
// subagent of the generator) so the review is genuinely independent — the generator
// cannot influence the reviewer's verdict by controlling the prompt context. The
// orchestrator uses THIS verdict, not the generator's self-reported approval, when
// review is enabled.
export interface ReviewInput {
  diff: string;
  specs: string[]; // relative paths of the specs to review (under e2e/)
  mirrorDir: string;
  e2eRelDir: string;
  baseUrl?: string;
  intent?: CommitIntent;
  guidance?: string; // manual mode: the user instruction the tests must satisfy (the review objective)
  appName: string;
  mode: RunMode;
  target?: TestTarget; // "e2e" (default) or "code" — adjusts wording and spec paths
  // PROVEN learned rules (pre-rendered by the orchestrator) injected as extra reject-on-sight
  // criteria. This is objective ledger state, NOT the generator's reasoning, so the reviewer's
  // independence is preserved while the judge gains app-specific anti-patterns earned from failures.
  learnedRules?: string;
}

export interface ReviewResult {
  approved: boolean;
  corrections: string[];
  // The reviewer's short reasoning for the verdict — captured on APPROVE and reject so a
  // wrong auto-merge is auditable after the fact. Optional (older verdicts / parse misses
  // omit it). Persisted on RunOutcome.gateSignals.reviewerRationale.
  rationale?: string;
  // false ONLY when NO verdict JSON could be parsed (a parse miss, not a real rejection).
  // Absent/true ⇒ a genuine verdict. Lets the caller avoid burning a regeneration round on
  // non-actionable feedback, and distinguish "reviewer is broken" from "tests rejected".
  parsed?: boolean;
}

// The reviewer is a bounded, read-only judge (10 steps, contents inlined in the prompt) —
// it must never inherit the generator's 25-minute worst-case budget: a hung reviewer would
// add that whole window to the run before the loop fails closed.
const REVIEWER_TIMEOUT_MS = Number(process.env.OPENCODE_REVIEWER_TIMEOUT_MS) || 6 * 60 * 1000;
// The explorer is a cheap read-only PRE-pass; cap it well below the generator/diff budget so a hung
// explorer cannot hold the sequential queue for the full window before the generator even starts.
const EXPLORER_TIMEOUT_MS = Number(process.env.OPENCODE_EXPLORER_TIMEOUT_MS) || 90 * 1000;

export async function reviewIndependently(
  input: ReviewInput,
  deps: AgentDeps,
  opts?: { signal?: AbortSignal },
): Promise<ReviewResult> {
  const session = await deps.open("qa-reviewer", input.mirrorDir, { signal: opts?.signal, timeoutMs: REVIEWER_TIMEOUT_MS });
  try {
    const changeType = input.intent?.type ?? input.mode;
    const specBlock = renderReviewSpecs(input);
    const kind = input.target === "code" ? "tests" : "E2E tests";
    // What these tests must defend — and how to name it — depends on the run mode. A diff run is
    // judged against the commit's changed code; a MANUAL run against the user's guidance; a
    // whole-repo (complete/exhaustive) run against each spec's own stated objective. Judging a
    // manual/whole-repo run against the commit diff is the [wrong-objective] bug: it rejects good
    // tests for "not testing the change" when the change was never the objective (e.g. a guided run
    // that happens to sit on an unrelated commit).
    const obj = reviewObjective(input);
    // Arm the judge with PROVEN app-specific rules (when present) as extra reject criteria.
    const rulesBlock = input.learnedRules ? [``, input.learnedRules] : [];
    const rulesInstruction = input.learnedRules
      ? [`5. Also REJECT if any spec violates an app-specific reject-on-sight rule listed above.`]
      : [];
    const prompt = [
      `## Independent review — judge these ${kind} WITHOUT the generator's reasoning`,
      ``,
      `You are reviewing tests written for ${obj.subject}, but you have NO access to the`,
      `generator's thought process. Judge the tests on their own merit using the`,
      `test-value-review skill.`,
      ``,
      `## Review context`,
      `- Run type: ${changeType}`,
      `- Base URL: ${input.baseUrl ?? "(not provided)"}`,
      ``,
      obj.heading,
      ...obj.body,
      ``,
      specBlock,
      ...rulesBlock,
      ``,
      `## Instructions`,
      `1. The spec contents are provided above — no need to read files.`,
      `2. Apply the test-value-review skill from BOTH perspectives (value + robustness).`,
      `3. Answer: could ${obj.targetNoun} be BROKEN and these tests STILL be green?`,
      `4. Be strict — a single anti-pattern in any spec means rejection.`,
      ...rulesInstruction,
      ``,
      `Output your verdict as JSON with no text before or after. Always include a one or two`,
      `sentence "rationale" explaining the verdict — on APPROVAL too (why these tests genuinely`,
      `defend ${obj.targetNoun}), not only on rejection.`,
      `Prefix EVERY correction with exactly one class tag from this closed list so the failure`,
      `is machine-classifiable: [false-positive] (asserts nothing / passes when the feature is`,
      `broken), [wrong-objective] (does not test ${obj.targetNoun}), [fragile-selector] (ambiguous or`,
      `brittle locator), [no-cleanup] (leaves test data behind), or [other].`,
      `{"approved":false,"rationale":"why, in 1-2 sentences","corrections":["[fragile-selector] file.spec.ts: specific actionable fix"]}`,
    ].join("\n");

    let output = await session.prompt(prompt);
    let v = parseReviewerVerdict(output);
    // The reviewer is the AUTHORITATIVE gate, so a formatting slip must not silently become a
    // fail-closed rejection (which would burn a regeneration round on non-actionable feedback).
    // Re-prompt ONCE with the specific issues; bounded so a broken reviewer cannot stall (the
    // repair reuses REVIEWER_TIMEOUT_MS, so worst case it is spent twice — error path only).
    if (!v.valid) {
      console.warn(`[qa] reviewer verdict failed the typed contract (${v.issues.join("; ")}); requesting one repair.`);
      output = await session.prompt(repairInstruction("reviewer", v.issues));
      v = parseReviewerVerdict(output);
    }
    if (v.parsed && v.valid) {
      return {
        approved: v.approved,
        corrections: v.corrections,
        ...(v.rationale ? { rationale: v.rationale } : {}),
        parsed: true,
      };
    }
    // Still unusable after one repair. Fail-closed direction (no false green), flagged as a
    // PARSE MISS so the caller does not mistake it for an actionable rejection.
    return { approved: false, corrections: ["the independent reviewer produced no parseable verdict"], parsed: false };
  } finally {
    await session.dispose().catch((err) => {
      console.warn(`[qa] reviewer session dispose failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

// The "what must these tests defend?" framing for the independent review, per run mode. Diff runs
// judge against the commit's changed code; MANUAL runs against the user's guidance; whole-repo
// (complete/exhaustive) runs against each spec's own stated objective (there is no single commit).
// `targetNoun` flows into the question, the rationale ask, and the [wrong-objective] definition so
// the judge measures the spec against the RIGHT goal.
function reviewObjective(input: ReviewInput): { subject: string; heading: string; body: string[]; targetNoun: string } {
  if (input.mode === "manual") {
    const g = sanitizeText(((input.guidance ?? "").trim() || "(no guidance was provided)")).text;
    return {
      subject: "a guided (manual) run",
      heading: `## Objective — the requested behavior (judge against THIS, NOT any commit diff)`,
      body: [g],
      targetNoun: "the requested behavior",
    };
  }
  if (input.mode === "complete" || input.mode === "exhaustive") {
    return {
      subject: `a whole-repo ${input.mode} run`,
      heading: `## Objective — there is no single commit; judge each spec against its OWN stated objective`,
      body: [
        `Each spec declares the user flow it targets (in its header comment / the manifest). Judge`,
        `whether it meaningfully exercises that flow, or could the flow break while the test stays green.`,
      ],
      targetNoun: "the targeted user flow",
    };
  }
  // diff (and any commit-driven run): the commit's changed code is the objective.
  return {
    subject: "this commit",
    heading: `## Commit diff`,
    body: ["```diff", sanitizeText(input.diff).text, "```"],
    targetNoun: "the change",
  };
}

const REVIEW_SPECS_MAX_BYTES = 40_000;

function renderReviewSpecs(input: ReviewInput): string {
  // e2e specs are e2e/-relative; code-mode tests are repo-relative (e2eRelDir = "").
  const rel = (s: string) => (input.e2eRelDir ? `${input.e2eRelDir}/${s}` : s);
  const contents: string[] = [];
  let totalBytes = 0;
  for (const s of input.specs) {
    let content: string;
    try {
      content = readFileSync(join(input.mirrorDir, input.e2eRelDir, s), "utf8");
    } catch {
      contents.push(`### ${rel(s)}\n( could not read file — review skipped for this spec )`);
      continue;
    }
    const block = `### ${rel(s)}\n\`\`\`typescript\n${content}\n\`\`\``;
    totalBytes += Buffer.byteLength(block, "utf8");
    if (totalBytes > REVIEW_SPECS_MAX_BYTES) {
      // The review silently degrades from "judge inline content" (deterministic, what the
      // orchestrator placed in the prompt) to "agent reads the files itself" (a weaker,
      // agent-driven path). Surface that mode switch to the operator instead of hiding it.
      console.warn(
        `[qa] WARNING: the combined contents of ${input.specs.length} spec(s) exceed the ${REVIEW_SPECS_MAX_BYTES}-byte inline cap — ` +
          `the reviewer will read files itself instead of judging inlined contents (weaker determinism).`,
      );
      return `## Specs to review\n\n${input.specs.map((n, i) => `${i + 1}. ${rel(n)}`).join("\n")}\n\n( spec contents exceed ${REVIEW_SPECS_MAX_BYTES} bytes — read each file with the read tool )`;
    }
    contents.push(block);
  }
  return `## Specs to review (${contents.length} file(s) — contents provided inline)\n\n${contents.join("\n\n")}`;
}

// ── complete/exhaustive: two-phase plan → fan-out ────────────────────────────
//
// A single agent cannot analyze a whole repo AND author every spec within one context window
// and step budget. So complete/exhaustive run in two phases (runOpencodeParallel):
//   1. PLAN  — one qa-generator (strong model) builds the coverage/importance map, persists
//              analysis.json, and returns a STRUCTURED list of objectives (no specs yet).
//   2. FAN-OUT — the orchestrator dispatches each objective to a SEPARATE qa-worker (cheap
//              flash model) that writes exactly ONE spec, with surgical per-flow context.
// The orchestrator then writes the manifest deterministically (workers never touch it → no
// concurrent-write race), and the normal Filter B/C run over all the specs.

export interface PlanObjective {
  flow: string; // user flow → spec filename + manifest id
  objective: string; // concrete acceptance criterion (given/when/then)
  symbols: string[]; // code symbols the spec should exercise (serena blast radius)
  needsUi: boolean; // true when the flow involves page navigation or DOM interaction
  brief?: ExplorationBrief; // Fase 2: distilled blast radius so the worker need not re-explore the code (optional → back-compat)
}

// Parse the planner's output: the LAST balanced object carrying an `objectives` array. Each
// objective needs at least a flow + objective; symbols are optional. Malformed entries are dropped.
export function parsePlan(text: string): PlanObjective[] {
  const o = lastJsonMatching(text, (x) => Array.isArray((x as Record<string, unknown>).objectives));
  if (!o) return [];
  const raw = (o.objectives as unknown[]) ?? [];
  const out: PlanObjective[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const r = item as Record<string, unknown>;
    const flow = typeof r.flow === "string" ? r.flow.trim() : "";
    const objective = typeof r.objective === "string" ? r.objective.trim() : "";
    if (!flow || !objective) continue;
    const coerced = coerceExplorationBrief(r.brief);
    // An empty blast radius is not a usable brief — drop it so the worker is not told to trust a brief
    // that maps nothing (and symbols fall back to []).
    const brief = coerced && coerced.blastRadius.length > 0 ? coerced : undefined;
    const symbols = Array.isArray(r.symbols)
      ? r.symbols.filter((s): s is string => typeof s === "string")
      : brief
        ? brief.blastRadius.map((n) => n.symbol) // coerce guarantees each symbol is non-empty
        : [];
    const needsUi = typeof r.needsUi === "boolean" ? r.needsUi : true; // default true: safe fallback
    out.push({ flow, objective, symbols, needsUi, ...(brief ? { brief } : {}) });
  }
  // De-duplicate by the RESULTING spec filename, so two distinct flow strings that normalize to
  // the same file (e.g. "Check Out" and "check-out") never have two workers write the same file.
  const seen = new Set<string>();
  return out.filter((o) => {
    const key = specFileForFlow(o.flow);
    return seen.has(key) ? false : (seen.add(key), true);
  });
}


interface ManifestEntry {
  id: string;
  objective: string;
  flow: string;
  targets: string[];
  changeRef: { sha: string; type: string };
  sha256?: string; // content checksum, written by the single-agent path (see ManifestEntrySchema)
}

// Injected fs for the manifest (the orchestrator owns this file; tested with stubs).
export interface ManifestFs {
  read(path: string): string | null;
  write(path: string, content: string): void;
}
export const realManifestFs: ManifestFs = {
  read: (p) => {
    try {
      return existsSync(p) ? readFileSync(p, "utf8") : null;
    } catch {
      return null;
    }
  },
  write: (p, c) => {
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, c);
  },
};

// Compute SHA-256 checksum of a file for integrity verification.
export function sha256File(path: string): string | undefined {
  try {
    const data = readFileSync(path);
    return createHash("sha256").update(data).digest("hex");
  } catch {
    return undefined;
  }
}

// Upsert (by id) manifest entries for the worker-written specs. Pure given the fs; preserves
// unrelated existing entries and any measured fields already on an upserted entry.
export function upsertManifest(fs: ManifestFs, manifestPath: string, entries: ManifestEntry[]): void {
  if (entries.length === 0) return;
  let arr: Array<Record<string, unknown>> = [];
  const raw = fs.read(manifestPath);
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (Array.isArray(p)) arr = p;
    } catch {
      /* corrupt manifest → rebuild from the entries we have */
    }
  }
  const byId = new Map<string, Record<string, unknown>>();
  for (const e of arr) if (e && typeof e.id === "string") byId.set(e.id, e);
  for (const e of entries) byId.set(e.id, { ...byId.get(e.id), ...e });
  fs.write(manifestPath, JSON.stringify([...byId.values()], null, 2));
}

export interface ParallelWorkerInput {
  objective: string;
  flow: string;
  symbols: string[];
  needsUi: boolean; // selects qa-worker (with Playwright MCP) vs qa-worker-code (serena only)
  brief?: ExplorationBrief; // Fase 2: the distilled blast radius for this objective (rendered into the worker prompt)
  specFile: string; // orchestrator-assigned path under e2eRelDir (e.g. "flows/checkout.spec.ts")
  repo: string;
  mirrorDir: string;
  e2eRelDir: string;
  namespace: string;
  baseUrl?: string;
  appName: string;
  mode: RunMode;
  learnedRules?: string; // anti-pattern rules from past runs — injected so workers don't repeat them
  runId?: string; // set on fan-out so the worker's live activity routes + carries a workerId
}

// Dispatch each worker objective to a SEPARATE qa-worker session, bounded concurrency.
// Uses a racing pool: when one worker finishes the next starts immediately — no batch
// blocked by the slowest member. Selects qa-worker-code (serena only, no Playwright MCP)
// for objectives that don't need UI navigation, reducing DEV pressure and browser overhead.
export async function generateParallel(
  workers: ParallelWorkerInput[],
  deps: AgentDeps,
  opts?: { signal?: AbortSignal; concurrency?: number },
): Promise<{ results: Array<{ flow: string; spec: string }>; errors: string[] }> {
  if (workers.length === 0) return { results: [], errors: [] };
  const concurrency = opts?.concurrency ?? Math.min(workers.length, 5);
  const results: Array<{ flow: string; spec: string }> = [];
  const errors: string[] = [];

  const runOne = async (w: ParallelWorkerInput) => {
    try {
      const agent = w.needsUi ? "qa-worker" : "qa-worker-code";
      const session = await deps.open(agent, w.mirrorDir, { signal: opts?.signal });
      if (w.runId) registerRunSession(session.id, w.runId, w.mirrorDir, w.flow);
      try {
        const output = await session.prompt(buildWorkerPrompt(w));
        const json = lastJsonMatching(output, (x) => typeof x.spec === "string");
        if (json?.spec) results.push({ flow: w.flow, spec: json.spec as string });
        else errors.push(`${w.flow}: worker produced no parseable spec name`);
      } finally {
        if (w.runId) unregisterRunSession(session.id);
        await session.dispose().catch(() => {});
      }
    } catch (err) {
      errors.push(`${w.flow}: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const inflight = new Set<Promise<void>>();
  for (const w of workers) {
    const p = runOne(w);
    const tracker = p.then(() => { inflight.delete(tracker); });
    inflight.add(tracker);
    if (inflight.size >= concurrency) await Promise.race(inflight);
  }
  await Promise.all(inflight);
  return { results, errors };
}


// The single routing decision between the single-agent path (runOpencode) and the
// plan→workers fan-out (runOpencodeParallel). Re-generation passes (fix/review/coverage)
// are always single-agent: they carry feedback context the worker prompts cannot hold.
export function shouldFanOut(input: {
  target?: TestTarget;
  mode: RunMode;
  parallelDiff?: boolean;
  fixCases?: QaCase[];
  reviewCorrections?: string[];
  coverageGap?: string;
}): boolean {
  if ((input.target ?? "e2e") !== "e2e") return false;
  if (input.fixCases?.length || input.reviewCorrections?.length || input.coverageGap) return false;
  if (input.mode === "complete" || input.mode === "exhaustive") return true;
  return input.mode === "diff" && input.parallelDiff === true;
}

// Two-phase complete/exhaustive entry point (see the block comment above). Returns an AgentResult
// shaped like runOpencode's, so the pipeline reviews/validates/executes it identically.
export async function runOpencodeParallel(
  input: OpencodeRunInput,
  deps: AgentDeps,
  opts?: { signal?: AbortSignal; onProgress?: (msg: string) => void; concurrency?: number },
  fs: ManifestFs = realManifestFs,
): Promise<AgentResult> {
  const timeoutMs = agentTimeout(input.mode);

  // Phase 1 — PLAN (strong model). Heartbeat while it analyses the whole repo.
  const planSession = await deps.open("qa-generator", input.mirrorDir, { signal: opts?.signal, timeoutMs });
  if (input.runId) registerRunSession(planSession.id, input.runId, input.mirrorDir);
  const startedAt = Date.now();
  const heartbeat = opts?.onProgress
    ? setInterval(() => opts.onProgress?.(`[qa] planner is analysing the repo... (${Math.round((Date.now() - startedAt) / 1000)}s elapsed)`), 15_000)
    : undefined;
  let planText: string;
  try {
    planText = await planSession.prompt(buildPlanPrompt(input));
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (input.runId) unregisterRunSession(planSession.id);
    await planSession.dispose().catch(() => {});
  }

  const objectives = parsePlan(planText);
  opts?.onProgress?.(`[qa] plan: ${objectives.length} objective(s) to generate`);
  if (objectives.length === 0) {
    // A valid no-op: nothing important is uncovered (honored as `skipped` upstream).
    return { output: planText, specs: [], reviewed: false, approved: true, note: "planner found no important uncovered flows" };
  }

  // A diff plan with a single objective gains nothing from fan-out and would LOSE the
  // single-agent prompt's full context (diff, fix/review blocks). Fall back.
  if (input.mode === "diff" && objectives.length < 2) {
    opts?.onProgress?.(`[qa] plan: ${objectives.length} objective(s) — falling back to the single-agent path`);
    // The planner already explored the repo (and may have distilled a brief for the single objective).
    // Reuse that brief and DISABLE the explorer pass so the fallback does not re-explore from scratch.
    const plannedBrief = objectives[0]?.brief;
    return runOpencode({ ...input, explorer: false, ...(plannedBrief ? { contextBrief: plannedBrief } : {}) }, deps, opts);
  }

  // Pre-index Serena so every worker inherits a warm index instead of paying
  // activate_project from scratch (15-60s each). On by default for fan-out runs
  // (best-effort, 120s cap); opt out with PRE_INDEX_SERENA=0.
  if (process.env.PRE_INDEX_SERENA !== "0") {
    opts?.onProgress?.(`[qa] pre-indexing serena for ${objectives.length} workers...`);
    try {
      const idxSession = await deps.open("qa-worker-code", input.mirrorDir, { timeoutMs: 120_000 });
      try {
        await idxSession.prompt("Activate serena (activate_project) on the current directory. Do nothing else. End with {\"spec\":\"\"}.");
      } finally {
        await idxSession.dispose().catch(() => {});
      }
    } catch {
      // Best-effort: if pre-indexing fails, workers will each activate serena themselves
    }
  }

  // Phase 2 — FAN-OUT to workers (one spec each).
  const changeType = input.intent?.type ?? input.mode;
  const workers: ParallelWorkerInput[] = objectives.map((o) => ({
    objective: o.objective,
    flow: o.flow,
    symbols: o.symbols,
    needsUi: o.needsUi,
    ...(o.brief ? { brief: o.brief } : {}),
    specFile: specFileForFlow(o.flow),
    repo: input.repo,
    mirrorDir: input.mirrorDir,
    e2eRelDir: input.e2eRelDir,
    namespace: input.namespace,
    baseUrl: input.baseUrl,
    appName: input.appName,
    mode: input.mode,
    learnedRules: input.learnedRules,
    runId: input.runId,
  }));
  const { results, errors } = await generateParallel(workers, deps, { signal: opts?.signal, concurrency: opts?.concurrency });
  opts?.onProgress?.(`[qa] workers: ${results.length} spec(s) written, ${errors.length} error(s)`);
  if (errors.length > 0) {
    // A failed worker means a PLANNED flow is silently absent from the suite. Surface it loudly
    // (not only buried in the result note): when review is off, the run can otherwise report
    // approved over a partial suite, so the missing coverage must be visible to the operator.
    const writtenFlows = new Set(results.map((r) => r.flow));
    const failedFlows = objectives.filter((o) => !writtenFlows.has(o.flow)).map((o) => o.flow);
    console.warn(`[qa] WARNING: ${errors.length} worker(s) failed — these planned flows are NOT in the suite: ${failedFlows.join(", ") || "(unknown)"}. ${errors.join("; ")}`);
  }

  // Phase 3 — CONSOLIDATE: the orchestrator writes the manifest from the plan (no worker race).
  const written = new Set(results.map((r) => r.flow));
  const entries: ManifestEntry[] = objectives
    .filter((o) => written.has(o.flow))
    .map((o) => ({ id: o.flow, objective: o.objective, flow: o.flow, targets: o.symbols, changeRef: { sha: input.sha, type: changeType } }));
  upsertManifest(fs, join(input.mirrorDir, input.e2eRelDir, ".qa", "manifest.json"), entries);

  const specs = results.map((r) => r.spec);
  return {
    output: planText,
    specs,
    specMetas: entries.map((e) => ({
      file: specFileForFlow(e.flow),
      flow: e.flow,
      objective: e.objective,
      targets: e.targets,
    })),
    reviewed: false,
    approved: specs.length > 0, // overridden by the orchestrator's independent reviewer when enabled
    note: errors.length ? `worker errors: ${errors.join("; ")}` : undefined,
  };
}

// Timeout wrapper for a promise: rejects if it elapses. Prevents a hung agent run
// from blocking the (sequential) queue, which would block every repo. The caller can
// supply an Error constructor so the timeout is typed (e.g. AgentUnavailableError /
// InfraError) instead of a generic Error that downstream would classify as a crash.
export function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  label: string,
  ErrorClass: new (message: string) => Error = Error,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new ErrorClass(`${label}: timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

const TIMEOUT_BY_MODE: Record<RunMode, number> = {
  diff: 5 * 60 * 1000,
  complete: 15 * 60 * 1000,
  exhaustive: 25 * 60 * 1000,
  manual: 10 * 60 * 1000,
  context: 10 * 60 * 1000,
};

export function agentTimeout(mode: RunMode): number {
  return Number(process.env.OPENCODE_TIMEOUT_MS) || TIMEOUT_BY_MODE[mode];
}

const MAX_AGENT_TIMEOUT_MS = Math.max(...Object.values(TIMEOUT_BY_MODE));

// Integration boundary: real connection to `opencode serve`. Not covered by unit
// tests (like the Playwright runner). The SDK is imported lazily so tests do not
// require the package. OPENCODE_SERVE_URL points to the `opencode` container.
export async function defaultAgentDeps(): Promise<AgentDeps> {
  // The undici transport timeout must exceed EVERY per-prompt withTimeout, or it aborts the
  // request before our own deadline fires. The reviewer has its OWN budget (REVIEWER_TIMEOUT_MS,
  // 6 min) that is independent of the generator's; if an operator sets a small OPENCODE_TIMEOUT_MS
  // it must NOT drag the transport below the reviewer's budget. Take the max of all of them + headroom.
  const generatorMax = Number(process.env.OPENCODE_TIMEOUT_MS) || MAX_AGENT_TIMEOUT_MS;
  const dispatcherTimeoutMs = Math.max(generatorMax, REVIEWER_TIMEOUT_MS) + 30_000;
  await installHttpDispatcher(dispatcherTimeoutMs);

  const client = await getSharedClient();

  return {
    // `directory` (query) positions the session in the repo working copy: the
    // agent reads/writes there. The working copy is a volume shared with the
    // `opencode` container, so the path is valid on both sides.
    open: async (agent, cwd, opts) => {
      const created = await client.session.create({ query: { directory: cwd } });
      if (created.error) throw new Error(`OpenCode session.create failed: ${JSON.stringify(created.error)}`);
      const id = created.data?.id;
      if (!id) throw new Error("OpenCode: the session returned no id");
      const entry: SessionEntry = { id, agent, cwd, openedAt: Date.now() };
      sessionRegistry.set(id, entry);

      // Wire external abort signal (cancel endpoint) to run interruption + session deletion.
      // session.delete alone does NOT stop a running turn server-side; abort interrupts the
      // in-flight run so a cancel actually frees the model/session compute, then we dispose.
      const onAbort = () => {
        client.session.abort({ path: { id } }).catch(() => {});
        client.session.delete({ path: { id } }).catch(() => {});
      };
      opts?.signal?.addEventListener("abort", onAbort, { once: true });

      const promptTimeoutMs = opts?.timeoutMs ?? dispatcherTimeoutMs;

      // Interrupt the in-flight run on the OpenCode server. withTimeout only rejects the
      // orchestrator's await; without this, a wedged agent turn keeps running (holding a
      // session, burning model tokens) until its natural end or the 30-min orphan sweep.
      const abortRun = () => client.session.abort({ path: { id } }).catch(() => {});

      return {
        id,
        prompt: (text, promptOpts) =>
          withTimeout(
            (() => {
              checkCircuit();
              const runPrompt = (modelOverride?: string) => {
                const overrideModel = modelOverride ? parseModelRef(modelOverride) : undefined;
                return client.session
                  .prompt({
                    path: { id },
                    query: { directory: cwd },
                    body: { agent, parts: [{ type: "text", text }], ...(overrideModel ? { model: overrideModel } : {}) },
                  })
                  .then((res) => {
                    if (res.error) {
                      recordCircuitFailure();
                      throw new Error(`OpenCode session.prompt failed: ${JSON.stringify(res.error)}`);
                    }
                    // ROOT-CAUSE FIX: a provider/agent fault (out of credits, auth, rate-limit,
                    // output-length) is embedded in the assistant message (info.error), NOT in
                    // res.error. extractText only reads text parts, so without this the fault
                    // degrades into an EMPTY response that downstream misreads as a code verdict
                    // (`invalid`/`fail`) — an out-of-credits run then blamed the operator's tests.
                    // Detect it at the source and throw it as a typed infra error.
                    const agentErr = (res.data?.info as { error?: AgentErrorPayload } | undefined)?.error;
                    if (agentErr) {
                      recordCircuitFailure();
                      throw agentErrorToInfra(agentErr);
                    }
                    recordCircuitSuccess();
                    return extractText(res.data?.parts, promptOpts);
                  })
                  .catch((err) => {
                    recordCircuitFailure();
                    throw err;
                  });
              };
              return runPrompt(opts?.model).catch((err) => {
                const fallback = getFallbackModel(agent);
                if (fallback) {
                  console.warn(`[qa] primary model failed for ${agent}, retrying with fallback ${fallback}: ${err instanceof Error ? err.message : String(err)}`);
                  return runPrompt(fallback);
                }
                throw err;
              });
            })(),
            promptTimeoutMs,
            "OpenCode prompt",
            AgentUnavailableError,
          ).catch((err: unknown) => {
            // On timeout (or any failure that left work in flight), interrupt the server run
            // so it stops consuming compute after the orchestrator has already given up.
            abortRun();
            throw err;
          }),
        dispose: async () => {
          try {
            await client.session.delete({ path: { id } });
          } catch (err) {
            console.warn(`[qa] session ${id} dispose failed: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            opts?.signal?.removeEventListener("abort", onAbort);
            sessionRegistry.delete(id);
          }
        },
      };
    },
    cleanupOrphans: async (maxAgeMs: number) => {
      const now = Date.now();
      let cleaned = 0;
      for (const [id, entry] of sessionRegistry) {
        if (now - entry.openedAt > maxAgeMs) {
          try {
            await client.session.delete({ path: { id } });
          } catch (err) {
            console.warn(`[qa] orphan cleanup failed for session ${id}: ${err instanceof Error ? err.message : String(err)}`);
          }
          sessionRegistry.delete(id);
          cleaned++;
        }
      }
      return cleaned;
    },
  };
}

// Minimal shape of an OpenCode AssistantMessage.error (res.data.info.error). A provider/agent
// fault is embedded HERE, NOT in the HTTP-level res.error — which is exactly why an out-of-credits
// run slipped past the old res.error-only check and degraded into an empty response.
type AgentErrorPayload = { name: string; data?: { message?: string; statusCode?: number; providerID?: string } };

// ROOT-CAUSE classifier: map an embedded agent/provider fault to a typed, actionable
// AgentUnavailableError (an InfraError) so the run surfaces as `infra-error` with a clear operator
// message — never a code verdict (`invalid`/`fail`) that blames the user's tests. Exported so the
// classification is unit-tested without standing up the SDK.
export function agentErrorToInfra(error: AgentErrorPayload): AgentUnavailableError {
  const d = error.data ?? {};
  const detail = d.message ? `: ${d.message}` : "";
  const tail = "INCONCLUSIVE (infrastructure), not a test failure";
  switch (error.name) {
    case "ProviderAuthError":
      return new AgentUnavailableError(
        `OpenCode provider '${d.providerID ?? "?"}' rejected the request (auth / out of credits)${detail}. ` +
          `${tail} — check OPENCODE_API_KEY and your OpenCode credit balance.`,
      );
    case "APIError": {
      const code = d.statusCode ? ` ${d.statusCode}` : "";
      const hint =
        d.statusCode === 429 ? " — rate-limited, retry later" :
        d.statusCode === 402 ? " — out of credits / billing" :
        d.statusCode === 401 || d.statusCode === 403 ? " — auth (check OPENCODE_API_KEY)" :
        "";
      return new AgentUnavailableError(`OpenCode API error${code}${detail}${hint}. ${tail}.`);
    }
    case "MessageOutputLengthError":
      return new AgentUnavailableError(`the model hit its output-length limit before finishing the turn. ${tail}.`);
    case "MessageAbortedError":
      return new AgentUnavailableError(`the agent turn was aborted${detail}. ${tail}.`);
    default: // UnknownError, or any future variant
      return new AgentUnavailableError(`OpenCode agent error (${error.name})${detail}. ${tail}.`);
  }
}

// textOf reads the string `text` field of a response part (empty when absent).
function textOf(p: { type: string }): string {
  const text = (p as { text?: unknown }).text;
  return typeof text === "string" ? text : "";
}

// Strips reasoning wrappers a model may inline in a text part (<think>…</think> etc.) —
// used only on the textOnly fallback path, so a leaked chain-of-thought is removed.
function stripReasoningWrappers(s: string): string {
  return s.replace(/<(think|thought|reasoning)>[\s\S]*?<\/\1>/gi, "").trim();
}

// Concatenates the text of the text parts in the agent's response.
function extractText(parts: Array<{ type: string }> | undefined, opts?: { textOnly?: boolean }): string {
  const all = parts ?? [];
  // Default: concatenate the text of EVERY part that carries a string `text` field, not
  // only type === "text". A model can emit its closing verdict in a reasoning/other
  // text-bearing part; restricting to "text" silently dropped it, so the JSON verdict
  // extractor saw an empty string and the run failed closed. The downstream
  // lastJsonMatching picks the LAST valid JSON, so any extra prose concatenated here is
  // harmless for the generator/reviewer.
  if (!opts?.textOnly) {
    return all.map(textOf).join("");
  }
  // textOnly: keep ONLY the final answer (type === "text"), excluding reasoning parts —
  // the assistant returns its text verbatim to the operator, so a concatenated
  // chain-of-thought would leak into the chat. If the model emitted NO plain text part
  // (unusual), fall back to the full content with reasoning wrappers stripped rather than
  // returning a blank answer (never swallow into an empty result).
  const textOnly = all.filter((p) => p.type === "text").map(textOf).join("");
  if (textOnly.trim() !== "") return textOnly;
  return stripReasoningWrappers(all.map(textOf).join(""));
}
