// Applies operator-provided env vars to the LIVE process env (config expansion reads
// process.env at load time — no restart needed) and persists them to .env so they
// survive a restart. Each var goes on its OWN line with no inline comment: docker
// compose env_file does NOT strip inline comments (a known gotcha — see CLAUDE.md).
// Doppler users must ALSO add the var in Doppler; .env only covers local boots.

import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KEY_RE = /^[A-Z][A-Z0-9_]*$/;

export interface EnvStoreFs {
  read(): string | null;
  write(content: string): void;
}

export function defaultEnvStoreFs(envPath = join(process.env.AI_PIPELINE_ROOT ?? process.cwd(), ".env")): EnvStoreFs {
  return {
    read: () => (existsSync(envPath) ? readFileSync(envPath, "utf8") : null),
    write: (c) => {
      writeFileSync(envPath, c, { encoding: "utf8", mode: 0o600 });
      chmodSync(envPath, 0o600);
    },
  };
}

export function applyEnvVars(
  vars: Record<string, string>,
  opts: { fs: EnvStoreFs; env: Record<string, string | undefined> },
): string[] {
  const entries = Object.entries(vars);
  // Validate EVERYTHING first: a failure must leave no half-applied state.
  for (const [key, value] of entries) {
    if (!KEY_RE.test(key)) throw new Error(`invalid env key (expected [A-Z][A-Z0-9_]*): ${JSON.stringify(key)}`);
    if (/[\r\n]/.test(value)) throw new Error(`env value for ${key} must be a single line`);
  }

  const existing = opts.fs.read() ?? "";
  const lines = existing.length ? existing.split("\n") : [];
  for (const [key, value] of entries) {
    const line = `${key}=${value}`;
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (idx >= 0) lines[idx] = line;
    else {
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      lines.push(line);
    }
  }
  opts.fs.write(lines.join("\n") + "\n");

  for (const [key, value] of entries) opts.env[key] = value;
  return entries.map(([k]) => k);
}
