// Defense in depth for DATA leaving the system: the E2E execution output
// (qa/execute.ts) before it is quoted in an Issue, and the diff before it is sent
// to OpenCode. Redacts secrets, internal hosts/IPs and PII. Repo source is
// already clean (secrets are injected at runtime by Doppler, never committed);
// this covers the residual — DEV data that shows up in logs and any secret that
// slips into a diff.
//
// v2: Structured detection with per‑pattern counting, a containsSecrets() gate
// and a SECRET_AUDIT map for post‑mortem analysis. Fail‑closed: if secrets are
// found the caller is warned and the audit is recorded.

export interface SecretDetection {
  redacted: boolean;
  patterns: string[]; // which named patterns matched
  count: number; // total redactions across all patterns
}

// Named secret patterns — the regex + a short stable identifier for the audit
// trail. Order matters: more specific patterns run first to avoid subsumption
// (e.g. Slack webhook URLs are more specific than the generic credential pattern).
const NAMED_SECRET_PATTERNS: Array<{ name: string; p: RegExp }> = [
  // Slack webhook URLs — very specific; match before generic URL patterns
  { name: "slack-webhook", p: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g },
  // Stripe keys: sk_/pk_ prefixed, test or live
  { name: "stripe-key", p: /\b(?:sk|pk)_(?:test|live)_[A-Za-z0-9]+\b/g },
  // AWS access key id — AKIA + 16 uppercase alphanumeric
  { name: "aws-access-key", p: /\bAKIA[0-9A-Z]{16}\b/g },
  // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_ with 36+ chars
  { name: "github-token", p: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  // JWT: three base64url segments separated by dots
  { name: "jwt", p: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  // PEM private key blocks — multi‑line with lazy match
  { name: "private-key-pem", p: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g },
  // API keys in query strings: ?token=xxx, &key=yyy, etc.
  { name: "api-key-query", p: /\b[?&](?:token|key|api_key|api-key|apiKey|secret)=[^&\s]+/gi },
  // Generic credential assignments: credential/auth_token/access_key = value
  { name: "generic-credential", p: /(?:credential|auth_token|access_key)\s*[:=]\s*\S+/gi },
  // ENV-VAR style credential names (UPPER_SNAKE ending in a credential word), e.g.
  // DEV_TEST_PASS=..., DEV_ENV_PASS=..., GITHUB_TOKEN=..., OPENCODE_API_KEY=... The
  // bare-keyword pattern below misses "PASS"/"KEY" as a suffix, so this covers the
  // system's own env credentials. Case-sensitive (UPPER) to limit false positives.
  { name: "env-credential", p: /\b[A-Z][A-Z0-9_]*(?:PASS|PASSWORD|SECRET|TOKEN|KEY|PWD|CRED|CREDENTIAL)[A-Z0-9_]*\s*[:=]\s*\S+/g },
  // api_key/token/secret/password assignments — catch‑all; keep LAST among
  // assignment patterns so the more specific ones fire first
  { name: "api-key-assignment", p: /(?:api[_-]?key|token|secret|password|passwd|pwd)\s*[:=]\s*\S+/gi },
  // base64‑encoded secrets (>40 chars of base64 chars), with data‑URI filter
  { name: "base64-secret", p: /\b[A-Za-z0-9+/=]{40,}\b/g },
];

const INTERNAL_HOST_PATTERNS: RegExp[] = [
  // Private IPv4 ranges (10/8, 192.168/16, 172.16/12)
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
];

// PII: email only. Broader patterns (phone numbers) would wreck diffs/code with
// false positives; an email is distinctive enough to redact safely.
const PII_PATTERNS: RegExp[] = [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g];

export function sanitizeText(input: string): { text: string; detection: SecretDetection } {
  if (!input) return { text: input, detection: { redacted: false, patterns: [], count: 0 } };

  let out = input;
  const matchedPatterns: string[] = [];
  let totalRedactions = 0;

  // pre‑filter: mask data URIs to avoid base64 false positives
  const DATA_URI_RE = /data:[^;]+;base64,[A-Za-z0-9+/=]+/gi;
  const dataUris: string[] = [];
  out = out.replace(DATA_URI_RE, (m) => {
    dataUris.push(m);
    return `__SANITIZER_DATAURI_${dataUris.length - 1}__`;
  });

  // secret patterns
  for (const { name, p } of NAMED_SECRET_PATTERNS) {
    const matches = out.match(p);
    if (matches && matches.length > 0) {
      matchedPatterns.push(name);
      totalRedactions += matches.length;
      out = out.replace(p, "[REDACTED_SECRET]");
    }
  }

  // restore data URIs
  out = out.replace(/__SANITIZER_DATAURI_(\d+)__/g, (_, i) => dataUris[Number(i)] ?? "");

  // host / PII
  for (const p of INTERNAL_HOST_PATTERNS) out = out.replace(p, "[REDACTED_HOST]");
  for (const p of PII_PATTERNS) out = out.replace(p, "[REDACTED_PII]");

  return {
    text: out,
    detection: {
      redacted: totalRedactions > 0,
      patterns: matchedPatterns,
      count: totalRedactions,
    },
  };
}

export function containsSecrets(text: string): boolean {
  if (!text) return false;
  let masked = text.replace(/data:[^;]+;base64,[A-Za-z0-9+/=]+/gi, "");
  for (const { p } of NAMED_SECRET_PATTERNS) {
    if (p.test(masked)) return true;
  }
  return false;
}

export const SECRET_AUDIT = new Map<string, number>();

export function recordAudit(runId: string, detection: SecretDetection): void {
  if (detection.redacted) {
    SECRET_AUDIT.set(runId, detection.count);
  }
}
