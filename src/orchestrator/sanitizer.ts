// Defensa en profundidad para los DATOS que salen del sistema: el output de
// ejecución de los E2E (qa/execute.ts) antes de citarlo en un Issue, y el diff
// antes de mandarlo a OpenCode. Redacta secretos, hosts/IPs internos y PII.
//
// Nota: con los secretos inyectados por Doppler en runtime (no commiteados),
// el código del repo ya viene limpio; este sanitizer cubre el residual —
// datos de DEV que aparezcan en logs y cualquier secreto colado en un diff.

const SECRET_PATTERNS: RegExp[] = [
  /(?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*\S+/gi,
  /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g, // JWT
  /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g,
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g, // GitHub tokens
];

const INTERNAL_HOST_PATTERNS: RegExp[] = [
  // IPv4 privadas (10/8, 192.168/16, 172.16/12)
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
];

// PII: solo email. Patrones más amplios (teléfonos) destrozarían diffs/código
// con falsos positivos; el email es lo bastante distintivo para redactar seguro.
const PII_PATTERNS: RegExp[] = [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g];

export function sanitizeText(input: string): string {
  if (!input) return input;
  let out = input;
  for (const p of SECRET_PATTERNS) out = out.replace(p, "[REDACTED_SECRET]");
  for (const p of INTERNAL_HOST_PATTERNS) out = out.replace(p, "[REDACTED_HOST]");
  for (const p of PII_PATTERNS) out = out.replace(p, "[REDACTED_PII]");
  return out;
}
