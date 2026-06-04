// Pipeline completo de QA, compartido por TODOS los disparadores (CLI manual y
// webhook). Toda la orquestación vive aquí; los pasos con red/efectos se
// inyectan vía PipelineDeps, de modo que el orden y las ramas son verificables
// con stubs (sin tocar DEV, MCP, git ni GitHub).

import { AppConfig } from "./orchestrator/config-loader";
import { DeployTarget, waitForDeploy } from "./env/deploy-gate";
import { ensureMirror, getCommitDiff, defaultMirrorDeps } from "./integrations/repo-mirror";
import { runAgent } from "./orchestrator/agent-core";
import { runE2E, defaultExecuteDeps } from "./qa/execute";
import { testDataNamespace } from "./qa/test-data";
import { github } from "./integrations/github";
import { renderIssue } from "./report/reporter";
import { AgentContext, AgentResult, QaRunResult, TriggerSource } from "./types";

export interface PipelineDeps {
  waitForDeploy(target: DeployTarget, sha: string): Promise<void>;
  prepareDiff(repo: string, sha: string): Promise<string>;
  generate(ctx: AgentContext): Promise<AgentResult>;
  execute(
    result: AgentResult,
    opts: { baseUrl: string; namespace: string },
  ): Promise<QaRunResult>;
  openIssue(repo: string, title: string, body: string): Promise<{ url: string }>;
  log?(msg: string): void;
}

export function defaultPipelineDeps(): PipelineDeps {
  return {
    waitForDeploy: (target, sha) => waitForDeploy(target, sha),
    prepareDiff: async (repo, sha) => {
      const dir = await ensureMirror(repo, sha, defaultMirrorDeps);
      return getCommitDiff(dir, sha, defaultMirrorDeps);
    },
    generate: (ctx) => runAgent(ctx),
    execute: (result, opts) => runE2E(result, opts, defaultExecuteDeps),
    openIssue: (repo, title, body) => github.openIssue(repo, title, body),
    log: (m) => console.log(m),
  };
}

export async function runPipeline(
  app: AppConfig,
  sha: string,
  deps: PipelineDeps,
  source: TriggerSource = "webhook",
): Promise<QaRunResult> {
  const log = deps.log ?? (() => {});
  log(`[qa] App=${app.name}  SHA=${sha}  (${source})`);

  // 1. Gate: esperar a que DEV corra este SHA y esté healthy.
  const target: DeployTarget = {
    name: app.name,
    versionUrl: app.dev.versionUrl,
    pollIntervalMs: app.dev.pollIntervalMs,
    deployTimeoutMs: app.dev.deployTimeoutMs,
  };
  log("[qa] Esperando deploy estable en DEV...");
  await deps.waitForDeploy(target, sha);

  // 2. Espejo del repo al SHA + diff del commit (alimenta el blast radius).
  log("[qa] Preparando espejo y diff...");
  const diff = await deps.prepareDiff(app.repo, sha);

  // 3. Generar (+ revisar) los E2E del cambio.
  log("[qa] Generando E2E...");
  const result = await deps.generate({
    source,
    task: `Genera tests E2E para los flujos afectados por el commit ${sha}.`,
    repo: app.repo,
    sha,
    diff,
    metadata: { needsReview: app.qa.needsReview },
  });

  // 4. Ejecutar contra DEV con datos namespaced.
  const ns = testDataNamespace(app.qa.testDataPrefix, sha);
  log(`[qa] Ejecutando E2E (namespace ${ns}) contra ${app.dev.baseUrl}...`);
  const run = await deps.execute(result, { baseUrl: app.dev.baseUrl, namespace: ns });

  // 5. Reportar: Issue solo si falla; en verde, sin ruido.
  if (!run.passed && app.report.onFailure === "github-issue") {
    const issue = await deps.openIssue(
      app.repo,
      `QA E2E falló en ${sha}`,
      renderIssue(run, result.note),
    );
    log(`[qa] FALLO — Issue abierto: ${issue.url}`);
  } else if (run.passed) {
    log(`[qa] OK — E2E en verde para ${sha}.`);
  }

  return run;
}
