# Run Digest — agent narration layer over the run report (design)

**Date:** 2026-07-09 (revised 2026-07-10 through adversarial review rounds 2–4)
**Status:** approved — Judgment Day rounds 3 and 4 both returned APPROVE WITH FIXES; all
confirmed findings applied; digest composes with the existing `RunReportView` system
**Branch policy:** all work happens on the current branch (`main`) — no feature branches.

## Problem

The deterministic presentation layer already exists: `toRunReportView`
(`src/server/run-report-view.ts`) turns one finished run into a self-describing,
importance-ranked `ReportView`; the `reportForRun` handler (`src/index.ts`) pairs it
with an `evolution` half (`toReportView(toTrendsView(...))`, time-bounded to outcomes
at or before the run, `null` with fewer than 2 outcomes) into the `RunReportView` the
API serves and the TUI renders with one intent-based renderer. What NO layer produces today is
**meaning**: which of those facts actually matter for THIS run, what the run *discovered
about the user's code* ("the contact form accepts an empty email — case X failed"), and
a prose narrative a human can digest in ten seconds. The deterministic report ranks
metrics; it cannot select, interpret, or cite findings. That interpretive layer is the
gap this feature fills.

## Reconciliation with the existing report system (anti-duplication contract)

This design deliberately does NOT introduce a second visual vocabulary. An earlier
draft proposed a custom `Shape` union (`stat`/`proportion`/`distribution`/`trend`/
`comparison`/`ranked-list`); review found it a near 1:1 remap of the existing
`InsightIntentSchema` (`single-value`/`comparison`/`trend`/`composition`/`distribution`,
`qa-engine/src/shared-kernel/contract/commands.ts`). The rule going forward:

- **The visual layer is the existing one.** Every keypoint embeds a standard
  `ReportInsight` (same Zod schema: `intent`, preferred `chart` with client fallback,
  `value`/`unit`/`delta`/`direction`/`goodWhen`/`series`/`breakdown`). Clients render
  keypoint visuals with the SAME intent-based renderer they already use for
  `RunReportView` — zero new renderers, zero contract forks.
- **The digest adds only what the deterministic system cannot:** selection (which facts
  matter), narrative (why they matter), evidence (what backs the claim), code findings
  (what the run revealed about the app under test), and the prose `summary`.
- If a future need genuinely does not fit an existing intent, the fix is to extend
  `InsightIntentSchema` (one shared vocabulary), never to fork a parallel one.

## Goal

After each substantive run, a new `qa-summarizer` role generates a **Run Digest**: a
consumer-agnostic JSON document with a prose `summary` plus up to 5 **keypoints** — each
one a narrated, evidence-backed `ReportInsight`. The agent decides *what* to highlight
and expresses *how* via the existing intent/chart vocabulary. Any client (TUI today, web
soon) renders it with its existing renderer plus two new text slots (summary, narrative).

## Non-goals

- The digest is **presentation only**. It never feeds publish/gate decisions — that would
  add another LLM proxy on the quality loop (see "The value/trust risk" in CLAUDE.md).
- No digest for `skipped` / `infra-error` runs (nothing executed — silence is signal) and
  no digest for context-mode clean passes (`isContextCleanPass` skips the entire
  persist/fold/reflect block today; the digest follows the same exclusion, stated here so
  it is not rediscovered mid-implementation). Context-mode `invalid` runs are likewise
  excluded structurally: they set `skipPersist` and the terminal digest site sits inside
  the same `if (!skipPersist)` block as the terminal `reflect()` — same placement, same
  exclusion, no extra gate needed.
- No replacement of `toRunReportView` or the deterministic TUI summary — the digest is
  additive and optional (absent digest = today's behavior).

## Design decisions (settled in discussion + two adversarial review rounds)

1. **History-aware.** The agent sees the current run AND history. Primary history source:
   the deterministic report pair (`current` + `evolution`). **Neither half exists yet at
   digest time** (the run is still inside `RunQaUseCase`; `reportForRun` composes them
   on API demand), so the real `RunHistoryReaderPort` adapter in `src/server/` performs
   that same composition — `toRunReportView` for `current`, `toReportView(toTrendsView(...))`
   for `evolution` — via a shared helper extracted from `reportForRun` (never duplicated)
   that takes an explicit **bound parameter**: `reportForRun` keeps its intentionally
   inclusive `<=` (an after-the-fact API report about the run), while the digest adapter
   passes strict `<` so BOTH the `evolution` view and the raw outcome window exclude the
   current run (its outcome is already saved when the digest step runs — see Facts
   payload item 4). One rule, no self-referential baselines. Relevance is comparative.
2. **Renderer-neutral via the EXISTING vocabulary.** Keypoint visuals are standard
   `ReportInsight` objects. Intent-based fallback is already specified in the contract
   ("a terminal has no good pie → stacked bar / percentages").
3. **Substantive runs only.** Digest gate: `verdict ∈ {pass, fail, flaky, invalid}`.
   **This is the digest's OWN gate, structurally independent of `reflect()`'s** — the
   reflector's gate (`shouldDistillLearning(...) && verdict !== "flaky" && errorClass
   not E-INFRA/E-FLAKY`) exists for the learning concern and MUST NOT be reused: it
   excludes `flaky`, which the digest covers. The digest must also not be coupled to
   `deps.reflector` being present — summarizer and reflector are separate optional
   collaborators.
4. **Metrics + code findings, with mandatory evidence.** Keypoints cover pipeline
   metrics AND what the run discovered about the user's code. Every keypoint cites
   resolvable evidence or is discarded at validation.
5. **The agent selects, structures and narrates — it never computes.** Every numeric
   value in a keypoint's insight must be traceable to the deterministic facts payload.
   Architecture mirrors the `ReflectorPort` pattern (post-run LLM pass, fault-isolated,
   timeout-capped) including its ADR-2 collaborator split: qa-engine composes against
   injected ports only; real host-side integrations are wired from `src/server/` at
   composition time, never imported by qa-engine.

## Architecture

New bounded context in qa-engine, following the existing hexagonal/DDD layout:

```
qa-engine/src/contexts/run-presentation/
├── domain/                       # pure, no I/O
│   ├── run-digest.ts             # RunDigest + Keypoint types (embedding ReportInsight)
│   ├── assemble-run-facts.ts     # builds the facts payload (run data + report views + history)
│   └── validate-digest.ts        # validates LLM output: schema, numeric trace, evidence
├── application/
│   └── ports/index.ts            # SummarizerPort, RunHistoryReaderPort
└── infrastructure/
    ├── summarizer-port.adapter.ts    # bridge to agent-runtime (qa-summarizer role)
    └── run-history-reader.fakes.ts   # in-memory TEST FAKES ONLY for RunHistoryReaderPort
```

### History adapter placement (ADR-2 split)

`qa-engine/src` never imports from `src/`. The real history adapter lives in
`src/server/` (wrapping `listRunOutcomes`/`listRecords` from `src/server/history.ts`)
and is injected through `CompositionConfig` at composition time. qa-engine keeps only
test fakes. `RunHistoryReaderPort` is deliberately named to avoid the existing
**save-only** `RunHistoryPort` in `qa-run-orchestration`.

### Position in the run flow

The digest step is invoked from `RunQaUseCase` at **both** exit points where a final
verdict exists — the same two sites where `reflect()` is wired, but under the digest's
own gate (decision 3):

| Exit point | Location | Facts available |
|---|---|---|
| Mainline (`pass`/`fail`/`flaky`) | alongside (not inside) the mainline reflect block, ~L1866 | See truth table below — full ONLY for `pass` |
| Terminal static-gate `invalid` | alongside the terminal reflect call, ~L2389 — before `execute()` ever ran | Reduced: `executionReached: false`, no cases, no coverage, no reviewer |

**Facts availability truth table** (verified against `run-qa.use-case.ts` — both
`objectiveSignal.measure()` calls and the reviewer-corrections loop are gated on
`run.verdict === "pass"`):

| Verdict | cases | coverage | reviewer corrections |
|---|---|---|---|
| `pass` | ✔ | ✔ (diff mode + `qa.changeCoverage.mode !== "off"`, **any target** — e2e collects V8 browser dumps, code target collects lcov/c8/JaCoCo via `makeTargetCoverageCollector`; always absent cross-repo, complete/exhaustive/manual/context modes, or when the collector finds no reports) | ✔ |
| `fail` / `flaky` | ✔ | `null` (never measured) | `[]` (loop never entered) |
| `invalid` (terminal) | `[]` | `null` | `[]` |

The facts payload declares these absences explicitly (`null`/`[]`, never fabricated
zeros — same "absence is never a hard zero" rule as `toRunReportView`), and the
`qa-summarizer` prompt forbids keypoints about facts the payload does not carry.

**Fault isolation (same contract as the reflector):** if the summarizer throws, times
out, or returns garbage, the run is unaffected — the error is logged loudly and the
digest simply does not exist for that run. The digest can never change a verdict, block
a publish, or fail a run.

**Timeout and queue latency.** `DIGEST_TIMEOUT_MS = 60_000` — matching
`REFLECT_TIMEOUT_MS`, deliberately NOT tighter: the digest's prompt (report views +
diff + logs + history) is at least as large as the reflector's and its structured
output is richer, so a 30s cap would chronically time out on real runs and silently
degrade the feature to "no digest most runs". Awaited **inline** (a fire-and-forget
would race run finalization — the reflector's own documented reason), elapsed time
logged per run like `reflect()`. Stated compound worst case: on a run where both fire,
reflect (≤60s) + digest (≤60s) are sequential at the same site — up to ~120s added tail
latency on the sequential queue. Mitigations: cheap model, and the digest being
**opt-in per app** (below).

### Exposure

- **Event vocabulary (closed Zod union — corrected edit order).** The canonical schema
  is `qa-engine/src/shared-kernel/contract/events.ts` (moved there by Plan 7.3; it feeds
  `src/contract/openapi.ts` codegen). `src/contract/events.ts` is now a pure re-export
  shim — it needs NO edit. `qa-engine/src/shared-kernel/run-event.ts` is **NOT optional**:
  its `RunEventBody` backs `ObserverPort.onEvent` (imported at
  `qa-run-orchestration/application/ports/index.ts:15`) — the exact channel the digest
  notification is emitted through from `RunQaUseCase`. Both files must gain the
  `run.digest` variant, atomically with the emitting code, or the `observer.onEvent`
  call will not type-check.
- `run.digest` is a lightweight **notification** event: `{ keypointCount, digestVersion }`
  — the envelope already stamps `runId` (producers emit only the body, like every sibling
  variant), and never the full document (it would be a size-class outlier in the
  SSE/replay stream). `keypointCount` is the **post-validation surviving count**, computed
  after `validate-digest` and immediately before emission — never the raw LLM count, so a
  client badge never promises keypoints the fetch won't return. Consumers fetch
  `GET /api/runs/:id/digest` (404 when absent). **That endpoint gets its own
  `src/contract/openapi.ts` registration** (`RunDigest` schema, mirroring the existing
  `/api/v1/runs/{id}/report` → `RunReportView` entry) so the Go client's types are
  codegenned like every other TUI-consumed payload.
- **Persistence:** a `digest TEXT` column on `run_outcomes`, added via the guarded
  `ALTER TABLE ... ADD COLUMN` + `columnExists` migration pattern. The precedents for
  the PATTERN are `step_started_at`/`trigger_repo` (on `runs`) and `archetype` (on
  `learning_rules`) in `src/server/history.ts:242-260` — note they target OTHER tables;
  this is the first deployed-volume column addition to `run_outcomes` itself, and
  `reflection` is NOT a precedent (it sits inline in the base `CREATE TABLE`, which will
  not add columns on already-deployed volumes). **The write path is a dedicated
  back-fill**: `updateRunOutcomeDigest(runId, digest)` mirroring
  `updateRunOutcomeReflection` (`history.ts:768`) — the digest is only known AFTER the
  outcome row was saved (`save()` precedes the digest step at both call sites), so it
  cannot thread through `insertOutcome`.
- **Type boundary:** `RunDigest` is declared in qa-engine and MIRRORED as a separate
  declaration in `src/types.ts`, which is a **zero-import file by convention** — so the
  mirror hand-duplicates the `ReportInsight`-shaped interface inside `Keypoint` too
  (like `StructuredReflection` before it), never importing across the boundary.
  `src/server/` code (which IS allowed to import qa-engine, e.g. `src/contract/openapi.ts`)
  keeps using the canonical shared-kernel schema for validation.
- **v1 client scope:** TUI renders `summary` + keypoint titles/narratives + keypoint
  insights through the EXISTING intent renderer (`client/internal/ui/charts.go` already
  draws `ReportInsight`). No new Go renderer work beyond the two text slots and the
  digest fetch. Web inherits the same contract later.

## Contract

```ts
interface RunDigest {
  version: 1;
  metadata: {
    runId: string;               // record id — retrievable via GET /api/runs/:id/digest
    app: string;
    sha: string;
    verdict: RunVerdict;
    generatedAt: string;         // ISO 8601
    generator: { provider: string; model: string };  // injected from config.assignments.chat
                                 // at composition time (qa-summarizer rides the chat tier)
    historyWindow?: { runs: number; fromSha: string; toSha: string };  // omitted on cold start
  };
  summary: string;               // 2-4 sentences of prose — numeric claims validated (below)
  keypoints: Keypoint[];         // max 5, ordered by relevance (array order IS priority)
}

interface Keypoint {
  title: string;                 // short headline
  narrative: string;             // 1-2 sentences: why this matters — the agent's contribution
  category: "finding" | "metric" | "trend" | "quality-gate";
  insight: ReportInsight;        // STANDARD shared-kernel schema — the visual layer, reused
  evidence: EvidenceRef[];       // REQUIRED, min 1 — no evidence, no keypoint
}

interface EvidenceRef {
  source: "case" | "coverage" | "diff" | "reviewer" | "log" | "history" | "report";
  ref: string;
}
```

`ReportInsight` is NOT redefined — it is the existing schema
(`qa-engine/src/shared-kernel/contract/commands.ts`). The agent either **references** a
deterministic insight from the facts payload (copying it verbatim into the keypoint) or
**authors** one in the same schema for code findings; both paths are validated
identically.

### EvidenceRef.ref format per source

| source | ref format |
|---|---|
| `case` | exact case name |
| `coverage` / `diff` | `path/to/file:start-end` line range (`coverage` refs can never appear in a cross-repo digest — coverage is structurally absent there per the truth table) |
| `reviewer` | `correction:N` (index) |
| `log` | `log:N` (line index within the capped log excerpt) |
| `history` | run sha; a `trend` insight requires one history ref per series point |
| `report` | deterministic insight `id` from the facts payload's report views |

### Trust rules (executable in `validate-digest.ts`)

- **Schema:** each keypoint's `insight` must parse against the existing
  `ReportInsightSchema`. Unknown intent/chart → keypoint discarded.
- **Numeric trace:** every number in an insight (`value`, `delta`, `series[]`,
  `breakdown[].value`, `target`, `multiplier`) must be traceable to the facts payload.
  **`score` is the single deliberate exemption:** it is never trusted from the LLM —
  `validate-digest` OVERWRITES it deterministically from the keypoint's array position
  ("array order IS priority" is already the contract), so the schema-required field is
  always populated and never an unfalsifiable agent-invented number. Stated semantic
  note: inside a keypoint, `score` therefore means positional priority — a deliberate
  repurposing of the field that means deterministic interestingness in a plain
  `ReportView` (no client renders `.Score` today; it is server-side sort-only, but any
  future consumer must not read a keypoint's `score` as the original ranking). For
  authored qualitative findings, `direction`/`goodWhen` carry no numeric claim and pass
  as-is; their `value` may be `null` (the schema allows it) when the finding has no
  natural metric.
- **Insight `id`:** a keypoint whose evidence cites `source: "report"` must carry the
  referenced deterministic insight's `id` verbatim; for authored insights,
  `validate-digest` overwrites `id` with `authored-<index>` — ids are never
  LLM-controlled, so they can neither collide with the deterministic slugs
  (`case-mix`, `change-coverage`, …) nor leak arbitrary strings to clients that key
  off `id`.
  **Normalization rule:** ratio ↔ percent conversion is permitted when the insight's
  `unit` says so (0.812 may appear as 81.2 with `unit: "percent"`), matched within
  epsilon 0.05 after canonicalizing to ratio; all other numbers match after rounding to
  one decimal. Anything untraceable → keypoint discarded.
- **Prose numerics:** numeric tokens extracted from `summary` and each `narrative` are
  validated with the same normalization. A failing narrative discards its keypoint; a
  failing summary rejects the whole digest (no digest for that run).
- **Evidence:** every `ref` must resolve against the facts payload. Unresolvable →
  keypoint discarded. Partial validation is fine: a digest with a valid summary and 2
  surviving keypoints out of 5 is a valid digest.
- **Trend degradation:** a `trend` insight requires ≥3 series points. With exactly 2,
  it degrades to `single-value` with `delta` computed from the two points; with <2, to
  a bare `single-value` (no delta). Cold start (zero history) simply produces no
  history-derived keypoints and omits `metadata.historyWindow`.
- Deliberately no LLM-assigned severity: `category` + verdict + the insight's own
  `goodWhen`/`semantic` fields give renderers everything for color/emphasis.

## Facts payload (the ONLY thing the agent sees)

Assembled deterministically by `assemble-run-facts.ts` — a **pure function** taking the
sanitizer as a required plain function parameter (no constructor-DI class in `domain/`;
the fail-closed rule — no default-to-identity — is enforced at the composition seam,
same spirit as `PublicationPortAdapter`'s required collaborator). The sanitizer is the
EXISTING ported twin `qa-engine/src/contexts/generation/infrastructure/sanitize-text.ts`
(cross-context import is the accepted pattern — `blast-radius-signal.ts` already does
it; do NOT port a fourth copy), never `src/orchestrator/sanitizer.ts`. **Tier decision,
stated explicitly:** the stricter "issue" tier, applied ONCE at assembly time so both
egresses (LLM prompt and API/TUI/web render) are covered by construction. This
deliberately accepts the known "issue"-tier cost (over-redacting secret-shaped but
legitimate code on the diff→model path) — for a presentation feature, a mangled snippet
in a citation is acceptable; an unsanitized public egress is not, and one sanitization
point beats a dual-tier scheme whose lax half could leak to the API. A sanitizer failure
fails the digest step (no digest), never the run.

1. **Deterministic report views:** `current` (`toRunReportView`) + `evolution`
   (composed by the `RunHistoryReaderPort` adapter per decision 1 — nothing has built it
   yet at digest time), ranked and delta'd. The agent's primary selection ground.
2. **Current run:** verdict, sanitized cases (name/status/error/duration), coverage per
   the truth table (nullable), sanitized reviewer verdict + corrections (pass only),
   commit classification, sanitized commit message, written files. Terminal path:
   `executionReached: false`.
3. **Sanitized diff** and **sanitized, byte-capped execution logs**
   (`DIGEST_LOG_CAP_BYTES = 16_384`, a named constant — the existing ask-context caps
   are internal to `buildRunContext`/`activityRouter` and not reusable as-is).
4. **History:** the composed `current` + `evolution` report views (decision 1) plus the
   last N raw run outcomes (verdict, counts, coverage ratio, shas) via
   `RunHistoryReaderPort`; N = `qa.digest.historyRuns`, default 10. **The window
   EXCLUDES the current run** — `save()` runs before the digest step at both call
   sites, so a naive "last N rows" query would return the run as its own most-recent
   history entry (a trend citing the run's own sha as historical evidence, or the run
   compared against itself). **Retrieval mechanism, stated explicitly** —
   `listRunOutcomes`/`listRecords` accept only `(app, limit)`, no bound parameter — the
   adapter over-fetches `historyRuns + 1`, drops the row matching the current `runId`
   (exact id match, immune to `at`-timestamp ties), and keeps the first `historyRuns`.
   The same exclusion applies to the outcome list fed into `toTrendsView` for
   `evolution` (decision 1's strict bound) — the two history sources share one
   exclusion rule.

The measured coverage detail (`uncovered` line ranges from `ObjectiveSignalPort.
measure()`) is today transient — **required extension:** `RunQaUseCase` retains the
`measure()` result and threads it to the digest call site; `covered` derives as
changed-minus-uncovered. The persisted ratio alone is insufficient. **When the enforce
mode one-shot regen fired, the retained result is always the LAST measurement**
(`signal2`, the same value that already wins for `coverageRatio`/`blocksPublish`) —
never the stale pre-regen `signal`, which would make the facts payload internally
inconsistent.

**Cross-repo runs:** the digest IS in scope (coverage simply absent per the truth
table). `diff`/`case` evidence refs resolve against the paths exactly as they appear in
the sanitized diff — i.e. the **triggering service repo's** tree, which is where the
diff and classification come from; the facts payload carries `triggerRepo` so clients
can label the origin.

## Agent role: `qa-summarizer` — full wiring

| Touch point | Change |
|---|---|
| `agents/agent/qa-summarizer.md` + `agent/roles/qa-summarizer.md` | new prompt (both layers); ships the intent/chart vocabulary + usage rules; "max 5 keypoints, fewer is better; if nothing is notable, return empty keypoints — do NOT pad; no numbers not present in the payload; no keypoints about absent facts" |
| `src/agent-runtime/types.ts` | new `AgentRole` union member + `READ_ONLY_ROLES` entry |
| assignment resolution | rides the **chat tier** (like the reflector) — no new assignments slot. **This requires an explicit branch in `assignmentForRole` (`src/agent-runtime/types.ts`)**: without `if (role === "summarizer") return config.assignments.chat;` the if-chain falls through to `config.assignments.primary` — the expensive author model, defeating the cheap-model latency mitigation. `{provider, model}` for `metadata.generator` injected from `config.assignments.chat` at composition time |
| `opencode-strategy.ts` / `codex-strategy.ts` | role→model constant / role→agent-name mapping |
| `src/server/rewritten-engine-factory.ts` | role mapping (mirrors `reflector: "qa-reflector"`) |
| `agents/opencode.json` | subagent registration (no tools; context → JSON) |

Output parsing reuses the balanced-brace JSON extraction pattern the reflector already
ports from `src/integrations/verdict-parse.ts` (ported, not imported) — never a naive
`JSON.parse`.

## Configuration

```yaml
qa:
  digest:
    enabled: false       # OPT-IN, per the repo's convention for new agent-invoking
                         # capabilities (parallelDiff, explorer, valueOracle all default
                         # off) — latency on the sequential queue is a real cost. Apps
                         # earn it on, like every other capability.
    historyRuns: 10
```

Adding `qa.digest` REQUIRES the Zod schema edit in `src/orchestrator/schemas.ts` — the
loader silently strips unknown keys; without the schema edit the feature never activates
and nothing errors.

## Error handling

- Summarizer failure / timeout / unparseable output → loud log, no digest, run unaffected.
- Sanitizer failure → fail-closed: no digest (never unsanitized egress), run unaffected.
- Validation discards keypoints individually; failed summary numeric check rejects the
  whole digest.
- `GET /api/runs/:id/digest` → 404 when absent (excluded verdicts, disabled apps, failed
  generation, pre-feature runs, context-mode clean passes).

## Testing (strict TDD)

- **Domain:** exhaustive unit tests for `assemble-run-facts` (truth-table absences,
  sanitization required/fail-closed, terminal path, cold start) and `validate-digest`
  (numeric trace + normalization epsilon, prose numerics, evidence resolution per
  source, trend degradation at 0/1/2/3 points, partial survival).
- **Use case:** digest gate independence (flaky INCLUDED, reflector absent, context
  clean-pass excluded), both exit points, fault isolation — with fakes against ports.
- **LLM adapter:** deliberately uncovered boundary, `*Deps` + `default*Deps` pattern.
- **Contract/clients:** OpenAPI regen after the event-vocabulary edit + Go build/test
  gate (`client/`), since the TUI consumes the codegenned types.
- `npm test` + `npm run typecheck` stay green — the gate for any change.
