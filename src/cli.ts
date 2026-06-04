// Disparo MANUAL (M0): orquesta el lazo completo end-to-end.
//   npm run qa -- --app <app> --sha <sha>
// El disparo automático por webhook llega en M2 (src/server/webhook.ts).

import { loadAppConfig } from "./orchestrator/config-loader";
import { waitForDeploy } from "./env/deploy-gate";
import { runAgent } from "./orchestrator/agent-core";
import { runE2E } from "./qa/execute";
import { testDataNamespace } from "./qa/test-data";
import { github } from "./integrations/github";
import { QaRunResult } from "./types";

async function main(): Promise<void> {
  const { app: appName, sha } = parseArgs(process.argv.slice(2));
  const app = loadAppConfig(appName);
  console.log(`[qa] App=${app.name}  SHA=${sha}`);

  // 1. Gate: esperar a que DEV corra este SHA y esté healthy.
  console.log("[qa] Esperando deploy estable en DEV...");
  await waitForDeploy(
    {
      name: app.name,
      versionUrl: app.dev.versionUrl,
      pollIntervalMs: app.dev.pollIntervalMs,
      deployTimeoutMs: app.dev.deployTimeoutMs,
    },
    sha,
  );
  console.log(`[qa] DEV estable en ${sha}. Generando E2E...`);

  // 2. Generar (+ revisar) los E2E del cambio.
  const result = await runAgent({
    source: "manual",
    task: `Genera tests E2E para los flujos afectados por el commit ${sha}.`,
    repo: app.repo,
    sha,
    metadata: { needsReview: app.qa.needsReview },
  });

  // 3. Ejecutar contra DEV con datos namespaced.
  const ns = testDataNamespace(app.qa.testDataPrefix, sha);
  console.log(`[qa] Ejecutando E2E (namespace ${ns}) contra ${app.dev.baseUrl}...`);
  const run = await runE2E(result, { baseUrl: app.dev.baseUrl, namespace: ns });

  // 4. Reportar.
  if (!run.passed) {
    console.error("[qa] FALLO.");
    if (app.report.onFailure === "github-issue") {
      const issue = await github.openIssue(
        app.repo,
        `QA E2E falló en ${sha}`,
        renderIssue(run, result.note),
      );
      console.error(`[qa] Issue abierto: ${issue.url}`);
    }
    process.exit(1);
  }
  console.log(`[qa] OK — E2E en verde para ${sha}.`);
}

function parseArgs(argv: string[]): { app: string; sha: string } {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, "");
    if (key) out[key] = argv[i + 1] ?? "";
  }
  if (!out.app || !out.sha) {
    console.error("Uso: npm run qa -- --app <app> --sha <sha>");
    process.exit(2);
  }
  return { app: out.app, sha: out.sha };
}

function renderIssue(run: QaRunResult, note?: string): string {
  const failed = run.cases.filter((c) => c.status === "fail");
  const lines = [
    `**SHA:** \`${run.sha}\``,
    note ? `**Nota del revisor:** ${note}` : "",
    "",
    "### Casos fallidos",
    failed.length
      ? failed.map((c) => `- ❌ ${c.name}${c.detail ? ` — ${c.detail}` : ""}`).join("\n")
      : "_(sin detalle de casos)_",
    "",
    "### Logs (sanitizados)",
    "```",
    run.logs,
    "```",
  ];
  return lines.filter((l) => l !== "").join("\n");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
