// Long-lived service entry point. Receives webhooks after a deploy to DEV and
// enqueues one run per event; the queue processes them one at a time. The manual
// trigger (CLI) remains available via src/cli.ts.

import { JobQueue } from "./server/queue";
import { createWebhookServer } from "./server/webhook";
import { loadAppConfigByRepo } from "./orchestrator/config-loader";
import { runPipeline, defaultPipelineDeps } from "./pipeline";

const port = Number(process.env.PORT ?? 8080);
const queue = new JobQueue((e) => console.error("[qa] run failed:", e));

const server = createWebhookServer({
  secret: process.env.WEBHOOK_SECRET,
  onRun: ({ repo, sha, mode, guidance }) => {
    const app = loadAppConfigByRepo(repo);
    if (!app) {
      console.warn(`[qa] no config/apps entry for ${repo}; event ignored`);
      return;
    }
    console.log(`[qa] enqueued ${repo}@${sha} mode=${mode} (queue: ${queue.size + 1})`);
    queue.enqueue(async () => {
      const run = await runPipeline(app, sha, defaultPipelineDeps(), "webhook", { mode, guidance });
      console.log(`[qa] run finished ${repo}@${sha}: verdict=${run.verdict}`);
    });
  },
});

server.listen(port, () => {
  console.log(`ai-pipeline listening for webhooks on :${port}`);
});
