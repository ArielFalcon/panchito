// Manual trigger: runs the SAME pipeline as the webhook.
//   npm run qa -- --app <app> --sha <sha> [--mode diff|complete|exhaustive|manual] [--guidance "..."]

import { loadAppConfig } from "./orchestrator/config-loader";
import { runPipeline, defaultPipelineDeps } from "./pipeline";
import { RunMode } from "./types";

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const app = loadAppConfig(args.app);
  const run = await runPipeline(app, args.sha, defaultPipelineDeps(), "manual", {
    mode: args.mode,
    guidance: args.guidance,
  });
  process.exit(run.passed ? 0 : 1);
}

const MODES: RunMode[] = ["diff", "complete", "exhaustive", "manual"];

function parseArgs(argv: string[]): { app: string; sha: string; mode: RunMode; guidance?: string } {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (key) out[key] = argv[i + 1] ?? "";
  }
  if (!out.app || !out.sha) {
    console.error("Usage: npm run qa -- --app <app> --sha <sha> [--mode diff|complete|exhaustive|manual] [--guidance \"...\"]");
    process.exit(2);
  }
  const mode = (MODES as string[]).includes(out.mode ?? "") ? (out.mode as RunMode) : "diff";
  return { app: out.app, sha: out.sha, mode, guidance: out.guidance };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
