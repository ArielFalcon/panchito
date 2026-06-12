// Trigger for the OpenCode agentic engine. Generation, review (subagent) and
// access to serena/engram all live INSIDE OpenCode (see opencode/opencode.json).
// Here we only open a session against `opencode serve`, pass it the change
// context, and the agent writes/updates the tests in the working copy's `e2e/`
// folder (a git repo: the source of truth). We collect no artifacts: the harness
// runs over `e2e/` and publishing commits the git diff.
//
// The SDK is injected via OpencodeDeps: the verifiable logic (prompt building,
// verdict parsing, orchestration) is tested with stubs; the real connection to
// `opencode serve` is the boundary not covered by unit tests.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { createHash } from "node:crypto";
import { AgentResult, QaCase, RunMode, TestTarget, SpecMeta, ActivityKind } from "../types";
import { CommitIntent } from "../qa/commit-classify";
import type { ArchitectureContext } from "../qa/context";
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

// Circuit breaker for the OpenCode client: if consecutive failures exceed the
// threshold, the circuit opens and requests are rejected for a cooldown period.
// This prevents cascading failures when the OpenCode server is down or overloaded.
let circuitFailures = 0;
let circuitOpen = false;
let circuitLastFailure = 0;
const CIRCUIT_THRESHOLD = 5;
const CIRCUIT_COOLDOWN_MS = 60_000;

function checkCircuit(): void {
  if (circuitOpen) {
    const elapsed = Date.now() - circuitLastFailure;
    if (elapsed < CIRCUIT_COOLDOWN_MS) {
      throw new Error(`OpenCode circuit breaker is OPEN (cooldown ${Math.round((CIRCUIT_COOLDOWN_MS - elapsed) / 1000)}s remaining)`);
    }
    circuitOpen = false;
    circuitFailures = 0;
  }
}

function recordCircuitFailure(): void {
  circuitFailures++;
  circuitLastFailure = Date.now();
  if (circuitFailures >= CIRCUIT_THRESHOLD) {
    circuitOpen = true;
    console.warn(`[qa] OpenCode circuit breaker OPENED after ${circuitFailures} consecutive failures`);
  }
}

function recordCircuitSuccess(): void {
  if (circuitFailures > 0) {
    circuitFailures = 0;
    circuitOpen = false;
  }
}

// Read fallback model mapping from opencode.json (root-level key). Keeps the
// fallback logic in one place so the orchestrator can retry with a different
// model when the primary is unavailable. Opt-in: absent `model_fallback` key
// (the default) means no fallback — the primary error propagates unchanged.
function getFallbackModel(agent: string): string | undefined {
  try {
    const configPath = join(process.cwd(), "opencode", "opencode.json");
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
      baseUrl: process.env.OPENCODE_SERVE_URL ?? "http://opencode:4096",
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
      baseUrl: process.env.OPENCODE_SERVE_URL ?? "http://opencode:4096",
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

// Read-only Q&A about a run. Opens a short-lived qa-assistant session.
export async function askAssistant(
  input: { context: string; question: string; instruction?: string },
  deps: OpencodeDeps,
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
      `  Use "───" to separate sections when the answer covers multiple topics.`,
      ``,
      `CRITICAL RULES:`,
      `- Respond in the SAME language as the question (Spanish → Spanish, English → English).`,
      `  Use neutral, standard language — no regional slang, no colloquialisms.`,
      ``,
      `TERMINAL-FRIENDLY FORMATTING (this renders in a TUI via Ink <Text>):`,
      `  ALLOWED — these render correctly in the terminal:`,
      `    · Blank lines to separate ideas.`,
      `    · Indentation (2-3 spaces) for nested detail.`,
      `    · CAPITALIZED single-word headers for structure (e.g. RESUMEN, CAUSA, ACCIÓN).`,
      `    · Plain text lists with "-" or "·" as bullet markers.`,
      `    · "───" (Unicode box-drawing) as visual separators between topics.`,
      `  FORBIDDEN — these do NOT render in the terminal:`,
      `    · **bold markdown**, \`inline code\`, # headings, > blockquotes.`,
      `    · Code fences (\`\`\`), HTML tags, URLs (unless asked for).`,
      `    · Emojis. Never use emojis.`,
      ``,
      `- Translate internal terms to user-friendly language:`,
      `  · "agent is working" → speak about what the agent is DOING (generating tests, exploring the page)`,
      `  · "heartbeat" → never mention; instead say "the agent is still active"`,
      `  · "pipeline phase" → speak about what's HAPPENING (testing, generating, validating)`,
      `  · "step/status/verdict" → describe the outcome in plain words`,
      `  · "classify/generate/validate/execute" → explain what the system is doing, not the phase name`,
      `  · Never mention panchito, the TUI, or pipeline internals. Focus on the user's tests.`,
      ``,
      `- If the context lacks the answer, say: "No tengo suficiente información para responder eso."`,
    ].join("\n");
  const session = await deps.open("qa-assistant", cwd);
  try {
    return await session.prompt([
      instruction,
      `Do not use any tools.`,
      `---`,
      input.context,
      `---`,
      `Question: ${input.question}`,
    ].join("\n"));
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
  service?: { repo: string; mirrorDir: string; openapi?: string | string[] }; // cross-repo: the triggering microservice (read-only working copy)
  services?: Array<{ repo: string; mirrorDir: string; openapi?: string | string[] }>; // context mode: every declared service, mirrored read-only
}

// A session opened against `opencode serve`. prompt() sends the message to the
// `qa-generator` agent and returns its final text (including the closing JSON).
// dispose() cleans up the session; call it when the session is no longer needed
// to avoid memory leaks on the server (sessions are never auto-cleaned).
export interface OpencodeSession {
  id: string;
  prompt(text: string): Promise<string>;
  dispose(): Promise<void>;
}

export interface OpencodeDeps {
  open(agent: string, cwd: string, opts?: { signal?: AbortSignal; timeoutMs?: number; model?: string }): Promise<OpencodeSession>;
  cleanupOrphans?(maxAgeMs: number): Promise<number>;
}

interface FinalVerdict {
  approved: boolean;
  specs: string[];
  specMetas?: SpecMeta[];
  note?: string;
  parsed: boolean; // false when NO verdict JSON was found (fail-closed default), so
                   // callers can distinguish "agent rejected" from "we couldn't parse it".
}

export async function runOpencode(
  input: OpencodeRunInput,
  deps: OpencodeDeps,
  opts?: { signal?: AbortSignal; onProgress?: (msg: string) => void },
): Promise<AgentResult> {
  const timeoutMs = agentTimeout(input.mode);
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
    const finalText = await session.prompt(buildPrompt(input));

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
      const entries: ManifestEntry[] = verdict.specMetas.map((m) => {
        const specPath = join(input.mirrorDir, input.e2eRelDir, m.file);
        const sha256 = sha256File(specPath);
        return {
          id: m.flow,
          objective: m.objective,
          flow: m.flow,
          targets: m.targets,
          changeRef: { sha: input.sha, type: changeType },
          ...(sha256 ? { sha256 } : {}),
        };
      });
      upsertManifest(
        realManifestFs,
        join(input.mirrorDir, input.e2eRelDir, ".qa", "manifest.json"),
        entries,
      );
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
  appName: string;
  mode: RunMode;
  target?: TestTarget; // "e2e" (default) or "code" — adjusts wording and spec paths
}

export interface ReviewResult {
  approved: boolean;
  corrections: string[];
  // false ONLY when NO verdict JSON could be parsed (a parse miss, not a real rejection).
  // Absent/true ⇒ a genuine verdict. Lets the caller avoid burning a regeneration round on
  // non-actionable feedback, and distinguish "reviewer is broken" from "tests rejected".
  parsed?: boolean;
}

// The reviewer is a bounded, read-only judge (10 steps, contents inlined in the prompt) —
// it must never inherit the generator's 25-minute worst-case budget: a hung reviewer would
// add that whole window to the run before the loop fails closed.
const REVIEWER_TIMEOUT_MS = Number(process.env.OPENCODE_REVIEWER_TIMEOUT_MS) || 6 * 60 * 1000;

export async function reviewIndependently(
  input: ReviewInput,
  deps: OpencodeDeps,
  opts?: { signal?: AbortSignal },
): Promise<ReviewResult> {
  const session = await deps.open("qa-reviewer", input.mirrorDir, { signal: opts?.signal, timeoutMs: REVIEWER_TIMEOUT_MS });
  try {
    const changeType = input.intent?.type ?? input.mode;
    const specBlock = renderReviewSpecs(input);
    const kind = input.target === "code" ? "tests" : "E2E tests";
    const prompt = [
      `## Independent review — judge these ${kind} WITHOUT the generator's reasoning`,
      ``,
      `You are reviewing tests written for this commit, but you have NO access to the`,
      `generator's thought process. Judge the tests on their own merit using the`,
      `test-value-review skill.`,
      ``,
      `## Change context`,
      `- Commit type: ${changeType}`,
      `- Base URL: ${input.baseUrl ?? "(not provided)"}`,
      ``,
      `## Commit diff`,
      "```diff",
      sanitizeText(input.diff).text,
      "```",
      ``,
      specBlock,
      ``,
      `## Instructions`,
      `1. The spec contents are provided above — no need to read files.`,
      `2. Apply the test-value-review skill from BOTH perspectives (value + robustness).`,
      `3. Answer: could the changed feature be BROKEN and these tests STILL be green?`,
      `4. Be strict — a single anti-pattern in any spec means rejection.`,
      ``,
      `Output your verdict as JSON with no text before or after:`,
      `{"approved":false,"corrections":["file.spec.ts: specific actionable fix"]}`,
    ].join("\n");

    const output = await session.prompt(prompt);
    const json = lastJsonMatching(output, (x) => typeof x.approved === "boolean");
    if (json) {
      return {
        approved: json.approved === true,
        corrections: Array.isArray(json.corrections) ? (json.corrections as string[]) : [],
        parsed: true,
      };
    }
    // Fail-closed direction (no false green), but flagged as a PARSE MISS so the caller
    // does not mistake it for an actionable rejection and burn a regeneration round.
    return { approved: false, corrections: ["the independent reviewer produced no parseable verdict"], parsed: false };
  } finally {
    await session.dispose().catch((err) => {
      console.warn(`[qa] reviewer session dispose failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
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
    const symbols = Array.isArray(r.symbols) ? r.symbols.filter((s): s is string => typeof s === "string") : [];
    const needsUi = typeof r.needsUi === "boolean" ? r.needsUi : true; // default true: safe fallback
    out.push({ flow, objective, symbols, needsUi });
  }
  // De-duplicate by the RESULTING spec filename, so two distinct flow strings that normalize to
  // the same file (e.g. "Check Out" and "check-out") never have two workers write the same file.
  const seen = new Set<string>();
  return out.filter((o) => {
    const key = specFileForFlow(o.flow);
    return seen.has(key) ? false : (seen.add(key), true);
  });
}

// A spec filename derived from a flow, safe for the filesystem and Playwright's testMatch.
export function specFileForFlow(flow: string): string {
  const safe = flow.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "flow";
  return `flows/${safe}.spec.ts`;
}

interface ManifestEntry {
  id: string;
  objective: string;
  flow: string;
  targets: string[];
  changeRef: { sha: string; type: string };
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
  deps: OpencodeDeps,
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

// Surgical, self-contained instructions for ONE worker. Adapts based on needsUi:
// UI workers get the Playwright MCP and explore-before-write instructions; code-only
// workers use serena exclusively to derive tests from the affected symbols.
export function buildWorkerPrompt(w: ParallelWorkerInput): string {
  const rules = w.needsUi
    ? [
        w.baseUrl
          ? `- Explore YOUR flow FIRST with the Playwright MCP: browser_navigate to the LIVE DEV URL, browser_snapshot, and use ONLY selectors verified against the real DOM. Never invent selectors.`
          : `- No LIVE DEV URL: derive selectors from the code (serena) and note this limitation in a spec comment.`,
        `- Prefer getByRole/getByLabel/getByTestId; scope to a section; no waitForTimeout; no network mocks.`,
        `- At least ONE real assertion on the observable OUTCOME (not just a click). Clean up created data via cleanup().`,
      ]
    : [
        `- This is a CODE-ONLY objective (no UI). Read the affected symbols with serena, write unit/integration tests using the repo's test framework.`,
        `- Assert on BEHAVIOR (the correct output for given inputs), not implementation details. Include edge cases from the objective.`,
        `- Do NOT attempt to navigate or use browser tools — you have no Playwright MCP.`,
      ];
  return [
    `Write ONE test for this objective. Write ONLY your assigned file.`,
    ``,
    `## Objective`,
    sanitizeText(w.objective).text,
    ``,
    `## Context`,
    `- Flow: ${w.flow}`,
    `- Affected code symbols (read them with serena): ${w.symbols.join(", ") || "(none specified)"}`,
    `- Namespace prefix for any data you create: ${w.namespace}`,
    w.needsUi ? `- LIVE DEV URL: ${w.baseUrl ?? "(not provided)"}` : null,
    `- Write EXACTLY this file: ${w.e2eRelDir}/${w.specFile}  — do not create or edit any other file.`,
    w.needsUi ? `- Import the shared harness: import { test, expect } from "../fixtures"` : null,
    ``,
    `## Rules`,
    ...rules,
    `- Do NOT write to the manifest — the orchestrator records metadata. Do NOT read or edit other workers' files.`,
    ...(w.learnedRules
      ? [
          ``,
          `## Lessons learned from past runs (avoid repeating these)`,
          w.learnedRules,
        ]
      : []),
    `- End your reply with ONLY this JSON: {"spec":"${w.specFile}"}`,
  ].filter((l): l is string => l !== null).join("\n");
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
  deps: OpencodeDeps,
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
    return runOpencode(input, deps, opts);
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

// Phase-1 planning prompt: analyse the whole repo, persist the coverage/importance map, and
// return STRUCTURED objectives (no spec files). It must question its own list (drop naive flows,
// keep main use cases + MVP happy paths + relevant edge cases).
export function buildPlanPrompt(input: OpencodeRunInput): string {
  const lessonsBlock = input.learnedRules
    ? [``, `## Lessons learned from past runs (factor these into the objectives you plan)`, input.learnedRules]
    : [];
  if (input.mode === "diff") {
    return [
      `Plan E2E test objectives for the blast radius of commit ${input.sha} of ${input.repo}.`,
      ``,
      `## Phase 1 of 2 — PLANNING ONLY. Do NOT write any .spec.ts in this phase.`,
      `1. Activate serena (activate_project). Read the commit intent and diff below; derive the`,
      `   affected user flows (use find_referencing_symbols to widen from the changed symbols).`,
      `2. Plan one objective per INDEPENDENT affected flow. Do NOT plan flows the commit does not`,
      `   touch; if everything fits one flow, return a single objective.`,
      `   Each objective is a concrete acceptance criterion in given/when/then form, with the code`,
      `   symbols it exercises. Set "needsUi": true when the flow involves page navigation or DOM`,
      `   interaction, and "needsUi": false for pure logic.`,
      ``,
      `## Change intent (Conventional Commits)`,
      `- Type: ${input.intent?.type ?? "unknown"}${input.intent?.breaking ? " (BREAKING)" : ""}`,
      `- Message: ${sanitizeText(input.intent?.message ?? "").text}`,
      `- Changed files: ${input.intent?.changedFiles.join(", ") || "(unknown)"}`,
      ``,
      `## Commit diff`,
      "```diff",
      sanitizeText(input.diff).text,
      "```",
      ...(input.service
        ? [
            ``,
            `## Cross-repo change (microservice)`,
            `The commit belongs to the microservice ${input.service.repo} (read-only working copy at`,
            `${input.service.mirrorDir}). Plan objectives for the FRONTEND flows that exercise the`,
            `changed service behavior through the UI.`,
          ]
        : []),
      ...lessonsBlock,
      ``,
      `## Output — end with ONLY this JSON (no spec files):`,
      `{"objectives":[{"flow":"checkout","objective":"given a cart with >10 items, when paying, then the bulk discount is applied and the order is created","symbols":["CheckoutService.pay"],"needsUi":true}]}`,
      `If the commit's change is not testable through a user flow, output {"objectives":[]}.`,
    ].join("\n");
  }
  const exhaustive = input.mode === "exhaustive";
  return [
    exhaustive
      ? `Audit the ENTIRE E2E suite of ${input.repo} and plan a full regeneration.`
      : `Analyze the WHOLE repository ${input.repo} and plan where to GROW the E2E suite.`,
    ``,
    `## Phase 1 of 2 — PLANNING ONLY. Do NOT write any .spec.ts in this phase.`,
    `1. Activate serena (activate_project) and build a COVERAGE + IMPORTANCE map: read the existing`,
    `   specs in ${input.e2eRelDir}/ and the app code (get_symbols_overview, find_symbol,`,
    `   find_referencing_symbols) to find the important user flows and which are NOT covered.`,
    `2. Persist this map to ${input.e2eRelDir}/.qa/analysis.json (flows, covered vs uncovered,`,
    `   importance, lastSha:"${input.sha}"); update it incrementally if it already exists.`,
    exhaustive
      ? `3. Plan objectives for EVERY important flow (the suite is regenerated from scratch).`
      : `3. Plan objectives ONLY for the important UNCOVERED flows (the delta over the existing suite).`,
    `   QUESTION your own list before finalizing: drop trivial/naive items (a single button, static`,
    `   content); KEEP the main use cases, the MVP happy paths, AND the relevant edge cases`,
    `   (boundaries, error paths, negative/invalid input). Each objective is a concrete acceptance`,
    `   criterion in given/when/then form, with the code symbols it exercises.`,
    `   For each objective, set "needsUi": true when the flow involves page navigation or DOM`,
    `   interaction, and "needsUi": false for pure logic (validation, calculation, data transformation).`,
    ...lessonsBlock,
    ``,
    `## Output — end with ONLY this JSON (no spec files):`,
    `{"objectives":[{"flow":"checkout","objective":"given a cart with >10 items, when paying, then the bulk discount is applied and the order is created","symbols":["CheckoutService.pay"],"needsUi":true}]}`,
    `If every important flow is already well covered, output {"objectives":[]}.`,
  ].join("\n");
}

// Assembles the dynamic message for the agent. The "how" lives in
// opencode/agent/qa-generator.md and the skills; only the task + context go here.
// The diff/guidance are sanitized (cheap defense in depth).
export function buildPrompt(input: OpencodeRunInput): string {
  const isGenerationMode = input.mode !== "context";

  // Review-fix mode: prepend the reviewer's actionable corrections before anything else, so
  // the agent's first priority is to resolve them (the reviewer→generator feedback loop).
  const reviewBlock = input.reviewCorrections?.length && isGenerationMode
    ? [
        `## Apply reviewer corrections (HIGHEST priority)`,
        ``,
        `An independent reviewer REJECTED the previous specs. Fix EACH item below precisely;`,
        `do NOT rewrite specs that were not flagged. Where a fix concerns a selector or an`,
        `assertion, re-verify it against the live DOM with the Playwright MCP before editing.`,
        ``,
        ...input.reviewCorrections.map((c) => `- ${c}`),
        ``,
      ]
    : [];

  // Coverage-improvement mode: the executed tests did not exercise some changed lines. Tell the
  // agent exactly which, so it extends/adds tests to cover the change (the change-coverage loop).
  const coverageBlock = input.coverageGap && isGenerationMode
    ? [
        `## Cover the change (HIGH priority)`,
        ``,
        `The tests ran green but did NOT exercise all the lines this commit changed. Extend or add`,
        `tests so those lines are actually executed and asserted (covering ≠ asserting — assert the`,
        `behavior of the changed code, do not just touch the line):`,
        ``,
        input.coverageGap,
        ``,
      ]
    : [];

  const learnedRulesBlock = input.learnedRules && isGenerationMode
    ? [input.learnedRules, ``]
    : [];

  // Fix mode: prepend failure feedback before the original task.
  const fixBlock = input.fixCases?.length && isGenerationMode
    ? [
        `## Fix failing tests`,
        ``,
        `The following tests FAILED during execution against DEV. Fix ONLY these`,
        `tests; do NOT rewrite or touch tests that passed.`,
        ``,
        `Failed cases:`,
        ...input.fixCases.map(
          (c) => `- ${c.name}\n  Error: ${c.detail?.slice(0, 500) ?? "(no detail)"}`,
        ),
        ``,
        `For each failure, use the Playwright MCP to explore the page and verify`,
        `your fix BEFORE writing it:`,
        `1. Read the test file to understand what it asserts`,
        `2. Use browser_navigate + browser_snapshot to see the ACTUAL page structure`,
        `3. Fix the ROOT CAUSE, guided by the error type:`,
        `   - "strict mode violation" → scope the selector to a section first`,
        `   - "locator.click: … not found" → the element doesn't exist; check role/label`,
        `   - "expect(…).toBeVisible() timed out" → the element exists but isn't visible; check loading states`,
        `   - "NS_ERROR_…" / network error → the URL or route is wrong; verify with browser_navigate`,
        `   - "locator resolved to N elements" → use .first() ONLY as last resort; prefer scoping`,
        `4. PRESERVE each test's objective and assertions — fix only what's broken`,
      ]
    : [];

  const changeType = input.intent?.type ?? input.mode;
  const openapiHint = Array.isArray(input.openapi) ? input.openapi.join(", ") : input.openapi;
  const isCode = input.target === "code";
  const memTarget = input.mode === "context" ? "context" : input.target;
  return [
    ...reviewBlock,
    ...coverageBlock,
    ...learnedRulesBlock,
    ...fixBlock,
    ...(fixBlock.length ? [``] : []),
    buildTask(input),
    ``,
    ...(input.contextMap
      ? [
          renderArchitectureContext(
            input.contextMap,
            input.mode === "diff" ? input.intent?.changedFiles : undefined,
          ) ?? "",
          ``,
        ]
      : []),
    `## Working rules`,
    input.mode === "context"
      ? [
          `- This is a CONTEXT mode run: you are building the FE↔BE architecture map, not writing tests.`,
          `- Your ONLY output is ${input.e2eRelDir}/.qa/context.json — do not create or modify any .spec.ts files.`,
          `- Use ONLY serena to read code (activate_project, find_symbol, get_symbols_overview) — no Playwright MCP.`,
          `- Extract from STRUCTURED sources: every route from a routing file, every operation from an OpenAPI spec.`,
          `- Consult the architecture-mapping skill for detailed extraction patterns per source type.`,
          `- The task block above has the complete procedure. Follow it precisely.`,
        ]
      : isCode
      ? [
          `- This is a CODE mode run: you are testing source-code logic, not a deployed web app.`,
          `- Detect the test framework from the repo's dependencies. Read 2-3 existing test files for conventions. Match them exactly.`,
          `- Place generated tests alongside existing ones. Use the repo's existing test command. Do not install new dependencies.`,
          `- In your closing verdict JSON, include specMetas with {file, flow, objective, targets} for each spec so the orchestrator can write the manifest deterministically.`,
          `- Classify each affected symbol:`,
          `  * Pure function → unit test: call with inputs, assert outputs`,
          `  * Module with deps → integration test: real module + test doubles`,
          `  * Handler/endpoint → integration test: test client, real request, assert status + body`,
          `  * Trivial delegation/getter/setter → skip`,
          `- Assert on BEHAVIOR, not implementation. Include edge cases from the diff.`,
          `- One objective per test, derived from commit intent. Use realistic test data.`,
          `- Never write a test whose only assertion is "does not throw".`,
        ]
      : [
          `- Work in the repo's tests folder: ${input.e2eRelDir}/ (source of truth in git). Reuse and improve existing fixtures/specs; do not duplicate.`,
          `- In your closing verdict JSON, include specMetas with {file, flow, objective, targets} for each spec. The orchestrator writes the manifest deterministically from these.`,
          `- Test-data prefix: ${input.namespace}`,
          `- LIVE DEV URL: ${input.baseUrl ?? "(not provided — ABORT and report infra-error: no base URL)"}`,
          `  In the SPEC files, reach the app via the PW_BASE_URL env var (the orchestrator sets it at run time).`,
          `- Playwright MCP is AVAILABLE and you MUST use it BEFORE writing any test: browser_navigate to`,
          `  the LIVE DEV URL above, then browser_snapshot to read the ACTUAL DOM. Selectors MUST be verified`,
          `  against the real DOM, NEVER invented from code analysis alone.`,
          `- Also inspect runtime signals with the Playwright MCP: browser_console_messages (catch JS errors`,
          `  and warnings — a console error on the changed flow is a real bug signal) and browser_network_requests`,
          `  (read the actual API calls/responses the flow makes, and assert against their real shape — status,`,
          `  required fields, error responses — not invented contracts). Drive the backend through the UI only.`,
          `- Consult the playwright-authoring skill for robust specs and this app's capabilities.`,
          ...(openapiHint
            ? [
                `- OpenAPI contract(s) for this repo: ${openapiHint}. For any backend endpoint the affected flow touches, read the matching operation and assert against its contract (required fields, enums, validation/error responses). Drive the app through the web UI like a user — never call the API directly.`,
              ]
            : []),
        ],
    `- engram memory: scoped per app AND per mode (e2e, code, or context). Use project="${input.appName}" on ALL mem_save, mem_search, mem_context, and mem_session_summary calls. Prefix every topic_key with "${memTarget}/" so each mode's memory lives in its own namespace (e.g. topic_key="context/angular-routes" or "e2e/checkout-flow"). When searching, include "${memTarget}" in the query text to filter results to this mode. Never save or search without the mode prefix.`,
    input.needsReview
      ? `- An INDEPENDENT reviewer judges your specs after you finish and may return corrections for a follow-up turn. Self-review against the test-value-review criteria BEFORE finishing (every spec must fail if its feature breaks); do not rely on spawning a subagent.`
      : `- Review disabled for this run.`,
  ].join("\n");
}

// ── Architecture context injection ──────────────────────────────────────────
//
// The orchestrator loads e2e/.qa/context.json and passes it via contextMap. This
// function renders the relevant slice as a prompt section so the agent receives
// the FE↔BE map as a FIRST-CLASS input — no "read it if it exists" ambiguity.
// For diff mode, it filters to only the routes/operations touched by the changed
// files. For other modes (complete/exhaustive/manual), it renders the full map.

// context.json is read from the WATCHED repo (and committed by this system's own PRs), so
// it is attacker-influenceable. Every field is sanitized before it reaches the test-writing
// agent (prompt-injection / secret-exfil defense), and the map is BOUNDED so a huge file
// cannot blow the token budget. `s()` redacts; MAX_ITEMS caps each section.
export function renderArchitectureContext(
  ctx: ArchitectureContext,
  changedFiles?: string[],
): string | null {
  if (!ctx.routes?.length && !ctx.api?.length) return null;

  const s = (x: unknown): string => sanitizeText(String(x ?? "")).text;
  const MAX_ITEMS = 200;
  const MAX_LEN = 20_000;

  const relevantLinks = (changedFiles?.length
    ? ctx.feBe?.filter((link) => {
        // Scope by terms specific enough to be meaningful: a route of "/" (or any 1-2 char
        // term) is a substring of EVERY file path and would defeat the scoping entirely.
        const terms = [link.route, link.via ?? "", link.operationId].filter((t) => t && t.length >= 3);
        return changedFiles.some((f) => terms.some((t) => f.includes(t)));
      }) ?? ctx.feBe ?? []
    : ctx.feBe ?? []
  ).slice(0, MAX_ITEMS);

  const lines: string[] = [];
  lines.push("## Architecture context (from e2e/.qa/context.json)");
  lines.push(`Built at ${s(ctx.builtAtSha).slice(0, 7)} — the FE↔BE map this app's QA uses to cross the frontend→backend boundary.`);
  lines.push("");

  if (ctx.routes.length) {
    lines.push(`### Routes (${ctx.routes.length} entry points)`);
    for (const r of ctx.routes.slice(0, MAX_ITEMS)) {
      lines.push(`- \`${s(r.path)}\` → ${s(r.component ?? "(unknown component)")}${r.name ? ` ("${s(r.name)}")` : ""}`);
    }
    lines.push("");
  }

  if (ctx.api.length) {
    lines.push(`### API operations (${ctx.api.length} endpoints)`);
    for (const o of ctx.api.slice(0, MAX_ITEMS)) {
      lines.push(`- \`${s(o.operationId)}\`: ${s(o.method)} ${s(o.path)}${o.service ? ` (${s(o.service)})` : ""}`);
    }
    lines.push("");
  }

  if (relevantLinks.length) {
    lines.push(`### FE↔BE links (${relevantLinks.length} of ${ctx.feBe?.length ?? 0} total)`);
    lines.push("Each link tells you which frontend route calls which backend operation — use this to widen the blast radius:");
    for (const l of relevantLinks) {
      lines.push(`- Route \`${s(l.route)}\` → \`${s(l.operationId)}\`${l.via ? ` (via ${s(l.via)})` : ""}`);
    }
    lines.push("");
  }

  if (ctx.flows?.length) {
    lines.push("### Named flows");
    for (const f of ctx.flows.slice(0, MAX_ITEMS)) {
      const opList = f.operations?.length ? ` → ${f.operations.slice(0, MAX_ITEMS).map(s).join(", ")}` : "";
      lines.push(`- **${s(f.id)}**: ${f.routes.slice(0, MAX_ITEMS).map(s).join(", ")}${opList}`);
    }
    lines.push("");
  }

  lines.push("When the blast radius from the diff touches a route, use its FE↔BE links");
  lines.push("to also consider the backend operations — a frontend change can break backend");
  lines.push("behaviour and vice-versa.");
  const out = lines.join("\n");
  return out.length > MAX_LEN ? out.slice(0, MAX_LEN) + "\n…(context truncated)" : out;
}

// ── context mode: build the FE↔BE architecture map ──────────────────────────
//
// The agent extracts routes from Angular routing, API operations from OpenAPI specs,
// and joins them via the generated API clients' operationIds. The result is written
// to e2e/.qa/context.json and validated deterministically by the orchestrator.
// This map is then consumed by diff-mode runs to cross the FE→BE boundary without
// re-deriving the architecture from raw code on every run.

export function buildContextTask(input: OpencodeRunInput): string {
  const openapiHint = Array.isArray(input.openapi) ? input.openapi.join(", ") : input.openapi;
  const serviceLines = input.services?.length
    ? [
        ``,
        `## Microservice repos (${input.services.length})`,
        `This app's backend is split into microservices. Each repo below is mirrored READ-ONLY;`,
        `extract its OpenAPI operations into the SAME context.json, setting each operation's`,
        `"service" field to the repo name shown here:`,
        ``,
        ...input.services.flatMap((s) => {
          const hint = Array.isArray(s.openapi) ? s.openapi.join(", ") : s.openapi;
          return [
            `- **${s.repo}** — working copy at: ${s.mirrorDir}`,
            ...(hint ? [`  OpenAPI hint: ${hint} (relative to that working copy)`] : [`  No OpenAPI hint — search that working copy for openapi/swagger files.`]),
          ];
        }),
        ``,
        `The feBe JOIN is still derived from THIS frontend repo's API clients: a client method's`,
        `operationId must match an operation extracted from one of the services above (or from`,
        `this repo's own specs). Do not invent links for services the frontend never calls.`,
      ]
    : [];
  return [
    `Build or refresh the FE↔BE architecture map for ${input.repo}.`,
    ``,
    `## Goal`,
    `Produce a distilled map of the app's architecture so future QA runs can cross the`,
    `frontend→backend boundary without re-deriving it from raw code.`,
    ``,
    `## What to produce`,
    `Write a single JSON file at ${input.e2eRelDir}/.qa/context.json with these sections:`,
    ``,
    `1. **routes** — every frontend entry URL (the unit an E2E targets) + the component it renders.`,
    `   Extract FROM the Angular routing files (e.g. app.routes.ts, *.routes.ts).`,
    `   Required per entry: path (e.g. "/checkout"). Optional: name, component, source.`,
    ``,
    `2. **api** — every backend operation the app calls.`,
    `   Extract FROM the OpenAPI specs${openapiHint ? ` (hint: ${openapiHint})` : " (search with serena/glob for openapi or swagger files)"}.`,
    `   Required per entry: operationId, method (GET/POST/...), path. Optional: service, spec.`,
    ``,
    `3. **feBe** — the JOIN between frontend routes and backend operations: which route calls which operation.`,
    `   Derive BY following each generated API client method to its operationId.`,
    `   Required per entry: route (a path from routes), operationId (from api). Optional: via (the client method).`,
    `   THE JOIN IS THE WHOLE POINT: every link must resolve to a known route AND a known operation.`,
    ``,
    `4. **flows** (optional) — named user flows grouping routes + operations for readability.`,
    ...serviceLines,
    ``,
    `## Procedure`,
    `1. Activate serena (activate_project) on the working directory.`,
    `2. Find ALL Angular routing files (serena glob: **/*routes*.ts, **/app-routing*.ts).`,
    `   For each route definition (path + component), add an entry to routes.`,
    `3. Find ALL OpenAPI spec files${openapiHint ? ` (start with ${openapiHint})` : ""}.${input.services?.length ? " Include every microservice repo listed above (their working copies are local paths you can read)." : ""}`,
    `   For each operation (operationId + method + path), add an entry to api.`,
    `4. Find the generated API client files (typically src/app/generated/ or similar).`,
    `   For each client method that calls a backend operation, map its call site to a route`,
    `   and add the link to feBe. The operationId in the client MUST match an api entry.`,
    `5. Self-validate: every feBe route exists in routes AND every feBe operationId exists in api.`,
    `   Remove any dangling link BEFORE writing.`,
    `6. Write ${input.e2eRelDir}/.qa/context.json with the four sections + "builtAtSha":"${input.sha}".`,
    ``,
    `## Rules`,
    `- Extract from STRUCTURED sources, never invent. Every route comes from a routing file;`,
    `  every operation from an OpenAPI spec; every link from a generated client.`,
    `- If no OpenAPI spec is found, leave api and feBe empty (a repo with no backend).`,
    `- If routing is file-based (not a central Routes array), enumerate the route files.`,
    `- Do NOT guess or hallucinate paths/operationIds. If a source is missing, leave that section empty.`,
    `- Keep the map small: this is an E2E authoring aid, not exhaustive documentation.`,
    ``,
    `## Output`,
    `End with ONLY this JSON (no other text):`,
    `{"approved":true,"specs":["${input.e2eRelDir}/.qa/context.json"],"note":"built architecture map with X routes, Y api operations, Z links"}`,
  ].join("\n");
}

// The mode-specific task block.
function buildTask(input: OpencodeRunInput): string {
  if (input.mode === "complete" || input.mode === "exhaustive") {
    return [
      input.mode === "exhaustive"
        ? `Audit and REGENERATE the entire E2E suite of ${input.repo} from scratch.`
        : `Analyze the WHOLE repository ${input.repo} and grow the E2E suite where it matters.`,
      ``,
      `1. Read the existing tests in ${input.e2eRelDir}/ and the app code (use serena:`,
      `   activate_project, get_symbols_overview, find_symbol, find_referencing_symbols) to`,
      `   build a COVERAGE + IMPORTANCE map: which user flows already have tests and which`,
      `   important/complex flows do NOT. Until real coverage instrumentation exists,`,
      `   estimate coverage by reading the existing specs and the code.`,
      `2. Persist this analysis in ${input.e2eRelDir}/.qa/analysis.json (flows, covered vs`,
      `   uncovered, importance, lastSha:"${input.sha}") so it need not be redone from`,
      `   scratch next time; if it already exists, update it incrementally.`,
      input.mode === "exhaustive"
        ? `3. Re-evaluate EVERY existing test for correctness, value and necessity (apply the test-value-review criteria): remove or rewrite tests that are trivial, false positives, redundant or obsolete. Ensure every important flow is covered — a fully re-evaluated suite, not a delta.`
        : `3. Generate tests ONLY for the important UNCOVERED flows (the delta over the existing suite). Do not duplicate existing coverage.`,
    ].join("\n");
  }
  if (input.mode === "manual") {
    return [
      `Generate/update E2E tests for ${input.repo}, FOCUSED on the following guidance:`,
      ``,
      sanitizeText(input.guidance ?? "(no guidance provided)").text,
      ``,
      `Use serena to read the relevant code and the existing ${input.e2eRelDir}/ suite.`,
      `Stay focused on the guidance; do not generate unrelated tests.`,
    ].join("\n");
  }
  if (input.mode === "context") return buildContextTask(input);

  // diff (default)
  const intent = input.intent;
  const svcOpenapi = Array.isArray(input.service?.openapi) ? input.service.openapi.join(", ") : input.service?.openapi;
  const serviceBlock = input.service
    ? [
        ``,
        `## Cross-repo change (microservice)`,
        `The commit under test belongs to the microservice ${input.service.repo}, NOT to this frontend repo.`,
        `- The service's working copy (READ-ONLY) is at: ${input.service.mirrorDir}`,
        ...(svcOpenapi ? [`- The service's OpenAPI contract(s): ${svcOpenapi} (paths relative to that working copy)`] : []),
        `- Use the architecture context below (operations whose service matches this repo) plus the`,
        `  service's code and contract to find which frontend routes and flows this change affects.`,
        `- Exercise the backend ONLY through the frontend UI at the LIVE DEV URL — never call the service directly.`,
      ]
    : [];
  return [
    `Generate/update E2E tests for the flows affected by commit ${input.sha} of ${input.repo}.`,
    ``,
    `## Change intent (Conventional Commits)`,
    `- Type: ${intent?.type ?? "unknown"}${intent?.breaking ? " (BREAKING)" : ""}`,
    `- Message: ${sanitizeText(intent?.message ?? "").text}`,
    `- Changed files (derive the scope/area from these): ${intent?.changedFiles.join(", ") || "(unknown)"}`,
    `The message gives the INTENT; derive each test's objective from it. But CROSS-CHECK`,
    `against the diff: if the code does more than the message claims, cover what the code`,
    `actually changes, not just what the message promises.`,
    ``,
    `## Commit diff`,
    "```diff",
    sanitizeText(input.diff).text,
    "```",
    ...serviceBlock,
    ``,
    `## Architecture context`,
    `If ${input.e2eRelDir}/.qa/context.json exists, READ it to understand which routes and`,
    `API operations the changed files belong to. Use the feBe links to widen the blast`,
    `radius across the frontend→backend boundary: a frontend change may affect the`,
    `backend behaviour and vice-versa. If the map is missing or stale, note the`,
    `limitation explicitly in your verdict note.`,
  ].join("\n");
}

// Extracts every BALANCED top-level JSON object from free-form agent text, respecting
// string literals and escapes (so a `}` inside a string, or nested objects, never mis-split
// the span). Returns them in document order; callers take the last one matching their shape.
// This replaces brittle regex/lastIndexOf scanning of the agent's closing JSON.
export function extractJsonObjects(text: string): unknown[] {
  const objs: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          try {
            objs.push(JSON.parse(text.slice(start, i + 1)));
          } catch {
            /* not valid JSON; ignore this span */
          }
          start = -1;
        }
      }
    }
  }
  return objs;
}

// Returns the LAST extracted JSON object for which `pred` holds, or undefined.
function lastJsonMatching<T = Record<string, unknown>>(text: string, pred: (o: Record<string, unknown>) => boolean): T | undefined {
  const objs = extractJsonObjects(text);
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    if (o && typeof o === "object" && pred(o as Record<string, unknown>)) return o as T;
  }
  return undefined;
}

// Extracts the agent's closing verdict JSON: the LAST balanced object carrying a boolean
// `approved`. If none is valid, assumes not approved (fail-closed) so nothing publishes by
// accident, and flags `parsed:false` so callers can tell a parse miss from a real rejection.
export function parseVerdict(text: string): FinalVerdict {
  const o = lastJsonMatching(text, (x) => typeof x.approved === "boolean");
  if (o) {
    return {
      approved: o.approved as boolean,
      specs: Array.isArray(o.specs) ? (o.specs as string[]) : [],
      specMetas: parseSpecMetas(o.specMetas),
      note: typeof o.note === "string" ? o.note : undefined,
      parsed: true,
    };
  }
  return { approved: false, specs: [], note: "the agent emitted no parseable verdict", parsed: false };
}

function parseSpecMetas(raw: unknown): SpecMeta[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const metas: SpecMeta[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const file = typeof e.file === "string" ? e.file.trim() : "";
    const flow = typeof e.flow === "string" ? e.flow.trim() : "";
    const objective = typeof e.objective === "string" ? e.objective.trim() : "";
    const targets = Array.isArray(e.targets)
      ? e.targets.filter((t): t is string => typeof t === "string")
      : [];
    if (file && flow && objective) {
      metas.push({ file, flow, objective, targets });
    }
  }
  return metas.length > 0 ? metas : undefined;
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

// Integration boundary: real connection to `opencode serve`. Not covered by unit
// tests (like the Playwright runner). The SDK is imported lazily so tests do not
// require the package. OPENCODE_SERVE_URL points to the `opencode` container.
export async function defaultOpencodeDeps(): Promise<OpencodeDeps> {
  const dispatcherTimeoutMs = Number(process.env.OPENCODE_TIMEOUT_MS) || MAX_AGENT_TIMEOUT_MS;
  // Raise undici timeouts for the worst-case agent turn (exhaustive = 25 min) so our per-prompt
  // withTimeout is the effective deadline, and route through any configured HTTP proxy.
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

      // Wire external abort signal (cancel endpoint) to session deletion.
      const onAbort = () => client.session.delete({ path: { id } }).catch(() => {});
      opts?.signal?.addEventListener("abort", onAbort, { once: true });

      const promptTimeoutMs = opts?.timeoutMs ?? dispatcherTimeoutMs;

      return {
        id,
        prompt: (text) =>
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
                    recordCircuitSuccess();
                    return extractText(res.data?.parts);
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
          ),
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

// Concatenates the text of the text parts in the agent's response.
function extractText(parts: Array<{ type: string }> | undefined): string {
  return (parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}
