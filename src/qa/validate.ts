// Filtro B del harness: gate estático sobre los specs generados, ANTES de
// gastar un navegador. Revisa "en seco" que los tests:
//   1. compilan (typecheck),
//   2. pasan el linter de Playwright (caza esperas fijas, asserts triviales,
//      element handles, awaits faltantes…),
//   3. cargan en Playwright (`test --list`).
// Si algo falla, los specs son inválidos: la generación fue mala y no tiene
// sentido ejecutarlos. Cada chequeo se inyecta → la orquestación es verificable
// con stubs; los runners reales (que hacen spawn) son el borde no cubierto.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateManifest } from "./metadata";

export interface CheckResult {
  ok: boolean;
  output: string;
}

export interface ValidateDeps {
  typecheck(specDir: string): Promise<CheckResult>;
  lint(specDir: string): Promise<CheckResult>;
  listTests(specDir: string): Promise<CheckResult>;
  checkManifest(specDir: string): Promise<CheckResult>; // metadata estándar válida
}

export interface ValidationResult {
  ok: boolean;
  errors: string[]; // un error por chequeo fallido, con su salida (para el agente)
}

export async function validateSpecs(
  specDir: string,
  deps: ValidateDeps,
): Promise<ValidationResult> {
  // Se corren TODOS (no corta al primero) para devolver feedback completo.
  const checks: Array<[string, (d: string) => Promise<CheckResult>]> = [
    ["typecheck", deps.typecheck],
    ["lint", deps.lint],
    ["list", deps.listTests],
    ["manifest", deps.checkManifest],
  ];
  const errors: string[] = [];
  for (const [name, run] of checks) {
    const res = await run(specDir);
    if (!res.ok) errors.push(`[${name}] ${res.output.trim()}`);
  }
  return { ok: errors.length === 0, errors };
}

// Runners por defecto: ejecutan las herramientas DENTRO del proyecto `e2e/` del
// repo (su propia config/tooling). Requieren tsc/eslint/playwright disponibles
// (deps del propio proyecto e2e, instaladas por el orchestrator antes del gate).
function sh(cmd: string, args: string[], e2eDir: string): Promise<CheckResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: e2eDir, env: { ...process.env } });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => resolve({ ok: false, output: String(e) }));
    child.on("close", (code) => resolve({ ok: code === 0, output: out }));
  });
}

export const defaultValidateDeps: ValidateDeps = {
  typecheck: (e2eDir) => sh("npx", ["tsc", "--noEmit"], e2eDir),
  lint: (e2eDir) => sh("npx", ["eslint", "."], e2eDir),
  listTests: (e2eDir) => sh("npx", ["playwright", "test", "--list"], e2eDir),
  checkManifest: async (e2eDir) => {
    try {
      const raw = JSON.parse(readFileSync(join(e2eDir, ".qa", "manifest.json"), "utf8"));
      const v = validateManifest(raw);
      return { ok: v.ok, output: v.errors.join("\n") };
    } catch (e) {
      return { ok: false, output: `e2e/.qa/manifest.json ilegible o ausente: ${String(e)}` };
    }
  },
};
