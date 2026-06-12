// Redacts credentials embedded in command/error strings before they reach
// persistence, HTTP responses, log shippers, or LLM prompts.

const PLACEHOLDER = "[REDACTED_CREDENTIAL]";

// Structural patterns (catch credentials whose value we may not hold in env,
// e.g. tokens echoed by a watched-repo tool).
const PATTERNS: Array<RegExp> = [
  /x-access-token:[^@\s]+@/g,
  /url\.https:\/\/x-access-token:[^@\s]+@[^\s]*/g,
  /Authorization\s*[:=]\s*Bearer\s+\S+/gi,
  // Known token shapes.
  /\b(?:gh[pousr]_|github_pat_)[A-Za-z0-9_]{10,}\b/g,
  /\bsk-[A-Za-z0-9_-]{10,}\b/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
  // Generic `key=value` / `token: value` assignments (value up to whitespace).
  /\b[A-Za-z0-9_]*(?:api[_-]?key|secret|token|password)\b\s*[:=]\s*["']?[^\s"']{6,}["']?/gi,
];

// Env var names whose VALUE is a secret — redacted verbatim wherever they appear,
// independent of surrounding format. Driven by a name heuristic so new secrets are
// covered without editing a list.
const SECRET_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASS)$/;
const MIN_SECRET_LEN = 6;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function secretValues(env: Record<string, string | undefined>): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= MIN_SECRET_LEN && SECRET_NAME.test(name)) values.push(value);
  }
  // Longest first so a secret that contains another is fully masked.
  return values.sort((a, b) => b.length - a.length);
}

export function redactSecrets(input: string, env: Record<string, string | undefined> = process.env): string {
  let out = input;
  for (const value of secretValues(env)) {
    if (out.includes(value)) out = out.split(value).join(PLACEHOLDER);
  }
  for (const p of PATTERNS) out = out.replace(p, PLACEHOLDER);
  return out;
}

export function redactError(err: unknown, env: Record<string, string | undefined> = process.env): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactSecrets(raw, env);
}
