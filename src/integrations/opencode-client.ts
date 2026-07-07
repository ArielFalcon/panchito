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
import { AgentResult, QaCase, RunMode, TestTarget, SpecMeta, ActivityKind, PLANNER_OBJECTIVE } from "../types";
import type { UsageSnapshot } from "../qa/usage";
import { CommitIntent } from "../qa/commit-classify";
import type { ArchitectureContext } from "../qa/context";
import { coerceExplorationBrief, parseExplorationBrief, type ExplorationBrief } from "../qa/exploration-brief";
import { normalizeRoutes, MAX_ROUTES } from "../qa/dom-snapshot";
import { sanitizeText } from "../orchestrator/sanitizer";
import { ActivityRouter } from "./agent-activity";
import { mapOpencodeEvent, eventRunId } from "./activity-mapper";
import { reexploreKindFromEvent, reexploreTracker } from "./reexplore";
import type { RunEventBody } from "../contract/events";
import { appendLog, saveAgentTurn } from "../server/history";
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
// Phase 1b: also re-exports the assembled variants (return AssembledPrompt) and the Section type
// so callers that need sectionSizes for telemetry can import directly from this module.
import { specFileForFlow, buildWorkerPrompt, buildWorkerPromptAssembled, buildPlanPrompt, buildPlanPromptAssembled, buildPrompt, buildPromptAssembled, buildExplorerPrompt, buildContextTask, renderArchitectureContext, buildReviewerPrompt, buildReviewerPromptAssembled, reviewObjective, renderReviewSpecs, renderExecutionResult } from "./prompts";
export { specFileForFlow, buildWorkerPrompt, buildWorkerPromptAssembled, buildPlanPrompt, buildPlanPromptAssembled, buildPrompt, buildPromptAssembled, buildExplorerPrompt, buildContextTask, renderArchitectureContext, buildReviewerPrompt, buildReviewerPromptAssembled, reviewObjective, renderReviewSpecs, renderExecutionResult };
export type { AssembledPrompt, ExecutionResultCase } from "./prompts";
// Typed verdict contract + bounded repair (post-ADR-001, Phase 1 / 3.1). Schema validation of
// the agent's generator + reviewer output, and the targeted re-prompt used on a contract miss.
import { checkGeneratorVerdict, repairInstruction, parseReviewerVerdict } from "./verdict-validate";
import { ManifestEntrySchema } from "../orchestrator/schemas";
import { AgentUnavailableError, StalledAgentError, isInfraError } from "../errors";
import { createStallWatchdog } from "./stall-watchdog";
import type { StallWatchdog } from "./stall-watchdog";

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

// Per-session liveness registry. withStallWatchdog registers a notify() callback keyed by
// session ID; the SSE event loop calls notifySessionActivity(sessionId) on every event that
// carries a sessionID so the watchdog can reset its timer. This is the only coupling between
// the event stream (observability) and the watchdog (resilience) — single-direction, zero
// verdict risk, and advisory-safe: a missed notify is a watchdog miss, not a data loss.
const sessionWatchdogNotifiers = new Map<string, () => void>();

/** Called by withStallWatchdog when a session opens. Not part of the public API surface. */
export function registerSessionWatchdogNotify(sessionId: string, notify: () => void): void {
  sessionWatchdogNotifiers.set(sessionId, notify);
}

/** Called by withStallWatchdog when a session is disposed or the watchdog stops. */
export function unregisterSessionWatchdogNotify(sessionId: string): void {
  sessionWatchdogNotifiers.delete(sessionId);
}

/** Notify the watchdog for a session (called from the SSE event loop on each activity). */
export function notifySessionActivity(sessionId: string): void {
  sessionWatchdogNotifiers.get(sessionId)?.();
}

// Maps an OpenCode session to a run so SSE events are routed to the correct RunRecord.
export function registerRunSession(sessionId: string, runId: string, directory: string, workerId?: string): void {
  activityRouter.register(sessionId, runId, workerId);
  eventStreams.attach(sessionId, directory);
}

export function unregisterRunSession(sessionId: string): void {
  activityRouter.unregister(sessionId);
  eventStreams.detach(sessionId);
  reexploreTracker.clear(sessionId); // RE-2: free the per-session counts (read before this call).
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

      // RE-2: count re-exploration tool calls (browser_navigate/snapshot, serena) from the RAW
      // `part.tool` — before mapOpencodeEvent collapses every tool into a 4-value `kind`. Keyed by
      // session so each generation cycle gets its own counts. Observability only.
      const reexKind = reexploreKindFromEvent(raw);
      // Extract part.sessionID once for both reexplore tracking and the liveness watchdog.
      const rawPart = raw.properties?.part as { sessionID?: string; callID?: string } | undefined;
      if (reexKind && rawPart?.sessionID) {
        // Pass callID so the tracker dedups re-streamed updates for one tool call (a part emits many).
        reexploreTracker.record(rawPart.sessionID, reexKind, rawPart.callID);
      }
      // Notify the liveness watchdog for this session: any event proves the agent is alive.
      // Advisory-only: if the sessionID is not in the registry (no watchdog) this is a no-op.
      if (rawPart?.sessionID) notifySessionActivity(rawPart.sessionID);

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
  // Phase 0b: `runId` threads the parent run's identity into the session descriptor so telemetry
  // records which run triggered a reflection/audit-diagnosis; undefined when no run context exists.
  input: { context: string; question: string; instruction?: string; agent?: string; runId?: string },
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
  const role = input.agent ?? "qa-assistant";
  // Phase 0b: thread the role into the descriptor; runId is forwarded when the caller has one
  // (reflectAndDistill / audit-diagnosis paths) so telemetry can correlate the session to a run.
  const session = await deps.open(role, cwd, {
    descriptor: { role, runId: input.runId },
  });
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
  // WS7.4 (full-flow remediation): classifyCommit's own explanation of its action decision, and
  // whether the message contradicted the diff (an escalated commit) — mirrors intent's own
  // "diff mode only, sourced from classifyCommit()" contract. Rendered as one line each in the
  // task section (buildTask, src/integrations/prompts.ts) when present.
  classificationReason?: string;
  contradiction?: boolean;
  guidance?: string; // manual mode: user instructions
  openapi?: string | string[]; // optional hint (from app config): where the repo's OpenAPI contract(s) live
  fixCases?: QaCase[]; // re-generation: failed cases from a previous execution to fix
  reviewCorrections?: string[]; // re-generation: actionable corrections from a reviewer rejection
  coverageGap?: string; // re-generation: changed lines not yet exercised (change-coverage gap)
  // Lever-2 deterministic selector contradictions for the fix prompt (W1): each string is a verified
  // absent/ambiguous finding against the captured failure-point tree ("role:name is NOT in the tree;
  // present roles: …" or "matches MULTIPLE nodes …"). Rendered as its OWN un-truncated prompt section
  // (NEVER folded into the 500-char-sliced fixCases detail, where verbose PW errors would cut it off).
  selectorContradictions?: string[];
  learnedRules?: string; // retrieval: rules from past runs injected into the agent prompt
  domSnapshot?: string; // live DEV a11y snapshot of the target routes — grounds the GENERATOR's selectors
  failureSourced?: boolean; // true when domSnapshot is the failure-point capture — switches to "GROUND TRUTH AT FAILURE" framing
  runId?: string; // maps the session to a RunRecord for SSE live activity
  contextMap?: ArchitectureContext; // cross-cutting: the FE↔BE map, injected by the orchestrator
  explorer?: boolean; // Fase 3: run a read-only explorer pass before the generator (diff single-agent, opt-in)
  contextBrief?: ExplorationBrief; // the distilled blast radius from the explorer pass (set internally → buildPrompt)
  // Slice G: the pre-built Context Pack text block (blast-radius + DOM slice + contracts),
  // assembled by the orchestrator BEFORE the first write and pushed into the VOLATILE band.
  // When present, the generator transcribes from this pack instead of re-exploring.
  // When absent, the explore-first mandate remains active (existing behaviour unchanged).
  contextPack?: string;
  // Static signal: deterministic pre-computed analysis rendered as a prompt section.
  // Empty string or absent = no section added. Signal-only, fail-open.
  staticSignal?: string;
  // C1: diff archetypes computed by detectStructuralPatterns (deterministic, from the commit diff).
  // Surfaces the structural shape of the change as a ONE-LINE hint to the generator so it can
  // prioritise archetype-appropriate tests (e.g. "auth-flow, data-list"). Absent or empty = no hint.
  diffArchetypes?: string[];
  // Seam b: deterministic list of existing spec file paths under e2eRelDir/**/*.spec.ts, enumerated
  // by the orchestrator from the filesystem before the session starts. When non-empty and mode is
  // diff or manual, rendered as an "existing-suite-manifest" semi-stable section so the generator
  // knows what flows are already covered without a serena delegation. Absent or empty = no section.
  existingSpecFiles?: string[];
  service?: { repo: string; mirrorDir: string; openapi?: string | string[] }; // cross-repo: the triggering microservice (read-only working copy)
  services?: Array<{ repo: string; mirrorDir: string; openapi?: string | string[] }>; // context mode: every declared service, mirrored read-only
  // Stitcher→Generation seam (design §0, §3.4 — NET-NEW): this file has no @contexts alias import
  // (verified against its own import block), so ServiceLink/ContractDrift are structurally MIRRORED
  // here (copied verbatim, the SAME "copied verbatim from src/" discipline generation-ports.ts
  // already applies to this whole interface, just mirrored in the other direction) rather than
  // imported. NOT a fix to a previously-dead field: the qa-engine mirror of OpencodeRunInput
  // (generation-ports.ts) already declares serviceLinks/contractDrift via a canonical import; this
  // legacy copy simply never had them until now.
  serviceLinks?: OcServiceLink[]; // deterministic cross-repo FE→BE links (advisory, from the stitcher)
  contractDrift?: OcContractDrift[]; // FE↔BE contract drift (advisory warnings)
  // Slice C (structural-signals-expansion, design §3.7): the advisory cross-repo impact narrowing —
  // mirrors serviceLinks/contractDrift's own "structurally mirrored, not imported" discipline
  // immediately above. Structured, not pre-rendered: prompts.ts extends the EXISTING
  // "Cross-service links" section with inline [IMPACTED:<tier>] markers, never a new subsection.
  crossRepoImpact?: { impactedLinks: Array<{ link: OcServiceLink; tier: string }> };
}

// Stitcher→Generation seam (design §3.4, NET-NEW structural mirrors): plain data, copied verbatim
// from service-topology's domain ServiceLink/ContractDrift shape — see OpencodeRunInput's own
// serviceLinks/contractDrift doc above for why this file mirrors rather than imports.
export interface OcServiceSymbolRef {
  repo: string;
  file: string;
  symbol: string;
}
export interface OcServiceLink {
  from: OcServiceSymbolRef;
  to: OcServiceSymbolRef;
  transport: "http" | "event" | "rpc";
  contractRef?: string;
  confidence: number;
  source: string;
}
export interface OcContractDrift {
  from: OcServiceSymbolRef;
  verb: string;
  path: string;
}

// A single agent prompt/response turn captured at the SDK funnel. Emitted via the
// `onTurn` callback on `open()` opts at the point where `onUsage` already fires.
// `outputText` is sanitized BEFORE persist (sanitizer.ts); `runId` is null when the
// session was opened without a descriptor (maintenance sessions, etc.).
// Phase 1b: `sectionSizes` carries the per-section byte map from the ContextAssembler
// when the prompt was assembled via one of the buildXxxAssembled() functions; null for
// prompts not produced by the assembler (contract-repair re-prompts, explorer, etc.).
export interface AgentTurnEvent {
  runId: string | null;
  sessionId: string;
  role: string;
  objective: string | undefined;
  round: number;
  isRepair: boolean;
  promptText: string;
  promptBytes: number;
  outputText: string;
  tokensInput: number | null;
  tokensOutput: number | null;
  tokensReasoning: number | null;
  tokensCacheRead: number | null;
  tokensCacheWrite: number | null;
  cost: number | null;
  ts: string;
  // Phase 1b: per-section size map from the ContextAssembler. Null when the prompt was not
  // assembled by one of the buildXxxAssembled() functions (repairs, explorer, etc.).
  sectionSizes: Record<string, number> | null;
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
  // round/isRepair are per-call opts so the funnel can distinguish generation rounds
  // from in-session contract-repair re-prompts when recording agent_turns rows.
  // Phase 1b: sectionSizes carries the per-section byte map from the ContextAssembler
  // when the prompt was produced by one of the buildXxxAssembled() functions. It flows
  // through the funnel into AgentTurnEvent so telemetry records it per turn.
  prompt(text: string, opts?: { textOnly?: boolean; round?: number; isRepair?: boolean; sectionSizes?: Record<string, number> | null }): Promise<string>;
  dispose(): Promise<void>;
  // selfTimed marks a session whose transport manages its own per-prompt timeout (e.g. Codex
  // exec-per-prompt, which never emits SSE activity). The stall watchdog SKIPS such sessions —
  // wrapping them would false-positive-kill any prompt slower than the stall threshold.
  selfTimed?: boolean;
}

// Session-scoped descriptor forwarded by every open() call-site that has a run context.
// `role` mirrors the existing `agent` arg (kept for consistency with the agent name).
// `runId`/`objective` are optional so inapplicable call-sites (maintainer, etc.) can
// leave them undefined without needing a type cast.
export interface AgentOpenDescriptor {
  runId?: string;
  role?: string;
  objective?: string;
}

export interface AgentDeps {
  open(
    agent: string,
    cwd: string,
    opts?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      model?: string;
      onUsage?: (u: UsageSnapshot) => void;
      onTurn?: (t: AgentTurnEvent) => void;
      // Session-scoped identity descriptor (threaded by call-sites that have a run context).
      descriptor?: AgentOpenDescriptor;
    },
  ): Promise<AgentSession>;
  cleanupOrphans?(maxAgeMs: number): Promise<number>;
}

// Runs the read-only explorer ONCE for a first-pass diff OR manual e2e generation when opted in,
// returning the distilled brief (or null to degrade silently). Gated tightly: never on code mode,
// never on a re-generation pass (fix/review/coverage already carry context), and only when
// input.explorer is set. (FIX 2: manual was previously excluded, so its Context Pack was empty.)
// Exported (Slice H) so the orchestrator (pipeline.ts) can call it BEFORE buildContextPack to wire
// the brief into the pack without a second explorer pass inside runOpencode (no-double-run guarantee).
export async function maybeExplore(
  input: OpencodeRunInput,
  deps: AgentDeps,
  opts?: { signal?: AbortSignal; onProgress?: (msg: string) => void },
): Promise<ExplorationBrief | null> {
  const isReGen = Boolean(input.fixCases?.length || input.reviewCorrections?.length || input.coverageGap);
  // FIX 2: manual mode shares the same engine as diff and benefits from blast-radius/route grounding
  // equally — the universal exploreForPack push must NOT no-op for manual. Allow diff AND manual here;
  // buildExplorerPrompt renders the guidance (not the empty diff) as the exploration objective for manual.
  if (!input.explorer || (input.mode !== "diff" && input.mode !== "manual") || input.target === "code" || isReGen) return null;
  let session: AgentSession | undefined;
  try {
    session = await deps.open("qa-explorer", input.mirrorDir, {
      signal: opts?.signal,
      timeoutMs: EXPLORER_TIMEOUT_MS,
      descriptor: { runId: input.runId, role: "qa-explorer" },
    });
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
  opts?: {
    signal?: AbortSignal;
    onProgress?: (msg: string) => void;
    // Phase 6a: called once when the generator fires an in-session contract-repair re-prompt,
    // so the shared cycle counter in pipeline.ts can account for in-session repairs without
    // polling the turn store. Optional — absent means repairs are not counted externally.
    onRepair?: () => void;
  },
): Promise<AgentResult> {
  const timeoutMs = agentTimeout(input.mode);
  // Fase 3: optional read-only explorer pass — distill the blast radius in an isolated session so the
  // generator gets a clean window. Best-effort: a failure/unparseable brief degrades to the generator
  // exploring inline (never fails the run).
  const explorerBrief = await maybeExplore(input, deps, opts);
  const effectiveInput = explorerBrief ? { ...input, contextBrief: explorerBrief } : input;
  const session = await deps.open("qa-generator", input.mirrorDir, {
    signal: opts?.signal,
    timeoutMs,
    // In manual mode intent.message is undefined; fall back to guidance so the turn attributes an
    // objective (parity with the reviewer descriptor in pipeline.ts: `opts.guidance ?? intent?.message`).
    descriptor: { runId: input.runId, role: "qa-generator", objective: input.guidance ?? input.intent?.message },
  });

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
    // Phase 1b: use the assembled variant so sectionSizes flows to the turn telemetry.
    const assembled = buildPromptAssembled(effectiveInput);
    let finalText = await session.prompt(assembled.text, { sectionSizes: assembled.sectionSizes });

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
      // Phase 6a: notify the shared cycle counter before the repair re-prompt fires.
      opts?.onRepair?.();
      // WS9.1: pass the prior response's tail so the repair prompt is self-contained — a
      // provider whose session does not remember the prior turn (Codex's exec-per-prompt
      // transport) can genuinely recover its own verdict instead of fabricating one. Harmless
      // for OpenCode (its server-side session already remembers the turn).
      finalText = await session.prompt(
        repairInstruction("generator", genCheck.issues, { priorResponseTail: finalText }),
        { isRepair: true },
      );
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

    // Option (c): the turn's browser NAVIGATION count (RE-2) — all tool calls are done now that the
    // prompt returned. We count `navigate` (one per route visit), NOT navigate+snapshot: the agent
    // pairs navigate→snapshot per route, so counting both would put 2 legitimate uncovered-route
    // visits over a small threshold and wrongly stop a progressing retry. Threaded to the fix-loop's
    // progress gate (heavy re-navigation that merely reshuffles failures = no progress). Read before
    // the `finally` clears the tracker.
    const reexCounts = reexploreTracker.snapshot(session.id);
    return {
      output: finalText,
      specs: verdict.specs,
      specMetas: verdict.specMetas,
      reviewed: input.needsReview,
      approved,
      note: approved ? undefined : verdict.note ?? "the reviewer did not approve the E2E tests",
      reexploreNavigations: reexCounts.navigate,
    };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    // RE-2: report this cycle's re-exploration tool usage (objective telemetry). Read BEFORE the
    // tracker is cleared. When the prompt carried grounding (Context Pack / DOM tree), a browser
    // navigate/snapshot is REDUNDANT — surface it so RE-1 non-compliance is visible in the logs.
    const reex = reexploreTracker.snapshot(session.id);
    if (reex.total > 0) {
      const grounded = Boolean(input.contextPack || input.domSnapshot);
      const browserCalls = reex.navigate + reex.snapshot;
      // Label the turn: a FIRST pass is EXPECTED to explore/read heavily; only a REGEN with high counts
      // is the re-exploration waste RE-1 targets. Without this the persisted counts are ambiguous.
      const turnKind =
        input.fixCases?.length || input.reviewCorrections?.length || input.coverageGap ? "regen" : "first-pass";
      // C5: when grounding was present a non-zero browser count is a SIGNAL, not a proven violation —
      // it is either RE-1 non-compliance OR a legitimately-uncovered route (the anti-blinding escape).
      // We cannot tell which without per-route coverage, so qualify it rather than alarm.
      const summary =
        `re-exploration this cycle (${turnKind}): ${reex.navigate} navigate, ${reex.snapshot} snapshot, ${reex.serena} serena` +
        (grounded && browserCalls > 0
          ? ` — ${browserCalls} browser call(s) WITH grounding present (expected ~0 after RE-1; non-zero = either non-compliance or an uncovered route)`
          : "");
      opts?.onProgress?.(`[qa] ${summary}`);
      // C4: persist durably to the run history so re-exploration can be compared across runs (the
      // plan's decision gate) instead of being lost in stderr. Best-effort — telemetry must not fail a run.
      if (input.runId) {
        try { appendLog(input.runId, `[telemetry] ${summary}`); } catch { /* advisory */ }
      }
    }
    reexploreTracker.clear(session.id);
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
  // A DETERMINISTIC snapshot of the live DEV DOM (roles + accessible names of the routes the spec
  // targets), captured by the ORCHESTRATOR — not the generator, so independence holds. It grounds
  // the reviewer's UI-fact claims (labels, button/link text) in reality instead of its training
  // memory of "similar apps", which is what made it hallucinate corrections (e.g. "the button says
  // Add Owner" when DEV says "Submit"). Absent for code mode / when capture is unavailable.
  domSnapshot?: string;
  // Phase 0b: threads the parent run's identity into the reviewer session so the resulting
  // agent_turns row carries a non-null run_id (previously always null for the reviewer).
  runId?: string;
  // Phase 0b: the human-readable description of what these tests are supposed to defend
  // (injected as the reviewer-session objective so telemetry can slice by intent).
  objective?: string;
  // Phase 4: the reviewer's OWN corrections from the PREVIOUS round. Injected so the
  // reviewer can judge convergence: approve once the previously-raised BLOCKING issues
  // are resolved; do not invent new nits on unchanged specs.
  priorCorrections?: string[];
  // D4/D5: runtime execution evidence rendered by renderExecutionResult (sanitized HTTP
  // statuses + final URLs captured via page.on('response') during Filter C). Injected as
  // an authoritative VOLATILE section so the reviewer can weigh an objective 5xx server
  // error before judging the test code. Absent when no execution has run yet (first-time
  // generate, code mode, cross-repo runs where browser coverage cannot map service lines).
  executionResult?: string;
}

export interface ReviewResult {
  approved: boolean;
  corrections: string[];
  // Phase 4: count of BLOCKING corrections (plain-string corrections without an explicit
  // severity are treated as blocking — fail-closed backward compat). The gate passes when
  // this is zero, regardless of advisory count. Absent means not yet populated (pre-Phase 4
  // or parse miss): callers treat absent as "all corrections are blocking" (fail-closed).
  blockingCount?: number;
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
// Exported (WS9.3): CodexRuntimeStrategy imports this so both providers share ONE per-role
// budget policy instead of Codex silently drifting from whatever this constant becomes.
export const REVIEWER_TIMEOUT_MS = Number(process.env.OPENCODE_REVIEWER_TIMEOUT_MS) || 6 * 60 * 1000;
// The explorer is a read-only PRE-pass; cap it well below the generator/diff budget so a hung
// explorer cannot hold the sequential queue for the full window before the generator even starts.
// 90s proved too tight on large microservice monorepos (petclinic): the read-only brief needs room
// to finish; 240s still sits far under the generator's 25-minute worst case.
// Exported (WS9.3): same cross-provider budget-sharing rationale as REVIEWER_TIMEOUT_MS above.
export const EXPLORER_TIMEOUT_MS = Number(process.env.OPENCODE_EXPLORER_TIMEOUT_MS) || 240 * 1000;
// The fan-out planner for a SCOPED mode (diff/manual — one commit or one guidance string) derives
// objectives from the brief + code; it must NOT navigate (F3), so it needs nowhere near the generator's
// per-mode budget. Bound it with its OWN deadline: it reads OPENCODE_PLANNER_TIMEOUT_MS, NOT the global
// OPENCODE_TIMEOUT_MS override (which, set to e.g. 900s, would otherwise let a misbehaving planner
// consume the generator's whole window — the hang that produced 0 specs). Applied to diff/manual
// REGARDLESS of whether the explorer brief arrived: a brief-less planner still only widens+plans a
// single scope, and reverting it to the 5–10 min generator budget would re-open the hang on exactly the
// monorepos this targets. Matched to EXPLORER_TIMEOUT_MS (240s) — the explorer does the comparable
// read+widen and needed that much on petclinic — and folded into the dispatcher Math.max below.
// complete/exhaustive (whole-repo analysis, no scope) keep the per-mode generator budget.
const PLANNER_TIMEOUT_MS = Number(process.env.OPENCODE_PLANNER_TIMEOUT_MS) || 240 * 1000;
// Cap on how many ungrounded objectives may take the SEQUENTIAL strong-agent recovery path before the
// run starts serializing. Beyond this, the overflow is dispatched to parallel blind workers instead, so
// a broad DOM-capture failure (e.g. every route soft-404s on a hash SPA) cannot stall the whole run.
const MAX_STRONG_FALLBACK = Number(process.env.OPENCODE_MAX_STRONG_FALLBACK) || 3;

export async function reviewIndependently(
  input: ReviewInput,
  deps: AgentDeps,
  opts?: {
    signal?: AbortSignal;
    // Phase 6a: called once when the reviewer fires an in-session contract-repair re-prompt,
    // so the shared cycle counter in pipeline.ts can account for in-session repairs without
    // polling the turn store. Optional — absent means repairs are not counted externally.
    onRepair?: () => void;
  },
): Promise<ReviewResult> {
  // Phase 0b: thread the parent run's identity so the reviewer's agent_turns row carries a
  // non-null run_id. The descriptor's `objective` echoes whatever the generator was defending
  // (guidance in manual mode, commit message in diff mode) for telemetry cross-slicing.
  const session = await deps.open("qa-reviewer", input.mirrorDir, {
    signal: opts?.signal,
    timeoutMs: REVIEWER_TIMEOUT_MS,
    descriptor: { runId: input.runId, role: "qa-reviewer", objective: input.objective },
  });
  try {
    // Phase 1a+1b: the initial prompt is built by the pure buildReviewerPromptAssembled() function.
    // The assembled variant carries sectionSizes for turn telemetry. The contract-repair re-prompt
    // and session lifecycle stay here (not extracted).
    const assembled = buildReviewerPromptAssembled(input);

    let output = await session.prompt(assembled.text, { sectionSizes: assembled.sectionSizes });
    let v = parseReviewerVerdict(output);
    // The reviewer is the AUTHORITATIVE gate, so a formatting slip must not silently become a
    // fail-closed rejection (which would burn a regeneration round on non-actionable feedback).
    // Re-prompt ONCE with the specific issues; bounded so a broken reviewer cannot stall (the
    // repair reuses REVIEWER_TIMEOUT_MS, so worst case it is spent twice — error path only).
    if (!v.valid) {
      console.warn(`[qa] reviewer verdict failed the typed contract (${v.issues.join("; ")}); requesting one repair.`);
      // Phase 6a: notify the shared cycle counter before the repair re-prompt fires.
      opts?.onRepair?.();
      // WS9.1: same self-contained-repair fallback as the generator path above — embed the
      // prior response's tail so a stateless provider session can recover its own verdict.
      output = await session.prompt(
        repairInstruction("reviewer", v.issues, { priorResponseTail: output }),
        { isRepair: true },
      );
      v = parseReviewerVerdict(output);
    }
    if (v.parsed && v.valid) {
      return {
        approved: v.approved,
        corrections: v.corrections,
        // Phase 4: thread blockingCount so the caller's gate can pass on advisory-only
        // verdicts without re-parsing the raw correction entries.
        blockingCount: v.blockingCount,
        ...(v.rationale ? { rationale: v.rationale } : {}),
        parsed: true,
      };
    }
    // Still unusable after one repair. Fail-closed direction (no false green), flagged as a
    // PARSE MISS so the caller does not mistake it for an actionable rejection.
    return { approved: false, corrections: ["the independent reviewer produced no parseable verdict"], blockingCount: 0, parsed: false };
  } finally {
    await session.dispose().catch((err) => {
      console.warn(`[qa] reviewer session dispose failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
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

// B4: structured plan result carrying both the objectives array and an optional reason string.
// The reason is emitted by the planner when it returns an empty objectives array, so a silent
// "nothing to cover" no-op is distinguishable from a failure. Non-empty plans may omit it.
export interface PlanResult {
  objectives: PlanObjective[];
  reason?: string; // populated only when the planner explicitly included one (typically on empty plans)
}

// Parse the planner's output into a structured result: objectives array + optional reason.
// The reason field is OPTIONAL so non-empty plans and existing tests are completely unaffected.
export function parsePlanResult(text: string): PlanResult {
  const objectives = parsePlan(text);
  const o = lastJsonMatching(text, (x) => Array.isArray((x as Record<string, unknown>).objectives));
  const reason =
    o && typeof (o as Record<string, unknown>).reason === "string"
      ? ((o as Record<string, unknown>).reason as string).trim() || undefined
      : undefined;
  return { objectives, reason };
}

// True when the planner's response INTENDED objectives (its text carries an `objectives` array with
// at least one object entry) but NONE parsed — i.e. the JSON was malformed/over-nested, not a
// genuine "nothing uncovered". Distinguishes a PARSE FAILURE (→ repair re-prompt, like the
// generator/reviewer get) from a legitimate empty plan (`{"objectives":[]}` or no array at all,
// which must be honored as a real no-op). Without this, a malformed whole-repo plan silently
// produced 0 objectives → a false `skipped` after a full planner run.
export function planNeedsRepair(planText: string): boolean {
  return parsePlan(planText).length === 0 && /"objectives"\s*:\s*\[\s*\{/.test(planText);
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
  needsUi: boolean; // selects qa-worker (UI — transcribes the injected a11y tree, browserless) vs qa-worker-code (code-only); BOTH are serena-only, neither has Playwright
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
  domSnapshot?: string; // live DEV a11y tree of this flow's routes — the worker transcribes, not guesses
  runId?: string; // set on fan-out so the worker's live activity routes + carries a workerId
  staticSignal?: string; // deterministic pre-computed analysis (signal-only, fail-open)
  // parity-for-the-future: no live fan-out on qa-engine today (GenerateTestsUseCase is single-session;
  // nothing constructs ParallelWorkerInput on the rewritten engine). Threaded so the worker seam
  // already carries these structural signals — including crossRepoImpact — the day generateParallel
  // is ported; dormant until then. The key-drift gate (not the round-trip, which tolerates one-sided
  // optionals) guards all three from drifting between the two mirrors.
  serviceLinks?: OcServiceLink[];
  contractDrift?: OcContractDrift[];
  crossRepoImpact?: { impactedLinks: Array<{ link: OcServiceLink; tier: string }> };
}

// Dispatch each worker objective to a SEPARATE qa-worker session, bounded concurrency.
// Uses a racing pool: when one worker finishes the next starts immediately — no batch
// blocked by the slowest member. BOTH qa-worker (UI) and qa-worker-code (code-only) are
// browserless (serena only); needsUi only selects the prompt framing — the UI worker
// transcribes the injected a11y tree, the code worker derives tests from the affected symbols.
export async function generateParallel(
  workers: ParallelWorkerInput[],
  deps: AgentDeps,
  opts?: { signal?: AbortSignal; concurrency?: number; specExists?: (path: string) => boolean },
): Promise<{ results: Array<{ flow: string; spec: string }>; errors: string[] }> {
  const exists = opts?.specExists ?? existsSync; // injectable for tests; defaults to the real FS check
  if (workers.length === 0) return { results: [], errors: [] };
  const concurrency = opts?.concurrency ?? Math.min(workers.length, 5);
  const results: Array<{ flow: string; spec: string }> = [];
  const errors: string[] = [];

  const runOne = async (w: ParallelWorkerInput) => {
    try {
      const agent = w.needsUi ? "qa-worker" : "qa-worker-code";
      const session = await deps.open(agent, w.mirrorDir, {
        signal: opts?.signal,
        descriptor: { runId: w.runId, role: agent, objective: w.objective },
      });
      if (w.runId) registerRunSession(session.id, w.runId, w.mirrorDir, w.flow);
      try {
        // Phase 1b: assembled variant carries sectionSizes for turn telemetry.
        const workerAssembled = buildWorkerPromptAssembled(w);
        const output = await session.prompt(workerAssembled.text, { sectionSizes: workerAssembled.sectionSizes });
        const json = lastJsonMatching(output, (x) => typeof x.spec === "string");
        const spec = json?.spec as string | undefined;
        // VERIFY on disk — a parsed spec NAME is the worker's CLAIM, not proof it wrote the file. A
        // worker that reports a spec it never persisted (phantom) must count as a FAILURE, so the
        // fan-out's "N written" is honest (the global reconcile drops phantoms later, but the
        // per-worker count must not over-report; this was hiding that 1 of 4 workers actually landed).
        if (spec && exists(join(w.mirrorDir, w.e2eRelDir, spec))) {
          results.push({ flow: w.flow, spec });
        } else if (spec) {
          errors.push(`${w.flow}: worker reported spec '${spec}' but it is NOT on disk (phantom)`);
        } else {
          errors.push(`${w.flow}: worker produced no parseable spec name`);
        }
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
  opts?: {
    signal?: AbortSignal;
    onProgress?: (msg: string) => void;
    concurrency?: number;
    specExists?: (path: string) => boolean;
    // Deterministic DOM grounding for the workers — the orchestrator captures the live a11y tree of
    // the planned routes (Playwright lives on the orchestrator side, so it is injected here, keeping
    // this agent boundary free of browser code), returned PER ROUTE (route → formatted block) so each
    // objective is grounded with only its own routes' DOM. Best-effort: a route absent from the map
    // got no usable/route-specific DOM, and its objective degrades to the strong agent.
    captureRoutesDom?: (routes: string[]) => Promise<Map<string, string>>;
  },
  fs: ManifestFs = realManifestFs,
): Promise<AgentResult> {
  // Phase 1 — PLAN. For a SCOPED mode (diff/manual) the planner derives objectives from one commit /
  // one guidance string and must not navigate (F3), so bound it with its OWN deadline
  // (PLANNER_TIMEOUT_MS), which takes precedence over the global OPENCODE_TIMEOUT_MS so a misbehaving
  // planner can never consume the generator's whole window (the hang that produced 0 specs). Keyed on
  // the MODE, not on brief presence: a brief-less diff/manual planner still only plans a single scope —
  // reverting it to the 5–10 min generator budget would re-open the hang. complete/exhaustive
  // (whole-repo analysis) keep the per-mode generator budget (unchanged).
  // NOTE: the planner stays on the qa-generator role — the production AgentDeps is the provider facade,
  // whose roleForLegacyAgent() maps any unknown agent name back to "primary"→qa-generator, so a
  // separate "qa-planner" agent would be inert without cross-cutting changes to the provider-agnostic +
  // Codex role plumbing. The timeout is the fix that matters; F3's prompt already removed navigation.
  const isScopedPlan = input.mode === "diff" || input.mode === "manual";
  const timeoutMs = isScopedPlan ? PLANNER_TIMEOUT_MS : agentTimeout(input.mode);
  const planSession = await deps.open("qa-generator", input.mirrorDir, {
    signal: opts?.signal,
    timeoutMs,
    descriptor: { runId: input.runId, role: "qa-generator", objective: PLANNER_OBJECTIVE },
  });
  if (input.runId) registerRunSession(planSession.id, input.runId, input.mirrorDir);
  const startedAt = Date.now();
  const heartbeat = opts?.onProgress
    ? setInterval(() => opts.onProgress?.(`[qa] planner is analysing the repo... (${Math.round((Date.now() - startedAt) / 1000)}s elapsed)`), 15_000)
    : undefined;
  let planText: string;
  try {
    // Phase 1b: assembled variant carries sectionSizes for turn telemetry.
    const planAssembled = buildPlanPromptAssembled(input);
    planText = await planSession.prompt(planAssembled.text, { sectionSizes: planAssembled.sectionSizes });
    // Typed-contract repair (parity with the generator/reviewer): a plan whose response INTENDED
    // objectives but parsed to NONE was malformed/over-nested JSON — re-prompt ONCE for a clean,
    // minimal plan before accepting a false "0 objectives" that would wrongly SKIP a whole-repo run
    // (a real bug seen on exhaustive mode: the planner found 11 flows, the nested JSON did not parse,
    // and the run skipped). A genuinely empty plan is left untouched.
    if (planNeedsRepair(planText)) {
      console.warn("[qa] planner plan did not parse (objectives intended but 0 extracted); requesting one repair.");
      planText = await planSession.prompt(
        'Your previous plan did not parse. Output ONLY a single JSON object — no prose, no markdown fences — ' +
          'of the form {"objectives":[{"flow":"...","objective":"...","needsUi":true}, ...]}. ' +
          "Keep it MINIMAL: omit the optional `brief`/blast-radius detail if it risks malforming the JSON.",
      );
    }
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    if (input.runId) unregisterRunSession(planSession.id);
    await planSession.dispose().catch(() => {});
  }

  // B4: use parsePlanResult to capture both objectives and the optional reason. The reason is
  // emitted by the planner when it returns an empty array (prompted to do so) so a silent no-op
  // is distinguishable from a failure. Non-empty plans are unaffected.
  const planResult = parsePlanResult(planText);
  const objectives = planResult.objectives;
  opts?.onProgress?.(`[qa] plan: ${objectives.length} objective(s) to generate`);
  if (objectives.length === 0) {
    // A valid no-op: nothing important is uncovered (honored as `skipped` upstream).
    const plannerReason = planResult.reason ?? "(no reason given)";
    console.log(`[qa] planner returned 0 objectives — reason: ${plannerReason}`);
    return { output: planText, specs: [], reviewed: false, approved: true, note: `planner found no important uncovered flows — reason: ${plannerReason}` };
  }

  // A diff or manual plan with a single objective gains nothing from fan-out and would LOSE
  // the single-agent prompt's full context (diff/guidance, fix/review blocks). Fall back to the
  // strong agent. This is the unified diff/manual cardinality gate (Phase 5): both modes branch
  // on objective count, not on the mode name — same logic, only the scope source differs.
  if ((input.mode === "diff" || input.mode === "manual") && objectives.length < 2) {
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
      // Phase 0b: thread role into the descriptor; runId is forwarded when available.
      // The serena pre-index session has no per-objective context, so objective is left undefined.
      const idxSession = await deps.open("qa-worker-code", input.mirrorDir, {
        timeoutMs: 120_000,
        descriptor: { runId: input.runId, role: "qa-worker-code" },
      });
      try {
        await idxSession.prompt("Activate serena (activate_project) on the current directory. Do nothing else. End with {\"spec\":\"\"}.");
      } finally {
        await idxSession.dispose().catch(() => {});
      }
    } catch {
      // Best-effort: if pre-indexing fails, workers will each activate serena themselves
    }
  }

  // Ground the workers BEFORE they write: capture the live a11y tree of the planned routes and hand
  // each worker ONLY its own objective's DOM (qa-worker has no browser MCP — it transcribes the
  // injected tree instead of guessing real selectors, the #1 failure class). The whole route union is
  // rendered ONCE (a shared route is not re-rendered) and returned per-route. Routes come from each
  // brief's code-derived `routes[]` (the real router paths) — NOT filtered by the planner's `verified`
  // flag: the planner no longer navigates to set it (F3), so grounding must not depend on it.
  // Best-effort — a route absent from the map got no usable/route-specific DOM (capture unavailable,
  // render failed, or a soft-404 shell), and its objective routes to the strong agent below.
  let domByRoute = new Map<string, string>();
  if (opts?.captureRoutesDom) {
    const allRoutes = normalizeRoutes(objectives.flatMap((o) => o.brief?.routes?.map((r) => r.path) ?? []).filter((r): r is string => Boolean(r)));
    if (allRoutes.length > 0) {
      domByRoute = await opts.captureRoutesDom(allRoutes).catch(() => new Map<string, string>());
      if (domByRoute.size > 0) opts?.onProgress?.(`[qa] grounding: captured the live a11y tree for ${domByRoute.size}/${allRoutes.length} planned route(s) → injected per-objective`);
    }
  }

  // Phase 2 — FAN-OUT to workers (one spec each), with per-objective grounding (Phase 5 + F1).
  //
  // Grounding semantics, evaluated PER objective:
  //   • code-only (needsUi:false) → grounded; no DOM needed at all.
  //   • UI with NO routes in its brief → grounded; the worker self-guides from the brief hints (the
  //     planner promised no concrete route to render — today's behavior, unchanged).
  //   • UI WITH routes, and DOM was captured for >=1 of them → grounded WITH that per-objective DOM.
  //     (PARTIAL is intentional: some-DOM is strictly better than none for the browserless worker —
  //     it transcribes the captured routes and marks the rest unverified, the same as the no-DOM path.)
  //   • UI WITH routes but NONE captured (capture unavailable, render failed, or a soft-404 shell) →
  //     UNGROUNDED → strong agent (full Playwright MCP) which can navigate to recover — BUT bounded:
  //     the strong-agent path is SEQUENTIAL, so a broad capture failure (e.g. every route soft-404s on
  //     a hash SPA) must not serialize the whole plan. Beyond MAX_STRONG_FALLBACK ungrounded objectives
  //     we stop serializing and dispatch the overflow to PARALLEL workers without DOM (the pre-F1 blind
  //     path) so the run stays bounded — surfaced loudly.
  //
  // This heterogeneous partial fan-out (some objectives to workers, some to the strong agent) is an
  // explicit Phase-5 design item; results are consolidated in Phase 3 below.
  const changeType = input.intent?.type ?? input.mode;
  const grounded: Array<{ objective: PlanObjective; dom?: string }> = [];
  const ungrounded: PlanObjective[] = [];
  for (const o of objectives) {
    if (!o.needsUi) {
      grounded.push({ objective: o }); // code-only: never needs DOM
      continue;
    }
    // This objective's own routes, capped per-objective (MAX_ROUTES). The UNION cap (MAX_ROUTES_UNION,
    // applied + logged in captureDomByRoute) can leave a late objective's route uncaptured → it falls
    // to the bounded fallback below, never a silent drop.
    const routes = normalizeRoutes(o.brief?.routes?.map((r) => r.path).filter((r): r is string => Boolean(r)) ?? []).slice(0, MAX_ROUTES);
    if (routes.length === 0) {
      grounded.push({ objective: o }); // no route promised → worker self-guides (today's behavior)
      continue;
    }
    const dom = routes.map((r) => domByRoute.get(r)).filter((b): b is string => Boolean(b)).join("\n\n");
    if (dom) {
      grounded.push({ objective: o, dom });
    } else {
      ungrounded.push(o);
    }
  }

  // Bound the SEQUENTIAL strong-agent fallback: only the first MAX_STRONG_FALLBACK ungrounded objectives
  // get strong-agent recovery; a broad capture failure (many ungrounded) must not serialize the plan, so
  // the overflow is dispatched to PARALLEL workers WITHOUT DOM (they mark selectors unverified — the
  // pre-F1 blind path). Surfaced loudly: blind specs lean on the static + selector gates downstream.
  if (ungrounded.length > MAX_STRONG_FALLBACK) {
    const overflow = ungrounded.splice(MAX_STRONG_FALLBACK);
    for (const o of overflow) grounded.push({ objective: o });
    console.warn(`[qa] WARNING: ${overflow.length} ungrounded objective(s) beyond the strong-agent cap (${MAX_STRONG_FALLBACK}) dispatched to PARALLEL workers WITHOUT DOM (blind) to avoid serializing the run — broad DOM-capture failure (e.g. a soft-404 SPA). Flows: ${overflow.map((o) => o.flow).join(", ")}`);
    opts?.onProgress?.(`[qa] grounding: ${overflow.length} ungrounded objective(s) over the cap → parallel blind workers (run stays bounded)`);
  }
  for (const o of ungrounded) {
    opts?.onProgress?.(`[qa] grounding: objective '${o.flow}' has routes but no captured DOM — routing to strong agent`);
  }

  const workers: ParallelWorkerInput[] = grounded.map(({ objective: o, dom }) => ({
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
    ...(dom ? { domSnapshot: dom } : {}),
    runId: input.runId,
    // INTENTIONALLY replicated to every parallel-diff worker: each worker benefits from the full
    // blast-radius signal, and the N× token cost of duplicating it per worker is accepted.
    staticSignal: input.staticSignal,
    // parity-for-the-future: dormant — this map only executes on the legacy generateParallel path.
    ...(input.serviceLinks?.length ? { serviceLinks: input.serviceLinks } : {}),
    ...(input.contractDrift?.length ? { contractDrift: input.contractDrift } : {}),
    ...(input.crossRepoImpact?.impactedLinks.length ? { crossRepoImpact: input.crossRepoImpact } : {}),
  }));

  // Dispatch grounded objectives to lite workers in parallel.
  const { results: workerResults, errors } = workers.length > 0
    ? await generateParallel(workers, deps, { signal: opts?.signal, concurrency: opts?.concurrency, ...(opts?.specExists ? { specExists: opts.specExists } : {}) })
    : { results: [], errors: [] };
  opts?.onProgress?.(`[qa] workers: ${workerResults.length} spec(s) written, ${errors.length} error(s)`);
  if (errors.length > 0) {
    // A failed worker means a PLANNED flow is silently absent from the suite. Surface it loudly
    // (not only buried in the result note): when review is off, the run can otherwise report
    // approved over a partial suite, so the missing coverage must be visible to the operator.
    const writtenFlows = new Set(workerResults.map((r) => r.flow));
    const failedFlows = grounded.filter(({ objective: o }) => !writtenFlows.has(o.flow)).map(({ objective: o }) => o.flow);
    console.warn(`[qa] WARNING: ${errors.length} worker(s) failed — these planned flows are NOT in the suite: ${failedFlows.join(", ") || "(unknown)"}. ${errors.join("; ")}`);
  }

  // Dispatch ungrounded objectives to the strong agent (sequentially, one per call).
  // Each strong-agent call produces its own specs; they are appended to the results.
  const strongResults: Array<{ flow: string; spec: string }> = [];
  for (const o of ungrounded) {
    try {
      opts?.onProgress?.(`[qa] strong agent handling ungrounded objective '${o.flow}'...`);
      const strongResult = await runOpencode(
        {
          ...input,
          explorer: false, // planner already ran; skip redundant explorer
          ...(o.brief ? { contextBrief: o.brief } : {}),
        },
        deps,
        opts,
      );
      // Collect specs the strong agent wrote (may be multiple if the planner didn't scope tightly).
      // Record them under this objective's flow so manifest consolidation can attribute them.
      for (const s of strongResult.specs) {
        strongResults.push({ flow: o.flow, spec: s });
      }
    } catch (err) {
      console.warn(`[qa] WARNING: strong-agent fallback for objective '${o.flow}' failed: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  // Phase 3 — CONSOLIDATE: merge worker specs + strong-agent specs; write manifest once (no race).
  const allResults = [...workerResults, ...strongResults];
  const written = new Set(allResults.map((r) => r.flow));
  const entries: ManifestEntry[] = objectives
    .filter((o) => written.has(o.flow))
    .map((o) => ({ id: o.flow, objective: o.objective, flow: o.flow, targets: o.symbols, changeRef: { sha: input.sha, type: changeType } }));
  upsertManifest(fs, join(input.mirrorDir, input.e2eRelDir, ".qa", "manifest.json"), entries);

  const specs = allResults.map((r) => r.spec);
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
    // Phase 6b: expose the planner's objective count so the pipeline can retroactively
    // dimension the runaway backstop to the actual scope of this run.
    objectiveCount: objectives.length,
  };
}

// Timeout wrapper for a promise: rejects if it elapses. Prevents a hung agent run
// from blocking the (sequential) queue, which would block every repo. Verifiable
// with stubs.
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
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

// Wrap an AgentDeps so EVERY open() injects the per-run usage sink, including internal callers
// (explorer, reviewer, parallel workers) that never set opts.onUsage themselves. A caller-supplied
// opts.onUsage still wins (`opts?.onUsage ?? onUsage`). No sink ⇒ baseDeps is returned untouched.
// Single home for this wrapper so the precedence cannot drift between the entrypoint (index.ts) and
// the default pipeline factory (pipeline.ts), which both need identical behavior.
//
// `onTurn` is TEST-ONLY: production never passes it (both call sites supply onUsage alone, and turn
// persistence runs via the defaultOnTurn sink inside defaultAgentDeps.open, not through this
// wrapper). It is retained solely so the colocated tests can exercise the same caller-wins
// threading contract for onTurn (`opts?.onTurn ?? onTurn`) that onUsage uses.
export function withUsageSink(
  baseDeps: AgentDeps,
  onUsage?: (u: UsageSnapshot) => void,
  onTurn?: (t: AgentTurnEvent) => void, // TEST-ONLY (see note above); production passes only onUsage.
): AgentDeps {
  if (!onUsage && !onTurn) return baseDeps;
  return {
    ...baseDeps,
    open: (agent, cwd, opts) =>
      baseDeps.open(agent, cwd, {
        ...opts,
        ...(onUsage ? { onUsage: opts?.onUsage ?? onUsage } : {}),
        ...(onTurn ? { onTurn: opts?.onTurn ?? onTurn } : {}),
      }),
  };
}

// Default stall threshold: STRICTLY less than the shortest mode timeout (diff = 5 min).
// Configurable via OPENCODE_STALL_MS. 180 seconds without any agent activity event triggers the
// watchdog — tight enough to catch a truly hung session well before the coarse deadline, yet with
// headroom for a single legitimately-long tool call (e.g. a large Serena index scan) that emits no
// intermediate SSE events. Raise OPENCODE_STALL_MS for very large repos if healthy runs trip it.
const DEFAULT_STALL_MS = 180_000;

export function stallMs(): number {
  return Number(process.env.OPENCODE_STALL_MS) || DEFAULT_STALL_MS;
}

// Factory type for injecting a custom watchdog in tests. Receives onStall; must
// return a StallWatchdog. The real path uses createStallWatchdog with the real clock.
export type WatchdogFactory = (onStall: () => void) => StallWatchdog;

// Wrap an AgentDeps so EVERY session gets an inactivity watchdog. If notify() is not
// called within stallMs, the in-flight prompt() is rejected with StalledAgentError and
// the session is disposed. notify() must be called from the SSE event stream on each
// activity event received for this session.
//
// `watchdogFactory` is TEST-ONLY: production never passes it. The real path uses
// createStallWatchdog with the global clock. The `stallMs` option is forwarded from
// the stallMs() helper (defaulting to OPENCODE_STALL_MS or DEFAULT_STALL_MS).
export function withStallWatchdog(
  baseDeps: AgentDeps,
  opts: {
    stallMs?: number;
    watchdogFactory?: WatchdogFactory;
  } = {},
): AgentDeps {
  const threshold = opts.stallMs ?? stallMs();
  const factory: WatchdogFactory = opts.watchdogFactory ?? ((onStall) => createStallWatchdog({ stallMs: threshold, onStall }));

  return {
    ...baseDeps,
    open: async (agent, cwd, openOpts) => {
      const inner = await baseDeps.open(agent, cwd, openOpts);

      // Self-timed sessions (Codex exec-per-prompt) manage their own timeout in the transport and
      // never emit SSE activity, so the stall watchdog — which only resets on notifySessionActivity
      // from the OpenCode SSE loop — would false-positive-kill every prompt slower than the
      // threshold. Skip wrapping; the transport's own timeout is the real deadline.
      if (inner.selfTimed) return inner;

      // Track the in-flight prompt's reject handle so the stall callback can surface
      // StalledAgentError from inside the watchdog (which runs on the timer thread).
      let rejectInFlight: ((err: unknown) => void) | undefined;

      const watchdog = factory(() => {
        // The stall callback: reject the in-flight prompt and dispose the session.
        const err = new StalledAgentError(
          `Agent session stalled: no activity for ${threshold}ms. Aborting session to free resources.`,
        );
        rejectInFlight?.(err);
        // Clean up the session→notify registry on the stall path too. wrapped.dispose() also
        // unregisters, but a caller that swallows the rejection without reaching its finally
        // (e.g. maybeExplore) would otherwise leak the entry for the process lifetime. Idempotent.
        unregisterSessionWatchdogNotify(inner.id);
        // Best-effort dispose — do not await (we are inside a timer callback).
        inner.dispose().catch(() => {});
      });

      // Register this session's watchdog notify with the SSE event loop so that
      // every incoming activity event for this session resets the stall timer.
      registerSessionWatchdogNotify(inner.id, () => watchdog.notify());

      const wrapped: typeof inner = {
        id: inner.id,
        prompt: (text, promptOpts) =>
          new Promise<string>((resolve, reject) => {
            rejectInFlight = reject;
            // Arm the watchdog at prompt-start; subsequent SSE events reset it.
            watchdog.notify();
            inner.prompt(text, promptOpts).then(
              (v) => {
                rejectInFlight = undefined;
                watchdog.stop();
                resolve(v);
              },
              (e) => {
                rejectInFlight = undefined;
                watchdog.stop();
                reject(e);
              },
            );
          }),
        dispose: async () => {
          watchdog.stop();
          unregisterSessionWatchdogNotify(inner.id);
          await inner.dispose();
        },
      };

      return wrapped;
    },
  };
}

// WS6.2 (full-flow remediation, timeouts & operational observability): registerRunSession/
// unregisterRunSession existed and were exported, but nothing on the rewritten (qa-engine)
// production path ever called them (the only call sites were the legacy runOpencode/
// generateParallel/maybeExplore/maybePlan functions — dead since the cutover deleted
// src/pipeline.ts). A session opened with a descriptor.runId never got mapped to its run, so SSE
// live-activity events for that session were never routed to the TUI's live run panel.
//
// Wrap AgentDeps at the SAME composition seam withStallWatchdog/withUsageSink already use (see
// createRewrittenEngineFactory's getAgentDeps wrapping) so every session opened through the
// rewritten engine — generator, reviewer, or any future role — registers/unregisters automatically
// whenever the caller supplied a descriptor.runId. Absent runId (e.g. a unit test or an operator
// script with no run context) -> no registration is attempted, matching every other "absent ->
// unchanged" optional-field contract in this file.
//
// `collaborators` is a testability seam (mirrors withStallWatchdog's watchdogFactory precedent) —
// defaults to the REAL exported registerRunSession/unregisterRunSession in production.
export function withSessionRegistration(
  baseDeps: AgentDeps,
  collaborators: {
    register?: typeof registerRunSession;
    unregister?: typeof unregisterRunSession;
  } = {},
): AgentDeps {
  const register = collaborators.register ?? registerRunSession;
  const unregister = collaborators.unregister ?? unregisterRunSession;

  return {
    ...baseDeps,
    open: async (agent, cwd, opts) => {
      const inner = await baseDeps.open(agent, cwd, opts);
      const runId = opts?.descriptor?.runId;
      if (runId) register(inner.id, runId, cwd);

      return {
        ...inner,
        dispose: async () => {
          if (runId) unregister(inner.id);
          await inner.dispose();
        },
      };
    },
  };
}

// Integration boundary: real connection to `opencode serve`. Not covered by unit
// tests (like the Playwright runner). The SDK is imported lazily so tests do not
// require the package. OPENCODE_SERVE_URL points to the `opencode` container.
//
// Usage capture is driven SOLELY by `opts.onUsage` on each open() — the single, typed mechanism.
// Callers that want the snapshots wrap this AgentDeps (via withUsageSink) to inject onUsage into
// every open() (the runner/pipeline path via the facade). There is no factory-level usage sink (it
// was dead in the production strategy path, which always constructs this with no argument).
export async function defaultAgentDeps(): Promise<AgentDeps> {
  // The undici transport timeout must exceed EVERY per-prompt withTimeout, or it aborts the
  // request before our own deadline fires. The reviewer, the explorer and the planner each have their
  // OWN budget (REVIEWER_TIMEOUT_MS, EXPLORER_TIMEOUT_MS, PLANNER_TIMEOUT_MS) independent of the
  // generator's; if an operator sets a small OPENCODE_TIMEOUT_MS (or raises a per-role one) it must NOT
  // drag the transport below any of them. Take the max + headroom.
  const generatorMax = Number(process.env.OPENCODE_TIMEOUT_MS) || MAX_AGENT_TIMEOUT_MS;
  const dispatcherTimeoutMs = Math.max(generatorMax, REVIEWER_TIMEOUT_MS, EXPLORER_TIMEOUT_MS, PLANNER_TIMEOUT_MS) + 30_000;
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

      // Default turn sink: persist to agent_turns when a runId is available and no caller-supplied
      // onTurn overrides it. Best-effort: a storage failure must not break the agent session.
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
      // The effective onTurn: caller-supplied wins; default sink fires when runId is present.
      const effectiveOnTurn = opts?.onTurn ?? defaultOnTurn;

      // Track the per-call round counter so `onTurn` can report which round produced each output.
      // The counter starts at 0 for the first prompt() call on this session and increments each
      // time prompt() is invoked (whether a normal generation round or an in-session repair).
      //
      // SEMANTICS: `round` is SESSION-LOCAL — a per-session prompt index, NOT a per-run regeneration
      // index. Each regeneration pass (fix / reviewer-corrections / coverage) opens a NEW session,
      // so every main generation turn is round=0; only in-session contract-repair re-prompts push it
      // to 1, 2, … within the same session. Cross-session regeneration ORDERING is therefore NOT
      // encoded in `round`; it is reconstructed from the turn `ts` (and run_id) when reading
      // agent_turns. (Threading a run-level regeneration index is intentionally out of scope here.)
      let _round = 0;

      return {
        id,
        prompt: (text, promptOpts) =>
          withTimeout(
            (() => {
              checkCircuit();
              // Capture the round for this call (incremented after the closure captures it so
              // round=0 on the first call, round=1 on the second, etc.).
              const thisRound = _round++;
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
                      throw agentErrorToInfra(agentErr);
                    }
                    recordCircuitSuccess();
                    const infoRaw = res.data?.info as
                      | { tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }; cost?: number }
                      | undefined;
                    // Emit a usage snapshot for the accumulator (observation-only). The ONLY sink is
                    // opts.onUsage — callers that want capture pre-wrap this AgentDeps to inject it
                    // into every open() (so internal callers like the explorer/reviewer are covered
                    // without touching their individual call sites).
                    if (infoRaw?.tokens) {
                      const snapshot: UsageSnapshot = {
                        input: infoRaw.tokens.input ?? 0,
                        output: infoRaw.tokens.output ?? 0,
                        reasoning: infoRaw.tokens.reasoning ?? 0,
                        cacheRead: infoRaw.tokens.cache?.read ?? 0,
                        cacheWrite: infoRaw.tokens.cache?.write ?? 0,
                        cost: infoRaw.cost ?? 0,
                      };
                      opts?.onUsage?.(snapshot);
                    }
                    const outputRaw = extractText(res.data?.parts, promptOpts);
                    // Emit a per-turn event alongside onUsage. Sanitize output_text before
                    // emitting so any DEV-environment data in the agent reply is redacted at
                    // the earliest point (before storage or logging by callers).
                    if (effectiveOnTurn) {
                      const sanitizedOutput = sanitizeText(outputRaw).text;
                      const turnEvent: AgentTurnEvent = {
                        runId: opts?.descriptor?.runId ?? null,
                        sessionId: id,
                        role: opts?.descriptor?.role ?? agent,
                        objective: opts?.descriptor?.objective,
                        round: promptOpts?.round ?? thisRound,
                        isRepair: promptOpts?.isRepair ?? false,
                        promptText: text,
                        promptBytes: Buffer.byteLength(text, "utf8"),
                        outputText: sanitizedOutput,
                        tokensInput: infoRaw?.tokens?.input ?? null,
                        tokensOutput: infoRaw?.tokens?.output ?? null,
                        tokensReasoning: infoRaw?.tokens?.reasoning ?? null,
                        tokensCacheRead: infoRaw?.tokens?.cache?.read ?? null,
                        tokensCacheWrite: infoRaw?.tokens?.cache?.write ?? null,
                        cost: infoRaw?.cost ?? null,
                        ts: new Date().toISOString(),
                        // Phase 1b: per-section byte map from the ContextAssembler. Null when
                        // the prompt was not assembled (repairs, explorer, etc.).
                        sectionSizes: promptOpts?.sectionSizes ?? null,
                      };
                      effectiveOnTurn(turnEvent);
                    }
                    return outputRaw;
                  })
                  // Record the circuit failure in EXACTLY one place per attempt. The error
                  // branches above throw without counting; this single trailing catch counts
                  // the attempt once (a previous double-count opened the breaker after ~3
                  // instead of CIRCUIT_THRESHOLD failures), then re-throws to the fallback retry.
                  .catch((err) => {
                    recordCircuitFailure();
                    throw err;
                  });
              };
              return runPrompt(opts?.model).catch((err) => {
                // Only retry a TRANSIENT primary-model fault on the fallback model. Skip the
                // retry (re-throw) on operator-abort (a cancel must not be defeated by a retry)
                // and on infra errors like AgentUnavailableError (out-of-credits/auth hits the
                // SAME OpenCode key — re-spending on the fallback is pointless and surfaces late).
                if (opts?.signal?.aborted || isInfraError(err)) throw err;
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
