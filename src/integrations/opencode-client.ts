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
import { QaCase, RunMode, TestTarget, SpecMeta } from "../types";
import type { CommitIntent } from "@contexts/generation/application/ports/generation-ports.ts";
import type { ArchitectureContext } from "../qa/context";
import { type ExplorationBrief, parseExplorationBrief, coerceExplorationBrief, renderExplorationBrief } from "../qa/exploration-brief";
// migration-tier-4c Slice 5a: skill-exemplar.ts relocated to qa-engine (a prompts.ts rider) — this
// type-only import re-points there. Shell importing qa-engine is open by design (the shell consumes
// the engine, never the reverse).
import type { StructuralPattern } from "@contexts/generation/infrastructure/prompt-builders/skill-exemplar.ts";
import { saveAgentTurn } from "../server/history";
// migration-tier-4c Slice 5b (D-4c-6 split-brain fix): configFromEnv resolves the REAL, env/dual-mode
// aware runtime model assignments (src/agent-runtime/config.ts) — the source of truth for what model
// each visible role (primary/reviewer/chat) actually executes under, as opposed to agents/
// opencode.json's own OpenCode-only roster. Type-only imports already cross this same file<->
// agent-runtime boundary in the opposite direction (agent-runtime/types.ts imports AgentDeps etc.
// from here); this VALUE import does not create a runtime cycle since config.ts itself has no value
// dependency back on this module.
import { configFromEnv } from "../agent-runtime/config";
import { setRuntimeRoleModels } from "@contexts/generation/infrastructure/prompt-builders/model-window-catalog";
import { installHttpDispatcher } from "../util/net";

// migration-tier-4c Slice 3 (D-4c-2, SSE two-tier split): activityRouter/registerRunSession/
// unregisterRunSession/LiveActivity/EventStreamManager/startActivitySink + the riders
// (activity-mapper.ts, agent-activity.ts, reexplore.ts) all MIGRATED to qa-engine's
// generation/infrastructure/sse/event-stream.ts — see buildRawAgentTransport's own header for the
// same two-tier rationale applied to the SSE lifecycle. Re-exported below so every existing
// importer of these names from "./opencode-client" keeps working unchanged.
import {
  activityRouter,
  registerRunSession,
  unregisterRunSession,
  startActivitySink,
  setRawEventStreamOpener,
  type LiveActivity,
  type RawEventStreamOpener,
} from "@contexts/generation/infrastructure/sse/event-stream";
export { activityRouter, registerRunSession, unregisterRunSession, startActivitySink };
export type { LiveActivity };

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
// migration-tier-4c Slice 5a: prompts.ts (+ its riders skill-exemplar.ts/structural-pattern.ts/
// context-assembler.ts/model-window-catalog.ts) relocated to qa-engine's generation/infrastructure/
// prompt-builders/ — re-pointed below, re-export contract unchanged so every existing importer keeps
// resolving these names from this module (same BND-08 re-export convention as the verdict-parse
// import above).
import {
  specFileForFlow,
  buildWorkerPrompt,
  buildWorkerPromptAssembled,
  buildPrompt,
  buildPromptAssembled,
  buildExplorerPrompt,
  buildContextTask,
  renderArchitectureContext,
  buildReviewerPrompt,
  buildReviewerPromptAssembled,
  reviewObjective,
  renderReviewSpecs,
  renderExecutionResult,
  setExplorationBriefCollaborators,
} from "@contexts/generation/infrastructure/prompt-builders/prompts";
export { specFileForFlow, buildWorkerPrompt, buildWorkerPromptAssembled, buildPrompt, buildPromptAssembled, buildExplorerPrompt, buildContextTask, renderArchitectureContext, buildReviewerPrompt, buildReviewerPromptAssembled, reviewObjective, renderReviewSpecs, renderExecutionResult };
export type { AssembledPrompt, ExecutionResultCase } from "@contexts/generation/infrastructure/prompt-builders/prompts";

// migration-tier-4c Slice 5a (D-4c-6 twin wiring): the previously-dormant ExplorationBriefAdapter
// (qa-engine/.../exploration-brief.adapter.ts) needed a genuine production call path once prompts.ts
// relocated to qa-engine (its `renderExplorationBrief` collaborator can no longer reach
// src/qa/exploration-brief.ts directly). Wired HERE, at THIS module's load, mirroring
// `setRawEventStreamOpener` below (Slice 3) exactly — same "shell resolves the real, shell-resident
// implementation once and injects it" discipline. This module is imported both directly (every
// existing consumer of buildPrompt/buildWorkerPrompt/etc. via "./opencode-client") and transitively
// by src/server/rewritten-engine-factory.ts (which imports REVIEWER_TIMEOUT_MS/withUsageSink/etc.
// from here already), so wiring it in ONE place covers every real production and test entry point —
// no duplicate wiring needed at the composition-root file.
setExplorationBriefCollaborators({ parseExplorationBrief, coerceExplorationBrief, renderExplorationBrief });

// migration-tier-4c Slice 5b (D-4c-6, the split-brain fix): wire the REAL runtime model assignments
// (env/dual-mode aware) into model-window-catalog's injection seam, ONCE at this module's load — same
// "shell resolves config once, injects into qa-engine" discipline as the ExplorationBriefAdapter
// wiring just above. Only the three VISIBLE roles (primary/reviewer/chat) have their own
// AgentRuntimeConfig assignment; roleWindowBytes falls back to agents/opencode.json for every other
// role (workers, explorer, maintainer, reflector), unchanged. See model-window-catalog.ts's own
// header for the full before/after rationale.
const runtimeConfig = configFromEnv();
setRuntimeRoleModels({
  primary: runtimeConfig.assignments.primary.model,
  reviewer: runtimeConfig.assignments.reviewer.model,
  chat: runtimeConfig.assignments.chat.model,
});

// migration-tier-4c Slice 2 (D-4c-1, two-tier transport split): circuit-breaker.ts, stall-watchdog.ts,
// the AgentDeps open/prompt POLICY (fallback-model retry, circuit-breaker gating, turn/usage
// telemetry assembly, sanitize-before-emit), the AgentDeps/AgentSession/AgentOpenDescriptor/
// AgentTurnEvent types, and the withStallWatchdog/withUsageSink/withSessionRegistration decorators
// all MIGRATED to qa-engine (agent-transport-policy.ts + resilience/) — this module keeps ONLY the
// raw @opencode-ai/sdk I/O closure (client construction, session.create/prompt/abort/delete),
// injected into qa-engine's createAgentDeps as a RawAgentTransport. Re-exported below so every
// existing importer of these names from "./opencode-client" keeps working unchanged (same pattern as
// the verdict-parse/prompts re-exports above).
import {
  checkCircuit,
  recordCircuitSuccess,
  recordCircuitFailure,
  resetCircuit,
} from "@contexts/generation/infrastructure/resilience/circuit-breaker";
export { resetCircuit };
import {
  createAgentDeps,
  parseModelRef,
  withTimeout,
  agentErrorToInfra,
  withStallWatchdog,
  withUsageSink,
  withSessionRegistration,
  getOpenSessions as engineGetOpenSessions,
  getOpenSessionCount as engineGetOpenSessionCount,
  registerSessionWatchdogNotify,
  unregisterSessionWatchdogNotify,
  notifySessionActivity,
  type AgentDeps,
  type AgentSession,
  type AgentOpenDescriptor,
  type AgentTurnEvent,
  type UsageSnapshot,
  type RawAgentTransport,
  type RawPromptResult,
  type RawAgentErrorPayload,
} from "@contexts/generation/infrastructure/agent-transport-policy";
export {
  parseModelRef,
  withTimeout,
  agentErrorToInfra,
  withStallWatchdog,
  withUsageSink,
  withSessionRegistration,
  registerSessionWatchdogNotify,
  unregisterSessionWatchdogNotify,
  notifySessionActivity,
};
export type { AgentDeps, AgentSession, AgentOpenDescriptor, AgentTurnEvent, UsageSnapshot };

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

// migration-tier-4c Slice 3 (D-4c-2, SSE two-tier split): activityRouter/registerRunSession/
// unregisterRunSession/LiveActivity/startScopedEventStream/OpenStreamFn/EventStreamManager/
// startActivitySink/EventStreamReconnectOptions/startEventStreamWithReconnect (+ the riders
// activity-mapper.ts, agent-activity.ts, reexplore.ts) all MIGRATED to qa-engine's
// generation/infrastructure/sse/ — SDK-free lifecycle/mapping POLICY. The genuinely raw primitive
// (opening ONE scoped event.subscribe and handing back the raw async-iterable) stays here, injected
// into qa-engine via setRawEventStreamOpener at module load — mirrors Slice 2's buildRawAgentTransport.
const rawEventStreamOpener: RawEventStreamOpener = {
  open: async (directory) => {
    const client = await getEventClient();
    const result = await client.event.subscribe({ directory });
    return result.stream as AsyncIterable<{ type?: string; properties?: Record<string, unknown> }> | undefined;
  },
};
setRawEventStreamOpener(rawEventStreamOpener);

// migration-tier-4c Slice 4 (D-4c-4, chat/session-count shell split): why shell — these two are
// permanent D1-family control-plane surfaces. The session registry itself lives in qa-engine
// (agent-transport-policy.ts, migrated Slice 2), but the shell keeps a thin re-exported accessor
// because its callers (src/index.ts's `/ask` + Prometheus metrics, src/cli.ts's `hasOpenSessions`,
// src/server/api.ts's health/status endpoint) are themselves permanent shell control-plane code —
// re-pointing them straight at qa-engine would blur the one-way shell→qa-engine dependency direction
// (arch:check forbids qa-engine importing src/, but shell importing qa-engine is fine and IS this
// re-export). No policy lives here: both functions are pure delegation, zero logic of their own.
export function getOpenSessions(): ReturnType<typeof engineGetOpenSessions> {
  return engineGetOpenSessions();
}

export function getOpenSessionCount(): number {
  return engineGetOpenSessionCount();
}

// migration-tier-4c Slice 4 (D-4c-4): why shell — askAssistant is a permanent D1-family control-plane
// surface (the `/ask` HTTP handler's read-only Q&A entry point, src/index.ts:566). It stays here
// because it is a thin orchestration wrapper over an injected `AgentDeps` (never touches raw SDK
// primitives or qa-engine internals directly) — the actual open()/prompt() policy it calls already
// lives in qa-engine (agent-transport-policy.ts, migrated Slice 2). Read-only Q&A about a run. Opens
// a short-lived session as the requested role.
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

// AgentTurnEvent/AgentSession/AgentOpenDescriptor/AgentDeps MIGRATED to qa-engine's
// agent-transport-policy.ts (migration-tier-4c Slice 2) — see this file's header re-export block.

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

// withTimeout MIGRATED to qa-engine's agent-transport-policy.ts (migration-tier-4c Slice 2) — see
// this file's header re-export block. TIMEOUT_BY_MODE/agentTimeout/MAX_AGENT_TIMEOUT_MS below STAY
// here (env-read confinement — see agent-transport-policy.ts's own header): they read
// `process.env.OPENCODE_TIMEOUT_MS`, and qa-engine/src may never read `process.env` directly.
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

// withUsageSink MIGRATED to qa-engine's agent-transport-policy.ts (migration-tier-4c Slice 2) — see
// this file's header re-export block.

// Default stall threshold: STRICTLY less than the shortest mode timeout (diff = 5 min).
// Configurable via OPENCODE_STALL_MS. 180 seconds without any agent activity event triggers the
// watchdog — tight enough to catch a truly hung session well before the coarse deadline, yet with
// headroom for a single legitimately-long tool call (e.g. a large Serena index scan) that emits no
// intermediate SSE events. Raise OPENCODE_STALL_MS for very large repos if healthy runs trip it.
const DEFAULT_STALL_MS = 180_000;

export function stallMs(): number {
  return Number(process.env.OPENCODE_STALL_MS) || DEFAULT_STALL_MS;
}

// withStallWatchdog (+ WatchdogFactory) and withSessionRegistration MIGRATED to qa-engine's
// agent-transport-policy.ts (migration-tier-4c Slice 2) — see this file's header re-export block.
// withSessionRegistration's `collaborators` is now REQUIRED there (qa-engine cannot reach this file's
// registerRunSession/unregisterRunSession on its own); the ONE production call site
// (src/server/rewritten-engine-factory.ts) now injects them explicitly instead of relying on an
// implicit default.

// Integration boundary: real connection to `opencode serve`. Not covered by unit
// tests (like the Playwright runner). The SDK is imported lazily so tests do not
// require the package. OPENCODE_SERVE_URL points to the `opencode` container.
//
// Usage capture is driven SOLELY by `opts.onUsage` on each open() — the single, typed mechanism.
// Callers that want the snapshots wrap this AgentDeps (via withUsageSink) to inject onUsage into
// every open() (the runner/pipeline path via the facade). There is no factory-level usage sink (it
// was dead in the production strategy path, which always constructs this with no argument).
// Raw transport (genuinely raw @opencode-ai/sdk primitives — client construction,
// session.create/prompt/abort/delete). Injected into qa-engine's createAgentDeps, which owns ALL
// policy (circuit-breaker gating, fallback-model retry, telemetry assembly, sanitize-before-emit).
// Raw response-shape validation (res.error, missing id) is a genuinely raw-transport concern and
// stays HERE — qa-engine's policy layer only sees a clean RawPromptResult or a rejected promise.
async function buildRawAgentTransport(): Promise<RawAgentTransport> {
  const client = await getSharedClient();

  return {
    createSession: async (cwd) => {
      const created = await client.session.create({ query: { directory: cwd } });
      if (created.error) throw new Error(`OpenCode session.create failed: ${JSON.stringify(created.error)}`);
      const id = created.data?.id;
      if (!id) throw new Error("OpenCode: the session returned no id");
      return { id };
    },
    promptSession: async ({ id, cwd, agent, text, model }): Promise<RawPromptResult> => {
      const res = await client.session.prompt({
        path: { id },
        query: { directory: cwd },
        body: { agent, parts: [{ type: "text", text }], ...(model ? { model } : {}) },
      });
      if (res.error) {
        throw new Error(`OpenCode session.prompt failed: ${JSON.stringify(res.error)}`);
      }
      // A provider/agent fault (out of credits, auth, rate-limit, output-length) is embedded in the
      // assistant message (info.error), NOT in res.error — surfaced as data, classified by the
      // policy layer's agentErrorToInfra.
      const info = res.data?.info as
        | { error?: RawAgentErrorPayload; tokens?: { input: number; output: number; reasoning: number; cache: { read: number; write: number } }; cost?: number }
        | undefined;
      return {
        agentError: info?.error,
        parts: (res.data?.parts ?? []) as Array<{ type: string; text?: string }>,
        tokens: info?.tokens
          ? {
              input: info.tokens.input ?? 0,
              output: info.tokens.output ?? 0,
              reasoning: info.tokens.reasoning ?? 0,
              cacheRead: info.tokens.cache?.read ?? 0,
              cacheWrite: info.tokens.cache?.write ?? 0,
            }
          : undefined,
        cost: info?.cost,
      };
    },
    abortSession: async (id) => {
      await client.session.abort({ path: { id } });
    },
    deleteSession: async (id) => {
      await client.session.delete({ path: { id } });
    },
  };
}

export async function defaultAgentDeps(): Promise<AgentDeps> {
  // The undici transport timeout must exceed EVERY per-prompt withTimeout, or it aborts the
  // request before our own deadline fires. The reviewer, the explorer and the planner each have their
  // OWN budget (REVIEWER_TIMEOUT_MS, EXPLORER_TIMEOUT_MS, PLANNER_TIMEOUT_MS) independent of the
  // generator's; if an operator sets a small OPENCODE_TIMEOUT_MS (or raises a per-role one) it must NOT
  // drag the transport below any of them. Take the max + headroom.
  const generatorMax = Number(process.env.OPENCODE_TIMEOUT_MS) || MAX_AGENT_TIMEOUT_MS;
  const dispatcherTimeoutMs = Math.max(generatorMax, REVIEWER_TIMEOUT_MS, EXPLORER_TIMEOUT_MS, PLANNER_TIMEOUT_MS) + 30_000;
  await installHttpDispatcher(dispatcherTimeoutMs);

  const raw = await buildRawAgentTransport();

  return createAgentDeps(raw, {
    defaultPromptTimeoutMs: dispatcherTimeoutMs,
    getFallbackModel,
    persistTurn: (t) => {
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
    },
  });
}

// agentErrorToInfra/extractText/textOf/stripReasoningWrappers MIGRATED to qa-engine's
// agent-transport-policy.ts (migration-tier-4c Slice 2) — see this file's header re-export block.
// The RawAgentErrorPayload type (formerly this file's own private AgentErrorPayload) is imported
// from that module too, used by buildRawAgentTransport above.
