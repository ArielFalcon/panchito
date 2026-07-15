// qa-engine/test/contract/seam-parity.contract.test.ts
//
// THE CLASS-KILLER (task #40). Every audit/live-run finding from 2026-06-25..2026-07-02 traced back
// to ONE root pattern: "a value exists at layer N of the rewritten chain and dies at layer N+1"
// (baseUrl reached execution but not the generation prompt; namespace, mode, guidance, publish
// flags, manifest fields, enrichment fields — all the SAME class of bug, found by a live run or a
// manual audit each time, never by a test). This file is the mechanized regression gate: it
// enumerates each legacy input surface and asserts the rewritten chain carries every field.
//
// Lives under qa-engine/test/contract/ (not test/contexts/.../bridges/) because it deliberately
// imports BOTH root src/ (the legacy shape it audits against) AND qa-engine's @contexts/@kernel
// aliases — the SAME "src/-importing seam" characterization-test pattern this file itself
// established. It is therefore excluded from qa-engine/tsconfig.json's
// `include` and added to qa-engine/tsconfig.parity.json's `include` instead, mirroring that exact
// precedent (see this repo's package.json `typecheck` script: tsc -b qa-engine/tsconfig.json, THEN
// tsc --noEmit -p tsconfig.json, THEN tsc --noEmit -p qa-engine/tsconfig.parity.json — three
// separate programs, each covering a disjoint file set).
//
// DESIGN — two describe-blocks, one per audited surface (migration-tier-4c Slice 6 retired the
// former (a) GENERATION PROMPT and (b) REVIEW blocks: OpencodeRunInput/ReviewInput's legacy
// declarations in src/integrations/opencode-client.ts were deleted once prompts.ts's builders and
// their canonical ports types fully migrated to qa-engine — see
// docs/superpowers/2026-07-14-migration-tier-4c-decisions.md. migration-tier-4d Slice 1b retired
// the former (c) EXECUTION block: ExecuteOptions/src/qa/execute.ts no longer exist — the real
// e2e-runner body moved into qa-engine's own e2e-execution.runner.ts, so there is no more
// src/-vs-qa-engine seam left to pin for this surface. Its exhaustiveness-guard coverage re-forms
// as a qa-engine-internal E2eExecuteOptions↔ExecutionRequest test with NO src/ import — see
// qa-engine/test/contexts/qa-run-orchestration/infrastructure/bridges/execution-port.adapter.test.ts,
// which already covers the field-forwarding behavior this block used to pin, plus the new
// exhaustiveness test added there in the same commit that retired this block):
//   d) PERSISTENCE — kernel RunOutcome vs SqliteRunHistoryAdapter's toLegacyRunOutcome mapping
//      (fully-populated kernel outcome, real (pure) mapping fn — no fake needed, it's already pure).
//   e) COMPOSITION — CompositionConfig vs buildRewrittenCompositionConfig's returned object
//      (a fully-populated AppConfig, asserting every non-optional field is present and every
//      optional field is either present or in a documented allowlist).
//
// Blocks (d)/(e) are PERMANENT boundary-contract tests, not migration debt: rewritten-engine-factory.ts
// (COMPOSITION) and run-history-sqlite-adapter.ts (PERSISTENCE) are DECLARED permanent shell
// survivors (migration-tier-4d design D-4d-1/D-4d-2) — arch:check's one-way rule (qa-engine never
// imports src/) makes their dissolution architecturally impossible, not merely undesirable. This
// file's own qa-engine/tsconfig.parity.json entry stays for exactly that reason: "anything crossing
// the boundary," not "anything pending retirement."
//
// Each block enumerates its target TYPE's field list via a `keyof`-driven `satisfies`/array
// construction so that a field ADDED to the type without a matching allowlist/sentinel entry FAILS
// TYPECHECK (npm run typecheck), and a field silently DROPPED by the adapter FAILS THIS TEST (npm
// test) — the two gates this class of bug needs closed. Every allowlist entry carries a one-line
// reason. Failure messages name the dropped field AND the dying layer.
import { test, describe } from "node:test";
import assert from "node:assert/strict";

import type { RunOutcome as KernelRunOutcome } from "@kernel/run-outcome.ts";

import { toLegacyRunOutcome, type RunHistorySqliteAdapterDeps, SqliteRunHistoryAdapter } from "../../../src/server/run-history-sqlite-adapter.ts";
import { buildRewrittenCompositionConfig, type RewrittenEngineFactoryDeps } from "../../../src/server/rewritten-engine-factory.ts";
import type { AppConfig } from "../../../src/orchestrator/config-loader.ts";
import type { AgentDeps } from "../../../src/integrations/opencode-client.ts";

// ── shared sentinel helpers ─────────────────────────────────────────────────────────────────────
// A sentinel is a value that is IMPOSSIBLE to produce by accident (unlike "", 0, false, or []),
// so `assert.equal(captured.field, SENTINEL)` fails loudly if the adapter silently substitutes a
// default, drops the field, or forwards the wrong one.
const S = (field: string): string => `__SENTINEL__${field}__`;

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (d) PERSISTENCE surface — kernel RunOutcome vs SqliteRunHistoryAdapter's toLegacyRunOutcome
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("seam-parity: PERSISTENCE (kernel RunOutcome vs toLegacyRunOutcome)", () => {
  const ALL_TOP_FIELDS = {
    runId: true, app: true, sha: true, mode: true, target: true, verdict: true, errorClass: true,
    gateSignals: true, rulesRetrieved: true, reflection: true, at: true, note: true, cases: true,
    logs: true, adjudication: true,
  } satisfies Record<keyof KernelRunOutcome, true>;

  const ALL_GATE_SIGNAL_FIELDS = {
    static: true, coverageRatio: true, valueScore: true, reviewerCorrections: true,
    reviewerRationale: true, reviewerApproved: true, flaky: true, retries: true, confinement: true,
    usage: true, phaseTimings: true, preExecAmbiguityCatches: true, deterministicSelectorBlocks: true,
    catalogGateInWindow: true, catalogGateAdvisory: true, catalogGateFailClosed: true,
    structuralSignalBytes: true, serviceLinksCount: true, contractDriftCount: true,
    crossRepoImpactedCount: true,
  } satisfies Record<keyof KernelRunOutcome["gateSignals"], true>;

  const ALLOWLIST: Record<string, string> = {
    // W5 fix (seam-parity re-classification, evidence-verified): RE-CLASSIFIED from FIXME to
    // correct-by-design. The original entry claimed "LegacyRunOutcome's own `note?: string` field" —
    // this is WRONG: legacy's actual `RunOutcome` interface (src/types.ts:224-274 — runId, app, sha,
    // mode, target, verdict, errorClass, gateSignals, rulesRetrieved, reflection, at) has NO `note`
    // field at all, grep/read-confirmed exhaustively against the full interface body. The TWO
    // `note?: string` fields that DO exist in src/types.ts belong to DIFFERENT types entirely:
    // QaRunResult (types.ts:153, "human-readable summary... reviewer rejection, skip reason") and
    // RunRecord (types.ts:194, the SQLite-persisted live-run record) — neither is RunOutcome. And
    // src/server/runner.ts:196-199 (runViaRewrittenEngine's own header) independently confirms this
    // exact gap from the OTHER direction: "RunOutcome carries no such field at this port boundary...
    // updateRecord's own note:run.note fallback already surfaces the publish outcome via
    // RunQaResult.note -> RunOutcome.note" — i.e. `note` reaches the run record through a DIFFERENT
    // seam (QaRunResult.note -> RunRecord.note), never through toLegacyRunOutcome/saveRunOutcome's
    // run_outcomes row. So toLegacyRunOutcome dropping `note` is FAITHFUL to the legacy shape it
    // targets (LegacyRunOutcome, this adapter's own type, which also has no note field) — not a bug.
    note: "CORRECT BY DESIGN (not a drop): toLegacyRunOutcome never carries outcome.note through because LegacyRunOutcome (src/types.ts's RunOutcome interface) has NO note field to carry it TO — grep/read-confirmed against the full interface. The kernel RunOutcome.note reaches the run record through a SEPARATE seam (QaRunResult.note -> RunRecord.note, src/server/runner.ts's own W3 F3 header), never through this mapping fn's run_outcomes row. Diagnostic-only either way (never gates verdict/publish).",
    cases: "DELIBERATELY not persisted via toLegacyRunOutcome — LegacyRunOutcome (src/types.ts) has NO cases field at all (grep-confirmed); this field exists on the kernel RunOutcome ONLY for a DIFFERENT driving-side consumer (src/server/runner.ts's runViaRewrittenEngine threads it into history.addCase() calls directly, per this file's own W3 F3 header comment), not for the run_outcomes row this adapter writes. Comparator-blind by the kernel type's own documented construction.",
    logs: "DELIBERATELY not persisted via toLegacyRunOutcome — same reason as cases above: LegacyRunOutcome has no logs field (grep-confirmed), and the kernel RunOutcome's own header says this is 'the same one-shot... string legacy's own QaRunResult.logs carries', a different sink than the run_outcomes row.",
    adjudication: "CORRECT BY DESIGN (not a drop): post-cutover-remediation P3 — LegacyRunOutcome (src/types.ts) has NO adjudication field at all (the legacy pipeline never threaded FixLoop's lastAdjudicatorVerdict into a persisted RunOutcome). This is a REWRITTEN-ONLY field: the kernel type carries it (wide, optional — see run-outcome.ts's own header) so shouldDistillLearning's fold guard can read it in run-qa.use-case.ts, but toLegacyRunOutcome has no legacy counterpart shape to map it into. Diagnostic/gating-only within the rewritten path; never reaches the legacy run_outcomes row.",
  };

  test("kernel RunOutcome's own top-level field list matches the allowlist + the mapping fn's carried set exactly", () => {
    const mapped = ["runId", "app", "sha", "mode", "target", "verdict", "errorClass", "gateSignals", "rulesRetrieved", "reflection", "at"];
    const allFieldNames = Object.keys(ALL_TOP_FIELDS).sort();
    const accountedFor = [...new Set([...mapped, ...Object.keys(ALLOWLIST)])].sort();
    assert.deepEqual(accountedFor, allFieldNames, "every kernel RunOutcome top-level field must be either mapped or allowlisted with a reason");
  });

  test("gateSignals' own field list is fully mapped (no allowlist needed — every field carries through)", () => {
    const mapped = [
      "static", "coverageRatio", "valueScore", "reviewerCorrections", "reviewerRationale",
      "reviewerApproved", "flaky", "retries", "confinement", "usage", "phaseTimings",
      "preExecAmbiguityCatches", "deterministicSelectorBlocks", "catalogGateInWindow",
      "catalogGateAdvisory", "catalogGateFailClosed",
      "structuralSignalBytes", "serviceLinksCount", "contractDriftCount", "crossRepoImpactedCount",
    ];
    assert.deepEqual(mapped.sort(), Object.keys(ALL_GATE_SIGNAL_FIELDS).sort(), "every gateSignals field must be mapped — toLegacyRunOutcome's own header claims 100% pass-through for this nested object");
  });

  test("toLegacyRunOutcome carries every top-level + gateSignals field through with its sentinel value (fully-populated kernel outcome)", () => {
    const kernelOutcome: KernelRunOutcome = {
      runId: S("runId"),
      app: S("app"),
      sha: S("sha"),
      mode: "diff",
      target: "e2e",
      verdict: "pass",
      errorClass: "E-EXEC-FAIL",
      gateSignals: {
        static: true,
        coverageRatio: 0.42,
        valueScore: 0.77,
        reviewerCorrections: [S("reviewerCorrections")],
        reviewerRationale: S("reviewerRationale"),
        reviewerApproved: true,
        flaky: true,
        retries: 3,
        confinement: { strays: 1, dangerous: 0, reverted: [S("reverted")] },
        usage: { totalTokens: 999 },
        phaseTimings: { generate: 111 },
        preExecAmbiguityCatches: 2,
        deterministicSelectorBlocks: 1,
        catalogGateInWindow: 5,
        catalogGateAdvisory: 4,
        catalogGateFailClosed: 0,
        structuralSignalBytes: 512,
        serviceLinksCount: 3,
        contractDriftCount: 0,
        crossRepoImpactedCount: 2,
      },
      rulesRetrieved: [S("rulesRetrieved")],
      reflection: { rootCause: S("reflection.rootCause") },
      at: "2026-07-02T00:00:00.000Z",
      note: S("note"),
    };

    const out = toLegacyRunOutcome(kernelOutcome);
    const dyingLayer = "toLegacyRunOutcome() -> LegacyRunOutcome (src/server/run-history-sqlite-adapter.ts)";

    assert.equal(out.runId, S("runId"), `runId dropped at ${dyingLayer}`);
    assert.equal(out.app, S("app"), `app dropped at ${dyingLayer}`);
    assert.equal(out.sha, S("sha"), `sha dropped at ${dyingLayer}`);
    assert.equal(out.mode, "diff", `mode dropped at ${dyingLayer}`);
    assert.equal(out.target, "e2e", `target dropped at ${dyingLayer}`);
    assert.equal(out.verdict, "pass", `verdict dropped at ${dyingLayer}`);
    assert.equal(out.errorClass, "E-EXEC-FAIL", `errorClass dropped at ${dyingLayer}`);
    assert.deepEqual(out.rulesRetrieved, [S("rulesRetrieved")], `rulesRetrieved dropped at ${dyingLayer}`);
    assert.equal((out.reflection as { rootCause?: string } | undefined)?.rootCause, S("reflection.rootCause"), `reflection dropped at ${dyingLayer}`);
    assert.equal(out.at, "2026-07-02T00:00:00.000Z", `at dropped at ${dyingLayer}`);

    const gs = out.gateSignals;
    assert.equal(gs.static, true, `gateSignals.static dropped at ${dyingLayer}`);
    assert.equal(gs.coverageRatio, 0.42, `gateSignals.coverageRatio dropped at ${dyingLayer}`);
    assert.equal(gs.valueScore, 0.77, `gateSignals.valueScore dropped at ${dyingLayer}`);
    assert.deepEqual(gs.reviewerCorrections, [S("reviewerCorrections")], `gateSignals.reviewerCorrections dropped at ${dyingLayer}`);
    assert.equal(gs.reviewerRationale, S("reviewerRationale"), `gateSignals.reviewerRationale dropped at ${dyingLayer}`);
    assert.equal(gs.reviewerApproved, true, `gateSignals.reviewerApproved dropped at ${dyingLayer}`);
    assert.equal(gs.flaky, true, `gateSignals.flaky dropped at ${dyingLayer}`);
    assert.equal(gs.retries, 3, `gateSignals.retries dropped at ${dyingLayer}`);
    assert.deepEqual(gs.confinement, { strays: 1, dangerous: 0, reverted: [S("reverted")] }, `gateSignals.confinement dropped at ${dyingLayer}`);
    assert.deepEqual(gs.usage, { totalTokens: 999 }, `gateSignals.usage dropped at ${dyingLayer}`);
    assert.deepEqual(gs.phaseTimings, { generate: 111 }, `gateSignals.phaseTimings dropped at ${dyingLayer}`);
    assert.equal(gs.preExecAmbiguityCatches, 2, `gateSignals.preExecAmbiguityCatches dropped at ${dyingLayer}`);
    assert.equal(gs.deterministicSelectorBlocks, 1, `gateSignals.deterministicSelectorBlocks dropped at ${dyingLayer}`);
    assert.equal(gs.catalogGateInWindow, 5, `gateSignals.catalogGateInWindow dropped at ${dyingLayer}`);
    assert.equal(gs.catalogGateAdvisory, 4, `gateSignals.catalogGateAdvisory dropped at ${dyingLayer}`);
    assert.equal(gs.catalogGateFailClosed, 0, `gateSignals.catalogGateFailClosed dropped at ${dyingLayer}`);
    assert.equal(gs.structuralSignalBytes, 512, `gateSignals.structuralSignalBytes dropped at ${dyingLayer}`);
    assert.equal(gs.serviceLinksCount, 3, `gateSignals.serviceLinksCount dropped at ${dyingLayer}`);
    assert.equal(gs.contractDriftCount, 0, `gateSignals.contractDriftCount dropped at ${dyingLayer}`);
    assert.equal(gs.crossRepoImpactedCount, 2, `gateSignals.crossRepoImpactedCount dropped at ${dyingLayer}`);

    assert.equal("note" in out, false, `note IS in the allowlist as CORRECT BY DESIGN (re-classified, W5) — LegacyRunOutcome genuinely has no note field, see the allowlist entry's own evidence trail; if this starts failing because LegacyRunOutcome gains a note field, update the allowlist entry above instead of patching the assertion`);
  });

  test("SqliteRunHistoryAdapter.save() forwards the mapped outcome to the injected saveOutcome (the seam a real caller uses)", async () => {
    let captured: unknown;
    const deps: RunHistorySqliteAdapterDeps = { saveOutcome: (o) => { captured = o; } };
    const adapter = new SqliteRunHistoryAdapter(deps);
    await adapter.save({
      runId: S("runId"), app: S("app"), sha: S("sha"), mode: "diff", target: "e2e", verdict: "pass",
      errorClass: null,
      gateSignals: { static: true, coverageRatio: null, valueScore: null, reviewerCorrections: [], flaky: false, retries: 0 },
      rulesRetrieved: [], at: "2026-07-02T00:00:00.000Z",
    });
    assert.equal((captured as { runId: string }).runId, S("runId"), "SqliteRunHistoryAdapter.save() dropped runId before it reached saveOutcome");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// (e) COMPOSITION surface — CompositionConfig vs buildRewrittenCompositionConfig
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("seam-parity: COMPOSITION (CompositionConfig vs buildRewrittenCompositionConfig)", () => {
  // Fields buildRewrittenCompositionConfig deliberately does NOT populate, each with a reason.
  // This is the SAME class of audit that caught the original 5 gaps (baseUrl/branch/mode/guidance/
  // testIdAttribute), mechanized: every optional CompositionConfig field must appear here OR be
  // asserted present by buildRewrittenCompositionConfigTest below.
  const OPTIONAL_ALLOWLIST: Record<string, string> = {
    guidance: "supplied by buildRewrittenCompositionConfig ONLY when run.guidance is present (asserted below as a present-when-given case) — legitimately absent for diff-mode runs with no manual guidance.",
    diff: "DELIBERATELY static '' — see this fn's own header 'difference #2': GenerationPortAdapter/ReviewPortAdapter both resolve the REAL per-run diff dynamically from ChangeAnalysisPort.classify() instead, since no per-run diff exists yet at composition-build time.",
    baseUrl: "supplied ONLY when app.dev?.baseUrl is present (asserted below as a present-when-given case) — legitimately absent for code-mode apps (no dev: block).",
    testIdAttribute: "supplied ONLY when app.e2e?.testIdAttribute is present (asserted below as a present-when-given case) — deliberately NO 'data-testid' default applied here (the seed playwright.config.ts already defaults it); legitimately absent when the app declares none.",
    readSpecSource: "FIXED (W5 quick win): IS supplied (a plain fs readFile) — asserted below as a present case. Wires the file-read collaborator FixLoop's Lever-2 selector-contradiction check needs (GenerationPortAdapter's optional collaborator, see that adapter's own header) so Lever-2 actually receives specSources on the real production path instead of [] forever.",
    setupCollaborators: "IS supplied (e2e + code) — asserted below as a present case; listed here only because this describe-block enumerates the type's full optional-field set before splitting into present/allowlisted.",
    cleanupCollaborators: "IS supplied (e2e only, matching composition-root.ts's own `!cfg.isCode` gate) — asserted below as a present case.",
    groundingCollaborators: "IS supplied ({} — resolves to the real production default per this factory's own header) — asserted below as a present case.",
    reviewDomGroundingCollaborators: "IS supplied ({}) — asserted below as a present case.",
    serviceTopology: "supplied ONLY when app.services?.length && app.boundaries?.length are both present (asserted below as a present-when-given case, ADR-6) — legitimately absent for single-repo apps or apps that never declared a cross-service boundary profile. Mirrors the 'observer' precedent immediately below: supplied only when the caller/config provides it.",
    crossRepoImpact: "supplied ONLY under the SAME structuralSignalsOn && app.services?.length && app.boundaries?.length gate serviceTopology uses (Slice C, structural-signals-expansion design §3.8) — legitimately absent for single-repo apps, apps with no declared boundary profile, or when structuralSignals.mode is 'off'.",
    contextMap: "DELIBERATELY absent — see this fn's own header: no per-run mirrorDir/diff exists yet at composition-build time to read e2e/.qa/context.json from. Documented graceful degradation, not a drop.",
    prChangedFiles: "DELIBERATELY absent — same reason as contextMap (per-run intent.changedFiles doesn't exist yet at composition-build time).",
    versionUrl: "supplied ONLY when app.dev?.versionUrl is present — legitimately absent for code-mode/static apps (no deploy gate).",
    versionPoll: "supplied ONLY when app.dev?.versionUrl is present (paired with versionUrl above).",
    deployGateIntervalMs: "IS supplied (defaulted via ?? DEFAULT) — asserted below as a present case.",
    deployGateTimeoutMs: "IS supplied (defaulted via ?? DEFAULT) — asserted below as a present case.",
    historyFilePath: "supplied ONLY as an explicit escape hatch (deps.historyFilePath) — production default path uses `runHistory` (SqliteRunHistoryAdapter) instead, asserted below.",
    runHistory: "IS supplied by default (SqliteRunHistoryAdapter) — asserted below as a present case; historyFilePath above is the opt-OUT alternative, mutually exclusive with this field.",
    observer: "supplied ONLY when the caller passes one — asserted below as a present-when-given case; legitimately absent for callers (tests, the F.2 operator) that omit it.",
    assembleChangeCoverage: "IS supplied (the value keystone) — asserted below as a present case.",
    baselineCases: "IS supplied ([]) — asserted below as a present case.",
    coverageBlocksForPublish: "IS supplied (false) — asserted below as a present case.",
    e2eChangedForPublish: "IS supplied (true) — asserted below as a present case.",
    reviewerApprovedForPublish: "IS supplied (true) — asserted below as a present case.",
    sanitize: "IS supplied (the real sanitizeText, F4 CRITICAL security invariant) — asserted below as a present case.",
    // sdd/migration-wiring-phase-2 Slice 6b (logs→Issue egress boundary): IS supplied (the SAME
    // RedactionPortAdapter instance's containsSecret, wired alongside sanitize's own redact
    // immediately above) — wired UNCONDITIONALLY, the SAME "IS supplied" precedent sanitize
    // establishes. Asserted below as a present case.
    containsSecret: "IS supplied (RedactionPortAdapter.containsSecret, wired alongside sanitize) — asserted below as a present case.",
    learningRepo: "IS supplied (SqliteLearningRepository) — asserted below as a present case.",
    // sdd/migration-remediation Slice 3 (P0 write-confinement wiring, D-P0b, task 3.6): IS supplied
    // (a WriteConfinementAdapter wrapping realGit — local ops, NO auth decoration — + node:fs
    // realpathSync/lstatSync) — asserted below as a present case, the SAME "IS supplied" precedent as
    // sanitize/learningRepo/assembleChangeCoverage immediately above.
    confinement: "IS supplied (WriteConfinementAdapter wrapping realGit + realpathSync/lstatSync) — asserted below as a present case.",
    // sdd/migration-remediation Slice 5 (P1 process-audit reconnect, D-P1b, task 5.7): IS supplied
    // (a ProcessAuditPortAdapter wrapping history.ts's listRunOutcomes/listLearningRules reads + the
    // 3 sinks recordIncident/setRuleStatusByHuman/markContextStale) — wired UNCONDITIONALLY (fail-open
    // fault isolation, not app-config gated), the SAME "IS supplied" precedent confinement/
    // reflectorPort establish immediately above. Asserted below as a present case.
    processAudit: "IS supplied (ProcessAuditPortAdapter wrapping history.ts reads + recordIncident/setRuleStatusByHuman/markContextStale sinks) — asserted below as a present case.",
    // sdd/migration-wiring-phase-2 Slice 2 (D-B mirror-gc, task 2.3): IS supplied (a MirrorGcAdapter
    // wrapping realGit's own local `git gc --auto --quiet`, no auth decoration) — wired
    // UNCONDITIONALLY (fail-open fault isolation, not app-config gated), the SAME "IS supplied"
    // precedent confinement/processAudit establish immediately above. Asserted below as a present case.
    mirrorGc: "IS supplied (MirrorGcAdapter wrapping realGit's local `git gc --auto --quiet`) — asserted below as a present case.",
  };

  function fakeAppConfig(overrides: Partial<AppConfig> = {}): AppConfig {
    return {
      name: S("app.name"),
      repo: S("app.repo"),
      baseBranch: S("app.baseBranch"),
      dev: { baseUrl: S("app.dev.baseUrl"), versionUrl: S("app.dev.versionUrl") },
      e2e: { testIdAttribute: S("app.e2e.testIdAttribute") },
      qa: { needsReview: true, shadow: false },
      report: { onFailure: "issue" },
      ...overrides,
    } as unknown as AppConfig;
  }

  function fakeFactoryDeps(): RewrittenEngineFactoryDeps {
    return { getAgentDeps: () => ({}) as unknown as AgentDeps };
  }

  test("buildRewrittenCompositionConfig supplies every non-optional CompositionConfig field, and every optional field is either present-when-expected or documented in OPTIONAL_ALLOWLIST", async () => {
    const cfg = buildRewrittenCompositionConfig(
      fakeAppConfig(),
      fakeFactoryDeps(),
      S("namespace"),
      { mode: "diff", guidance: S("run.guidance") },
    );

    const dyingLayer = "buildRewrittenCompositionConfig() -> CompositionConfig (src/server/rewritten-engine-factory.ts)";

    // Non-optional fields — every one MUST be present (undefined fails these asserts loudly).
    const nonOptional: Array<keyof typeof cfg> = [
      "repo", "appName", "mirrorDir", "e2eRelDir", "branch", "target", "mode", "needsReview",
      "shadow", "onFailure", "maxRetries", "isCode", "coveragePolicyMode", "vcs", "generationUseCase",
      "reviewRuntime", "validationStrategies", "executionStrategies", "objectiveSignal", "coveragePolicy",
      "githubPr", "githubIssue", "checkout",
    ];
    for (const field of nonOptional) {
      assert.notEqual(cfg[field], undefined, `${String(field)} (non-optional CompositionConfig field) dropped at ${dyingLayer}`);
    }

    // Optional fields this factory IS expected to populate given a fully-populated AppConfig.
    assert.equal(cfg.guidance, S("run.guidance"), `guidance dropped at ${dyingLayer}`);
    assert.equal(cfg.baseUrl, S("app.dev.baseUrl"), `baseUrl dropped at ${dyingLayer} (the CRITICAL live-crash fix this fn's own header documents)`);
    assert.equal(cfg.testIdAttribute, S("app.e2e.testIdAttribute"), `testIdAttribute dropped at ${dyingLayer} (worst leak in audit-2026-07-flaky-selector-leaks)`);
    assert.ok(cfg.setupCollaborators?.e2e && cfg.setupCollaborators?.code, `setupCollaborators dropped at ${dyingLayer}`);
    assert.ok(cfg.cleanupCollaborators?.e2e, `cleanupCollaborators dropped at ${dyingLayer}`);
    assert.notEqual(cfg.groundingCollaborators, undefined, `groundingCollaborators dropped at ${dyingLayer}`);
    assert.notEqual(cfg.reviewDomGroundingCollaborators, undefined, `reviewDomGroundingCollaborators dropped at ${dyingLayer}`);
    assert.equal(cfg.versionUrl, S("app.dev.versionUrl"), `versionUrl dropped at ${dyingLayer}`);
    assert.notEqual(cfg.versionPoll, undefined, `versionPoll dropped at ${dyingLayer}`);
    assert.equal(cfg.deployGateIntervalMs, 2000, `deployGateIntervalMs dropped/mis-defaulted at ${dyingLayer}`);
    assert.equal(cfg.deployGateTimeoutMs, 60000, `deployGateTimeoutMs dropped/mis-defaulted at ${dyingLayer}`);
    assert.notEqual(cfg.runHistory, undefined, `runHistory (SqliteRunHistoryAdapter default) dropped at ${dyingLayer}`);
    assert.notEqual(cfg.assembleChangeCoverage, undefined, `assembleChangeCoverage (the value keystone) dropped at ${dyingLayer}`);
    assert.deepEqual(cfg.baselineCases, [], `baselineCases dropped at ${dyingLayer}`);
    assert.equal(cfg.coverageBlocksForPublish, false, `coverageBlocksForPublish dropped at ${dyingLayer}`);
    assert.equal(cfg.e2eChangedForPublish, true, `e2eChangedForPublish dropped at ${dyingLayer}`);
    assert.equal(cfg.reviewerApprovedForPublish, true, `reviewerApprovedForPublish dropped at ${dyingLayer}`);
    assert.notEqual(cfg.sanitize, undefined, `sanitize (F4 CRITICAL security invariant) dropped at ${dyingLayer}`);
    // sdd/migration-wiring-phase-2 Slice 6b: containsSecret must be wired unconditionally alongside
    // sanitize — the SAME "IS supplied" assertion pattern immediately above.
    assert.notEqual(cfg.containsSecret, undefined, `containsSecret (logs→Issue egress boundary, Slice 6b) dropped at ${dyingLayer}`);
    assert.notEqual(cfg.learningRepo, undefined, `learningRepo dropped at ${dyingLayer}`);
    // sdd/migration-remediation Slice 3 (task 3.6): confinement must be wired unconditionally (fail-open
    // fault isolation, not app-config gated) — the SAME "IS supplied" assertion pattern as sanitize/
    // learningRepo immediately above.
    assert.notEqual(cfg.confinement, undefined, `confinement (write-confinement wiring, D-P0b) dropped at ${dyingLayer}`);
    // sdd/migration-remediation Slice 5 (task 5.7): processAudit must be wired unconditionally (fail-
    // open fault isolation, not app-config gated) — the SAME "IS supplied" assertion pattern as
    // confinement immediately above.
    assert.notEqual(cfg.processAudit, undefined, `processAudit (process-audit reconnect, D-P1b) dropped at ${dyingLayer}`);
    // sdd/migration-wiring-phase-2 Slice 2 (task 2.3): mirrorGc must be wired unconditionally
    // (fail-open fault isolation, not app-config gated) — the SAME "IS supplied" assertion pattern
    // as confinement/processAudit immediately above.
    assert.notEqual(cfg.mirrorGc, undefined, `mirrorGc (mirror-lifecycle wiring, D-B) dropped at ${dyingLayer}`);
    // W5 fix (seam-parity FIXME, flipped): readSpecSource IS wired now — assert it's a real file-read
    // collaborator, not just a truthy stub, by reading this very test file back through it.
    assert.equal(typeof cfg.readSpecSource, "function", `readSpecSource dropped at ${dyingLayer} (Lever-2 selector-contradiction check starves without it)`);
    const readBack = await cfg.readSpecSource!(import.meta.url.replace("file://", ""));
    assert.ok(readBack.includes("seam-parity.contract.test.ts"), `readSpecSource at ${dyingLayer} did not return real file content`);

    // Deliberately-absent-at-this-call optional fields (see OPTIONAL_ALLOWLIST for why).
    assert.equal(cfg.diff, "", "diff is deliberately static '' at composition time — see OPTIONAL_ALLOWLIST.diff");
    assert.equal(cfg.contextMap, undefined, "contextMap is deliberately absent at composition time — see OPTIONAL_ALLOWLIST.contextMap");
    assert.equal(cfg.prChangedFiles, undefined, "prChangedFiles is deliberately absent at composition time — see OPTIONAL_ALLOWLIST.prChangedFiles");
    assert.equal(cfg.historyFilePath, undefined, "historyFilePath is the opt-OUT alternative to runHistory — absent by default, see OPTIONAL_ALLOWLIST.historyFilePath");
    assert.equal(cfg.observer, undefined, "observer is absent because this call omitted the 5th argument — see OPTIONAL_ALLOWLIST.observer");
  });

  test("every documented OPTIONAL_ALLOWLIST field is a REAL optional field on the type (guards against a stale allowlist entry after a refactor)", () => {
    const cfg = buildRewrittenCompositionConfig(fakeAppConfig(), fakeFactoryDeps(), S("namespace"), { mode: "diff" });
    for (const field of Object.keys(OPTIONAL_ALLOWLIST)) {
      assert.ok(field in cfg || cfg[field as keyof typeof cfg] === undefined, `OPTIONAL_ALLOWLIST references '${field}', which is not a real field on the returned CompositionConfig object shape — stale allowlist entry`);
    }
  });

  test("buildRewrittenCompositionConfig leaves guidance/baseUrl/testIdAttribute/versionUrl/observer absent when the AppConfig/caller omits them (never fabricated)", () => {
    const cfg = buildRewrittenCompositionConfig(
      fakeAppConfig({ dev: undefined, e2e: undefined } as Partial<AppConfig>),
      fakeFactoryDeps(),
      S("namespace"),
      { mode: "diff" },
    );
    assert.equal(cfg.guidance, undefined);
    assert.equal(cfg.baseUrl, undefined);
    assert.equal(cfg.testIdAttribute, undefined);
    assert.equal(cfg.versionUrl, undefined);
    assert.equal(cfg.versionPoll, undefined);
    assert.equal(cfg.observer, undefined);
  });
});
