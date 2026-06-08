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
import { AgentResult, QaCase, RunMode, TestTarget } from "../types";
import { CommitIntent } from "../qa/commit-classify";
import { sanitizeText } from "../orchestrator/sanitizer";
import { ActivityRouter } from "./agent-activity";
import { appendLog } from "../server/history";
import { installHttpDispatcher } from "../util/net";

interface SessionEntry {
  id: string;
  agent: string;
  cwd: string;
  openedAt: number;
}

const sessionRegistry = new Map<string, SessionEntry>();

// Shared OpenCode SDK client — lazy-initialised once, reused by SSE stream AND
// session operations. This avoids creating two independent HTTP connections to
// the OpenCode server (official best practice: one client, many operations).
let sharedClient: Awaited<ReturnType<typeof import("@opencode-ai/sdk").createOpencodeClient>> | undefined;

async function getSharedClient() {
  if (sharedClient) return sharedClient;
  const { createOpencodeClient } = await import("@opencode-ai/sdk");
  const serverPassword = process.env.OPENCODE_SERVER_PASSWORD;
  sharedClient = createOpencodeClient({
    baseUrl: process.env.OPENCODE_SERVE_URL ?? "http://opencode:4096",
    ...(serverPassword
      ? { headers: { Authorization: `Basic ${Buffer.from(`opencode:${serverPassword}`).toString("base64")}` } }
      : {}),
  });
  return sharedClient;
}

export function disposeSharedClient(): void {
  sharedClient = undefined;
}

// SSE live activity: routes OpenCode events to RunRecord logs in real time.
export const activityRouter = new ActivityRouter();

// Maps an OpenCode session to a run so SSE events are routed to the correct RunRecord.
export function registerRunSession(sessionId: string, runId: string): void {
  activityRouter.register(sessionId, runId);
}

export function unregisterRunSession(sessionId: string): void {
  activityRouter.unregister(sessionId);
}

// Subscribes to OpenCode's global SSE event stream and routes every event through
// the activityRouter. `onActivity` is called for each successfully routed event
// with the runId and human-readable text. Runs until aborted.
export async function startEventStream(
  onActivity: (runId: string, text: string) => void,
  signal?: AbortSignal,
): Promise<void> {
  const client = await getSharedClient();

  // The SDK's global.event() returns a Promise<ServerSentEventsResult> whose
  // `.stream` is an AsyncGenerator yielding GlobalEvent { directory, payload }.
  const result = await client.global.event();
  const stream = result.stream;
  if (!stream) {
    console.warn("[qa] SSE event stream returned no stream");
    return;
  }

  const abortHandler = () => { /* handled by `if (signal?.aborted) break` below */ };
  signal?.addEventListener("abort", abortHandler, { once: true });

  try {
    for await (const event of stream) {
      if (signal?.aborted) break;

      const payload = event.payload;
      if (!payload?.type) continue;

      const activity = activityRouter.route({
        type: payload.type,
        properties: payload.properties,
      });

      if (activity) {
        // Concise display: file → basename, tool → first 3 args, todo → strip prefix.
        let display = activity.text;
        if (activity.kind === "file") {
          display = display.replace(/^edited /, "").split("/").pop() ?? display;
          display = `wrote ${display}`;
        } else if (activity.kind === "tool") {
          display = display.replace(/^ran: /, "");
          const parts = display.split(" ");
          if (parts.length > 3) display = parts.slice(0, 3).join(" ") + " …";
        } else if (activity.text.startsWith("todo [")) {
          display = activity.text.replace(/^todo \[.*?\] /, "");
        }
        // Match the TUI's visual identity: ✓/✗/·/⚠/⚙/⊘ — no emoji.
        const prefix = activity.kind === "message" ? "✎" : activity.kind === "file" ? "✎" : activity.kind === "tool" ? "⚙" : activity.text.includes("error") ? "⚠" : "▸";
        onActivity(activity.runId, `[qa] ${prefix} ${display}`);
      }
    }
  } catch (err) {
    if (!signal?.aborted) {
      console.warn(`[qa] SSE event stream error: ${err instanceof Error ? err.message : String(err)}`);
    }
  } finally {
    signal?.removeEventListener("abort", abortHandler);
    console.log("[qa] SSE event stream closed");
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
    `Answer the operator's question about this QA run using ONLY the run context below.`;
  const session = await deps.open("qa-assistant", cwd);
  try {
    return await session.prompt([
      instruction,
      `Do not use any tools. If the context does not contain the answer, say so plainly.`,
      ``,
      `## Context`,
      input.context,
      ``,
      `## Question`,
      input.question,
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
  runId?: string; // maps the session to a RunRecord for SSE live activity
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
  open(agent: string, cwd: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<OpencodeSession>;
  cleanupOrphans?(maxAgeMs: number): Promise<number>;
}

interface FinalVerdict {
  approved: boolean;
  specs: string[];
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
    registerRunSession(session.id, input.runId);
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

    return {
      output: finalText,
      specs: verdict.specs,
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
}

export interface ReviewResult {
  approved: boolean;
  corrections: string[];
  // false ONLY when NO verdict JSON could be parsed (a parse miss, not a real rejection).
  // Absent/true ⇒ a genuine verdict. Lets the caller avoid burning a regeneration round on
  // non-actionable feedback, and distinguish "reviewer is broken" from "tests rejected".
  parsed?: boolean;
}

export async function reviewIndependently(
  input: ReviewInput,
  deps: OpencodeDeps,
  opts?: { signal?: AbortSignal },
): Promise<ReviewResult> {
  const session = await deps.open("qa-reviewer", input.mirrorDir, { signal: opts?.signal });
  try {
    const changeType = input.intent?.type ?? input.mode;
    const prompt = [
      `## Independent review — judge these E2E tests WITHOUT the generator's reasoning`,
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
      `## Specs to review`,
      ...input.specs.map((s, i) => `${i + 1}. ${input.e2eRelDir}/${s}`),
      ``,
      `## Instructions`,
      `1. Read each spec file listed above (they are in ${input.e2eRelDir}/).`,
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
    out.push({ flow, objective, symbols });
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
  specFile: string; // orchestrator-assigned path under e2eRelDir (e.g. "flows/checkout.spec.ts")
  repo: string;
  mirrorDir: string;
  e2eRelDir: string;
  namespace: string;
  baseUrl?: string;
  appName: string;
  mode: RunMode;
}

// Dispatch each worker objective to a SEPARATE qa-worker session, bounded concurrency. Each
// worker writes ONE spec; failures are isolated per worker (one bad worker never aborts the
// batch). Returns the flow→spec mapping (for the manifest) plus per-flow errors.
export async function generateParallel(
  workers: ParallelWorkerInput[],
  deps: OpencodeDeps,
  opts?: { signal?: AbortSignal; concurrency?: number },
): Promise<{ results: Array<{ flow: string; spec: string }>; errors: string[] }> {
  if (workers.length === 0) return { results: [], errors: [] };
  const concurrency = opts?.concurrency ?? Math.min(workers.length, 5);
  const results: Array<{ flow: string; spec: string }> = [];
  const errors: string[] = [];

  for (let i = 0; i < workers.length; i += concurrency) {
    const batch = workers.slice(i, i + concurrency);
    await Promise.all(
      batch.map(async (w) => {
        try {
          const session = await deps.open("qa-worker", w.mirrorDir, { signal: opts?.signal });
          try {
            const output = await session.prompt(buildWorkerPrompt(w));
            const json = lastJsonMatching(output, (x) => typeof x.spec === "string");
            if (json?.spec) results.push({ flow: w.flow, spec: json.spec as string });
            else errors.push(`${w.flow}: worker produced no parseable spec name`);
          } finally {
            await session.dispose().catch(() => {});
          }
        } catch (err) {
          errors.push(`${w.flow}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }),
    );
  }
  return { results, errors };
}

// Surgical, self-contained instructions for ONE worker. The worker has serena + Playwright MCP
// and writes exactly its assigned file; it must NOT touch the manifest or other specs.
export function buildWorkerPrompt(w: ParallelWorkerInput): string {
  return [
    `Write ONE Playwright E2E spec for this objective. Write ONLY your assigned file.`,
    ``,
    `## Objective`,
    sanitizeText(w.objective).text,
    ``,
    `## Context`,
    `- Flow: ${w.flow}`,
    `- Affected code symbols (read them with serena): ${w.symbols.join(", ") || "(none specified)"}`,
    `- Namespace prefix for any data you create: ${w.namespace}`,
    `- LIVE DEV URL: ${w.baseUrl ?? "(not provided)"}`,
    `- Write EXACTLY this file: ${w.e2eRelDir}/${w.specFile}  — do not create or edit any other file.`,
    `- Import the shared harness: import { test, expect } from "../fixtures"`,
    ``,
    `## Rules`,
    w.baseUrl
      ? `- Explore YOUR flow FIRST with the Playwright MCP: browser_navigate to the LIVE DEV URL, browser_snapshot, and use ONLY selectors verified against the real DOM. Never invent selectors.`
      : `- No LIVE DEV URL: derive selectors from the code (serena) and note this limitation in a spec comment.`,
    `- Prefer getByRole/getByLabel/getByTestId; scope to a section; no waitForTimeout; no network mocks.`,
    `- At least ONE real assertion on the observable OUTCOME (not just a click). Clean up created data via cleanup().`,
    `- Do NOT write to the manifest — the orchestrator records metadata. Do NOT read or edit other workers' files.`,
    `- End your reply with ONLY this JSON: {"spec":"${w.specFile}"}`,
  ].join("\n");
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
  if (input.runId) registerRunSession(planSession.id, input.runId);
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

  // Phase 2 — FAN-OUT to workers (one spec each).
  const changeType = input.intent?.type ?? input.mode;
  const workers: ParallelWorkerInput[] = objectives.map((o) => ({
    objective: o.objective,
    flow: o.flow,
    symbols: o.symbols,
    specFile: specFileForFlow(o.flow),
    repo: input.repo,
    mirrorDir: input.mirrorDir,
    e2eRelDir: input.e2eRelDir,
    namespace: input.namespace,
    baseUrl: input.baseUrl,
    appName: input.appName,
    mode: input.mode,
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
    reviewed: false,
    approved: specs.length > 0, // overridden by the orchestrator's independent reviewer when enabled
    note: errors.length ? `worker errors: ${errors.join("; ")}` : undefined,
  };
}

// Phase-1 planning prompt: analyse the whole repo, persist the coverage/importance map, and
// return STRUCTURED objectives (no spec files). It must question its own list (drop naive flows,
// keep main use cases + MVP happy paths + relevant edge cases).
export function buildPlanPrompt(input: OpencodeRunInput): string {
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
    ``,
    `## Output — end with ONLY this JSON (no spec files):`,
    `{"objectives":[{"flow":"checkout","objective":"given a cart with >10 items, when paying, then the bulk discount is applied and the order is created","symbols":["CheckoutService.pay"]}]}`,
    `If every important flow is already well covered, output {"objectives":[]}.`,
  ].join("\n");
}

// Assembles the dynamic message for the agent. The "how" lives in
// opencode/agent/qa-generator.md and the skills; only the task + context go here.
// The diff/guidance are sanitized (cheap defense in depth).
export function buildPrompt(input: OpencodeRunInput): string {
  // Review-fix mode: prepend the reviewer's actionable corrections before anything else, so
  // the agent's first priority is to resolve them (the reviewer→generator feedback loop).
  const reviewBlock = input.reviewCorrections?.length
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
  const coverageBlock = input.coverageGap
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

  // Fix mode: prepend failure feedback before the original task.
  const fixBlock = input.fixCases?.length
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
        `5. Update the manifest if the test id or targets changed`,
      ]
    : [];

  const changeType = input.intent?.type ?? input.mode;
  const openapiHint = Array.isArray(input.openapi) ? input.openapi.join(", ") : input.openapi;
  const isCode = input.target === "code";
  return [
    ...reviewBlock,
    ...coverageBlock,
    ...fixBlock,
    ...(fixBlock.length ? [``] : []),
    buildTask(input),
    ``,
    `## Working rules`,
    isCode
      ? [
          `- This is a CODE mode run: you are testing source-code logic, not a deployed web app.`,
          `- Detect the test framework from the repo's dependencies. Read 2-3 existing test files for conventions. Match them exactly.`,
          `- Place generated tests alongside existing ones. Use the repo's existing test command. Do not install new dependencies.`,
          `- For each test, record metadata in ${input.e2eRelDir}/.qa/manifest.json with { id, objective, targets, changeRef:{sha:"${input.sha}",type:"${changeType}"} }.`,
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
          `- For each test, add/update its entry in ${input.e2eRelDir}/.qa/manifest.json with { id, objective, flow, targets, changeRef:{sha:"${input.sha}",type:"${changeType}"} }.`,
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
    `- engram memory: scoped per app AND per mode (e2e or code). Use project="${input.appName}" on ALL mem_save, mem_search, mem_context, and mem_session_summary calls. Prefix every topic_key with "${input.target}/" so each mode's memory lives in its own namespace (e.g. topic_key="e2e/checkout-flow" or "code/order-total", not "checkout-flow"). When searching, include "${input.target}" in the query text to filter results to this mode. Never save or search without the mode prefix.`,
    input.needsReview
      ? `- An INDEPENDENT reviewer judges your specs after you finish and may return corrections for a follow-up turn. Self-review against the test-value-review criteria BEFORE finishing (every spec must fail if its feature breaks); do not rely on spawning a subagent.`
      : `- Review disabled for this run.`,
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
  // diff (default)
  const intent = input.intent;
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
      note: typeof o.note === "string" ? o.note : undefined,
      parsed: true,
    };
  }
  return { approved: false, specs: [], note: "the agent emitted no parseable verdict", parsed: false };
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
            client.session
              .prompt({
                path: { id },
                query: { directory: cwd },
                body: { agent, parts: [{ type: "text", text }] },
              })
              .then((res) => {
                if (res.error) throw new Error(`OpenCode session.prompt failed: ${JSON.stringify(res.error)}`);
                return extractText(res.data?.parts);
              }),
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
