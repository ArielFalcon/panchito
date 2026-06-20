// Contracts shared across the system. A trigger (webhook, manual) builds the run
// context and the orchestration lives in pipeline.ts.

export type TriggerSource = "webhook" | "manual";
export type TestTarget = "e2e" | "code";

// Structured metadata the agent emits per spec — the day-one fields (objective, flow,
// targets) the orchestrator uses for deterministic manifest upsert. Complements the
// flat `specs: string[]` in AgentResult for backward compatibility.
export interface SpecMeta {
  file: string;    // spec file name, e.g. "login.spec.ts"
  flow: string;    // user flow, e.g. "login"
  objective: string; // acceptance criterion
  targets: string[];  // symbols/routes the spec exercises
  sha256?: string; // content checksum for integrity verification
}

// Execution mode for a run (taken from the POST body; defaults to "diff").
//   diff       → test the change of the given commit (its blast radius). The
//                commit is classified (Conventional Commits) to decide whether to
//                generate, run regression only, or skip.
//   complete   → analyze the WHOLE repo + existing suite, estimate coverage and
//                importance, persist that analysis, and generate tests for the
//                important UNCOVERED flows (the delta over the existing suite).
//   exhaustive → like complete, but re-evaluate the WHOLE suite from scratch
//                (audit every existing test for correctness/value/necessity and
//                regenerate), not just the delta.
//   manual     → generation focused by user-provided `guidance`.
//   context    → build or refresh the FE↔BE architecture map (e2e/.qa/context.json)
//                from structured sources (routing, OpenAPI, generated clients).
export type RunMode = "diff" | "complete" | "exhaustive" | "manual" | "context";
export const RUN_MODES: readonly RunMode[] = ["diff", "complete", "exhaustive", "manual", "context"] as const;

// The objective marker stamped on the fan-out PLANNER turn (a plan-only pass that produces the
// objectives, carrying no Context Pack). Shared between the producer (opencode-client's planner
// session descriptor) and the consumer (history's groundingPresence telemetry, which excludes the
// planner so a fan-out run is not counted as partly ungrounded). One source of truth so the two
// sides cannot silently drift.
export const PLANNER_OBJECTIVE = "(planner)";

export interface RunOptions {
  target?: TestTarget; // defaults to "e2e" when omitted
  mode: RunMode;
  guidance?: string; // used by "manual" and by a human-in-the-loop continuation
  // Continuation: seed the FIRST generation with these previously-failed cases (so the
  // agent fixes them) and record the run it continues.
  fixCases?: QaCase[];
  parentRunId?: string;
  previousNamespace?: string; // cleanup: namespace from an interrupted previous run
  runId?: string; // the tracked run id; scopes the data/coverage namespace per run
  triggerRepo?: string; // cross-repo: the service repo whose commit triggered this run
  commits?: number; // diff mode: how many commits ending at the SHA the diff spans (default 1)
}

// Outcome of an OpenCode agent run. The agent writes the E2E tests directly into
// the working copy's `e2e/` folder (git is the source of truth, not this object);
// only the reviewer subagent's verdict (resolved inside OpenCode) and the final
// text travel here.
export interface AgentResult {
  output: string; // the agent's final text, including its closing verdict
  specs: string[]; // names of the specs it reported writing/updating
  specMetas?: SpecMeta[]; // structured metadata per spec (flow, objective, targets)
  reviewed: boolean; // whether review was enabled
  approved: boolean; // reviewer verdict (true when not reviewed)
  note?: string; // reason when not approved (e.g. did not converge)
  // Option (c): browser NAVIGATIONS (route visits) the agent made THIS turn (RE-2 telemetry; counts
  // `navigate`, not snapshots). Threaded into the fix-loop's RoundResult so the progress gate can
  // treat a heavy-re-navigation retry that merely reshuffles the failure set as "no progress".
  // Absent ⇒ treated as 0 (no gating).
  reexploreNavigations?: number;
  // Phase 6b: the number of objectives the planner derived for this run. Set on plan-first paths
  // (diff/manual fan-out) so the pipeline can retroactively adjust the runaway backstop to the
  // actual scope — multi-objective runs legitimately need more cycles than single-objective ones.
  // Absent on single-agent paths (defaults to 1 in the backstop calculation).
  objectiveCount?: number;
}

// Outcome of RUNNING the E2E tests against DEV.
//   pass        → everything green and stable
//   fail        → at least one case fails consistently (real Issue)
//   flaky       → unstable cases (pass sometimes, fail others) → quarantine
//   invalid     → generated specs did not pass the static gate (do not compile,
//                 lint, or load): they were never executed
//   infra-error → the run is inconclusive due to infrastructure (DEV down, etc.):
//                 NOT reported as a code bug
//   skipped     → the commit carries no tests (style/docs/chore without logic):
//                 nothing is run
export type RunVerdict = "pass" | "fail" | "flaky" | "invalid" | "infra-error" | "skipped";
export type CaseStatus = "pass" | "fail" | "flaky";

export interface QaCase {
  name: string;
  status: CaseStatus;
  detail?: string;
  flow?: string;
  objective?: string;
  reason?: string;
  durationMs?: number; // wall-clock of the test, from the Playwright stream (live cases)
  // Populated for failed cases: the accessible-role tree captured at the failure point (ariaSnapshot
  // YAML parsed + formatted). Used by the fix-loop to ground the regeneration prompt in the REAL
  // post-failure DOM instead of the pre-write grounding snapshot. Absent when capture missed
  // (page closed on nav-crash, env var unset, or parse failure) — grounding gap is warned loudly.
  failureDom?: string;
  // The spec file basename that contains this test (e.g. "login.spec.ts", "flows/checkout.spec.ts").
  // Populated by the Playwright report parser from the enclosing top-level suite title.
  // Used by the filtered-retry optimization to scope re-runs to only the files with failing cases.
  file?: string;
}

export interface QaRunResult {
  sha: string;
  verdict: RunVerdict;
  passed: boolean;
  cases: QaCase[];
  logs: string;
  note?: string; // human-readable summary of what happened (reviewer rejection, skip reason, etc.)
  outcome?: string; // what the run PRODUCED — "suite PR merged · <url>", "Issue filed · <url>", etc.
}

// A single spec produced by the AI agent with its objective and flow path.
export interface SpecRecord {
  name: string;
  objective?: string;
  flow?: string;
}

// A structured, real-time activity event surfaced to the TUI while a run is live.
// Replaces the old "flatten everything to one prefixed string" approach: keeping the
// `kind` (and `status` for todos) lets the dashboard categorize, count, and render a
// live panel instead of one cropped line. Raw model-stream prose is NEVER an activity
// (it produced broken fragments like `"file": "s`); only clean structured events are.
export type ActivityKind = "file" | "command" | "todo" | "phase" | "error";

export interface AgentActivity {
  kind: ActivityKind;
  text: string;             // already clean: file basename, full command, or todo content
  status?: "pending" | "in_progress" | "completed"; // todos only
  ts: string;               // ISO timestamp — for ordering and elapsed
}

// Full run history record persisted in SQLite (src/server/history.ts).
export interface RunRecord {
  id: string;
  app: string;
  sha: string;
  ref?: string;
  target: TestTarget;
  mode: RunMode;
  status: "enqueued" | "running" | "done";
  step?: string;
  stepDetail?: string;
  verdict?: RunVerdict;
  passed?: number;
  failed?: number;
  note?: string;
  retrying?: boolean;
  parentRunId?: string;
  triggerRepo?: string; // cross-repo runs: the service repo that originated the event
  cases: QaCase[];
  specs?: SpecRecord[];
  logs: string[];
  activity?: AgentActivity[];  // structured live activity feed (newest last)
  stepStartedAt?: string;      // ISO time the current `step` began — drives the elapsed clock
  at: string;
}

export type IncidentSeverity = "warn" | "error" | "critical";
export type IncidentSource = "health-check" | "log-scraper" | "qa-generator" | "qa-reviewer" | "cli" | "process-audit";

export interface Incident {
  id: string;
  source: IncidentSource;
  severity: IncidentSeverity;
  summary: string;
  detail?: string;
  status: "pending" | "diagnosing" | "fixed" | "dismissed";
  at: string;
  prUrl?: string;
}

// ── Learning layer (Fase 0 — Marcador) ────────────────────────────────────────

export type { ErrorClass } from "./qa/learning/taxonomy";

export interface RunOutcome {
  runId: string;
  app: string;
  sha: string;
  mode: RunMode;
  target: TestTarget;
  verdict: RunVerdict;
  errorClass: import("./qa/learning/taxonomy").ErrorClass | null;
  gateSignals: {
    static: boolean;
    coverageRatio: number | null;
    valueScore: number | null;
    reviewerCorrections: string[];
    // The reviewer's one/two-sentence reasoning for its verdict — on APPROVAL too, not only
    // rejection. The reviewer is the keystone publish gate; without this, a wrong auto-merge
    // (green-but-meaningless test that ships) leaves no durable record of WHY it was approved.
    reviewerRationale?: string;
    // The reviewer's APPROVE/REJECT verdict, persisted so the end-of-run value report (CLI, TUI)
    // can state it without re-deriving from corrections. Absent when review was disabled/not reached.
    reviewerApproved?: boolean;
    flaky: boolean;
    retries: number;
    // Write-confinement guard: set when the guard ran (dep wired), absent when dep not wired.
    // { strays: 0, dangerous: 0, reverted: [] } is a positive "guard ran, clean" record.
    confinement?: { strays: number; dangerous: number; reverted: string[] };
    // Per-run agent token/cost usage — observation-only, never affects verdict or publish.
    // Absent when no snapshot fired (Codex-only run or dep not wired); never a zero-filled object.
    usage?: import("./qa/usage").RunUsage;
  };
  rulesRetrieved: string[];
  reflection?: StructuredReflection;
  at: string;
}

export interface StructuredReflection {
  goal: string;
  decision: string;
  assumption: string;
  errorClass: import("./qa/learning/taxonomy").ErrorClass;
  gateSignal: string;
  evidence: string;
  rootCause: string;
  preventiveRule: { trigger: string; action: string };
}
