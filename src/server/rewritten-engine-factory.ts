// src/server/rewritten-engine-factory.ts
//
// The REAL production engineFactory (Plan 7.6 cutover finale: the ONLY engine — the legacy
// runPipeline path was deleted). Maps an AppConfig to a qa-engine CompositionConfig and returns
// `buildProduction(process.env, cfg)`, wiring the SAME production collaborators the host process
// already builds (the real agent runtime at :4097, the real GitHub PR/Issue client, the real deploy
// gate, the real Playwright/code runners) — not a second, parallel set of integrations.
//
// RunnerDeps.engineFactory (src/server/runner.ts) is now REQUIRED — every real caller
// (src/index.ts, src/cli.ts) supplies this factory, and enqueueTrackedRun throws loudly if it is
// ever omitted (a boot-time wiring defect, not a silent fallback).
//
// This is the REAL production path (buildProduction → real GitHub publish, real durable run
// history), NOT buildShadow (used by tests/operator scripts, which always force the shadow-log
// route + in-memory history). An app's own `qa.shadow: true` config still routes
// PublishDecisionService to the ShadowLogAdapter here too — see composition-root.ts's
// wireBridges() "Production publication" comment — so onboarding a new app in shadow mode behaves
// identically.
//
// Faithful port of qa-engine/test/characterization/shadow-run.operator.ts's buildCompositionConfig
// (the FIRST and, until this file, ONLY place the AppConfig→CompositionConfig mapping was written —
// confirmed by searching the qa-engine tree before writing this module). The only structural
// differences from that operator template:
//   1. The agent runtime is INJECTED (getAgentDeps: () => AgentDeps), not rebuilt — this factory
//      reuses the host's existing AgentRuntimeManager (src/index.ts's `agentRuntime`, resolved via
//      currentAgentDeps()) instead of constructing a second one. Two independent AgentRuntimeManager
//      instances would each try to own the same :4097 supervisor's session bookkeeping.
//   2. The diff is sourced DYNAMICALLY per run (engram #939's dynamic-diff fix): this factory's
//      CompositionConfig always sets `diff: ""` at composition-build time (the mirrorDir/checkout
//      SHA are not known yet either — see the checkout note below) — GenerationPortAdapter and
//      ReviewPortAdapter both resolve the REAL per-run diff from ChangeAnalysisPort.classify()'s
//      widened return value instead. No static pre-compute is needed or possible here (unlike the
//      operator script, which already has legacyMirror + legacyDiff in hand before composing).
//   3. checkout resolves mirrorDir per-run via WorkspacePort.prepare(sha) → ensureMirror(...) — this
//      factory's own `mirrorDir` field is a PLACEHOLDER (the app's own working directory under
//      MIRROR_DIR) satisfying CompositionConfig's static shape; the REAL per-run mirrorDir the
//      adapters actually operate on comes back from the `checkout` fn's return value, exactly as
//      composition-root.ts's WorkspacePortAdapter contract requires.
//   4. branch/namespace is caller-supplied PER RUN: buildRewrittenCompositionConfig(app, deps,
//      namespace) sets `branch: namespace` from an explicit argument, unlike the operator template
//      (which builds one CompositionConfig for a single one-shot comparison run and can afford a
//      constant). The runner (src/server/runner.ts) computes this namespace once per run via
//      testDataNamespace(app.qa.testDataPrefix, sha, runId) — the SAME formula legacy runPipeline
//      uses at src/pipeline.ts:1222 — and passes it through RunnerDeps.engineFactory. A static
//      branch here would collide every run of every app on the same live-DEV test-data namespace
//      the moment PIPELINE_ENGINE=rewritten is set (fixed after judgment-day caught it).
//   5. mode/guidance are caller-supplied PER RUN (audit-remediation fix, judgment-day): the operator
//      template hardcodes a single mode for its one-shot comparison run; this factory's runner caller
//      knows the REAL req.mode/req.guidance for every run (diff/complete/exhaustive/manual/context),
//      so buildRewrittenCompositionConfig(app, deps, namespace, run) takes them as an explicit `run`
//      argument instead of a static "diff" literal — a hardcode here silently mis-prompted every
//      non-diff run's Generation/Review phase (composition-root.ts:187,199 feed cfg.mode/cfg.guidance
//      straight into prompt assembly).
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { readdirSync, readFileSync, mkdirSync, writeFileSync, realpathSync, lstatSync } from "node:fs";
import { spawn } from "node:child_process";
import type { AppConfig } from "../orchestrator/config-loader";
import type { AgentDeps } from "../integrations/opencode-client";
// WS6.1 (full-flow remediation, timeouts & operational observability): the purpose-built reviewer
// budget (6min, env-tunable via OPENCODE_REVIEWER_TIMEOUT_MS) — threaded into CompositionConfig.
// reviewTimeoutMs so ReviewPortAdapter.review() no longer silently inherits the dispatcher's
// ~25.5min worst-case ceiling.
import { REVIEWER_TIMEOUT_MS } from "../integrations/opencode-client";
// WS6.2 (full-flow remediation, timeouts & operational observability): see
// createRewrittenEngineFactory's own header comment for why these three wrappers are composed here.
import { withUsageSink, withStallWatchdog, withSessionRegistration } from "../integrations/opencode-client";
import type { RunPipelinePort, ObserverPort } from "@contexts/qa-run-orchestration/application/ports/index.ts";
import { buildProduction, type CompositionConfig } from "@contexts/qa-run-orchestration/composition/composition-root";
import { Sha } from "@kernel/sha";
import type { AgentRole } from "@kernel/agent-role";
import type { RunMode } from "@kernel/run-mode";

import { GitMirrorReadAdapter } from "@contexts/change-analysis/infrastructure/git-mirror-read.adapter";
import { GenerateTestsUseCase } from "@contexts/generation/application/generate-tests.use-case";
import { AgentRuntimeAdapter } from "@contexts/generation/infrastructure/agent-runtime.adapter";
import { PromptRenderingAdapter } from "@contexts/generation/infrastructure/prompt-rendering.adapter";
import { VerdictParserAdapter } from "@contexts/generation/infrastructure/verdict-parser.adapter";
import { ManifestRepositoryAdapter } from "@contexts/generation/infrastructure/manifest-repository.adapter";
import { readManifest, reconcileManifest } from "@contexts/generation/infrastructure/manifest-fs";
import { PromptBudgetAdapter } from "@contexts/generation/infrastructure/prompt-budget.adapter";
import { capDiff, capText } from "@contexts/generation/infrastructure/prompt-cap";
import { StaticGateAdapter } from "@contexts/test-execution/infrastructure/static-gate.adapter";
import { E2eExecutionStrategy } from "@contexts/test-execution/infrastructure/e2e-execution.strategy";
import { CodeExecutionStrategy } from "@contexts/test-execution/infrastructure/code-execution.strategy";
import { CodeValidationStrategy } from "@contexts/test-execution/infrastructure/code-validation.strategy";
import { StrykerMutationOracleAdapter } from "@contexts/objective-signal/infrastructure/stryker-mutation-oracle.adapter";
import { FaultInjectionOracleAdapter } from "@contexts/objective-signal/infrastructure/fault-injection-oracle.adapter";
import { GitHubPrAdapter } from "@contexts/workspace-and-publication/infrastructure/github-pr.adapter";
import { GitHubIssueAdapter } from "@contexts/workspace-and-publication/infrastructure/github-issue.adapter";
import { VcsWriteAdapter } from "@contexts/workspace-and-publication/infrastructure/vcs-write.adapter";
import { CONFINEMENT_DENYLIST } from "@contexts/workspace-and-publication/domain/write-confinement.service";
import { WriteConfinementAdapter } from "@contexts/workspace-and-publication/infrastructure/write-confinement.adapter";
import { MirrorGcAdapter } from "@contexts/workspace-and-publication/infrastructure/mirror-gc.adapter";
import type { VcsPublishCollaborator } from "@contexts/qa-run-orchestration/infrastructure/bridges/publication-port.adapter";
import { makeTargetCoverageCollector } from "@contexts/objective-signal/infrastructure/target-coverage-collector";
import { assembleChangeCoverage } from "@contexts/objective-signal/domain/assemble-change-coverage";

// SandboxedBinaryRunner + ProcessKillAdapter: real, src/-free process-sandbox primitives
// (Sub-Plan 7.2 item 1) — no root src/ import needed for these, unlike the collaborators below.
import { SandboxedBinaryRunnerAdapter } from "../../qa-engine/src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.adapter";
import { ProcessKillAdapter } from "../../qa-engine/src/shared-infrastructure/process-sandbox/process-kill.adapter";
// CodebaseMemoryClient (CodeGraph Phase 2a/4b): the raw codebase-memory-mcp CLI spawn client —
// supplied as CompositionConfig.codebaseMemory so wireBridges() builds the ACTIVE structural
// blast-radius chain (StructuralSignalPortAdapter over LazyProjectCodeGraphAdapter). Fail-open by
// construction at every layer: an unindexed mirror resolves to no project -> every query ok([]) ->
// "" -> no prompt section — so supplying this unconditionally is always safe.
import { CodebaseMemoryClient } from "../../qa-engine/src/shared-infrastructure/code-graph/codebase-memory-client";

// ── Root src/ collaborators (the REAL production pieces) ─────────────────────────────────────────
// This module intentionally imports both qa-engine's @contexts/@kernel aliases AND root src/
// integrations — it is the E.3 seam whose entire job is bridging the two, exactly like the F.2
// operator template it ports (see that file's own TS6307 note on why a composition-mapping module
// unavoidably imports both sides). Unlike shadow-run.operator.ts, this file lives in src/ itself
// (not qa-engine/test/), so it is NOT subject to qa-engine/tsconfig.json's exclude list or the
// tsconfig.parity.json split — it is covered by the root tsconfig.json project (which already
// references qa-engine via TS project references) like any other src/ module.
import {
  buildPromptAssembled,
  buildWorkerPromptAssembled,
  buildReviewerPromptAssembled,
  buildExplorerPrompt,
  specFileForFlow,
} from "../integrations/prompts";
import { parseVerdict } from "../integrations/verdict-parse";
import { parseReviewerVerdict, checkGeneratorVerdict, repairInstruction } from "../integrations/verdict-validate";
import { roleWindowBytes } from "../integrations/model-window-catalog";
import type { RepairPort } from "@contexts/generation/application/generate-tests.use-case.ts";
import { validateSpecs, defaultValidateDeps } from "../qa/validate";
import { validateCodeProject, defaultCodeValidateDeps } from "../qa/code-validate";
import { runE2E, defaultExecuteDeps, defaultCleanupDeps } from "../qa/execute";
import { runCodeTests, defaultCodeExecuteDeps, runCodeCoverage, detectCodeProject, scrubEnv } from "../qa/code-runner";
import { setupE2eProject, defaultSetupDeps } from "../qa/setup";
import { setupCodeProject, defaultCodeSetupDeps } from "../qa/code-runner";
import { github } from "../integrations/github";
import { RedactionPortAdapter } from "../orchestrator/sanitizer";
import { shaMatches } from "../env/deploy-gate";
import { ensureMirror, ensureMirrorAtBranch, defaultMirrorDeps, workdirRoot, realGit, authHeaderArgs } from "../integrations/repo-mirror";
import { stageServiceContext, serviceContextDir } from "./service-context";
import { SqliteRunHistoryAdapter } from "./run-history-sqlite-adapter";
import { SqliteLearningRepository, type LearningStore } from "@contexts/cross-run-learning/infrastructure/sqlite-learning-repository.adapter";
import { listLearningRules, listAllLearningRules, upsertLearningRule, incrementRuleUsage, recordRuleOutcome, updateRunOutcomeReflection, listRunOutcomes, setRuleStatusByHuman, markContextStale } from "./history";
import { recordIncident } from "./maintainer";
import { preventionOutcome } from "@contexts/cross-run-learning/domain/rule-fold";
import { ReflectorPortAdapter, REFLECT_TIMEOUT_MS } from "@contexts/cross-run-learning/infrastructure/reflector-port.adapter";
import { ProcessAuditPortAdapter } from "@contexts/cross-run-learning/infrastructure/process-audit-port.adapter";
import { YamlBoundaryProfileAdapter } from "@contexts/service-topology/infrastructure/yaml-boundary-profile.adapter";
import { expandEnv } from "../orchestrator/config-loader";

// Same role→agent-name mapping the F.2 operator template uses (roleToAgentName) — the
// AgentRuntimeAdapter needs it to resolve which of the agents container's role configs
// (qa-generator/qa-reviewer/qa-worker/…) an AgentRole maps to.
// CHIP: explorer misroutes to qa-generator — diverges from ROLE_TO_OPENCODE_AGENT/rolePromptName; tracked separately, out of scope
export function roleToAgentName(role: AgentRole): string {
  const map: Record<AgentRole, string> = {
    primary: "qa-generator",
    reviewer: "qa-reviewer",
    chat: "qa-assistant",
    worker: "qa-worker",
    workerCode: "qa-worker-code",
    maintainer: "qa-maintainer",
    reflector: "qa-reflector",
    explorer: "qa-generator",
    proposer: "qa-proposer",
  };
  return map[role];
}

// PROD-BLOCKER fix: the git-write side of publish() — stage/commit/push the agent's generated tests
// BEFORE PublicationPortAdapter's "pr" route opens the PR (see that file's own header for the full
// bug description: GitHubPrAdapter.openWithAutoMerge() was previously called against a branch that
// was NEVER created/committed/pushed, because VcsWriteAdapter — the only VcsWritePort implementation
// — was never instantiated anywhere in composition-root.ts).
//
// Ports (not imports) the exact legacy sequence from src/integrations/publish.ts's publishChanges:
// writeExcludes -> status-check/skip-if-no-changes -> checkout -B -> add -> commit -> push. Deliberately
// does NOT call createPullRequest/enableAutoMerge/mergePullRequest itself — publication-port.adapter.ts's
// "pr" case already owns PR creation via the SEPARATE githubPr collaborator (GitHubPrAdapter, wired
// below); duplicating PR creation here would open two PRs. This keeps GitHubPrAdapter as the SINGLE
// place owning PR-creation/merge-fallback, and this collaborator as the SINGLE place owning git
// mechanics — no behavior is duplicated between the two.
//
// Target dispatch (e2e vs code), mirroring publish.ts's own E2E_ADD/CODE_ADD/E2E_EXCLUDES/CODE_EXCLUDES
// exactly: e2e publishes only the `e2e/` dir (publishE2e-shaped); code publishes the whole tree minus
// installed deps/build output/run artifacts (publishCode-shaped) — the SAME split Execution/Setup/
// Validation adapters already make on `cfg.isCode` elsewhere in this factory.
//
// sdd/migration-remediation D1 (docs/superpowers/2026-07-10-migration-remediation-decisions.md):
// - `e2e/.qa/service-context/` is excluded on BOTH targets — src/server/service-context.ts writes
//   cross-repo service snapshots there, and CODE_PUBLISH_ADD=["."] stages the whole tree, so a
//   code-target run would leak another repo's staged context into the PR just as readily as an
//   e2e-target run would.
// - The e2e entries for coverage/measured.json are anchored with an `e2e/` prefix. A gitignore-style
//   pattern with a slash NOT at the very end (a "mid-pattern slash") is anchored to the directory of
//   the exclude file itself — for `.git/info/exclude` that is the repo root, never `e2e/`. The
//   PRE-FIX entries `.qa/coverage/` / `.qa/measured.json` therefore excluded NOTHING (they looked for
//   `<root>/.qa/coverage/`, never the real `<root>/e2e/.qa/coverage/`) — verified with a real
//   git-status fixture test (rewritten-engine-factory.publish-excludes.test.ts), not an
//   array-membership assertion (membership would have passed on the broken anchoring).
// - `node_modules/` stays UNPREFIXED deliberately: a pattern with no slash at all (only a trailing
//   one) is NOT anchored and matches at any depth — prefixing it would narrow it to only the
//   top-level `e2e/node_modules/` and stop matching nested occurrences.
const E2E_PUBLISH_ADD = ["e2e"];
const E2E_PUBLISH_EXCLUDES = ["node_modules/", "e2e/.qa/coverage/", "e2e/.qa/measured.json", "e2e/.qa/service-context/"];
const CODE_PUBLISH_ADD = ["."];
// sdd/migration-remediation Slice 7.2 (verify-first spike -> confirmed fix): context mode stages
// ONLY the FE<->BE architecture map, never seed fixtures or specs. Legacy oracle: src/integrations/
// publish.ts's own CONTEXT_ADD = ["e2e/.qa/context.json"]. CONFIRMED DEFECT this closes:
// buildVcsPublish(isCode) previously dispatched ONLY on isCode — context-mode runs are never
// isCode (they are e2e-shaped), so a context-mode run reaching "pr" fell through to
// E2E_PUBLISH_ADD (["e2e"]), staging the WHOLE e2e/ tree instead of just the context artifact.
const CONTEXT_PUBLISH_ADD = ["e2e/.qa/context.json"];
// sdd/migration-remediation D2: CONFINEMENT_DENYLIST (write-confinement.service.ts) is spread in
// here so the code-target commit-time allowlist actually denies the same paths write-confinement
// denies mid-run (.env*, .github/, Dockerfile, docker-compose*, .gitattributes, .gitmodules) — this
// makes confinement's fault-isolated fail-open posture genuine defense-in-depth over a real
// deterministic guard for the code target, not the only guard (CODE_PUBLISH_ADD=["."] stages the
// whole tree, unlike the e2e target's hard `e2e/` allowlist).
const CODE_PUBLISH_EXCLUDES = [
  "node_modules/",
  ...CONFINEMENT_DENYLIST,
  "dist/",
  "build/",
  "__pycache__/",
  "*.pyc",
  ".venv/",
  "venv/",
  "target/",
  ".next/",
  "coverage/",
  "e2e/.qa/coverage/",
  "e2e/.qa/service-context/",
  ".stryker-tmp/",
  "stryker.conf.json",
  "reports/mutation/",
];

// Writes gitignore-style patterns to .git/info/exclude (LOCAL, never committed) — same real fs write
// as publish.ts's own defaultPublishDeps.writeExcludes.
function writeExcludes(mirrorDir: string, patterns: readonly string[]): void {
  const dir = join(mirrorDir, ".git", "info");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "exclude"), patterns.map((p) => `${p}\n`).join(""));
}

type GitFn = (args: string[], cwd?: string) => Promise<string>;

// Adversarial-review CRITICALs (auth-on-push + commit identity): realGit is a BARE execFile wrapper
// — it applies hardenGitArgs (hooks/safe.directory) + GIT_TERMINAL_PROMPT=0 but NEVER prepends
// authHeaderArgs(); auth in this codebase is applied per CALL SITE (repo-mirror's own syncMirror/
// resolveRef, legacy publish.ts:124 `[...authHeaderArgs(), "push", ...]`). Likewise a fresh mirror
// has NO git identity configured anywhere (Dockerfile/compose/repo-mirror set none), which is why
// legacy committed with `-c user.name=<GIT_AUTHOR_NAME ?? "panchito"> -c user.email=
// <GIT_AUTHOR_EMAIL ?? "panchito@users.noreply.github.com">` (publish.ts:107-108,120-123). Without
// these, every real pr-route push fails non-interactively and every fresh-mirror commit hard-fails
// "Author identity unknown".
//
// SEAM CHOICE: the decoration lives HERE (factory land), wrapping the injected git fn, so the
// qa-engine VcsWriteAdapter stays 100% token-agnostic — honoring its own header contract ("the
// real-wiring obligation is on the injector, not this class") and keeping all token/identity
// knowledge in src/server. Dispatch keys on args[0], which for this adapter is ALWAYS the bare git
// subcommand (VcsWriteAdapter never emits leading -c flags itself — its unit tests pin every argv
// shape; hardenGitArgs' own -c flags are prepended later, inside realGit, after this decorator).
// Both env vars are read at CALL time, exactly like legacy (authHeaderArgs() reads GITHUB_TOKEN per
// call; publishChanges read GIT_AUTHOR_* per call).
function withPublishGitDecorations(git: GitFn): GitFn {
  return (args, cwd) => {
    if (args[0] === "push") return git([...authHeaderArgs(), ...args], cwd);
    if (args[0] === "commit") {
      const name = process.env.GIT_AUTHOR_NAME ?? "panchito";
      const email = process.env.GIT_AUTHOR_EMAIL ?? "panchito@users.noreply.github.com";
      return git(["-c", `user.name=${name}`, "-c", `user.email=${email}`, ...args], cwd);
    }
    return git(args, cwd);
  };
}

// Exported for structural/unit testing (rewritten-engine-factory.test.ts) — constructs the
// VcsPublishCollaborator dispatched by isCode. `git`/`writeExcludesFn` are injectable (default to the
// REAL realGit / fs-backed writeExcludes, the same DI pattern VcsWriteAdapter itself already uses) so
// the exact call sequence can be pinned with a fake git fn, mirroring publish.test.ts's own
// established convention for this exact class of git-mechanics test — no real subprocess/filesystem
// needed to prove the sequence/dispatch is correct. The injected git fn is ALWAYS wrapped in
// withPublishGitDecorations (above) — the fake therefore observes the SAME decorated argv the real
// realGit receives in production, which is exactly what lets the tests pin the auth/identity
// prefixes instead of only recording bare argv (the gap that let both CRITICALs slip first time).
export function buildVcsPublish(
  isCode: boolean,
  // sdd/migration-remediation Slice 7.2: REQUIRED (no default) — every call site must state its
  // mode explicitly rather than silently falling back, so a future new mode can never reach this
  // dispatch un-considered. `mode === "context"` OVERRIDES the isCode-based addDir/excludes split
  // entirely (context runs are never isCode, so without this override they fell through to the
  // e2e branch — see CONTEXT_PUBLISH_ADD's own doc for the confirmed defect this closes).
  mode: RunMode,
  git: GitFn = realGit,
  writeExcludesFn: (dir: string, patterns: readonly string[]) => void = writeExcludes,
): VcsPublishCollaborator {
  const vcs = new VcsWriteAdapter(withPublishGitDecorations(git), writeExcludesFn);
  const isContext = mode === "context";
  const addDir = isContext ? CONTEXT_PUBLISH_ADD : isCode ? CODE_PUBLISH_ADD : E2E_PUBLISH_ADD;
  // Legacy parity (src/integrations/publish.ts's publishContext: `excludes: []`): the context
  // artifact is staged by its OWN exact pathspec, never a directory scan, so exclude patterns have
  // nothing to filter — an empty list here matches legacy exactly rather than reusing the e2e/code
  // exclude split, which exists to filter directory-wide `git add`/`git status` scans.
  const excludes = isContext ? [] : isCode ? CODE_PUBLISH_EXCLUDES : E2E_PUBLISH_EXCLUDES;
  return {
    async publish({ mirrorDir, branch }): Promise<{ changed: boolean }> {
      // Apply local ignore patterns FIRST (same ordering as publish.ts's publishChanges) so both the
      // change check and the `git add` below silently skip installed deps/artifacts instead of
      // failing on an ignored path (the node_modules/.gitignore `git add` failure this ordering fixes).
      await vcs.writeExcludes(mirrorDir, excludes);
      const changed = await vcs.hasChanges(mirrorDir, addDir);
      if (!changed) return { changed: false };
      await vcs.checkoutBranch(mirrorDir, branch);
      const commitMsg = isContext ? "docs(context): automated QA context map" : isCode ? "test(code): automated QA" : "test(e2e): automated QA";
      await vcs.commit(mirrorDir, commitMsg, addDir);
      await vcs.push(mirrorDir, branch);
      return { changed: true };
    },
  };
}

// sdd/migration-remediation Slice 3 (P0 write-confinement wiring, D-P0b): constructs the REAL
// ConfinementPort collaborator — realGit (LOCAL ops only: git status/restore/clean; deliberately NOT
// wrapped in withPublishGitDecorations, since confinement never pushes or commits, so no auth/
// identity decoration is needed) + node:fs realpathSync + an isSymlink probe built on lstatSync
// (a failed lstat means the path was deleted mid-check, not a symlink — never thrown past this probe,
// matching WriteConfinementAdapter's own "lstat pre-filter" contract). Exported for direct unit
// testing (same precedent as buildVcsPublish above) — a test can inject a fake git/realpath/isSymlink
// to pin the exact real-git-fixture behavior without touching this host's actual filesystem.
export function buildConfinement(
  git: GitFn = realGit,
  realpath: (p: string) => string = realpathSync,
  isSymlink: (p: string) => boolean = (p) => {
    try {
      return lstatSync(p).isSymbolicLink();
    } catch {
      return false; // deleted mid-check or otherwise unreadable — never a symlink escape
    }
  },
): WriteConfinementAdapter {
  return new WriteConfinementAdapter({ git, realpath, isSymlink });
}

// sdd/migration-wiring-phase-2 Slice 2 (D-B mirror-gc): constructs the REAL MirrorGcPort
// collaborator — realGit's own LOCAL `git gc --auto --quiet` (no auth decoration, mirrors
// buildConfinement's own "confinement/gc never push or commit" rationale immediately above).
// realGit resolves to Promise<string> (stdout); MirrorGcAdapter's injected gc fn contract is
// Promise<void> — the trailing `.then(() => {})` discards the stdout, never widening the port's
// own signature. Exported for direct unit testing (same precedent as buildConfinement above).
export function buildMirrorGc(git: GitFn = realGit): MirrorGcAdapter {
  return new MirrorGcAdapter((dir) => git(["gc", "--auto", "--quiet"], dir).then(() => {}));
}

// One-shot /version fetch + sha/health match — VersionPollFn's contract is a SINGLE probe per
// call (DeployGatePortAdapter.waitUntilServing owns the outer poll-until-deadline loop itself,
// calling this repeatedly at cfg.intervalMs). This intentionally does NOT delegate to
// src/env/deploy-gate.ts's waitForDeploy, which runs its OWN internal poll-until-deadline loop —
// composing two nested poll loops would multiply the effective timeout instead of bounding it once
// at the adapter's own cfg.timeoutMs. shaMatches is reused verbatim from that same module (the
// short-sha / full-sha / 7-char-prefix equivalence legacy already relies on).
async function fetchVersion(url: string): Promise<{ sha?: string; healthy?: boolean } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return null;
    return (await res.json()) as { sha?: string; healthy?: boolean };
  } catch {
    return null;
  }
}

// Bridges cross-run-learning's LearningStore port onto src/server/history.ts's existing
// learning_rules exports (listLearningRules/upsertLearningRule/incrementRuleUsage — the SAME SQLite
// table the legacy engine's own retrieval/distillation already reads/writes). selectRules re-shapes
// history.ts's already-camelCased LearningRule[] back into the port's raw-row LearningRow[] shape
// (trigger_text/action_text) because history.ts exposes no raw-row query publicly and
// SqliteLearningRepository's own rowToRule immediately re-maps it right back — a lossless
// round-trip, not a second source of truth. upsert() narrows the port's full LearningRule down to
// legacy's RuleUpsert (trigger/action/errorClass/archetype/source) — upsertLearningRule's own
// contract always resets confidence/usageCount/status to their insert-time defaults on ANY upsert
// (see that function's own header comment in history.ts), so a caller-supplied confidence/status
// would be silently discarded by the legacy fn regardless; narrowing here just makes that existing
// contract explicit at the bridge, rather than passing fields the sink ignores.
//
// W3 fix (F3b, dual-judge round): `appName` is now an explicit parameter, threaded from the
// factory's own AppConfig.name (buildRewrittenCompositionConfig's `app` argument, already in scope
// at every call site below) — upsert() previously wrote `app: rule.archetype ?? ""`, a genuine
// cross-app data-corruption landmine (archetype is a diff-shape tag like "form"/"api-call", not an
// app identifier, and a bare upsert() caller would have silently mixed every app's rules under one
// wrong/empty `app` column, corrupting listLearningRules(app, ...)'s per-app filtering the moment
// upsert() gets a real caller). save() still has zero call sites on the orchestrated retrieval path
// (this module's scope is RETRIEVAL — see W3 F2's own header), so this fix has no behavioral effect
// until the distiller (Plan 6) starts calling save(); it closes the landmine before that day arrives.
// Exported for direct unit testing (same precedent as buildRewrittenCompositionConfig above).
export function historyLearningStore(appName: string): LearningStore {
  return {
    selectRules: (app) =>
      listLearningRules(app, 200).map((r) => ({
        id: r.id,
        trigger_text: r.trigger,
        action_text: r.action,
        error_class: r.errorClass,
        archetype: r.archetype ?? null,
        status: r.status,
        confidence: r.confidence,
        usage_count: r.usageCount,
        outcome_count: r.outcomeCount,
        oracle_outcome_count: r.oracleOutcomeCount,
        success_rate: r.successRate,
        last_verified: r.lastVerified,
        source: r.source,
        at: r.at,
      })),
    // Task 2 (full-flow remediation, WS1.3 closure): wires the store's OPTIONAL selectAllRules onto
    // history.ts's UNFILTERED listAllLearningRules(app, limit) — the SAME row-shape mapping
    // selectRules above already does, just backed by the unfiltered (all-statuses, incl.
    // deprecated/superseded) query instead of the active/candidate-only one. Before this fix,
    // SqliteLearningRepository.listAll(app, limit) always fell back to [] in production (this
    // store never implemented the method), so ReflectorPortAdapter's anti-respawn dedup
    // (decideDistill scanning the FULL existing-rule set) was a documented pass-through: it always
    // received an empty existing set and could never actually detect a duplicate. Wiring this
    // makes that dedup live.
    selectAllRules: (app, limit) =>
      listAllLearningRules(app, limit).map((r) => ({
        id: r.id,
        trigger_text: r.trigger,
        action_text: r.action,
        error_class: r.errorClass,
        archetype: r.archetype ?? null,
        status: r.status,
        confidence: r.confidence,
        usage_count: r.usageCount,
        outcome_count: r.outcomeCount,
        oracle_outcome_count: r.oracleOutcomeCount,
        success_rate: r.successRate,
        last_verified: r.lastVerified,
        source: r.source,
        at: r.at,
      })),
    upsert: (rule) =>
      upsertLearningRule({
        id: rule.id,
        app: appName, // W3 fix (F3b): the REAL app name, not the archetype placeholder — see this
        // function's own header for the corruption this closes.
        trigger: rule.trigger,
        action: rule.action,
        // The port's LearningRule.errorClass is WIDE (`string` — cross-run-learning/application/
        // ports/index.ts's own doc: "the real owner; the kernel RunOutcome.errorClass widens to
        // this"), matching the kernel's own widening pattern (run-outcome.ts's ErrorClass alias).
        // upsertLearningRule expects legacy's narrow ErrorClass union — safe to cast here because
        // the ONLY genuine producer of a port LearningRule.errorClass value is the SAME re-ported
        // labeler taxonomy (domain/helpers/error-class.ts, a verbatim port of
        // src/qa/learning/taxonomy.ts) every RunOutcome.errorClass already derives from.
        errorClass: rule.errorClass as import("../qa/learning/taxonomy").ErrorClass,
        archetype: rule.archetype ?? null,
        source: rule.source,
      }),
    recordOutcome: (outcome) => {
      // P4a (post-cutover-remediation, unit 6): off-path fold (LearningPort.fold ->
      // LearningRepositoryPort.applyOutcome -> here). Folds a RunOutcome into EACH retrieved rule's
      // running statistics via the SAME legacy recordRuleOutcome(ruleId, score, ...) this store's
      // upsert()/incrementUsage() already bridge onto. Never gates publish either way
      // (LearningPort.fold's own off-path contract) — wrapped in try/catch below so a fold failure
      // can never surface as a run failure.
      //
      // P3's suppression guard (shouldDistillLearning, app_defect) lives in the USE-CASE, before
      // learning.fold() is even called — this function trusts the caller already gated it and does
      // NOT re-check outcome.adjudication itself (single guard-owner, per design).
      try {
        const { rulesRetrieved, gateSignals, errorClass } = outcome;
        if (rulesRetrieved.length === 0) return; // nothing retrieved -> nothing to fold
        const { valueScore, coverageRatio } = gateSignals;
        const coverageMeasured = coverageRatio !== null;
        const coverageCreditConfirmed = coverageMeasured ? coverageRatio > 0 : null;

        if (valueScore !== null) {
          // Oracle path: a real value-oracle score is available — fold it onto every retrieved id
          // independently (each rule's running mean advances on its own). WS1.4(b): isOracleScore=true
          // here is what satisfies nextStatus's objective-evidence gate for candidate -> active.
          for (const id of rulesRetrieved) {
            recordRuleOutcome(id, valueScore, coverageCreditConfirmed, true);
          }
        } else {
          // Prevention path: no oracle score for this run — derive a weaker, conservative signal
          // from the run's OWN errorClass via preventionOutcome(rule.errorClass, outcome.errorClass).
          // listLearningRules(appName, 200) is the SAME lookup already used above (line ~192) to
          // build the retrieval id->rule map, reused here for the per-rule errorClass lookup.
          // WS1.4(b): isOracleScore is omitted (defaults to false) — prevention credit is DERIVED
          // (absence of a failure class), never an objective observation, so it must never advance
          // oracleOutcomeCount or by itself satisfy the candidate -> active promotion gate.
          const rules = listLearningRules(appName, 200);
          const byId = new Map(rules.map((r) => [r.id, r]));
          for (const id of rulesRetrieved) {
            const rule = byId.get(id);
            if (!rule) continue; // RESIDUAL EDGE: a rule deprecated between retrieval and fold is
            // excluded from listLearningRules' active/candidate filter — inert, acceptable (a
            // deprecated rule earning no signal is inert anyway).
            const score = preventionOutcome(rule.errorClass, errorClass);
            if (score !== null) recordRuleOutcome(id, score, coverageCreditConfirmed);
          }
        }
      } catch {
        // Off-path swallow, matching LearningPort.fold's existing off-path contract: a fold failure
        // must never gate or fail the run it is trying to learn from.
      }
    },
    // W3 fix (F3a, dual-judge round): bridges LearningRepositoryPort.incrementUsage (called by
    // LearningPortAdapter.retrieve() on every real retrieval) onto legacy's OWN incrementRuleUsage
    // (src/server/history.ts) — the SAME learning_rules.usage_count column the legacy engine's own
    // retrieveRules() increments. Prior to this fix, no caller anywhere in the store contract
    // incremented usage_count, so it stayed 0 for every rule retrieved through the rewritten engine
    // regardless of real injection count.
    incrementUsage: (ids) => incrementRuleUsage([...ids]),
  };
}

// The host's already-built real collaborators this factory reuses instead of re-assembling.
export interface RewrittenEngineFactoryDeps {
  // Reads the SAME AgentDeps facade the host's currentAgentDeps() resolves (src/index.ts) — the
  // real :4097 supervisor, not a second AgentRuntimeManager instance.
  getAgentDeps: () => AgentDeps;
  // Optional RunHistoryPort override — when absent (the production default), this factory wires the
  // REAL durable SqliteRunHistoryAdapter (src/server/run-history-sqlite-adapter.ts), which bridges
  // into the SAME src/server/history.ts SQLite run_outcomes table the TUI trends view, /ask learning
  // context, and the audit process all read (W3 F1, CRITICAL cutover blocker — prior to this fix,
  // production never set this field, so composition-root.ts's wireBridges() silently fell back to a
  // process-lifetime InMemoryRunHistoryAdapter). historyFilePath remains as an ESCAPE HATCH (a
  // caller that explicitly wants the file-backed JSONL adapter instead of SQLite — e.g. a test, or
  // a future non-SQLite deployment) — set it to opt OUT of the SQLite default.
  historyFilePath?: string;
  env?: Record<string, string | undefined>;
  mirrorRoot?: string;
  // Testability seam (cross-repo composition fix): lets a test inject spies for the two mirror
  // primitives this factory's checkout/vcs wiring depends on, instead of touching real git/disk.
  // Mirrors the pre-existing deps.mirrorRoot precedent — an explicit test/override seam, defaulting
  // to the real ensureMirror/ensureMirrorAtBranch (src/integrations/repo-mirror.ts) in production.
  mirror?: {
    ensureMirror: typeof ensureMirror;
    ensureMirrorAtBranch: typeof ensureMirrorAtBranch;
  };
  // Testability seam (cross-repo generation-stall fix): lets a test inject a spy/no-op for the
  // service-context staging side effect the checkout closure performs for cross-repo runs
  // (triggerService) and context-mode services[], instead of touching real disk/git. Mirrors the
  // pre-existing deps.mirror precedent — defaults to the real stageServiceContext
  // (src/server/service-context.ts) in production.
  stageServiceContext?: typeof stageServiceContext;
}

// Assembles a REAL CompositionConfig for the given AppConfig, mirroring
// shadow-run.operator.ts's buildCompositionConfig (see this module's header for the 3 documented
// differences). Exported for direct unit testing of the mapping without going through the factory
// closure.
//
// `namespace` is the caller's (the runner's) PER-RUN test-data namespace — the exact same value
// legacy computes via testDataNamespace(app.qa.testDataPrefix, sha, runId) at src/pipeline.ts:1222.
// It becomes `branch` below, which composition-root.ts's wireBridges() threads into BOTH
// GenerationPortAdapter's and ExecutionPortAdapter's `namespace` field — i.e. it is the live-DEV
// test-data scoping AND the publish branch. A caller MUST pass a fresh namespace per run; passing
// the same value twice reproduces the exact DEV-data collision this fix closes.
//
// `run` (audit fix, judgment-day): mode/guidance are PER-RUN values, not app-static — the runner
// knows req.mode/req.guidance at call time (mirrors the namespace precedent above). Mode feeds
// GenerationPortAdapter's/ReviewPortAdapter's own prompt assembly (composition-root.ts:187,199), so
// a hardcoded "diff" here silently mis-prompted every non-diff run (complete/exhaustive/manual/
// context) as if it were a diff run.
//
// `run.triggerRepo` (bug fix — cross-repo composition threading): the SAME per-run value the
// runner already threads onto RunInput.triggerRepo for coverage-unknown/issue-routing/
// CrossRepoImpact — see runner.ts's own doc. This factory previously never received it at all, so
// vcs/checkout/the deploy gate stayed hardwired to the PRIMARY repo even on a genuine cross-repo
// (deploy-event) run, which crashed `git checkout -f <serviceSha>` inside the primary mirror. When
// `run.triggerRepo` names a declared `app.services[]` entry (and differs from app.repo), THIS
// function additionally routes vcs/checkout/gate to the service — see `triggerService` below.
export function buildRewrittenCompositionConfig(
  app: AppConfig,
  deps: RewrittenEngineFactoryDeps,
  namespace: string,
  run: { mode: RunMode; guidance?: string; triggerRepo?: string },
  // Bug fix: the PER-RUN ObserverPort (src/server/runner.ts's buildRewrittenObserver) — threaded
  // straight into CompositionConfig.observer so wireBridges() wires it into RunQaUseCaseDeps.
  // Optional: a caller that omits it (e.g. a unit test building a config directly) keeps every
  // onStep() call in RunQaUseCase a no-op, exactly the pre-fix behavior.
  observer?: ObserverPort,
): CompositionConfig {
  const isCode = app.code === true;
  const target: "e2e" | "code" = isCode ? "code" : "e2e";
  const e2eRelDir = "e2e";
  // sdd/migration-remediation Slice 6 (D-P2, RedactionPort unification): the ONE canonical
  // redaction collaborator for both egress boundaries this factory wires (logs → Issue via
  // `sanitize` below; diff → model is wired directly in src/integrations/prompts.ts and
  // opencode-client.ts, which import sanitizer.ts's sanitizeText themselves). Stateless — safe to
  // construct once per composition.
  const redactionPort = new RedactionPortAdapter();
  // P2b (post-cutover-remediation) Constraint 3: SINGLE source for the coverage policy. Previously
  // `coveragePolicyMode` (below) and `coveragePolicy` (further down, feeding DecideCoverageService)
  // independently re-read `app.qa.changeCoverage?.mode ?? "signal"` — two copies of the same value
  // that could silently desynchronize if either read site drifted. Compute it ONCE here;
  // `coveragePolicyMode` is DERIVED from `coveragePolicy.mode`, never re-read from app config.
  const coveragePolicy = { mode: app.qa.changeCoverage?.mode ?? "signal", minRatio: app.qa.changeCoverage?.minRatio ?? 0.7 } as const;
  // Single shared source for the mirror root (Warning fix, judgment-day): reuse repo-mirror.ts's own
  // workdirRoot() instead of re-deriving the formula here, so this factory's `vcs`/mirrorDir can
  // never silently diverge from where ensureMirror/checkout actually write. deps.mirrorRoot remains
  // an explicit test/override seam (unit tests construct configs without touching process.env).
  const mirrorRoot = deps.mirrorRoot ?? workdirRoot();
  // Placeholder static mirrorDir — the REAL per-run mirrorDir is whatever `checkout(sha)` returns
  // (WorkspacePortAdapter's own contract in composition-root.ts). This field only needs to exist to
  // satisfy CompositionConfig's static shape and to seed the coverage collector's repoDir/e2eDir
  // (which — like the diff — is a known limitation shared with the ObjectiveSignalPort's own
  // documented "assembleChangeCoverage optional" degrade path: an unmeasured/mismatched repoDir
  // reads as "unknown", which NEVER blocks publish, exactly the safe default the port already
  // guarantees for exactly this class of gap).
  const mirrorDir = join(mirrorRoot, app.repo.replaceAll("/", "__"));
  const e2eDir = join(mirrorDir, e2eRelDir);

  // Cross-repo composition (bug fix): resolve the declared service this run was triggered from, if
  // any. `run.triggerRepo === app.repo` is deliberately NOT cross-repo (the same-repo path) — this
  // mirrors runner.ts's own assertTriggerRepoDeclared, which also treats an equal triggerRepo as a
  // no-op guard. Defense in depth (matches legacy pipeline.ts:1012-1020's own two guards): runner.ts's
  // assertTriggerRepoDeclared already rejects an undeclared triggerRepo BEFORE this factory is ever
  // called, but this factory can also be exercised directly (as this file's own tests do), so it must
  // not silently trust an unvalidated triggerRepo either — nor skip the sibling context-mode guard
  // immediately below (both restored verbatim from legacy pipeline.ts).
  const triggerService =
    run.triggerRepo && run.triggerRepo !== app.repo
      ? app.services?.find((s) => s.repo === run.triggerRepo)
      : undefined;
  if (run.triggerRepo && run.triggerRepo !== app.repo && !triggerService) {
    throw new Error(`trigger repo ${run.triggerRepo} is not a declared service of app ${app.name}`);
  }
  // Sibling guard restored (matches legacy pipeline.ts:1017-1020 exactly): context mode is a whole-repo
  // maintenance task driven from the primary repo; running it against a service trigger would pass the
  // service diff to the architecture-map builder and contaminate the prompt with irrelevant signal.
  if (triggerService && run.mode === "context") {
    throw new Error(`context mode cannot be triggered by a service repo (${triggerService.repo}); run it from the primary repo ${app.repo}`);
  }
  // deps.mirror is a computation/test seam only: the REAL checkout below always calls
  // ensureMirror/ensureMirrorAtBranch with `defaultMirrorDeps` (whose own root resolves through the
  // same workdirRoot() fallback as this factory's `mirrorRoot` above), never with a caller-supplied
  // MirrorDeps — if a future caller sets deps.mirrorRoot in production expecting checkout's real root
  // to follow it, it will NOT; only the mirror ROOT PATH is overridable here, not the underlying
  // MirrorDeps used to run the actual git commands.
  const mirror = deps.mirror ?? { ensureMirror, ensureMirrorAtBranch };
  // Testability seam (see RewrittenEngineFactoryDeps.stageServiceContext's own doc) — defaults to
  // the real stageServiceContext in production.
  const stage = deps.stageServiceContext ?? stageServiceContext;

  // CRITICAL fix (judgment-day): branch/namespace must be PER-RUN, not a static literal. A static
  // "qa-bot/rewritten" collided every run of every app on the same live-DEV test-data namespace the
  // moment PIPELINE_ENGINE=rewritten is flipped (shadow:true only suppresses PR/Issue — it still
  // runs real Playwright + writes real DEV test data). `namespace` is byte-comparable to legacy's
  // testDataNamespace(...) output — see this function's header.
  const branch = namespace;

  const runner = new SandboxedBinaryRunnerAdapter({ processKill: new ProcessKillAdapter() });
  // Cross-repo composition (bug fix): the diff/classify SOURCE is the SERVICE mirror at the event
  // sha for a cross-repo run — never the primary. Same dir formula as mirrorDir above
  // (mirrorRoot + repo.replaceAll("/", "__")), reused verbatim so this can never silently diverge
  // from where ensureMirror actually writes (the SAME rationale mirrorDir's own comment gives).
  const vcsDir = triggerService ? join(mirrorRoot, triggerService.repo.replaceAll("/", "__")) : mirrorDir;
  const vcs = new GitMirrorReadAdapter(vcsDir, runner);

  // Advisory structural-signal calibration gate (Slice B, design §2/ADR-B2). mode "off" disables
  // BOTH advisory collaborators (codebaseMemory + serviceTopology) below — a HALF-GATE (disabling
  // only one) is the named hazard this design guards against. Default (absent/"signal") is today's
  // behavior byte-for-byte: both collaborators keep their own pre-existing supply conditions.
  const structuralSignalsMode = app.qa.structuralSignals?.mode ?? "signal";
  const structuralSignalsOn = structuralSignalsMode !== "off";

  // Reuses the host's already-built AgentDeps (see this module's header, difference #1) — never a
  // second AgentRuntimeManager. onUsage/onTurn are deliberately not forwarded, matching the operator
  // template exactly (AgentRuntimeAdapter's LegacyAgentDeps types them against the kernel
  // UsageSnapshot/AgentTurnEvent shapes, a genuinely different shape from src/qa/usage.ts's).
  //
  // WS6.2 (full-flow remediation, timeouts & operational observability): `descriptor` was
  // previously DROPPED here — AgentRuntimeAdapter.openSession (qa-engine's generation/infrastructure/
  // agent-runtime.adapter.ts) already forwards opts?.descriptor into this closure's `opts`, but this
  // closure never forwarded it onward to `real.open(...)`, so descriptor.runId never reached
  // withSessionRegistration (or defaultAgentDeps' own agent_turns persistence sink) on the rewritten
  // production path — a session opened by ReviewPortAdapter/GenerationPortAdapter with a real runId
  // silently lost that identity right here. Forwarding it mirrors the signal/timeoutMs/model
  // precedent immediately above (conditional spread — absent stays absent, never fabricated).
  const runtimeAdapter = new AgentRuntimeAdapter(
    {
      open: async (agent, cwd, opts) => {
        const real = deps.getAgentDeps();
        return real.open(agent, cwd, {
          ...(opts?.signal ? { signal: opts.signal } : {}),
          ...(opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
          ...(opts?.model ? { model: opts.model } : {}),
          ...(opts?.descriptor ? { descriptor: opts.descriptor } : {}),
        });
      },
    },
    roleToAgentName,
  );
  const rendering = new PromptRenderingAdapter({ buildPromptAssembled, buildWorkerPromptAssembled, buildReviewerPromptAssembled, buildExplorerPrompt, specFileForFlow });
  const verdicts = new VerdictParserAdapter({ parseVerdict, parseReviewerVerdict });

  // Follow-up #27 (WS9 review): the bounded contract-repair was DORMANT on this production path —
  // GenerationPorts.repair is optional and nothing here constructed a concrete RepairPort, so a
  // malformed generator/reviewer verdict got NO bounded re-prompt and the fail-closed gate fired
  // immediately. Wraps the SAME legacy checkGeneratorVerdict/repairInstruction (src/integrations/
  // verdict-validate.ts) the legacy opencode-client.ts bounded-repair loop already uses, so both
  // engines repair identically. `instruction`'s opts.priorResponseTail is forwarded verbatim —
  // repairInstruction already accepts it (WS9, tail frame-hardening) and the use-case now threads
  // the agent's own prior-turn output (generatorOutput/reviewText) into it at both call sites.
  const repair: RepairPort = {
    checkGenerator: (text) => checkGeneratorVerdict(text),
    instruction: (kind, issues, opts) => repairInstruction(kind, issues, opts),
  };

  const generationUseCase = new GenerateTestsUseCase({
    runtime: runtimeAdapter,
    rendering,
    verdicts,
    manifest: new ManifestRepositoryAdapter({ readManifest, reconcileManifest }),
    budget: new PromptBudgetAdapter(roleWindowBytes, capDiff, capText),
    repair,
  });

  const staticGate = new StaticGateAdapter({
    typecheck: defaultValidateDeps.typecheck,
    lint: defaultValidateDeps.lint,
    listTests: defaultValidateDeps.listTests,
    checkManifest: defaultValidateDeps.checkManifest,
    validateAll: (specDir) => validateSpecs(specDir, defaultValidateDeps),
  });
  // WS2.2 (full-flow remediation, code-mode restoration): Filter B for the CODE target — the
  // compile-feedback gate ported from src/qa/code-validate.ts, wired here for the first time
  // (previously the code target had NO pre-execution feedback at all; a compile error surfaced
  // only as an opaque whole-build failure at execution). Mirrors the e2e staticGate's own
  // construction immediately above.
  const codeValidate = new CodeValidationStrategy((repoDir, opts) => validateCodeProject(repoDir, defaultCodeValidateDeps, opts));

  const e2e = new E2eExecutionStrategy((specDir, opts) => runE2E(specDir, opts, defaultExecuteDeps));
  const code = new CodeExecutionStrategy((repoDir, opts) => runCodeTests(repoDir, opts, defaultCodeExecuteDeps));

  // changedFiles: static `[]` placeholder — the SAME documented limitation as `diff: ""` above (no
  // per-run diff exists yet at composition time). ObjectiveSignalPortAdapter.measure() derives the
  // REAL per-run changedFiles from the dynamic diff and threads them into collect()'s optional
  // trailing arg (the "dynamic diff" precedent), so this placeholder only matters for a caller that
  // never supplies a diff (i.e. never a real production diff-mode run).
  // repoDir/e2eDir intentionally stay PRIMARY-bound even under `triggerService`: browser coverage
  // cannot map service-repo lines back onto the primary suite, so cross-repo coverage is "unknown"
  // by design (never blocks publish — see CLAUDE.md's change-coverage `unknown` NEVER blocks note).
  const rawCollector = makeTargetCoverageCollector({ target, repoDir: mirrorDir, e2eDir, changedFiles: [] });
  // Code-mode coverage trigger (legacy parity: src/pipeline.ts:487 `if (input.target === "code")
  // await runCodeCoverage(input.repoDir).catch(() => {})`, BEFORE the lcov/Istanbul readers run —
  // src/qa/code-runner.ts:786's own doc: "best-effort... never throws... caller falls back to
  // unmeasured"). The rewritten collector composite (LcovCoverageAdapter/C8CoverageAdapter) reads
  // conventional report paths passively; nothing in the rewritten path ever RUNS the repo's own
  // instrumented test command to PRODUCE those reports — this wrapper closes that gap the same
  // best-effort way legacy does (catch -> ignore, degrading to the collector's own fail-open "no
  // report found" -> "unknown", never a crash).
  const collector: typeof rawCollector = isCode
    ? {
        collect: async (specDir, namespace, changedFiles) => {
          await runCodeCoverage(mirrorDir).catch(() => {});
          return rawCollector.collect(specDir, namespace, changedFiles);
        },
      }
    : rawCollector;
  // Fault-injection oracle collaborators (migration-tier-1-2, Slice 2): the orchestration body
  // moved into FaultInjectionOracleAdapter itself (qa-engine, src-free); the two effectful
  // collaborators it needs stay HERE, src-bound, and are injected — the adapter never imports
  // src/ directly. Ported verbatim from the deleted src/qa/learning/fault-injection-e2e.ts
  // defaultFaultInjectionDeps.
  const runCorruptedFaultInjection = ({ dir, baseUrl, namespace }: { dir: string; baseUrl: string; namespace: string }) =>
    // Desktop-only on purpose: the oracle measures assertion strength, not viewport behavior, and
    // the seed runs every spec in BOTH projects — one project halves the re-run cost. A repo whose
    // config renamed the seed's "desktop" project fails the pass → infra-error → valueScore null
    // (inconclusive), never a wrong score.
    runE2E(dir, { baseUrl, namespace, faultInject: true, project: "desktop" }, defaultExecuteDeps);
  const countInjectedFaultInjectionResponses = (e2eDir: string, namespace: string): number => {
    try {
      const dir = join(e2eDir, ".qa", "fault-injection", namespace);
      let total = 0;
      for (const f of readdirSync(dir)) {
        try {
          total += Number((JSON.parse(readFileSync(join(dir, f), "utf8")) as { corrupted?: unknown }).corrupted) || 0;
        } catch {
          /* unreadable dump — skip */
        }
      }
      return total;
    } catch {
      return 0; // no marker dir — nothing was corrupted
    }
  };

  // Mutation oracle collaborators (migration-tier-1-2, Slice 3): the node-stdlib/Stryker
  // orchestration moved into StrykerMutationOracleAdapter itself (qa-engine, src-free); the three
  // effectful collaborators it needs stay HERE, src-bound, and are injected as one bundle — the
  // adapter never imports src/ directly.
  const mutationOracleDeps = { spawn, detectCodeProject, scrubEnv };

  const oracle = isCode
    ? new StrykerMutationOracleAdapter(mutationOracleDeps)
    : new FaultInjectionOracleAdapter(runCorruptedFaultInjection, countInjectedFaultInjectionResponses, app.dev?.baseUrl ?? "");

  // WorkspacePort's checkout(sha) resolves the REAL per-run mirrorDir. Same-repo: the single
  // ensureMirror the legacy runPipeline's `prepare` step calls, so both engines checkout identically.
  // Cross-repo (bug fix): the legacy contract restored — the SERVICE mirror is brought to the event
  // sha FIRST (the diff/classify source ChangeAnalysis reads right after this resolves), THEN the
  // PRIMARY mirror is brought to baseBranch HEAD and its dir is what the suite (setup/validate/
  // execute/publish) actually operates on. Order matters: the service mirror must already be at the
  // event sha before ChangeAnalysis.classify() runs.
  // Cross-repo generation-stall fix: the agent session is rooted at the PRIMARY working copy, so
  // any prompt path OUTSIDE it (a sibling service mirror) trips opencode serve's external_directory
  // permission gate and hangs until the watchdog fires (see service-context.ts's own header for the
  // full root cause). After each service mirror is ensured, stage its bounded, READ-ONLY context
  // (contracts + this commit's diff) INTO the primary working copy, at the SAME deterministic path
  // (serviceContextDir) already threaded into CompositionConfig.triggerService/services below — so
  // by the time generation reads that path, real staged content is sitting there.
  const checkout = async (checkoutSha: Sha): Promise<string> => {
    if (triggerService) {
      await mirror.ensureMirror(triggerService.repo, checkoutSha.value, defaultMirrorDeps);
      const primaryDir = await mirror.ensureMirrorAtBranch(app.repo, app.baseBranch ?? "main", defaultMirrorDeps);
      await stage({
        workingCopyDir: primaryDir,
        service: { repo: triggerService.repo, mirrorDir: vcsDir, ...(triggerService.openapi ? { openapi: triggerService.openapi } : {}) },
        sha: checkoutSha.value,
      });
      return primaryDir;
    }
    const primaryDir = await mirror.ensureMirror(app.repo, checkoutSha.value, defaultMirrorDeps);
    // Context-mode multi-service parity (legacy pipeline.ts:1330-1355 buildContextMap): mirror every
    // declared service READ-ONLY at its OWN svc.baseBranch ?? "main", sequentially like the legacy
    // loop — these are advisory prompt-context sources for the FE<->BE architecture map, never the
    // diff/classify source (that stays PRIMARY-bound for context mode by the sibling guard above), so
    // there is no ordering dependency against ChangeAnalysis.classify() the way triggerService's
    // cross-repo branch has. Config paths (CompositionConfig.services, composed above) are static —
    // this is where the actual clones are brought into existence by run time. No sha: context-mode
    // services carry no per-run commit, so staging is contracts-only (see service-context.ts).
    if (run.mode === "context" && app.services?.length) {
      for (const svc of app.services) {
        const svcDir = await mirror.ensureMirrorAtBranch(svc.repo, svc.baseBranch ?? "main", defaultMirrorDeps);
        await stage({ workingCopyDir: primaryDir, service: { repo: svc.repo, mirrorDir: svcDir, ...(svc.openapi ? { openapi: svc.openapi } : {}) } });
      }
    }
    return primaryDir;
  };

  // W3 F2 / reflector-rewire (Unit 5): ONE SqliteLearningRepository instance per composed run,
  // wrapping the SAME learning_rules SQLite table src/server/history.ts already owns
  // (historyLearningStore(), this module's own bridge, above). Reused for BOTH `learningRepo`
  // (composition-root.ts's wireBridges() -> LearningPortAdapter) and the ReflectorPortAdapter's
  // own `repo` dep below — a single source of truth, never two independently-constructed
  // repositories racing over the same table.
  const learningRepo = new SqliteLearningRepository(historyLearningStore(app.name));

  return {
    repo: app.repo,
    appName: app.name,
    mirrorDir,
    e2eRelDir,
    branch,
    target,
    // Audit fix (judgment-day): PER-RUN, not a static "diff" literal — see this fn's own header.
    // A hardcoded "diff" fed GenerationPortAdapter/ReviewPortAdapter the wrong mode prompt for
    // every complete/exhaustive/manual/context run.
    mode: run.mode,
    ...(run.guidance ? { guidance: run.guidance } : {}),
    needsReview: app.qa.needsReview,
    shadow: app.qa.shadow ?? false,
    onFailure: app.report.onFailure,
    maxRetries: app.qa.fixLoop?.maxRetries ?? 2,
    isCode,
    // Derived from coveragePolicy.mode (computed once, above) — single source, see this fn's own
    // header comment near `const coveragePolicy = ...`.
    coveragePolicyMode: coveragePolicy.mode,
    // The dynamic-diff fix (engram #939): GenerationPortAdapter/ReviewPortAdapter both prefer the
    // REAL per-run diff sourced from ChangeAnalysisPort.classify() over this static field, which is
    // deliberately left empty here — there is no per-run commit diff known at composition-build
    // time (unlike the F.2 operator script, which already ran classify()/getCommitDiff() before
    // calling buildCompositionConfig). Only callers that omit the dynamic diff argument fall back
    // to this static "" (documented backward-compatible default in the port's own header).
    diff: "",

    vcs,
    generationUseCase,
    // W5 fix (seam-parity FIXME): the file-read collaborator for FixLoop's Lever-2 selector-
    // contradiction check (fix-loop.aggregate.ts's own FixLoopGenerateResult.specSources contract,
    // consumed via GenerationPortAdapter's optional readSpecSource — see that adapter's own header).
    // Without this, GenerationPortAdapter.generate() never populates specSources, so Lever-2's
    // checkSpecSelectors always receives [] on the real production path and can never fire. A plain
    // fs read is sufficient — the adapter already resolves the absolute path (`${specDir}/${spec}`)
    // before calling this collaborator, so no further path resolution belongs here.
    readSpecSource: (absolutePath: string) => readFile(absolutePath, "utf8"),
    reviewRuntime: {
      runtime: runtimeAdapter,
      rendering,
      verdicts,
    },
    // WS6.1 (full-flow remediation, timeouts & operational observability): see the import's own
    // header comment above.
    reviewTimeoutMs: REVIEWER_TIMEOUT_MS,
    validationStrategies: { e2e: staticGate, code: codeValidate },
    executionStrategies: { e2e, code },
    // SetupPort (CLAUDE.md run-flow step 3): bootstraps the config/e2e seed into e2e/ (first run) +
    // npm ci, or installs the repo's own deps for code mode — the SAME real src/qa/setup.ts /
    // src/qa/code-runner.ts functions defaultPipelineDeps() wires for the legacy engine, so both
    // engines set up a fresh mirror identically. specDir here is whatever WorkspacePortAdapter's
    // checkout(sha) resolved (composition-root.ts's own contract) — e2eDir under the REAL per-run
    // mirrorDir, not this factory's static placeholder mirrorDir/e2eDir above.
    setupCollaborators: {
      e2e: (specDir, opts) => setupE2eProject(specDir, defaultSetupDeps, opts),
      code: (specDir, opts) => setupCodeProject(specDir, defaultCodeSetupDeps, opts),
    },
    // CleanupPort (audit CRITICAL, task #33): orphan test-data cleanup — the SAME real
    // defaultCleanupDeps.runCleanup src/pipeline.ts's own defaultPipelineDeps() wires for the
    // legacy engine (src/pipeline.ts:432's `cleanup: (e2eDir, opts) =>
    // defaultCleanupDeps.runCleanup({ dir: e2eDir, ...opts })`), so both engines clean an
    // interrupted prior run's DEV data identically. e2e-only by construction (CleanupPortAdapter's
    // own collaborators shape has no `code` slot — composition-root.ts's wireBridges() also gates
    // this entire port on `!cfg.isCode`, matching setupCollaborators' own e2e/code split one layer
    // up here, since code mode has no web test data to clean).
    cleanupCollaborators: {
      e2e: (args) => defaultCleanupDeps.runCleanup(args),
    },
    // W4 follow-up (Task #37 audit CRITICAL, a9e7dfb's own "KNOWN FOLLOW-UP" note): wire the
    // PreGenerationGroundingPort / ReviewDomGroundingPort collaborators explicitly, mirroring
    // setupCollaborators' own visible-wiring precedent immediately above, rather than relying on
    // composition-root.ts's wireBridges() implicit `cfg.groundingCollaborators ?? {}` fallback.
    // `{}` here is not a stub: PreGenerationGroundingPortAdapter/ReviewDomGroundingPortAdapter each
    // resolve an omitted collaborator to the REAL production fn (`this.collaborators.buildContextPack
    // ?? buildContextPack`, `this.collaborators.captureDom ?? captureDom`, both backed by
    // defaultContextPackDeps/defaultCaptureDomDeps — the same real-Playwright-spawn capture legacy's
    // own defaultCaptureDomDeps uses) — so this was already functionally wired before this fix; this
    // makes that fact explicit at the ONE seam permitted to say so, instead of leaving it implicit
    // three files away. wireBridges() itself skips both ports entirely on the code target
    // (isCode guard, mirroring legacy's own `!isCode` guards, pipeline.ts:1466/1643/2078), so no
    // target check is needed here.
    groundingCollaborators: {},
    reviewDomGroundingCollaborators: {},
    // CodeGraph Phase 4 (design §5.3/§6, user-confirmed ACTIVE wiring): the raw CLI client for the
    // structural blast-radius signal. Reuses this factory's own `runner` (the same sandboxed spawn
    // primitive every other extractor uses). Unconditional by design — an unindexed mirror degrades
    // to "" (no section) entirely inside the adapter chain, so there is no per-app opt-in to forget;
    // indexing an app's mirror is the ONLY step needed to light the signal up for that app.
    // Gated on structuralSignalsOn (Slice B): mode:"off" omits this collaborator entirely.
    ...(structuralSignalsOn ? { codebaseMemory: new CodebaseMemoryClient(runner) } : {}),
    // Stitcher→Generation seam (design §3.6, ADR-6): supply serviceTopology ONLY when the app
    // declares BOTH services[] (the participating repos) AND boundaries[] (the call convention).
    // Either absent -> no collaborator -> the phase is inert (fail-open, byte-identical to today).
    // Unlike codebaseMemory above (supplied unconditionally because an unindexed mirror
    // self-degrades cheaply), this seam has a cheap, honest config gate: no boundaries[] means
    // there is literally nothing for the resolver to stitch.
    // ALSO gated on structuralSignalsOn (Slice B, ADR-B2): mode:"off" must omit this collaborator
    // too, even when services[]+boundaries[] are both declared — the half-gate hazard this design
    // explicitly guards against (disabling codebaseMemory alone while leaving this one active).
    ...(structuralSignalsOn && app.services?.length && app.boundaries?.length
      ? {
          serviceTopology: {
            appName: app.name,
            primaryRepo: app.repo,
            mirrorRoot, // the SAME local already computed above (deps.mirrorRoot ?? workdirRoot())
            services: app.services.map((s) => ({ repo: s.repo })),
            boundaryProfiles: new YamlBoundaryProfileAdapter((name) =>
              expandEnv(readFileSync(join(process.env.PANCHITO_ROOT ?? process.cwd(), "config", "apps", `${name}.yaml`), "utf8"))),
          },
        }
      : {}),
    // Slice C (structural-signals-expansion, design §3.8, ADR-C6): SAME gate as serviceTopology
    // above (structuralSignalsOn && services[] && boundaries[]) — the advisory cross-repo impact
    // composition has nothing to stitch without a declared service/boundary set either. Reuses
    // this factory's own `runner` (the SAME sandboxed spawn primitive every other extractor uses)
    // for the C.4 step-1.5 mirror-freshness fetch — no new process-spawning surface.
    ...(structuralSignalsOn && app.services?.length && app.boundaries?.length
      ? { crossRepoImpact: { mirrorRoot, codebaseMemory: new CodebaseMemoryClient(runner), runner } }
      : {}),
    // contextMap / prChangedFiles: LEFT ABSENT, deliberately. Legacy sources contextMap by reading
    // e2e/.qa/context.json off the REAL per-run mirrorDir (src/pipeline.ts's loadContextMap(),
    // :1308-1320) and prChangedFiles from intent.changedFiles (classifyCommit(message, diff),
    // src/pipeline.ts:2121) — both are per-run values that only exist AFTER checkout(sha) resolves
    // the real mirrorDir and classifyCommit runs, neither of which has happened yet at this
    // composition-build call (the SAME documented limitation as `diff: ""` and the static
    // `mirrorDir` placeholder above: this factory has no per-run mirrorDir/diff in hand here).
    // Wiring a value that doesn't exist yet would be fabrication, not grounding — per the
    // CompositionConfig's own documented degrade path, buildContextPack falls back to
    // blast-radius + DOM only, exactly the same graceful degradation legacy itself documents when
    // context.json/the brief is absent. A future fix can thread these dynamically once
    // GenerationPortAdapter/ReviewPortAdapter grow the SAME "dynamic diff" seam pattern the diff
    // field already uses (composition-root.ts's own precedent for this class of gap).
    //
    // sdd/migration-wiring-phase-2 Slice 3 (D-C, RIDER 4) update: contextMap's per-run read-back IS
    // now wired — but NOT here. PreGenerationGroundingPortAdapter.ground(specDir, ...) reads
    // `${specDir}/.qa/context.json` fresh on every run (specDir = the REAL per-run mirrorDir, only
    // known post-checkout — the composition-build-time gap this comment describes still holds for
    // THIS field). `config.contextMap` genuinely stays absent here, by design, unchanged. prChangedFiles
    // remains the one still-open gap this comment describes.
    // CRITICAL fix (live crash, judgment-day audit): baseUrl is app-static (the live DEV URL from
    // config), so it is correct to set it once here at composition time — unlike diff/mode/guidance,
    // there is no per-run value to thread. Without this, E2eExecutionStrategy.run() (wired via
    // executionStrategies.e2e above) never receives a baseUrl and throws "E2eExecutionStrategy
    // requires a baseUrl (live DEV URL)" the moment a real e2e run reaches execution.
    ...(app.dev?.baseUrl ? { baseUrl: app.dev.baseUrl } : {}),
    // W5 fix (seam-parity FIXME): app.openapi is app-static (a config-time hint, like baseUrl above)
    // — threaded straight through to CompositionConfig.openapi so GenerationPortAdapter's ctx
    // carries it into OpencodeRunInput.openapi (prompts.ts:500,1068's OpenAPI-hint rendering).
    ...(app.openapi ? { openapi: app.openapi } : {}),
    // Cross-repo generation-prompt parity (legacy pipeline.ts:1909, restored by this fix), UPDATED
    // for the generation-stall fix: mirrorDir here is the STAGED, IN-ROOT path (serviceContextDir),
    // NEVER the raw sibling mirror (vcsDir) — the agent session is rooted at the primary working
    // copy, and any prompt path outside it trips opencode serve's external_directory permission
    // gate and hangs (see service-context.ts's own header). vcsDir/classify are UNCHANGED (the
    // ChangeAnalysisPort above still reads the real mirror) — only the agent-facing path switches.
    // serviceContextDir is a PURE function of (primaryDir, repo) — the SAME deterministic formula
    // the checkout closure above uses to know where to actually write the staged content, so this
    // placeholder and the real staged content agree by construction (never re-derived elsewhere).
    // Only a genuine cross-repo run (triggerService resolved above) supplies this — same-repo runs
    // (the common case) omit the key entirely. openapi is preserved as declared on the service YAML
    // entry (string | string[] | undefined), mirroring app.openapi's own conditional-spread
    // precedent immediately above.
    ...(triggerService
      ? { triggerService: { repo: triggerService.repo, mirrorDir: serviceContextDir(mirrorDir, triggerService.repo), ...(triggerService.openapi ? { openapi: triggerService.openapi } : {}) } }
      : {}),
    // Context-mode multi-service parity (legacy pipeline.ts:1330-1355 buildContextMap, restored by
    // this fix), UPDATED for the generation-stall fix: a context-mode run threads EVERY declared
    // app.services[] entry through — same-repo context runs and every non-context mode omit the key
    // entirely (mutually exclusive with triggerService above by the sibling guard already thrown
    // near this function's top). Each service's mirrorDir is the SAME staged serviceContextDir
    // formula as triggerService above (never the raw sibling mirror) — never re-derived, so it can't
    // silently diverge from where the checkout closure above actually stages it. openapi is
    // preserved as declared on the service YAML entry, mirroring triggerService's own
    // conditional-spread precedent immediately above.
    ...(run.mode === "context" && app.services?.length
      ? {
          services: app.services.map((svc) => ({
            repo: svc.repo,
            mirrorDir: serviceContextDir(mirrorDir, svc.repo),
            ...(svc.openapi ? { openapi: svc.openapi } : {}),
          })),
        }
      : {}),
    // Audit fix (worst leak in audit-2026-07-flaky-selector-leaks): mirrors legacy's
    // resolveTestIdAttribute(app) (src/pipeline.ts:835: `config.e2e?.testIdAttribute ?? "data-testid"`)
    // — but deliberately WITHOUT the "data-testid" default. CompositionConfig's own doc
    // (composition-root.ts:87-89) already documents "NO defaulting logic here; undefined flows
    // through and the seed playwright.config.ts already defaults to data-testid" — applying the
    // default a second time here would just be redundant, not wrong, but omitting it keeps this
    // factory's mapping a pure pass-through of the app's declared config, matching every other
    // optional field in this object.
    ...(app.e2e?.testIdAttribute !== undefined ? { testIdAttribute: app.e2e.testIdAttribute } : {}),
    objectiveSignal: { collector, oracle },
    coveragePolicy,
    // THE VALUE KEYSTONE (CLAUDE.md "The value/trust risk"): turns the collector's raw CoverageReport
    // + the run's real per-run diff (threaded dynamically by ObjectiveSignalPortAdapter.measure(), the
    // SAME "dynamic diff" precedent as generationUseCase/reviewRuntime above) into the ChangeCoverage
    // read-model DecideCoverageService.decide() consumes. A pure port of legacy parseDiffHunks +
    // computeChangeCoverage (qa-engine/src/contexts/objective-signal/domain/assemble-change-coverage.ts)
    // — supplying it here is what turns the previously-always-"unknown" measurement into a REAL one.
    assembleChangeCoverage,
    baselineCases: [],

    // Real GitHub PR/Issue collaborators — the actual production publish path (buildProduction, not
    // buildShadow). PublishDecisionService's own decide() still routes to the ShadowLogAdapter when
    // cfg.shadow is true (composition-root.ts wireBridges() wires that unconditionally), so a
    // shadow-mode app never fires these even on this REAL path.
    // F5 fix (HIGH): GitHubPrAdapter defaults its own `base` param to "main" when omitted
    // (github-pr.adapter.ts:14) — this call previously never passed app.baseBranch at all, so every
    // app with a non-"main" default branch (mirrors legacy's own `app.baseBranch ?? "main"` used
    // throughout src/pipeline.ts, e.g. :1214/:1430/:3138/:3222) would silently target the wrong base
    // branch for its suite PR.
    githubPr: new GitHubPrAdapter(
      {
        createPullRequest: (repo, args) => github.createPullRequest(repo, args),
        enableAutoMerge: (nodeId) => github.enableAutoMerge(nodeId),
        mergePullRequest: (repo, number) => github.mergePullRequest(repo, number),
      },
      app.baseBranch ?? "main",
    ),
    githubIssue: new GitHubIssueAdapter((repo, title, body) => github.openIssue(repo, title, body)),
    // PROD-BLOCKER fix: the REAL git-write collaborator — stages/commits/pushes the agent's generated
    // tests to the PR branch BEFORE githubPr.openWithAutoMerge() is called (PublicationPortAdapter's
    // "pr" route, see that file's own header). Dispatched by isCode exactly like
    // validationStrategies/executionStrategies/setupCollaborators above (e2e publishes only e2e/;
    // code publishes the whole tree minus installed deps/build output).
    vcsWrite: buildVcsPublish(isCode, run.mode),
    // sdd/migration-remediation Slice 3 (P0 write-confinement wiring, D-P0b): wired UNCONDITIONALLY
    // (fail-open fault isolation makes it safe to run on every composition, not gated by app config)
    // — realGit local ops only, no auth decoration (confinement never pushes/commits).
    confinement: buildConfinement(),
    // sdd/migration-wiring-phase-2 Slice 2 (D-B mirror-gc): wired UNCONDITIONALLY (fail-open fault
    // isolation makes it safe to run on every composition, not gated by app config) — realGit local
    // `git gc --auto --quiet`, no auth decoration (gc never pushes/commits, mirrors confinement's
    // own rationale immediately above).
    mirrorGc: buildMirrorGc(),
    reviewerApprovedForPublish: true,
    coverageBlocksForPublish: false,
    e2eChangedForPublish: true,
    // F4 fix (CRITICAL security invariant): the REAL redaction adapter (this module is the E.3 seam
    // permitted to import src/ — see this file's own header) — PublicationPortAdapter's renderBody/
    // renderTitle apply it to every log/case-detail/note reaching an Issue/PR body, matching
    // src/report/reporter.ts's own `s = (v) => sanitizeText(v).text` precedent for the legacy engine.
    // sdd/migration-remediation Slice 6 (D-P2, RedactionPort unification): formalized as
    // RedactionPortAdapter (wraps sanitizer.ts's sanitizeText/containsSecrets, "issue" mode) instead
    // of an ad hoc lambda — the canonical placeholder is `[REDACTED]`, sourced from qa-engine's
    // shared-kernel redaction.port.ts. PublicationPortCollaborators.sanitize's own type (`(text:
    // string) => string`) is unchanged (duck-typed) — only the implementation is formalized.
    sanitize: (text: string) => redactionPort.redact(text),
    // sdd/migration-wiring-phase-2 Slice 6b (logs→Issue egress boundary): wired UNCONDITIONALLY,
    // alongside sanitize above — the SAME RedactionPortAdapter instance, so production is never
    // silently unguarded (PublicationPortCollaborators.containsSecret's own doc has the full
    // contract). Post-redaction fail-loud check on the "issue" route only.
    containsSecret: (text: string) => redactionPort.containsSecret(text),

    checkout,
    // Cross-repo composition (bug fix): a cross-repo run gates on the SERVICE's own versionUrl —
    // NEVER falls back to the primary's app.dev?.versionUrl, which would poll the primary's /version
    // endpoint for a sha that never appears there (the event sha belongs to the service repo). A
    // service that declares no versionUrl at all leaves this undefined on purpose: composition-root's
    // own `cfg.versionUrl ? new DeployGatePortAdapter(...) : new NullDeployGateAdapter()` branch
    // (the gate's single decision point) then skips the gate entirely — trust the deploy event,
    // matching the legacy contract's "NO versionUrl on the service -> gate skipped entirely" rule.
    versionUrl: triggerService ? triggerService.versionUrl : app.dev?.versionUrl,
    // Single-shot probe (see fetchVersion's own header) — DeployGatePortAdapter.waitUntilServing
    // is the ONLY poll loop; this fn is called once per its interval, never loops itself.
    versionPoll: (triggerService ? triggerService.versionUrl : app.dev?.versionUrl)
      ? async (versionUrl: string, sha) => {
          const v = await fetchVersion(versionUrl);
          return { serving: shaMatches(v?.sha, sha.value) && v?.healthy === true };
        }
      : undefined,
    // Service-level defaults (10_000/600_000) are deliberately DIFFERENT from the primary's
    // (2000/60000) — the legacy contract's own service-level defaults, restored verbatim.
    deployGateIntervalMs: triggerService
      ? (triggerService.pollIntervalMs ?? 10_000)
      : (app.dev?.pollIntervalMs ?? 2000),
    deployGateTimeoutMs: triggerService
      ? (triggerService.deployTimeoutMs ?? 600_000)
      : (app.dev?.deployTimeoutMs ?? 60000),

    // W3 F1 (CRITICAL cutover blocker): the REAL durable RunHistoryPort by default — takes
    // precedence over historyFilePath in composition-root.ts's wireBridges(). historyFilePath stays
    // available as an explicit opt-OUT (see RewrittenEngineFactoryDeps's own doc above).
    ...(deps.historyFilePath ? { historyFilePath: deps.historyFilePath } : { runHistory: new SqliteRunHistoryAdapter() }),
    // W3 F2 (CRITICAL cutover blocker): the REAL SqliteLearningRepository — wraps the SAME
    // learning_rules SQLite table src/server/history.ts already owns (historyLearningStore(), this
    // module's own bridge, above) via the SAME LearningRepositoryPort -> LearningPort seam
    // composition-root.ts's wireBridges() already wires (LearningPortAdapter). Prior to this fix,
    // composition-root.ts's `cfg.learningRepo ?? new StubLearningRepository()` default meant
    // production had ZERO real constructors of SqliteLearningRepository anywhere — retrieval and
    // the outcome fold were both provable no-ops end-to-end, regardless of what history.ts's own
    // SQLite table held.
    learningRepo,
    // reflector-rewire (design ADR-2/ADR-5, Unit 5): this factory is the ONE module permitted to
    // import both qa-engine's @contexts aliases AND root src/, so it is the ONLY place that can
    // construct a real ReflectorPortAdapter — runtime (the SAME runtimeAdapter reviewRuntime.runtime
    // above reuses, never a second AgentRuntimeManager), repo (the SAME learningRepo instance just
    // above — one SqliteLearningRepository per app, not two independent ones), and backfill
    // (updateRunOutcomeReflection, src/server/history.ts:750 — the host-side back-fill ADR-2
    // documents; the use-case itself never calls this directly). REFLECTOR_TIMEOUT_MS resolves the
    // env-name deferred at task 2.4: parsed here with the SAME `Number(process.env.X) || default`
    // convention src/integrations/opencode-client.ts's OPENCODE_*_TIMEOUT_MS constants use (deps.env
    // mirrors that module's own injectable-env seam, defaulting to process.env), falling back to
    // the adapter's own REFLECT_TIMEOUT_MS (60_000) when unset/non-numeric.
    reflectorPort: new ReflectorPortAdapter({
      runtime: runtimeAdapter,
      repo: learningRepo,
      // qa-engine's ReflectionInput/StructuredReflection widen errorClass to `string` (the port's
      // own documented kernel-widening convention — see cross-run-learning/application/ports/
      // index.ts's ErrorClass alias); updateRunOutcomeReflection expects legacy's narrow
      // ErrorClass string-literal union. Safe to cast here for the SAME reason
      // historyLearningStore's own upsert() cast is safe (this module's W3 fix F3b comment,
      // above): the ONLY genuine producer of this errorClass value is the re-ported labeler
      // taxonomy (qa-engine's domain/helpers/error-class.ts, a verbatim port of
      // src/qa/learning/taxonomy.ts) every RunOutcome.errorClass already derives from.
      backfill: (runId, refl) => updateRunOutcomeReflection(runId, refl as import("../types").StructuredReflection),
      cwd: mirrorDir,
      app: app.name,
      timeoutMs: Number((deps.env ?? process.env).REFLECTOR_TIMEOUT_MS) || REFLECT_TIMEOUT_MS,
    }),
    // sdd/migration-remediation Slice 5 (P1 process-audit reconnect, D-P1b): this factory is the ONE
    // module permitted to import both qa-engine's @contexts aliases AND root src/, so it is the ONLY
    // place that can construct a real ProcessAuditPortAdapter — the 2 factory-injected READS
    // (history.ts's listRunOutcomes/listLearningRules, the SAME SQLite table reflectorPort/
    // learningRepo above already read) and the 3 SINKS (recordEngineIncident -> maintainer.ts's
    // recordIncident; deprecateRule -> history.ts's setRuleStatusByHuman(id,"deprecated"), the
    // `reason` argument discarded exactly like legacy's own pipeline.ts wiring did; invalidateContext
    // -> history.ts's markContextStale, true on success matching legacy's try/catch-and-return
    // shape) are all src-only collaborators qa-engine itself must never import.
    processAudit: new ProcessAuditPortAdapter({
      app: app.name,
      readRecentOutcomes: (a, limit) => listRunOutcomes(a, limit),
      readRules: (a, limit) => listLearningRules(a, limit),
      deprecateRule: (ruleId) => { setRuleStatusByHuman(ruleId, "deprecated"); },
      recordEngineIncident: (finding) =>
        recordIncident({
          source: "process-audit",
          severity: finding.severity === "error" ? "error" : "warn",
          summary: finding.summary,
          // finding.diagnosis is never populated by this port today (Layer 2 LLM root-cause
          // diagnosis is deferred — see process-audit.ts's own SCOPE NOTE); kept conditional so a
          // future diagnosis producer needs no change here.
          detail: [finding.evidence, finding.diagnosis ? `\nLIKELY ROOT CAUSE: ${finding.diagnosis}` : ""].join(""),
        }),
      invalidateContext: (reason) => {
        try {
          markContextStale(app.name);
          console.log(`[audit] marked context stale for ${app.name} — rebuilds next run (${reason})`);
          return true;
        } catch {
          return false; // best-effort — mirrors legacy's own try/catch-and-return-false shape
        }
      },
    }),
    ...(observer ? { observer } : {}),
  };
}

// The RunnerDeps.engineFactory seam (src/server/runner.ts) — returns a factory mapping
// (AppConfig, namespace, run) → RunPipelinePort. Only ever invoked by the runner when
// selectEngine(process.env) already resolved to "rewritten"; buildProduction internally reads the
// SAME flag and returns the RewrittenOrchestratorAdapter on that branch (never
// LegacyPipelineAdapter — that branch requires options.legacyRunner, which this factory never
// supplies, matching this seam's own contract: the runner's `engine === "rewritten" &&
// deps.engineFactory` guard already ensures this function is never reached on the legacy path).
//
// The `namespace` parameter (CRITICAL fix, judgment-day) is the caller's PER-RUN test-data
// namespace — the runner computes it once per run via testDataNamespace(...) (mirroring legacy's
// own src/pipeline.ts:1222 formula) and passes it here on every invocation. This closure itself
// stays stateless: no namespace is cached or defaulted internally, so two calls with two different
// namespaces always compose two independent CompositionConfigs with two different `branch` values.
//
// The `run` parameter (audit fix, judgment-day) carries the PER-RUN mode/guidance — see
// buildRewrittenCompositionConfig's own header. Same statelessness contract: nothing here is
// cached, so two calls with two different `run` values compose two independent configs.
//
// The `observer` parameter (bug fix): the runner's PER-RUN ObserverPort (src/server/runner.ts's
// buildRewrittenObserver) — forwarded straight into buildRewrittenCompositionConfig so the
// resulting RunPipelinePort's RunQaUseCase actually reports progress back to the RunRecord/
// RunEvents. Without this 4th argument (or a caller that omits it), record.step never advances
// past its initial value and /api/runs/:id/events stays empty for the ENTIRE run — this was the
// root cause: RunnerDeps.engineFactory's signature had no seam for an observer at all, so even
// though ObserverPort/RunQaUseCaseDeps.observer existed, nothing ever constructed one.
// The `previousNamespace` parameter (audit CRITICAL fix, task #33): accepted here for signature
// parity with RunnerDeps.engineFactory (src/server/runner.ts), which now threads it as a 5th
// argument. NOT forwarded into CompositionConfig — RunQaUseCase reads previousNamespace directly
// off RunInput/RunQaInput (set by runner.ts's runViaRewrittenEngine at the port.run(input) call
// site), not off a composition-time config — see CompositionConfig.cleanupCollaborators' own doc
// (composition-root.ts) for why this field is deliberately NOT duplicated onto CompositionConfig.
// Accepting (and ignoring) it here keeps this factory's own call signature aligned with the
// caller's, rather than silently swallowing an argument the caller now always passes.
//
// `run.triggerRepo` (bug fix — cross-repo composition threading), by contrast, IS forwarded into
// buildRewrittenCompositionConfig — unlike previousNamespace, it now ALSO shapes composition itself
// (vcs/checkout/the deploy gate route to the declared service, not just the primary), not merely a
// RunInput-only seam. See buildRewrittenCompositionConfig's own header for the full contract.
//
// WS6.2 (full-flow remediation, timeouts & operational observability): withUsageSink/
// withStallWatchdog/withSessionRegistration existed and were fully tested, but nothing on the
// rewritten production path ever composed them onto the AgentDeps this factory consumes — the
// factory received deps.getAgentDeps() RAW (src/index.ts's currentAgentDeps / src/cli.ts's
// equivalent), so a hung session never tripped the 180s stall watchdog, usage snapshots never
// reached a sink, and sessions never registered for SSE (see withSessionRegistration's own header).
// Wrapping HERE — the single seam BOTH src/index.ts (webhook path) and src/cli.ts (manual/CLI path)
// already funnel through via createRewrittenEngineFactory — restores all three without duplicating
// the wrap at each entrypoint. The wrap itself stays LAZY (deps.getAgentDeps is called, not
// deps.getAgentDeps() eagerly captured) so factory construction still never touches a real agent
// session, matching the existing "construction must never call .open()" contract this file's own
// tests already pin.
export function createRewrittenEngineFactory(
  deps: RewrittenEngineFactoryDeps,
): (appConfig: AppConfig, namespace: string, run: { mode: RunMode; guidance?: string; triggerRepo?: string }, observer?: ObserverPort, previousNamespace?: string) => RunPipelinePort {
  const env = deps.env ?? process.env;
  const wrappedDeps: RewrittenEngineFactoryDeps = {
    ...deps,
    getAgentDeps: () => withUsageSink(withStallWatchdog(withSessionRegistration(deps.getAgentDeps()))),
  };
  return (appConfig: AppConfig, namespace: string, run: { mode: RunMode; guidance?: string; triggerRepo?: string }, observer?: ObserverPort): RunPipelinePort => {
    const cfg = buildRewrittenCompositionConfig(appConfig, wrappedDeps, namespace, run, observer);
    return buildProduction(env, cfg);
  };
}
