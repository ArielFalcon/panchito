// Pipeline completo de QA, compartido por TODOS los disparadores (CLI manual y
// webhook). La INFRA determinística vive aquí (gate, espejo, ejecución,
// reporte); la GENERACIÓN agéntica la delega en OpenCode (ver
// integrations/opencode-client.ts + opencode/opencode.json). Los pasos con
// red/efectos se inyectan vía PipelineDeps, de modo que el orden y las ramas
// son verificables con stubs (sin tocar DEV, OpenCode, git ni GitHub).

import { join } from "node:path";
import { AppConfig } from "./orchestrator/config-loader";
import { DeployTarget, waitForDeploy } from "./env/deploy-gate";
import { ensureMirror, getCommitDiff, defaultMirrorDeps } from "./integrations/repo-mirror";
import { runOpencode, defaultOpencodeDeps } from "./integrations/opencode-client";
import { runE2E, defaultExecuteDeps } from "./qa/execute";
import { testDataNamespace } from "./qa/test-data";
import { github } from "./integrations/github";
import { renderIssue } from "./report/reporter";
import { AgentResult, QaRunResult, TriggerSource } from "./types";

// Subdirectorio (relativo al espejo) donde el agente escribe los specs del run.
const SPEC_SUBDIR = ".qa-specs";

export interface GenerateInput {
  repo: string;
  sha: string;
  diff: string;
  mirrorDir: string;
  namespace: string;
  needsReview: boolean;
}

export interface PipelineDeps {
  waitForDeploy(target: DeployTarget, sha: string): Promise<void>;
  prepare(repo: string, sha: string): Promise<{ mirrorDir: string; diff: string }>;
  generate(input: GenerateInput): Promise<AgentResult>;
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
    prepare: async (repo, sha) => {
      const mirrorDir = await ensureMirror(repo, sha, defaultMirrorDeps);
      const diff = await getCommitDiff(mirrorDir, sha, defaultMirrorDeps);
      return { mirrorDir, diff };
    },
    generate: async (input) => {
      const specRelDir = join(SPEC_SUBDIR, input.namespace);
      return runOpencode(
        {
          repo: input.repo,
          sha: input.sha,
          diff: input.diff,
          mirrorDir: input.mirrorDir,
          specRelDir,
          specAbsDir: join(input.mirrorDir, specRelDir),
          namespace: input.namespace,
          needsReview: input.needsReview,
        },
        await defaultOpencodeDeps(),
      );
    },
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

  // 2. Espejo del repo al SHA (cwd del agente) + diff del commit.
  log("[qa] Preparando espejo y diff...");
  const { mirrorDir, diff } = await deps.prepare(app.repo, sha);

  // 3. Generar (+ revisar) los E2E con OpenCode. El agente escribe los specs
  //    en el espejo; recogemos los artefactos resultantes.
  const ns = testDataNamespace(app.qa.testDataPrefix, sha);
  log("[qa] Generando E2E con OpenCode...");
  const result = await deps.generate({
    repo: app.repo,
    sha,
    diff,
    mirrorDir,
    namespace: ns,
    needsReview: app.qa.needsReview,
  });

  // 4. Ejecutar contra DEV con datos namespaced.
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
