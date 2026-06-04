// Publicación de los E2E generados como PR (con auto-merge si procede). Es la
// PERSISTENCIA real: la fuente de verdad de los tests es la carpeta `e2e/` DEL
// REPO de la app, versionada en git — no un volumen. Cada run en verde abre un
// PR con lo que el agente escribió/mejoró en `e2e/`; si no tocó nada, no hay PR.
//
// git y las llamadas a GitHub se inyectan → la lógica (skip-sin-cambios, rama,
// auto-merge best-effort) es verificable con stubs; el push/PR real es el borde.

import { Git, realGit, authHeaderArgs } from "./repo-mirror";
import { github, PullRequest } from "./github";

export interface PublishInput {
  repo: string;
  sha: string;
  mirrorDir: string; // espejo del repo (donde vive `e2e/`)
  baseBranch: string;
}

export interface PublishDeps {
  git: Git;
  createPullRequest(repo: string, args: { title: string; head: string; base: string; body: string }): Promise<PullRequest>;
  enableAutoMerge(nodeId: string): Promise<void>;
  log?(msg: string): void;
}

const E2E_DIR = "e2e";

export async function publishE2e(
  input: PublishInput,
  deps: PublishDeps,
): Promise<{ prUrl: string } | null> {
  const { mirrorDir, sha, repo, baseBranch } = input;

  // ¿El agente modificó `e2e/`? Si no, la suite ya cubría el cambio → sin PR.
  const status = await deps.git(["status", "--porcelain", "--", E2E_DIR], mirrorDir);
  if (!status.trim()) {
    deps.log?.("[qa] sin cambios en e2e/ — la suite ya cubre el cambio, no se abre PR.");
    return null;
  }

  const short = sha.slice(0, 7);
  const branch = `qa/e2e-${short}`;
  const name = process.env.GIT_AUTHOR_NAME ?? "ai-pipeline-qa";
  const email = process.env.GIT_AUTHOR_EMAIL ?? "ai-pipeline-qa@users.noreply.github.com";

  await deps.git(["checkout", "-B", branch], mirrorDir);
  await deps.git(["add", "--", E2E_DIR], mirrorDir);
  await deps.git(
    ["-c", `user.name=${name}`, "-c", `user.email=${email}`, "commit", "-m", `test(e2e): QA automatizado para ${short}`],
    mirrorDir,
  );
  await deps.git([...authHeaderArgs(), "push", "--force-with-lease", "-u", "origin", branch], mirrorDir);

  const pr = await deps.createPullRequest(repo, {
    title: `QA E2E para ${short}`,
    head: branch,
    base: baseBranch,
    body: `Tests E2E generados/actualizados por ai-pipeline para \`${sha}\`. Harness en verde (typecheck + lint + ejecución estable contra DEV).`,
  });

  // Auto-merge best-effort: si el repo no lo permite, se deja el PR abierto.
  try {
    await deps.enableAutoMerge(pr.nodeId);
    deps.log?.(`[qa] PR abierto con auto-merge: ${pr.url}`);
  } catch (e) {
    deps.log?.(`[qa] PR abierto (auto-merge no disponible, mergéalo a mano): ${pr.url} — ${String(e)}`);
  }
  return { prUrl: pr.url };
}

export const defaultPublishDeps: PublishDeps = {
  git: realGit,
  createPullRequest: (repo, args) => github.createPullRequest(repo, args),
  enableAutoMerge: (nodeId) => github.enableAutoMerge(nodeId),
  log: (m) => console.log(m),
};
