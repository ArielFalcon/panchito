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

export interface CheckResult {
  ok: boolean;
  output: string;
}

export interface ValidateDeps {
  typecheck(specDir: string): Promise<CheckResult>;
  lint(specDir: string): Promise<CheckResult>;
  listTests(specDir: string): Promise<CheckResult>;
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
  ];
  const errors: string[] = [];
  for (const [name, run] of checks) {
    const res = await run(specDir);
    if (!res.ok) errors.push(`[${name}] ${res.output.trim()}`);
  }
  return { ok: errors.length === 0, errors };
}

// Runners por defecto: ejecutan las herramientas en el proyecto e2e
// (config/e2e), apuntando al dir de specs del run. Requieren tsc/eslint/
// playwright disponibles en el entorno (imagen del orchestrator).
function sh(cmd: string, args: string[], specDir: string): Promise<CheckResult> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, {
      cwd: process.env.E2E_PROJECT_DIR ?? "config/e2e",
      env: { ...process.env, PW_SPEC_DIR: specDir },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => resolve({ ok: false, output: String(e) }));
    child.on("close", (code) => resolve({ ok: code === 0, output: out }));
  });
}

export const defaultValidateDeps: ValidateDeps = {
  typecheck: (specDir) => sh("npx", ["tsc", "--noEmit", "-p", "tsconfig.json"], specDir),
  lint: (specDir) => sh("npx", ["eslint", specDir], specDir),
  listTests: (specDir) => sh("npx", ["playwright", "test", "--list"], specDir),
};
