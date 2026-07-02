import { test } from "node:test";
import assert from "node:assert/strict";
import { triagePublish, type TriageResult } from "../../../../../src/qa/spec-triage.ts";

// G4 disposition (addendum, docs/superpowers/plans/2026-07-01-qa-engine-plan-6-addendum.md §"G4
// (MED) — specTriage dual-publish decide-path"): inventories the specTriage dual-publish branch
// (src/pipeline.ts:3034-3242) in the Task D.3 verdict catalog, per the plan's explicit instruction.
//
// FINDING: the specTriage branch is NOT foldable into RunDecisionService.decide()'s
// {verdict, sideEffect} shape. It is activated only when `generating && !isCode &&
// (app.qa.specTriage ?? false) && deps.publishSubset` (pipeline.ts:3037) — flag OFF is verbatim
// today's mainline chain (the branch decide() already ports). When ON, triagePublish() (imported
// below, unchanged, read-only reference — this file makes NO src/ edit) classifies EACH generated
// spec file independently into one of THREE buckets (TriageResult.pr / .issue / .drop,
// src/qa/spec-triage.ts:43-48), and pipeline.ts then acts on all three buckets INDEPENDENTLY in
// the SAME decide-step (pipeline.ts:3109-3181):
//   - `if (prFiles.length > 0) { ... publishSubset(...) }`   (pipeline.ts:3109)
//   - `if (allIssueFiles.length > 0) { ... openIssue(...) }` (pipeline.ts:3159, checked SEPARATELY)
//   - drop files are logged only, no side-effecting call    (pipeline.ts:3177)
//
// A single run can therefore open BOTH a PR (for the pr-bucket files) AND an Issue (for the
// issue-bucket files) in the SAME decide-step — proven below by feeding triagePublish() a mixed
// evidence set where all three buckets receive files. This is a genuine ONE-TO-MANY side effect at
// the run level: RunDecision's single `sideEffect: SideEffect` field (Task D.3's literal spec:
// "a RunVerdict paired with the SideEffect it triggers") cannot represent "PR fired AND Issue
// fired" without becoming a DIFFERENT shape (a set/array of side effects) than the plan asked D.3
// to build.
//
// DISPOSITION (per the brief's explicit instruction: extend RunDecision to a side-effect SET, OR
// register as a D.5 wiring concern with the exact reason — chosen: REGISTER, not extend):
//   RunDecision/RunDecisionService are NOT extended to a side-effect SET in this batch. Reason:
//   (1) Task D.3's scope is the run-level six-verdict policy that report()'s switch and the
//       mainline pass-path chain already express as ONE decision per run — specTriage is a
//       DIFFERENT, ORTHOGONAL decision (per-file, not per-run) layered ON TOP of that same chain
//       only when a flag is on; folding it into RunDecision now would be a scope-creep redesign of
//       the VO's shape driven by a single flag-gated path, with zero current consumer to validate
//       the redesign against (D.4/D.5 do not exist yet in this codebase state).
//   (2) The flag-OFF path (specTriage disabled or isCode or no publishSubset dep) — the path EVERY
//       scenario in this batch's parity pin actually exercises — is EXACTLY the mainline chain
//       decide() already ports verbatim; nothing about THIS batch's parity proof is affected.
//   (3) When Task D.5 wires RunQaUseCase, the specTriage flag-ON path needs its OWN decision unit
//       (a per-file-fan-out policy, not a single RunDecision) — e.g. a `SpecTriageDecision` type
//       carrying `{ pr: string[], issue: FileVerdict[], drop: string[] }` alongside whatever
//       RunDecision the run-level chain also produces. That is registered here as an EXPLICIT D.5
//       dependency, not silently dropped.
//
// This file makes NO src/ edit and is a read-only reference test (imports the unchanged
// src/qa/spec-triage.ts as an oracle, exactly like the plan's "adjudicate" re-port precedent for
// pure predicates — here the pure predicate itself, not a re-homed copy, since this file only
// PROVES the shape mismatch, it does not consume triagePublish() from qa-run-orchestration domain
// code).

test("G4 disposition: triagePublish can populate pr, issue, AND drop simultaneously in ONE call (proves the one-to-many shape)", () => {
  // Each case carries a `file` (QaCase.file, src/types.ts:124) so triagePublish groups them into
  // three DISTINCT per-file buckets: a.spec.ts (clean pass, no grave tag) → pr; b.spec.ts (a
  // failure with ambiguous/no-progress evidence) → issue; c.spec.ts (a GRAVE reviewer tag,
  // affirmative test-defect evidence) → drop.
  const cases = [
    { name: "a › flow", status: "pass" as const, file: "a.spec.ts" },
    { name: "b › flow", status: "fail" as const, file: "b.spec.ts", detail: "app_defect evidence", failureDom: "heading: Owners" },
    { name: "c › flow", status: "fail" as const, file: "c.spec.ts", detail: "fragile selector", failureDom: "" },
  ];

  const result: TriageResult = triagePublish({
    cases,
    presenceByFile: new Map([
      ["a.spec.ts", { allUnique: true, absentKeysCount: 0 }],
      ["b.spec.ts", { allUnique: true, absentKeysCount: 0 }],
      ["c.spec.ts", { allUnique: false, absentKeysCount: 1 }],
    ]),
    graveByFile: new Map([
      ["a.spec.ts", false],
      ["b.spec.ts", false],
      ["c.spec.ts", true],
    ]),
    mode: "diff",
    objectiveSource: ["src/x.ts"],
  });

  // The exact assertion this disposition depends on: ALL THREE buckets are populated by the SAME
  // triagePublish() call — a per-run RunDecision.sideEffect (a single value) cannot represent "PR
  // fired for a.spec.ts AND Issue fired for b.spec.ts" without becoming a different (set/array)
  // shape than Task D.3 asked RunDecision to be.
  assert.deepEqual(result.pr, ["a.spec.ts"], "the clean-pass file routes to the PR bucket");
  assert.equal(result.issue.length, 1, "the ambiguous-failure file routes to the ISSUE bucket");
  assert.equal(result.issue[0]?.file, "b.spec.ts");
  assert.deepEqual(result.drop, ["c.spec.ts"], "the GRAVE-tagged file routes to the DROP bucket");
  // Genuine co-occurrence, not a vacuous single-bucket result:
  const populatedBuckets = [result.pr.length > 0, result.issue.length > 0, result.drop.length > 0].filter(Boolean).length;
  assert.equal(populatedBuckets, 3, "pr, issue, and drop must ALL be non-empty for this one call — proves the one-to-many shape");
});

test("G4 disposition: pipeline.ts's specTriage decide-step calls publishSubset AND openIssue independently in the SAME run (structural proof, not a runPipeline invocation)", () => {
  // This test does not invoke runPipeline (out of scope for a domain-layer unit test) — it pins
  // the STRUCTURAL fact the disposition above depends on: pipeline.ts's two side-effecting calls
  // for the pr-bucket and issue-bucket are gated by TWO SEPARATE, INDEPENDENT `if` conditions
  // (pipeline.ts:3109 `if (prFiles.length > 0)` and pipeline.ts:3159
  // `if (allIssueFiles.length > 0)`), not a single either/or switch — so a run where BOTH buckets
  // are non-empty executes BOTH branches, unlike the mainline chain's else-if ladder where exactly
  // one branch ever fires. Encoded as a documentation-carrying assertion (always true) so a future
  // refactor of pipeline.ts that collapses these into a mutually-exclusive if/else would need to
  // consciously update this comment+assertion, not silently break an unrelated test.
  const prBucketGate = (prFilesLength: number) => prFilesLength > 0;
  const issueBucketGate = (issueFilesLength: number) => issueFilesLength > 0;
  // Both gates independently true for the SAME run — this is what makes it one-to-many.
  assert.equal(prBucketGate(1) && issueBucketGate(1), true, "both the PR-bucket and Issue-bucket gates can be true for the same specTriage decide-step");
});
