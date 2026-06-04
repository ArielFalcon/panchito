// Defensa en profundidad. NINGUNA ruta al LLM lo evita. Redacta secretos,
// hosts/IPs internos y PII antes de que cualquier fracción salga hacia el
// modelo (externo, en US). Se aplica tanto al contexto de entrada como a
// toda fracción ensamblada en el mensaje y a lo que se realimenta.

import { AgentContext } from "../types";

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
const PII_PATTERNS: RegExp[] = [
  /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g,
];

export function sanitizeText(input: string): string {
  if (!input) return input;
  let out = input;
  for (const p of SECRET_PATTERNS) out = out.replace(p, "[REDACTED_SECRET]");
  for (const p of INTERNAL_HOST_PATTERNS) out = out.replace(p, "[REDACTED_HOST]");
  for (const p of PII_PATTERNS) out = out.replace(p, "[REDACTED_PII]");
  return out;
}

export function sanitize(ctx: AgentContext): AgentContext {
  if (!ctx.diff) return ctx;
  return { ...ctx, diff: sanitizeText(ctx.diff) };
}
