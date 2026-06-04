// Pipeline completo de QA, compartido por TODOS los disparadores (CLI manual y
// webhook). La INFRA determinística vive aquí (gate, espejo, harness, publicación
// y reporte); la GENERACIÓN agéntica la delega en OpenCode (ver
// integrations/opencode-client.ts + opencode/opencode.json). La fuente de verdad
// de los tests es la carpeta `e2e/` DEL REPO (git), no un volumen. Los pasos con
// red/efectos se inyectan vía PipelineDeps → orden y ramas verificables con stubs.

import { join } from "node:path";
import { AppConfig } from "./orchestrator/config-loader";
import { DeployTarget, waitForDeploy } from "./env/deploy-gate";
import { ensureMirror, getCommitDiff, defaultMirrorDeps } from "./integrations/repo-mirror";
import { runOpencode, defaultOpencodeDeps } from "./integrations/opencode-client";
import { setupE2eProject, defaultSetupDeps } from "./qa/setup";
import { validateSpecs, defaultValidateDeps } from "./qa/validate";
import { runE2E, defaultExecuteDeps } from "./qa/execute";
import { publishE2e, defaultPublishDeps } from "./integrations/publish";
import { testDataNamespace } from "./qa/test-data";
import { github } from "./integrations/github";
import { renderIssue } from "./report/reporter";
import { AgentResult, QaRunResult, TriggerSource } from "./types";

// Carpeta de tests dentro del repo (fuente de verdad, versionada en git).
const E2E_DIR = "e2e";

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
  setupE2e(e2eDir: string): Promise<void>; // instala deps del proyecto e2e
  validate(e2eDir: string): Promise<{ ok: boolean; errors: string[] }>;
  execute(e2eDir: string, opts: { baseUrl: string; namespace: string }): Promise<QaRunResult>;
  publish(input: { repo: string; sha: string; mirrorDir: string; baseBranch: string }): Promise<{ prUrl: string } | null>;
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
    generate: async (input) =>
      runOpencode(
        {
          repo: input.repo,
          sha: input.sha,
          diff: input.diff,
          mirrorDir: input.mirrorDir,
          e2eRelDir: E2E_DIR,
          namespace: input.namespace,
          needsReview: input.needsReview,
        },
        await defaultOpencodeDeps(),
      ),
    setupE2e: (e2eDir) => setupE2eProject(e2eDir, defaultSetupDeps),
    validate: (e2eDir) => validateSpecs(e2eDir, defaultValidateDeps),
    execute: (e2eDir, opts) => runE2E(e2eDir, opts, defaultExecuteDeps),
    publish: (input) => publishE2e(input, defaultPublishDeps),
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

  // 2. Espejo del repo al SHA (cwd del agente y donde vive `e2e/`) + diff.
  log("[qa] Preparando espejo y diff...");
  const { mirrorDir, diff } = await deps.prepare(app.repo, sha);
  const e2eDir = join(mirrorDir, E2E_DIR);

  // 3. Generar (+ revisar) los E2E con OpenCode: el agente escribe/mejora `e2e/`.
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

  // 4. Filtro B — gate estático sobre `e2e/` (instala deps + typecheck/lint/list).
  await deps.setupE2e(e2eDir);
  log("[qa] Validando specs (typecheck + lint + list)...");
  const validation = await deps.validate(e2eDir);
  if (!validation.ok) {
    const invalid: QaRunResult = {
      sha: ns,
      verdict: "invalid",
      passed: false,
      cases: [],
      logs: validation.errors.join("\n\n"),
    };
    await report(app, sha, invalid, deps, log, "los E2E generados no superaron el gate estático");
    return invalid;
  }

  // 5. Filtro C — ejecutar contra DEV (clasifica pass/fail/flaky).
  log(`[qa] Ejecutando E2E (namespace ${ns}) contra ${app.dev.baseUrl}...`);
  const run = await deps.execute(e2eDir, { baseUrl: app.dev.baseUrl, namespace: ns });

  // 6. Verde → publicar como PR (auto-merge si el repo lo permite). Fallo/inválido
  //    → Issue. Flaky → cuarentena (sin PR ni Issue de fallo).
  if (run.verdict === "pass") {
    const pr = await deps.publish({ repo: app.repo, sha, mirrorDir, baseBranch: app.baseBranch ?? "main" });
    if (pr) log(`[qa] OK — E2E en verde; PR de la suite: ${pr.prUrl}`);
    else log(`[qa] OK — E2E en verde (sin cambios en e2e/).`);
  } else {
    await report(app, sha, run, deps, log, result.note);
  }
  return run;
}

// Issue solo para fallo real o specs inválidos. Los flaky van a cuarentena.
async function report(
  app: AppConfig,
  sha: string,
  run: QaRunResult,
  deps: PipelineDeps,
  log: (m: string) => void,
  note?: string,
): Promise<void> {
  if (app.report.onFailure !== "github-issue") return;
  switch (run.verdict) {
    case "fail": {
      const issue = await deps.openIssue(app.repo, `QA E2E falló en ${sha}`, renderIssue(run, note));
      log(`[qa] FALLO — Issue abierto: ${issue.url}`);
      break;
    }
    case "invalid": {
      const issue = await deps.openIssue(
        app.repo,
        `QA no pudo validar los E2E generados en ${sha}`,
        renderIssue(run, note),
      );
      log(`[qa] INVÁLIDO — Issue abierto: ${issue.url}`);
      break;
    }
    case "flaky":
      log(`[qa] FLAKY — ${flakyNames(run)} en cuarentena (sin PR ni Issue de fallo).`);
      break;
  }
}

function flakyNames(run: QaRunResult): string {
  return run.cases.filter((c) => c.status === "flaky").map((c) => c.name).join(", ");
}
