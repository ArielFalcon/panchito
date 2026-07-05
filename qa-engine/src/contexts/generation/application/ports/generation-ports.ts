// qa-engine/src/contexts/generation/application/ports/generation-ports.ts
// Seam-2 cycle break: the canonical OpencodeRunInput / ReviewInput / ParallelWorkerInput live HERE,
// cycle-free. At Phase B the legacy src/integrations/opencode-client.ts definitions become re-export
// ALIASES of these, and prompts.ts:19 re-roots onto this module — dissolving the opencode-client ⇄
// prompts type-only cycle (design §7.1 Seam-2, §7.2 Step 4b). These are the FULL current field sets
// (not a frozen subset) so the user's growing deterministic-signal fields flow through unchanged.
import type { TestTarget, RunMode } from "@kernel/run-mode.ts";
import type { QaCase } from "@kernel/qa-case.ts";
// §6.6 Option B: cross-repo link types from the service-topology bounded context.
// Imported here so OpencodeRunInput.serviceLinks / .contractDrift are strongly typed.
import type { ServiceLink, ContractDrift } from "@contexts/service-topology/domain/index.ts";

// Supporting authoring-context types. NOT yet kernel-resident (CommitIntent lives in src/qa/commit-classify.ts,
// ArchitectureContext in src/qa/context.ts, ExplorationBrief in src/qa/exploration-brief.ts). Declared here as
// faithful structural aliases — importing them from src/ would recreate the cross-tree coupling the qa-engine
// typecheck rejects. Structural shape mirrors the legacy definitions so a legacy value is assignable to the
// canonical input (the generation-ports-parity.test.ts round-trip proves no field was dropped).
// Plan-6: re-home to kernel.

export type CommitType =
  | "feat" | "fix" | "perf" | "refactor" | "chore"
  | "style" | "docs" | "ci" | "build" | "test" | "revert" | "unknown";

export interface CommitIntent {
  type: CommitType;
  breaking: boolean;
  message: string; // first line (what the agent uses as intent)
  body?: string; // the commit message body (lines after the subject) — the richest statement of intent
  changedFiles: string[]; // the agent derives the scope/area from these
}

export interface RouteEntry {
  path: string; // frontend entry URL, e.g. "/checkout" (the unit an E2E test targets)
  name?: string; // human flow label, e.g. "Checkout"
  component?: string; // the Angular component/page symbol it renders
  source?: string; // file where the route is declared
}
export interface ApiOperation {
  operationId: string; // stable join key (matches the generated client + the OpenAPI op)
  method: string; // GET | POST | PUT | ...
  path: string; // "/orders/{id}"
  service?: string; // owning microservice
  spec?: string; // path to the OpenAPI file it came from
}
export interface FeBeLink {
  route: string; // a RouteEntry.path
  operationId: string; // an ApiOperation.operationId that route exercises
  via?: string; // the client/method symbol that makes the call
}
export interface FlowEntry {
  id: string; // stable id, e.g. "checkout"
  routes: string[]; // entry routes for the flow
  operations?: string[]; // operationIds the flow touches
}
export interface ArchitectureContext {
  builtAtSha: string; // provenance: the SHA the map was derived from (staleness signal)
  routes: RouteEntry[];
  api: ApiOperation[];
  feBe: FeBeLink[];
  flows?: FlowEntry[];
}

export interface BlastNode {
  symbol: string; // e.g. "CheckoutService.pay"
  file: string; // repo-relative file the symbol lives in
  role: string; // ONE line: what this symbol does for the flow (the distillate, not the body)
}
export interface FeBeFact {
  route: string; // a frontend entry route the flow uses
  operationId: string; // the backend operation it exercises
  via?: string; // the client/method symbol that makes the call
}
export interface ContractFact {
  operationId: string; // join key with FeBeFact
  method: string; // GET | POST | ...
  path: string; // "/orders/{id}"
  fields?: string[]; // required fields / enums worth asserting
  errors?: string[]; // error responses worth a negative case
}
export interface RouteRecon {
  path: string; // entry route, e.g. "/checkout"
  component?: string; // the component/page it renders
  domLandmarks?: string[]; // HINTS only — NOT verified selectors
  verified: boolean; // DEPRECATED (vestigial after F3); retained for backward-compat, never branched on
}
export interface ExplorationBrief {
  builtForSha: string; // provenance + staleness signal (the SHA the brief was derived from)
  objective: string; // the flow/objective this brief serves
  blastRadius: BlastNode[]; // the code touched, distilled to symbol + file + 1-line role
  feBe?: FeBeFact[]; // resolved FE→BE joins relevant to the objective
  contracts?: ContractFact[]; // contract facts relevant to assertions
  routes?: RouteRecon[]; // candidate entry routes + DOM landmark hints
  risks?: string[]; // fragilities / what to assert to catch the regression
  notes?: string;
}

// The full primary-generation input. FULL current field set copied from src/integrations/opencode-client.ts
// (comments preserved). The deterministic-signal fields (contextPack/domSnapshot/staticSignal/diffArchetypes)
// are first-class and GROWING — keep this canonical, not a frozen subset.
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
  // Level 3 / §6.6 Option B: deterministic cross-repo FE↔BE links produced by ServiceBoundaryResolverPort.
  // Threaded through so the resolver's output has a typed home on the run input and reaches
  // renderMain intact (GenerateTestsUseCase passes the full input through). NO production
  // renderMain implementation renders a "CROSS-REPO LINKS" prompt section from it YET — that
  // rendering is deferred to the runtime-wiring step. Optional: absent today in every real run.
  serviceLinks?: ServiceLink[];
  // Optional contract-drift findings (undeclared endpoints): surfaced as advisory context for the generator.
  contractDrift?: ContractDrift[];
  // Slice C (structural-signals-expansion, design §3.7): the advisory cross-repo impact narrowing
  // CrossRepoImpactPort.resolve() produced. Structured (not pre-rendered) — mirrors serviceLinks'
  // own "prompts.ts owns rendering" precedent: prompts.ts extends the EXISTING "Cross-service
  // links" section with inline [IMPACTED:<tier>] markers, never a new subsection. Absent -> no key
  // at all, byte-identical to today. Advisory ONLY: reaches the generation prompt and NOTHING else
  // — no verdict/gate/coverage path reads it.
  crossRepoImpact?: { impactedLinks: Array<{ link: ServiceLink; tier: string }> };
}

// The reviewer input. FULL current field set copied from src/integrations/opencode-client.ts (comments preserved).
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

// One fan-out worker input. FULL current field set copied from src/integrations/opencode-client.ts (comments preserved).
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
  // carries these structural signals the day generateParallel is ported (crossRepoImpact is
  // deliberately NOT threaded here — a tracked follow-up for the fan-out port); the NEW key-drift
  // gate (not the round-trip, which tolerates one-sided optionals) guards them from then on.
  serviceLinks?: ServiceLink[];
  contractDrift?: ContractDrift[];
}
