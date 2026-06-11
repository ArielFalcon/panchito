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

import { JobQueue } from "./server/queue";
import { enqueueTrackedRun } from "./server/runner";
import { getRecord, listRunOutcomes, listLearningRules, loadCurriculum } from "./server/history";
import { loadAppConfig } from "./orchestrator/config-loader";
import { RUN_MODES, RunMode, TestTarget } from "./types";

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

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));

  if (args.learning) {
    showLearning(args.app);
    return;
  }

  if (!args.allowConcurrent && (await localServiceIsRunning())) {
    console.error(
      "[qa] the long-lived service is running on this host (responded on /api/health).\n" +
        "      A manual CLI run uses a SEPARATE queue and could run QA concurrently against DEV,\n" +
        "      breaking the sequential-queue invariant. Trigger the run through the service instead\n" +
        "      (TUI, or POST /api/runs), or stop the service.\n" +
        "      To override and accept the risk, re-run with --allow-concurrent.",
    );
    process.exit(2);
  }

  const queue = new JobQueue();
  // When --target is not given, derive it from the app config: a `code: true` app must run
  // code mode (running e2e against it would hit the no-dev defensive infra-error).
  const target = args.target ?? (loadAppConfig(args.app).code ? "code" : "e2e");
  const id = enqueueTrackedRun(queue, {
    app: args.app,
    sha: args.sha,
    target,
    mode: args.mode,
    guidance: args.guidance,
    source: "manual",
  });
  await queue.drain();
  const record = getRecord(id);
  // pass and skipped are success; fail/invalid/infra-error/flaky are not.
  const ok = record?.verdict === "pass" || record?.verdict === "skipped";
  process.exit(ok ? 0 : 1);
}

const TARGETS: TestTarget[] = ["e2e", "code"];

function parseArgs(argv: string[]): { app: string; sha: string; mode: RunMode; target?: TestTarget; guidance?: string; learning: boolean; allowConcurrent: boolean } {
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
      `Usage: npm run qa -- --app <app> --sha <sha> [--mode ${RUN_MODES.join("|")}] [--target e2e|code] [--guidance "..."] [--allow-concurrent]`,
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
  return { app: out.app ?? "", sha: out.sha ?? "", mode, target, guidance: out.guidance, learning, allowConcurrent };
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

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
