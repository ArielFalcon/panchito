// Prepara el proyecto `e2e/` del repo para correr el harness, ANTES de los
// Filtros B/C:
//   1. Bootstrap: si el repo aún no tiene `e2e/` (primera vez), copia el SEED
//      (config/e2e: config base de Playwright, fixtures, lint, tsconfig). Ese
//      scaffold entra en el primer PR → a partir de ahí el repo es su dueño.
//   2. Install: instala las deps del proyecto e2e.
// Las operaciones de disco/red se inyectan → la lógica es verificable; el copy/
// `npm ci` reales son el borde no cubierto por unitarios.

import { spawn } from "node:child_process";
import { cpSync, existsSync } from "node:fs";
import { join } from "node:path";

export interface SetupDeps {
  hasManifest(e2eDir: string): boolean; // ¿ya existe el proyecto e2e?
  bootstrap(e2eDir: string): void; // copia el seed dentro del repo
  install(e2eDir: string): Promise<void>;
}

export async function setupE2eProject(e2eDir: string, deps: SetupDeps): Promise<void> {
  if (!deps.hasManifest(e2eDir)) deps.bootstrap(e2eDir); // primera vez: sembrar
  await deps.install(e2eDir);
}

function seedDir(): string {
  return join(process.env.AI_PIPELINE_ROOT ?? process.cwd(), "config", "e2e");
}

export const defaultSetupDeps: SetupDeps = {
  hasManifest: (e2eDir) => existsSync(join(e2eDir, "package.json")),
  bootstrap: (e2eDir) =>
    cpSync(seedDir(), e2eDir, {
      recursive: true,
      filter: (src) => !src.includes("node_modules"),
    }),
  install: (e2eDir) =>
    new Promise((resolve, reject) => {
      // `npm ci` si hay lockfile; si no, `npm install`.
      const useCi = existsSync(join(e2eDir, "package-lock.json"));
      const child = spawn("npm", [useCi ? "ci" : "install"], { cwd: e2eDir, env: { ...process.env } });
      child.on("error", reject);
      child.on("close", (code) =>
        code === 0 ? resolve() : reject(new Error(`npm ${useCi ? "ci" : "install"} en e2e falló (code ${code})`)),
      );
    }),
};
