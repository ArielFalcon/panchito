# Run Digest — agent-generated post-run keypoints (design)

**Date:** 2026-07-09
**Status:** approved in discussion, pending spec review
**Branch policy:** all work happens on the current branch (`main`) — no feature branches.

## Problem

Everything a run produces today is deterministic data rendered client-side by the Go TUI
(`client/internal/ui/live.go`: `summaryBody`, `renderWhatHappened`). The composition logic
lives in the client, so no other consumer can reuse it, and no layer answers the question
the operator actually has: *what did this run discover about my code, and why does it
matter?* The complex, invisible work of a run (classification, generation, review,
execution, change-coverage, history) never becomes a digestible presentation of value.

## Goal

After each substantive run, the system generates a **Run Digest**: a consumer-agnostic
JSON document with a prose `summary` plus up to 5 **keypoints** — the most relevant facts
and findings of the run — where the agent decides both *what* to highlight and *how* it
should be represented visually (stat, proportion, trend, comparison, …). Any client (TUI
today, web soon) renders the same document with its own capabilities.

## Non-goals

- The digest is **presentation only**. It never feeds publish/gate decisions — that would
  add another LLM proxy on the quality loop (see "The value/trust risk" in CLAUDE.md).
- No digest for `skipped` / `infra-error` runs: nothing executed, so there is nothing to
  analyze. Those keep today's deterministic one-line outcome. Silence is also signal.
- No replacement of the existing deterministic TUI summary — the digest is additive.

## Design decisions (settled in discussion)

1. **History-aware (option B).** The agent sees the current run AND a window of previous
   runs of the same app. Relevance is comparative — without a baseline the agent cannot
   know whether "12 specs generated" is notable or routine.
2. **Renderer-neutral shapes (option B).** TUI today, web soon. Shapes declare the
   *intent* of the data ("parts of a whole", "evolution over runs"), never a widget name.
   Each client draws what it can.
3. **Substantive runs only (option B).** Digest is generated for `pass` / `fail` /
   `flaky` / `invalid`. An LLM forced to highlight something where nothing happened
   invents relevance; that erodes trust.
4. **Metrics + code findings, with mandatory evidence (option B).** Keypoints cover both
   pipeline metrics AND what the run discovered about the user's code ("the contact form
   accepts an empty email — case X failed"). Every keypoint must cite resolvable
   evidence or it is discarded at validation.
5. **Architecture: new summarizer role over a deterministic facts payload (option 1).**
   The agent **selects, structures and narrates — it never computes**. All numbers must
   exist in the facts payload assembled deterministically by the engine; the validator
   enforces this. This mirrors the `ReflectorPort` pattern (post-run LLM pass,
   fault-isolated, timeout-capped, verdict-gated).

## Architecture

New bounded context in qa-engine, following the existing hexagonal/DDD layout:

```
qa-engine/src/contexts/run-presentation/
├── domain/                       # pure, no I/O
│   ├── keypoint.ts               # RunDigest + Keypoint + Shape discriminated union
│   ├── assemble-run-facts.ts     # builds the facts payload from run data + history
│   └── validate-digest.ts        # validates LLM output against facts + shape schemas
├── application/
│   └── ports/index.ts            # SummarizerPort, RunHistoryPort
└── infrastructure/
    ├── summarizer-port.adapter.ts   # bridge to agent-runtime (qa-summarizer role)
    └── run-history-port.adapter.ts  # bridge to the orchestrator's run history (SQLite)
```

### Position in the run flow

`RunQaUseCase` invokes the digest step **after the final verdict** (after step 9,
decide), only for substantive verdicts. At that point everything is in scope: verdict,
cases with errors, coverage with exact lines, reviewer verdict and corrections, commit
classification, written files. History enters through `RunHistoryPort`.

**Fault isolation (same contract as the reflector):** if the summarizer throws, times
out, or returns garbage, the run is unaffected — the error is logged loudly (never
swallowed) and the digest simply does not exist for that run. The digest step can never
change a verdict, block a publish, or fail a run.

### Exposure

- The use case emits the digest as a run event (`run.digest`).
- The orchestrator (`src/server`) persists it on the run record and serves it at
  `GET /api/runs/:id/digest` (404 when absent). This is plumbing, not logic — no
  app-specific or domain logic lands in `src/`.
- TUI and web are two consumers of the same JSON.

## Contract

```ts
interface RunDigest {
  version: 1;                    // the contract WILL evolve — versioned from day one
  metadata: {
    runId: string;               // record id — retrievable via GET /api/runs/:id/digest
    app: string;
    sha: string;                 // analyzed commit
    verdict: RunVerdict;
    generatedAt: string;         // ISO 8601
    generator: { provider: string; model: string };   // which LLM produced it (trust audit)
    historyWindow?: { runs: number; fromSha: string; toSha: string }; // what history the agent saw
  };
  summary: string;               // 2-4 sentences: the most important outcome, in prose
  keypoints: Keypoint[];         // max 5, ordered by relevance (array order IS priority)
}

interface Keypoint {
  title: string;                 // short headline, e.g. "Payment error branch left uncovered"
  insight: string;               // 1-2 sentences: what it means and why it matters
  category: "finding" | "metric" | "trend" | "quality-gate";
  shape: Shape;                  // how to represent it visually
  evidence: EvidenceRef[];       // REQUIRED, min 1 — no evidence, no keypoint
}

interface EvidenceRef {
  source: "case" | "coverage" | "diff" | "reviewer" | "log" | "history";
  ref: string;                   // resolvable against the facts payload
}
```

### Shape catalog

Semantic intent, not widget names. Discriminated union, one strict schema per member:

| Shape | Expresses | TUI rendering | Web rendering |
|---|---|---|---|
| `stat` | one value (+ optional delta vs. history) | big number + arrow | stat card |
| `proportion` | parts of a whole (2–5 parts) | stacked bar | donut / pie |
| `distribution` | values per category | horizontal bars | bar chart |
| `trend` | evolution over N runs (points carry sha/date) | sparkline | line chart |
| `comparison` | A vs B (before/after, expected/actual) | two columns | paired bars |
| `ranked-list` | items ordered by a criterion | numbered list | list / table |

Shape-level rules enforced by the validator:

- `proportion`: parts must sum to the declared total.
- `trend`: requires ≥ 3 historical points; with fewer, the validator **degrades it to a
  `stat` with delta** instead of rejecting it.
- Unknown shape or schema mismatch → that keypoint is discarded (the digest survives with
  the remaining valid keypoints; an empty `keypoints` array with a valid `summary` is a
  valid digest).

### Trust rules (executable in `validate-digest.ts`)

- Every numeric value in a shape must exist in the facts payload — the agent reorders
  facts, it cannot mint them.
- Every `EvidenceRef.ref` must resolve against the payload (case name, line range,
  historical run sha). Unresolvable ref → keypoint discarded.
- Deliberately **no** `severity`/`tone` property: `category` + the run verdict give the
  renderer everything needed for color/emphasis. LLM-assigned severity is opinion, not
  data. The contract version exists if this ever changes.

## Facts payload (the ONLY thing the agent sees)

The agent has no tools and never touches the repo. The payload is assembled
deterministically by `assemble-run-facts.ts`:

1. **Current run:** verdict, cases (name / status / error / duration), change-coverage
   with covered/uncovered diff lines, reviewer verdict + corrections, commit
   classification, specs and other written files.
2. **Sanitized diff** — same egress path as generation today (`sanitizer.ts`).
3. **Sanitized, capped execution logs** — byte-capped like `handleAsk`'s context.
4. **History:** last N runs of the same app (verdict, pass/fail counts, coverage ratio,
   shas) via `RunHistoryPort`. N configurable, default 10.

## Agent role: `qa-summarizer`

- New prompt in `agents/agent/qa-summarizer.md` + provider-neutral mirror in
  `agent/roles/qa-summarizer.md` (the two existing prompt layers).
- No tools; context → JSON, same interaction shape as `qa-assistant`.
- Cheap model (`deepseek-v4-flash`): the task is selection and phrasing over given facts,
  not deep reasoning.
- The prompt ships the shape catalog with usage rules: "use `trend` only with ≥ 3
  historical points", "max 5 keypoints — fewer is better", "if nothing is notable beyond
  the verdict, return an empty keypoints array; do NOT pad".

## Configuration

`qa.digest` in `config/apps/<app>.yaml`:

```yaml
qa:
  digest:
    enabled: true        # default true — presentation, not a gate; no earn-trust ramp needed
    historyRuns: 10      # optional, history window size
```

App-specificity stays in `config/`, per the repo invariant.

## Error handling

- Summarizer failure/timeout/invalid JSON → loud log + no digest. Run unaffected.
- Validation discards keypoints individually; the digest survives partial validation.
- `GET /api/runs/:id/digest` → 404 when no digest exists (skipped/infra-error runs,
  disabled apps, failed generation, pre-feature runs).

## Testing (strict TDD)

- **Domain (the real risk surface):** exhaustive unit tests for `assemble-run-facts`
  and `validate-digest` — evidence resolution, per-shape schemas, numeric traceability,
  trend degradation, keypoint discarding.
- **Use case:** orchestration branches (verdict gating, fault isolation, event emission)
  tested with fakes against the ports, per the existing DI strategy.
- **LLM adapter:** deliberately uncovered boundary, `*Deps` + `default*Deps` pattern.
- `npm test` and `npm run typecheck` stay green — the gate for any `src/`/`qa-engine/`
  change.
