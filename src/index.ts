// Arranque del SERVICIO permanente (M2). Recibe webhooks tras el deploy a DEV
// y encola un run por evento; la cola los procesa de a uno. El disparo manual
// (CLI) sigue disponible vía src/cli.ts.

import { JobQueue } from "./server/queue";
import { createWebhookServer } from "./server/webhook";
import { loadAppConfigByRepo } from "./orchestrator/config-loader";
import { runPipeline, defaultPipelineDeps } from "./pipeline";

const port = Number(process.env.PORT ?? 8080);
const queue = new JobQueue((e) => console.error("[qa] run falló:", e));

const server = createWebhookServer({
  secret: process.env.WEBHOOK_SECRET,
  onRun: ({ repo, sha }) => {
    const app = loadAppConfigByRepo(repo);
    if (!app) {
      console.warn(`[qa] sin config/apps para ${repo}; evento ignorado`);
      return;
    }
    console.log(`[qa] encolado ${repo}@${sha} (cola: ${queue.size + 1})`);
    queue.enqueue(async () => {
      await runPipeline(app, sha, defaultPipelineDeps(), "webhook");
    });
  },
});

server.listen(port, () => {
  console.log(`ai-pipeline escuchando webhooks en :${port}`);
});
