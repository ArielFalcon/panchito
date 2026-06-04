// Pipeline completo de QA, compartido por TODOS los disparadores (CLI manual y
// webhook). La INFRA determinística vive aquí (gate, espejo, persistencia,
// validación, ejecución, reporte); la GENERACIÓN agéntica la delega en OpenCode
// (ver integrations/opencode-client.ts + opencode/opencode.json). Los pasos con
// red/efectos se inyectan vía PipelineDeps, de modo que el orden y las ramas son
// verificables con stubs (sin tocar DEV, OpenCode, git ni GitHub).

import { join } from "node:path";
import { AppConfig } from "./orchestrator/config-loader";
import { DeployTarget, waitForDeploy } from "./env/deploy-gate";
import { ensureMirror, getCommitDiff, defaultMirrorDeps } from "./integrations/repo-mirror";
import { runOpencode, defaultOpencodeDeps } from "./integrations/opencode-client";
import { saveArtifacts } from "./qa/store";
import { validateSpecs, defaultValidateDeps } from "./qa/validate";
import { runE2E, defaultExecuteDeps } from "./qa/execute";
import { testDataNamespace } from "./qa/test-data";
import { github } from "./integrations/github";
import { renderIssue } from "./report/reporter";
import { AgentResult, Artifact, QaRunResult, TriggerSource } from "./types";

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
  persist(artifacts: Artifact[], namespace: string): Promise<string>; // → specDir
  validate(specDir: string): Promise<{ ok: boolean; errors: string[] }>;
  execute(
    specDir: string,
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
    persist: async (artifacts, namespace) => (await saveArtifacts(artifacts, namespace)).dir,
    validate: (specDir) => validateSpecs(specDir, defaultValidateDeps),
    execute: (specDir, opts) => runE2E(specDir, opts, defaultExecuteDeps),
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

  // 3. Generar (+ revisar) los E2E con OpenCode; persistirlos (suite de regresión).
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
  const specDir = await deps.persist(result.artifacts, ns);

  // 4. Filtro B — gate estático: compilan, pasan lint y cargan. Si no, los
  //    specs son inválidos: no se ejecutan y se reporta para revisión.
  log("[qa] Validando specs (typecheck + lint + list)...");
  const validation = await deps.validate(specDir);
  if (!validation.ok) {
    const invalid: QaRunResult = {
      sha: ns,
      verdict: "invalid",
      passed: false,
      cases: [],
      logs: validation.errors.join("\n\n"),
    };
    await maybeReport(app, sha, invalid, deps, log, "los E2E generados no superaron el gate estático");
    return invalid;
  }

  // 5. Filtro C — ejecutar contra DEV con datos namespaced (clasifica pass/fail/flaky).
  log(`[qa] Ejecutando E2E (namespace ${ns}) contra ${app.dev.baseUrl}...`);
  const run = await deps.execute(specDir, { baseUrl: app.dev.baseUrl, namespace: ns });

  // 6. Reportar según veredicto.
  await maybeReport(app, sha, run, deps, log, result.note);
  return run;
}

// Política de reporte: Issue solo para fallo real o specs inválidos. Los flaky
// van a cuarentena (log, sin Issue de fallo); en verde, sin ruido.
async function maybeReport(
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
      log(`[qa] FLAKY — ${flakyNames(run)} en cuarentena (sin Issue de fallo).`);
      break;
    case "pass":
      log(`[qa] OK — E2E en verde para ${sha}.`);
      break;
  }
}

function flakyNames(run: QaRunResult): string {
  return run.cases
    .filter((c) => c.status === "flaky")
    .map((c) => c.name)
    .join(", ");
}
