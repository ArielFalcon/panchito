// Manual trigger. Routes through the SAME sequential funnel as the webhook and the
// control API (enqueueTrackedRun → JobQueue), so a manual run is queued, recorded
// in history and addressable — and can never run concurrently against DEV. It then
// drains the queue and exits with the run's verdict.
//   npm run qa -- --app <app> --sha <sha> [--mode diff|complete|exhaustive|manual]
//                 [--target e2e|code] [--guidance "..."]

import { JobQueue } from "./server/queue";
import { enqueueTrackedRun } from "./server/runner";
import { getRecord } from "./server/history";
import { RunMode, TestTarget } from "./types";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const queue = new JobQueue();
  const id = enqueueTrackedRun(queue, {
    app: args.app,
    sha: args.sha,
    target: args.target,
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

const MODES: RunMode[] = ["diff", "complete", "exhaustive", "manual", "context"];
const TARGETS: TestTarget[] = ["e2e", "code"];

function parseArgs(argv: string[]): { app: string; sha: string; mode: RunMode; target: TestTarget; guidance?: string } {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (key) out[key] = argv[i + 1] ?? "";
  }
  if (!out.app || !out.sha) {
    console.error(
      'Usage: npm run qa -- --app <app> --sha <sha> [--mode diff|complete|exhaustive|manual] [--target e2e|code] [--guidance "..."]',
    );
    process.exit(2);
  }
  const mode = (MODES as string[]).includes(out.mode ?? "") ? (out.mode as RunMode) : "diff";
  const target = (TARGETS as string[]).includes(out.target ?? "") ? (out.target as TestTarget) : "e2e";
  return { app: out.app, sha: out.sha, mode, target, guidance: out.guidance };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
