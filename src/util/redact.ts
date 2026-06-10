// Redacts credentials embedded in command/error strings before they reach
// persistence, HTTP responses, log shippers, or LLM prompts.

const PATTERNS: Array<RegExp> = [
  /x-access-token:[^@\s]+@/g,
  /url\.https:\/\/x-access-token:[^@\s]+@[^\s]*/g,
  /Authorization\s*[:=]\s*Bearer\s+\S+/gi,
];

export function redactSecrets(input: string): string {
  let out = input;
  for (const p of PATTERNS) out = out.replace(p, "[REDACTED_CREDENTIAL]");
  return out;
}

export function redactError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  return redactSecrets(raw);
}
