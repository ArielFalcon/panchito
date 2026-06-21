// Manual trigger. Routes through a sequential funnel (enqueueTrackedRun → JobQueue), so a
// manual run is queued, recorded in history and addressable. It then drains the queue and
// exits with the run's verdict.
//   npm run qa -- --app <app> --sha <sha> [--mode diff|complete|exhaustive|manual|context]
//                 [--target e2e|code] [--guidance "..."] [--allow-concurrent]
//   npm run qa -- --app <app> --learning   → show learning state (outcomes, rules, curriculum)
//
// IMPORTANT: this CLI uses its OWN in-process queue. If the long-lived service is also
// running on this host it has a SEPARATE queue, so a CLI run could execute QA against DEV
// concurrently with a service run — breaking the "one run at a time against DEV" invariant.
// We therefore refuse to start when the local service answers its health probe, unless the
// operator explicitly accepts the risk with --allow-concurrent.

import { fileURLToPath } from "node:url";
import { JobQueue } from "./server/queue";
import { enqueueTrackedRun } from "./server/runner";
import { createDurableRunEventStore } from "./server/durable-run-events";
import { delegateRun, type DelegateRunResult } from "./server/run-delegate";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { getRecord, getRunOutcome, listRunOutcomes, listLearningRules, loadCurriculum } from "./server/history";
import { loadAppConfig } from "./orchestrator/config-loader";
import { RUN_MODES, RunMode, TestTarget } from "./types";
import { runSucceeded } from "./cli-exit";
import { renderRunReport } from "./qa/value-report";

// Probe the local service's unauthenticated liveness endpoint. A 200 means a long-lived
// orchestrator owns the queue on this host and a second queue here would race it against DEV.
async function localServiceIsRunning(): Promise<boolean> {
  const port = Number(process.env.PORT ?? 8080);
  try {
    const res = await fetch(`http://localhost:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
    return res.ok;
  } catch {
    return false; // nothing listening / not reachable → safe to run locally
  }
}

// The control-plane token, discovered the same way the server resolves it (env wins, then the
// persisted config/.api_token file) so delegation authenticates without the operator typing it.
function discoverApiToken(): string | undefined {
  if (process.env.QA_API_TOKEN) return process.env.QA_API_TOKEN;
  try {
    const root = process.env.AI_PIPELINE_ROOT ?? process.cwd();
    const token = readFileSync(join(root, "config", ".api_token"), "utf8").trim();
    return token || undefined;
  } catch {
    return undefined;
  }
}

// Delegate the run to the already-running service and wait for its verdict, mirroring the
// standalone CLI's contract (wait, report, exit with the verdict's code). The run executes IN the
// server process, so the TUI streams it live and the single-queue invariant holds.
async function runViaService(args: { app: string; sha: string; mode: RunMode; target?: TestTarget; guidance?: string }): Promise<void> {
  const port = Number(process.env.PORT ?? 8080);
  const baseUrl = `http://localhost:${port}`;
  const appCfg = loadAppConfig(args.app);
  const target = args.target ?? (appCfg.code ? "code" : "e2e");
  console.log("[qa] the service is running — delegating this run to it (one queue against DEV; watch it live in the TUI).");
  // Explicitly typed: the catch terminates via process.exit, so result is always assigned past the
  // try/catch — the annotation enforces that invariant instead of relying on process.exit narrowing.
  let result: DelegateRunResult;
  try {
    result = await delegateRun(
      { app: args.app, sha: args.sha, target, mode: args.mode, guidance: args.guidance },
      {
        fetch,
        baseUrl,
        token: discoverApiToken(),
        onUpdate: (r) => process.stdout.write(`\r[qa] ${r.status}${r.step ? " · " + r.step : ""}                    `),
      },
    );
  } catch (err) {
    console.error(`\n[qa] ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
  if (result.timedOut) {
    console.log(`\n[qa] run ${result.id} is still running server-side (stopped waiting) — watch it in the TUI.`);
    process.exit(0);
  }
  console.log(`\n[qa] run ${result.id} finished: verdict=${result.verdict ?? "?"} (${result.passed} passed, ${result.failed} failed)`);
  if (result.note) console.log(`[qa] ${result.note}`);
  // A run SUCCEEDED when the engine produced a trustworthy result — including a real bug found
  // (verdict `fail` → Issue). Only an engine error (infra-error/invalid, or no verdict) exits non-zero.
  process.exit(runSucceeded(result.verdict) ? 0 : 1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.learning) {
    showLearning(args.app);
    return;
  }

  if (!args.allowConcurrent && (await localServiceIsRunning())) {
    // The service owns the only queue against DEV. Rather than refuse (or race it with a second
    // queue), hand the run to it: it then executes IN the server process, so a TUI attached to
    // that server streams it live, and the sequential-queue invariant is preserved.
    // --allow-concurrent forces the standalone path below.
    await runViaService(args);
    return; // runViaService always exits the process with the verdict's code
  }

  const queue = new JobQueue();
  // Persist run events to the SAME durable store the server uses. A standalone CLI run lives in
  // its own process, so the server's in-process event bus never sees it — persisting here is what
  // lets the TUI (attached to the server) replay and tail this run's progress instead of freezing
  // on an empty stream.
  const runEvents = createDurableRunEventStore();
  // When --target is not given, derive it from the app config: a `code: true` app must run
  // code mode (running e2e against it would hit the no-dev defensive infra-error).
  const appCfg = loadAppConfig(args.app);
  const target = args.target ?? (appCfg.code ? "code" : "e2e");
  const id = enqueueTrackedRun(queue, {
    app: args.app,
    sha: args.sha,
    baseSha: args.baseSha,
    target,
    mode: args.mode,
    guidance: args.guidance,
    source: "manual",
  }, { runEvents });
  await queue.drain();
  const record = getRecord(id);
  // The end-of-run value report: a manual run used to print NOTHING (just an exit code), so in
  // shadow mode — where there is no PR/Issue artifact to inspect — the operator could not tell what
  // the run was WORTH. Print the deterministic value signals the run already persisted.
  if (record) printRunReport(record, appCfg);
  // A run SUCCEEDED when the engine produced a trustworthy result — including a real bug found
  // (verdict `fail` → Issue). Only an engine error (infra-error/invalid, or no verdict) exits non-zero.
  process.exit(runSucceeded(record?.verdict) ? 0 : 1);
}

// Compose the value report from the persisted run record + its RunOutcome (the structured gate
// signals). Kept in the CLI (not the pure renderer) because it stitches two persistence reads.
function printRunReport(record: ReturnType<typeof getRecord> & {}, appCfg: ReturnType<typeof loadAppConfig>): void {
  const outcome = getRunOutcome(record.id);
  const gs = outcome?.gateSignals;
  const report = renderRunReport({
    app: record.app,
    sha: record.sha,
    mode: record.mode,
    target: record.target,
    shadow: appCfg.qa.shadow ?? false,
    verdict: record.verdict ?? "infra-error",
    passed: record.passed ?? 0,
    failed: record.failed ?? 0,
    specCount: record.specs?.length ?? 0,
    specNames: record.specs?.map((s) => s.name),
    note: record.note,
    signals: {
      // A persisted non-null ratio means coverage was actually measured (the pipeline persists
      // null for an unmeasured run, never a misleading 0). So presence === measured.
      coverageRatio: gs?.coverageRatio ?? null,
      coverageMeasured: gs?.coverageRatio !== null && gs?.coverageRatio !== undefined,
      coveragePolicy: appCfg.qa.changeCoverage?.mode ?? "signal",
      // Resolve the oracle policy exactly as the pipeline does, so the report distinguishes a
      // genuinely-off oracle from one that was enabled but had no passing specs to score.
      oraclePolicy: appCfg.qa.valueOracle ?? (appCfg.qa.shadow ? "off" : "signal"),
      valueScore: gs?.valueScore ?? null,
      reviewerApproved: gs?.reviewerApproved ?? null,
      reviewerRationale: gs?.reviewerRationale,
    },
    errorClass: outcome?.errorClass ?? null,
  }, { color: process.stdout.isTTY === true && !process.env.NO_COLOR });
  console.log("\n" + report + "\n");
}

const TARGETS: TestTarget[] = ["e2e", "code"];

export function parseArgs(argv: string[]): { app: string; sha: string; baseSha?: string; mode: RunMode; target?: TestTarget; guidance?: string; learning: boolean; allowConcurrent: boolean } {
  const out: Record<string, string> = {};
  let learning = false;
  let allowConcurrent = false;
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]?.replace(/^--/, "");
    if (key === "learning") { learning = true; continue; }
    if (key === "allow-concurrent") { allowConcurrent = true; continue; }
    if (key) out[key] = argv[i + 1] ?? "";
    if (key) i++; // skip value
  }
  if (!learning && (!out.app || !out.sha)) {
    console.error(
      `Usage: npm run qa -- --app <app> --sha <sha> [--base-sha <sha>] [--mode ${RUN_MODES.join("|")}] [--target e2e|code] [--guidance "..."] [--allow-concurrent]`,
    );
    console.error('       npm run qa -- --app <app> --learning');
    process.exit(2);
  }
  if (learning && !out.app) {
    console.error("Usage: npm run qa -- --app <app> --learning");
    process.exit(2);
  }
  const mode = (RUN_MODES as readonly string[]).includes(out.mode ?? "") ? (out.mode as RunMode) : "diff";
  // Undefined when not passed → the caller derives it from the app config (code vs e2e).
  const target = (TARGETS as string[]).includes(out.target ?? "") ? (out.target as TestTarget) : undefined;
  return { app: out.app ?? "", sha: out.sha ?? "", baseSha: out["base-sha"] || undefined, mode, target, guidance: out.guidance, learning, allowConcurrent };
}

function showLearning(app: string): void {
  console.log(`\n📊 Learning state for "${app}"\n`);

  const outcomes = listRunOutcomes(app, 20);
  console.log(`── RunOutcomes (${outcomes.length} most recent) ──`);
  if (outcomes.length === 0) {
    console.log("  (none — run the pipeline first)\n");
  } else {
    for (const o of outcomes) {
      const vs = o.gateSignals.valueScore !== null ? ` valueScore=${(o.gateSignals.valueScore * 100).toFixed(0)}%` : "";
      const ec = o.errorClass ? ` ${o.errorClass}` : "";
      const rules = o.rulesRetrieved.length > 0 ? ` rules=${o.rulesRetrieved.length}` : "";
      console.log(`  ${o.at.slice(0, 19)}  ${o.verdict}${ec}${vs}${rules}  ${o.sha.slice(0, 9)}  ${o.mode}/${o.target}`);
    }
    console.log("");
  }

  const rules = listLearningRules(app, 20);
  console.log(`── Learning Rules (${rules.length} active/candidate) ──`);
  if (rules.length === 0) {
    console.log("  (none — failures will create rules via reflection)\n");
  } else {
    for (const r of rules) {
      const sr = r.successRate !== null ? ` sr=${(r.successRate * 100).toFixed(0)}%` : "";
      console.log(`  ${r.status} ${r.confidence}${sr} uses=${r.usageCount}  ${r.errorClass}`);
      console.log(`    trigger: ${r.trigger.slice(0, 100)}`);
      console.log(`    action:  ${r.action.slice(0, 100)}`);
    }
    console.log("");
  }

  const curriculum = loadCurriculum(app);
  console.log(`── Curriculum ──`);
  if (!curriculum) {
    console.log("  (none — will be created on first run)\n");
  } else {
    const proven = curriculum.archetypes.filter((a) => a.caughtRealBug);
    console.log(`  ${proven.length}/${curriculum.archetypes.length} archetypes proven by real bugs:`);
    for (const a of proven) {
      console.log(`    ✓ ${a.archetype} (promoted ${a.promotionCount}x, first: ${a.firstCaughtAt?.slice(0, 10) ?? "?"})`);
    }
    const unproven = curriculum.archetypes.filter((a) => !a.caughtRealBug);
    if (unproven.length > 0) {
      console.log(`  ${unproven.length} unproven: ${unproven.map((a) => a.archetype).join(", ")}`);
    }
    console.log("");
  }

  console.log("── Summary ──");
  const runsWithError = outcomes.filter((o) => o.errorClass !== null).length;
  const runsWithValue = outcomes.filter((o) => o.gateSignals.valueScore !== null).length;
  const rulesWithAttribution = rules.filter((r) => r.successRate !== null).length;
  console.log(`  total outcomes: ${outcomes.length}`);
  console.log(`  with errorClass: ${runsWithError}`);
  console.log(`  with valueScore: ${runsWithValue}`);
  console.log(`  rules with attribution: ${rulesWithAttribution}/${rules.length}`);
  console.log(`  archetypes proven: ${curriculum?.archetypes.filter((a) => a.caughtRealBug).length ?? 0}/${curriculum?.archetypes.length ?? 10}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
