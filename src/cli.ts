// Manual trigger: runs the SAME pipeline as the webhook.
//   npm run qa -- --app <app> --sha <sha>

import { loadAppConfig } from "./orchestrator/config-loader";
import { runPipeline, defaultPipelineDeps } from "./pipeline";

async function main(): Promise<void> {
  const { app: appName, sha } = parseArgs(process.argv.slice(2));
  const app = loadAppConfig(appName);
  const run = await runPipeline(app, sha, defaultPipelineDeps(), "manual");
  process.exit(run.passed ? 0 : 1);
}

function parseArgs(argv: string[]): { app: string; sha: string } {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (key) out[key] = argv[i + 1] ?? "";
  }
  if (!out.app || !out.sha) {
    console.error("Usage: npm run qa -- --app <app> --sha <sha>");
    process.exit(2);
  }
  return { app: out.app, sha: out.sha };
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
