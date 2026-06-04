// Pipeline completo de QA, compartido por TODOS los disparadores (CLI manual y
// webhook). La INFRA determinística vive aquí (gate, espejo, harness, publicación
// y reporte); la GENERACIÓN agéntica la delega en OpenCode (ver
// integrations/opencode-client.ts + opencode/opencode.json). La fuente de verdad
// de los tests es la carpeta `e2e/` DEL REPO (git), no un volumen. Los pasos con
// red/efectos se inyectan vía PipelineDeps → orden y ramas verificables con stubs.

import { join } from "node:path";
import { AppConfig } from "./orchestrator/config-loader";
import { DeployTarget, waitForDeploy } from "./env/deploy-gate";
import { ensureMirror, getCommitDiff, getCommitMessage, defaultMirrorDeps } from "./integrations/repo-mirror";
import { runOpencode, defaultOpencodeDeps } from "./integrations/opencode-client";
import { classifyCommit, CommitIntent } from "./qa/commit-classify";
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
  intent: CommitIntent; // tipo + mensaje + ficheros → el agente define el objetivo
}

export interface PipelineDeps {
  waitForDeploy(target: DeployTarget, sha: string): Promise<void>;
  prepare(repo: string, sha: string): Promise<{ mirrorDir: string; diff: string; message: string }>;
  generate(input: GenerateInput): Promise<AgentResult>;
  setupE2e(e2eDir: string): Promise<void>; // instala deps del proyecto e2e
  validate(e2eDir: string): Promise<{ ok: boolean; errors: string[] }>;
  execute(e2eDir: string, opts: { baseUrl: string; namespace: string }): Promise<QaRunResult>;
  isHealthy(versionUrl: string): Promise<boolean>; // ¿DEV sano AHORA? (infra vs calidad)
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
      const message = await getCommitMessage(mirrorDir, sha, defaultMirrorDeps);
      return { mirrorDir, diff, message };
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
          intent: input.intent,
        },
        await defaultOpencodeDeps(),
      ),
    setupE2e: (e2eDir) => setupE2eProject(e2eDir, defaultSetupDeps),
    validate: (e2eDir) => validateSpecs(e2eDir, defaultValidateDeps),
    execute: (e2eDir, opts) => runE2E(e2eDir, opts, defaultExecuteDeps),
    isHealthy: async (versionUrl) => {
      try {
        const res = await fetch(versionUrl);
        if (!res.ok) return false;
        return ((await res.json()) as { healthy?: boolean }).healthy === true;
      } catch {
        return false;
      }
    },
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
  const shadow = app.qa.shadow ?? false;
  log(`[qa] App=${app.name}  SHA=${sha}  (${source})${shadow ? "  [MODO SOMBRA]" : ""}`);

  // 1. Gate: esperar a que DEV corra este SHA y esté healthy.
  const target: DeployTarget = {
    name: app.name,
    versionUrl: app.dev.versionUrl,
    pollIntervalMs: app.dev.pollIntervalMs,
    deployTimeoutMs: app.dev.deployTimeoutMs,
  };
  log("[qa] Esperando deploy estable en DEV...");
  await deps.waitForDeploy(target, sha);

  // 2. Espejo del repo al SHA (cwd del agente y donde vive `e2e/`) + diff + mensaje.
  log("[qa] Preparando espejo y diff...");
  const { mirrorDir, diff, message } = await deps.prepare(app.repo, sha);
  const e2eDir = join(mirrorDir, E2E_DIR);
  const ns = testDataNamespace(app.qa.testDataPrefix, sha);

  // 3. Clasificar el commit (Conventional Commits, contrastado con el diff).
  //    skip → no hay nada que probar. regression → no se generan tests nuevos,
  //    solo se confirma que los existentes siguen verdes. generate → flujo completo.
  const cls = classifyCommit(message, diff);
  log(`[qa] Commit '${cls.type}' → ${cls.action}${cls.contradiction ? " (contradicción mensaje/diff)" : ""}: ${cls.reason}`);
  if (cls.action === "skip") {
    log(`[qa] Sin objetivo testeable (${cls.type}); no se ejecuta.`);
    return { sha: ns, verdict: "skipped", passed: true, cases: [], logs: cls.reason };
  }
  const generating = cls.action === "generate";

  // 4. Generar (solo si procede): el agente escribe/mejora `e2e/`.
  let result: AgentResult | null = null;
  if (generating) {
    log("[qa] Generando E2E con OpenCode...");
    result = await deps.generate({
      repo: app.repo,
      sha,
      diff,
      mirrorDir,
      namespace: ns,
      needsReview: app.qa.needsReview,
      intent: cls,
    });
  } else {
    log("[qa] Regresión: no se generan tests; se valida y ejecuta la suite existente.");
  }

  // 5. Filtro B — gate estático sobre `e2e/` (instala deps + typecheck/lint/list/manifest).
  await deps.setupE2e(e2eDir);
  log("[qa] Validando specs (typecheck + lint + list)...");
  const validation = await deps.validate(e2eDir);
  if (!validation.ok) {
    const invalid = infraOrResult(ns, "invalid", validation.errors.join("\n\n"));
    await report(app, sha, invalid, deps, log, shadow, "los E2E generados no superaron el gate estático");
    return invalid;
  }

  // 5. Pre-flight de salud: DEV pudo caerse durante la generación. Si no está
  //    sano, el run no es concluyente → infra, NO se reporta como bug.
  if (!(await deps.isHealthy(app.dev.versionUrl))) {
    const infra = infraOrResult(ns, "infra-error", "DEV no está sano antes de ejecutar");
    await report(app, sha, infra, deps, log, shadow);
    return infra;
  }

  // 6. Filtro C — ejecutar contra DEV (clasifica pass/fail/flaky).
  log(`[qa] Ejecutando E2E (namespace ${ns}) contra ${app.dev.baseUrl}...`);
  let run = await deps.execute(e2eDir, { baseUrl: app.dev.baseUrl, namespace: ns });

  // 7. Infra vs calidad: si hubo fallos PERO DEV ya no está sano, los fallos son
  //    de infraestructura, no del código → reclasifica para no abrir Issue falso.
  if (run.verdict === "fail" && !(await deps.isHealthy(app.dev.versionUrl))) {
    run = infraOrResult(ns, "infra-error", "fallos con DEV no saludable: tratado como infraestructura");
  }

  // 8. Decisión final.
  if (run.verdict !== "pass") {
    await report(app, sha, run, deps, log, shadow, result?.note);
  } else if (!generating) {
    // Regresión en verde: no hay tests nuevos que publicar.
    log(`[qa] OK — regresión en verde para ${sha}.`);
  } else if (app.qa.needsReview && !result!.approved) {
    // Verde en el harness PERO el revisor independiente no aprobó (caza falsos
    // positivos que el harness no ve) → NO se publica; se reporta para iteración.
    await issueOrShadow(
      shadow,
      deps,
      log,
      app.repo,
      `QA: el revisor no aprobó los E2E en ${sha}`,
      renderIssue(run, result!.note),
    );
  } else if (shadow) {
    log(`[qa] (sombra) E2E en verde; habría abierto PR de la suite.`);
  } else {
    const pr = await deps.publish({ repo: app.repo, sha, mirrorDir, baseBranch: app.baseBranch ?? "main" });
    log(pr ? `[qa] OK — E2E en verde; PR de la suite: ${pr.prUrl}` : `[qa] OK — E2E en verde (sin cambios en e2e/).`);
  }
  return run;
}

function infraOrResult(ns: string, verdict: QaRunResult["verdict"], logs: string): QaRunResult {
  return { sha: ns, verdict, passed: false, cases: [], logs };
}

// Issue solo para fallo real o specs inválidos. Flaky → cuarentena. Infra → log.
// En modo sombra nunca se abren Issues.
async function report(
  app: AppConfig,
  sha: string,
  run: QaRunResult,
  deps: PipelineDeps,
  log: (m: string) => void,
  shadow: boolean,
  note?: string,
): Promise<void> {
  if (app.report.onFailure !== "github-issue") return;
  switch (run.verdict) {
    case "fail":
      await issueOrShadow(shadow, deps, log, app.repo, `QA E2E falló en ${sha}`, renderIssue(run, note));
      break;
    case "invalid":
      await issueOrShadow(shadow, deps, log, app.repo, `QA no pudo validar los E2E generados en ${sha}`, renderIssue(run, note));
      break;
    case "infra-error":
      log(`[qa] INFRA — ${run.logs} — no se reporta como bug.`);
      break;
    case "flaky":
      log(`[qa] FLAKY — ${flakyNames(run)} en cuarentena (sin PR ni Issue de fallo).`);
      break;
  }
}

async function issueOrShadow(
  shadow: boolean,
  deps: PipelineDeps,
  log: (m: string) => void,
  repo: string,
  title: string,
  body: string,
): Promise<void> {
  if (shadow) {
    log(`[qa] (sombra) habría abierto Issue: "${title}"`);
    return;
  }
  const issue = await deps.openIssue(repo, title, body);
  log(`[qa] Issue abierto: ${issue.url}`);
}

function flakyNames(run: QaRunResult): string {
  return run.cases.filter((c) => c.status === "flaky").map((c) => c.name).join(", ");
}
