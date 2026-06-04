// Copia de trabajo local de los repos vigilados. OJO: es de SOLO LECTURA para
// el agente (leer código con Serena, sacar el diff) y de ESCRITURA solo para la
// carpeta `e2e/` (los tests, que se commitean por PR). NUNCA se construye ni se
// levanta la app: el sistema bajo prueba es el entorno DEV. git/exists se
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

function workdirRoot(): string {
  return process.env.MIRROR_DIR ?? join(process.cwd(), ".mirrors");
}

function remoteUrl(repo: string): string {
  const base = process.env.GIT_REMOTE_BASE ?? "https://github.com";
  return `${base}/${repo}.git`;
}

// Auth por cabecera efímera (-c http.extraHeader): NO persiste el token en
// .git/config como sí haría embeberlo en la URL del remoto. Se exporta para que
// el publicador (publish.ts) reuse la misma auth al hacer push.
export function authHeaderArgs(): string[] {
  const token = process.env.GITHUB_TOKEN;
  return token ? ["-c", `http.extraHeader=Authorization: Bearer ${token}`] : [];
}

// Deja la copia de trabajo PRÍSTINA en el SHA. `checkout -f` descarta cambios en
// ficheros trackeados (p. ej. e2e/ tocado por un run previo que no publicó) y
// `clean -fd` borra los no trackeados (specs sobrantes), EXCEPTO node_modules
// para no reinstalar las deps del proyecto e2e en cada run. Sin esto, los runs
// que no publican contaminarían el siguiente (o romperían el checkout).
export async function ensureMirror(repo: string, sha: string, deps: MirrorDeps): Promise<string> {
  const root = deps.root ?? workdirRoot();
  const dir = join(root, repo.replace("/", "__"));
  if (!deps.exists(dir)) {
    await deps.git([...authHeaderArgs(), "clone", remoteUrl(repo), dir]);
  } else {
    await deps.git([...authHeaderArgs(), "fetch", "origin"], dir);
  }
  await deps.git(["checkout", "-f", sha], dir);
  await deps.git(["clean", "-fd", "-e", "node_modules"], dir);
  return dir;
}

// Diff del commit `sha` respecto a su padre (solo el contenido, sin cabecera).
export async function getCommitDiff(dir: string, sha: string, deps: MirrorDeps): Promise<string> {
  return deps.git(["show", "--format=", sha], dir);
}

// Mensaje del commit (subject + body): da la INTENCIÓN para clasificar el cambio.
export async function getCommitMessage(dir: string, sha: string, deps: MirrorDeps): Promise<string> {
  return deps.git(["show", "-s", "--format=%B", sha], dir);
}

export const realGit: Git = (args, cwd) =>
  new Promise((resolve, reject) => {
    execFile("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (err, stdout) =>
      err ? reject(err) : resolve(stdout.toString()),
    );
  });

export const defaultMirrorDeps: MirrorDeps = { git: realGit, exists: existsSync };
