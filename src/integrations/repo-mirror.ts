// Espejos locales de los repos vigilados. El servicio (permanente) clona/
// actualiza cada repo y hace checkout del SHA, para que codegraph pueda
// calcular el blast radius y para extraer el diff del commit. git/exists se
// inyectan para verificar la lógica sin tocar disco ni red en tests.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export type Git = (args: string[], cwd?: string) => Promise<string>;

export interface MirrorDeps {
  git: Git;
  exists(path: string): boolean;
  root?: string;
}

function mirrorRoot(): string {
  return process.env.MIRROR_DIR ?? join(process.cwd(), ".mirrors");
}

function remoteUrl(repo: string): string {
  const base = process.env.GIT_REMOTE_BASE ?? "https://github.com";
  return `${base}/${repo}.git`;
}

// Auth por cabecera efímera (-c http.extraHeader): NO persiste el token en
// .git/config como sí haría embeberlo en la URL del remoto.
function authArgs(): string[] {
  const token = process.env.GITHUB_TOKEN;
  return token ? ["-c", `http.extraHeader=Authorization: Bearer ${token}`] : [];
}

export async function ensureMirror(repo: string, sha: string, deps: MirrorDeps): Promise<string> {
  const root = deps.root ?? mirrorRoot();
  const dir = join(root, repo.replace("/", "__"));
  if (!deps.exists(dir)) {
    await deps.git([...authArgs(), "clone", remoteUrl(repo), dir]);
  } else {
    await deps.git([...authArgs(), "fetch", "origin"], dir);
  }
  await deps.git(["checkout", sha], dir);
  return dir;
}

// Diff del commit `sha` respecto a su padre (solo el contenido, sin cabecera).
export async function getCommitDiff(dir: string, sha: string, deps: MirrorDeps): Promise<string> {
  return deps.git(["show", "--format=", sha], dir);
}

export const realGit: Git = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.toString()),
    );
  });

export const defaultMirrorDeps: MirrorDeps = { git: realGit, exists: existsSync };
