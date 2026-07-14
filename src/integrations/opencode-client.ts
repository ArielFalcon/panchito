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

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { QaCase, RunMode, TestTarget, SpecMeta, ActivityKind } from "../types";
import type { UsageSnapshot } from "../qa/usage";
import type { CommitIntent } from "@contexts/generation/application/ports/generation-ports.ts";
import type { ArchitectureContext } from "../qa/context";
import { type ExplorationBrief } from "../qa/exploration-brief";
import type { StructuralPattern } from "../qa/learning/skill-exemplar";
import { sanitizeText } from "../orchestrator/sanitizer";
import { ActivityRouter } from "./agent-activity";
import { mapOpencodeEvent, eventRunId } from "./activity-mapper";
import { reexploreKindFromEvent, reexploreTracker } from "./reexplore";
import type { RunEventBody } from "../contract/events";
import { saveAgentTurn } from "../server/history";
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
import { type FinalVerdict, extractJsonObjects, parseVerdict } from "./verdict-parse";
export { extractJsonObjects, parseVerdict };
// Prompt/task assembly (extracted to ./prompts, BND-08). Re-exported so existing importers (runtime
// + tests) keep resolving them from this module. The input types are shared via a type-only import
// on the prompts side, so there is no runtime import cycle.
// Phase 1b: also re-exports the assembled variants (return AssembledPrompt) and the Section type
// so callers that need sectionSizes for telemetry can import directly from this module.
// migration-tier-4c Slice 1: buildPlanPrompt/buildPlanPromptAssembled deleted (dead — the fan-out
// planner they served was never called on the rewritten qa-engine path); no longer re-exported here.
import { specFileForFlow, buildWorkerPrompt, buildWorkerPromptAssembled, buildPrompt, buildPromptAssembled, buildExplorerPrompt, buildContextTask, renderArchitectureContext, buildReviewerPrompt, buildReviewerPromptAssembled, reviewObjective, renderReviewSpecs, renderExecutionResult } from "./prompts";
export { specFileForFlow, buildWorkerPrompt, buildWorkerPromptAssembled, buildPrompt, buildPromptAssembled, buildExplorerPrompt, buildContextTask, renderArchitectureContext, buildReviewerPrompt, buildReviewerPromptAssembled, reviewObjective, renderReviewSpecs, renderExecutionResult };
export type { AssembledPrompt, ExecutionResultCase } from "./prompts";
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
  // sdd/migration-wiring-phase-2 Slice 4 (D-E skill-exemplar restore): the FULL detected structural
  // shapes (restored src/qa/learning/structural-pattern.ts's detectStructuralPatterns) — a richer
  // sibling of diffArchetypes above. Fed into prompts.ts's matchExemplars/renderExemplarsForPrompt
  // loop to render a "Skill exemplars" section. Absent or empty = no section (never fabricated).
  structuralPatterns?: StructuralPattern[];
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

// ESCALATED FINDING (migration-tier-4c Slice 1 fresh-grep gate): this type has ZERO production
// callers — generateParallel/runOpencodeParallel/shouldFanOut, its only real consumers, were deleted
// in this slice as confirmed dead. It is kept ONLY because
// qa-engine/test/contexts/generation/application/ports/generation-ports-parity.test.ts (a Slice-6-
// owned parity gate, out of this slice's scope) structurally imports it from this module for its
// AssertNever key-drift check against the canonical ParallelWorkerInput in generation-ports.ts.
// Slice 6 (task 6.1) deletes generation-ports-parity.test.ts wholesale alongside OpencodeRunInput/
// ReviewInput; this declaration MUST be deleted in that same commit, not before.
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
  // Dead on the production path (see the ESCALATED FINDING note above) — kept structurally in sync
  // with the canonical type solely for the Slice-6-owned parity gate until it retires both together.
  serviceLinks?: OcServiceLink[];
  contractDrift?: OcContractDrift[];
  crossRepoImpact?: { impactedLinks: Array<{ link: OcServiceLink; tier: string }> };
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
        // would otherwise leak the entry for the process lifetime. Idempotent.
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
