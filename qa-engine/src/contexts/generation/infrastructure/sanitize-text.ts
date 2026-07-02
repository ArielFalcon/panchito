// qa-engine/src/contexts/generation/infrastructure/sanitize-text.ts
// PORT (verbatim behavior) of src/orchestrator/sanitizer.ts's `sanitizeText` — Sub-Plan 7.4b's leaf
// dependency for context-pack.ts's `s()` render helper (redacts secrets/PII from agent-produced
// exploration-brief and DOM text before it enters the prompt — defense in depth for DATA leaving
// the system, same rationale as the legacy header).
//
// DELIBERATELY NARROW SCOPE (mirrors prompt-cap.ts's own scoping decision, which already ported
// capDiff/capText into a SEPARATE module and explicitly deferred sanitizeText/containsSecrets/
// SECRET_AUDIT as "a security boundary concern outside PromptBudgetPort's contract"): this module
// ports ONLY `sanitizeText`, the one function context-pack.ts's renderers actually call. It does
// NOT port `containsSecrets`, `recordAudit`, or the `SECRET_AUDIT` diagnostic map — those are
// pipeline-boundary concerns (Issue-body / diff-to-model gates) with no caller in the grounding
// context-assembly path this sub-plan covers. If a future qa-engine slice needs them, port them
// then, at their own call site — do not widen this module's scope speculatively.

export interface SecretDetection {
  redacted: boolean;
  patterns: string[]; // which named patterns matched
  count: number; // total redactions across all patterns
}

// Named secret patterns — the regex + a short stable identifier for the audit trail. Order matters:
// more specific patterns run first to avoid subsumption (e.g. Slack webhook URLs are more specific
// than the generic credential pattern). Ported verbatim from sanitizer.ts.
const NAMED_SECRET_PATTERNS: Array<{ name: string; p: RegExp; skip?: (m: string) => boolean }> = [
  // Slack webhook URLs — very specific; match before generic URL patterns
  { name: "slack-webhook", p: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g },
  // Stripe keys: sk_/pk_ prefixed, test or live
  { name: "stripe-key", p: /\b(?:sk|pk)_(?:test|live)_[A-Za-z0-9]+\b/g },
  // AWS access key id — AKIA + 16 uppercase alphanumeric
  { name: "aws-access-key", p: /\bAKIA[0-9A-Z]{16}\b/g },
  // GitHub tokens: ghp_, gho_, ghu_, ghs_, ghr_ with 36+ chars
  { name: "github-token", p: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  // GitHub fine-grained tokens: github_pat_ with 36+ chars
  { name: "github-token-fg", p: /\bgithub_pat_[A-Za-z0-9_]{36,}\b/g },
  // LLM-provider keys: OpenAI/Anthropic `sk-...` (sk-proj-…, sk-ant-api03-…). Bare-value
  // form (no adjacent credential keyword), which the assignment patterns below miss. The
  // {20,} body keeps it off short hyphenated identifiers while every real key is far longer.
  { name: "llm-api-key", p: /\bsk-[A-Za-z0-9_-]{20,}\b/g },
  // Slack tokens: xoxb-/xoxp-/xoxa-/xoxr-/xoxs-
  { name: "slack-token", p: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g },
  // Credentials embedded in a connection string / URL: scheme://user:password@host. Match
  // only the user:password span (lookbehind ://, lookahead @) so the host stays readable;
  // requires the inner ':' so a bare scheme://host@ (no password) is left intact.
  { name: "url-credentials", p: /(?<=:\/\/)[^\s:/@]+:[^\s:/@]+(?=@)/g },
  // Bearer tokens leaking in command output (git http.extraHeader, curl -H, etc.)
  { name: "bearer-token", p: /(?:Authorization|auth)\s*[:=]\s*Bearer\s+\S+/gi },
  // JWT: three base64url segments separated by dots
  { name: "jwt", p: /eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g },
  // PEM private key blocks — multi‑line with lazy match
  { name: "private-key-pem", p: /-----BEGIN [A-Z ]+PRIVATE KEY-----[\s\S]+?-----END [A-Z ]+PRIVATE KEY-----/g },
  // API keys in query strings: ?token=xxx, &key=yyy, etc.
  { name: "api-key-query", p: /\b[?&](?:token|key|api_key|api-key|apiKey|secret)=[^&\s]+/gi },
  // Generic credential assignments: credential/auth_token/access_key = value.
  // The [\"']? before the separator handles JSON formatting where a closing quote
  // separates the key from the colon: "password": "hunter2" (previously leaked).
  { name: "generic-credential", p: /(?:credential|auth_token|access_key)[\"']?\s*[:=]\s*\S+/gi },
  // ENV-VAR style credential names (UPPER_SNAKE ending in a credential word), e.g.
  // DEV_TEST_PASS=..., DEV_ENV_PASS=..., GITHUB_TOKEN=..., OPENCODE_API_KEY=... The
  // bare-keyword pattern below misses "PASS"/"KEY" as a suffix, so this covers the
  // system's own env credentials. Case-sensitive (UPPER) to limit false positives.
  { name: "env-credential", p: /\b[A-Z][A-Z0-9_]*(?:PASS|PASSWORD|SECRET|TOKEN|KEY|PWD|CRED|CREDENTIAL)[A-Z0-9_]*[\"']?\s*[:=]\s*\S+/g },
  // api_key/token/secret/password assignments — catch‑all; keep LAST among
  // assignment patterns so the more specific ones fire first.
  { name: "api-key-assignment", p: /(?:api[_-]?key|token|secret|password|passwd|pwd)[\"']?\s*[:=]\s*\S+/gi },
  // base64‑encoded secrets (>40 chars of base64 chars), with data‑URI filter.
  // skip: a run of pure hex is a git SHA / digest (commit ids, lockfile hashes), NOT a
  // secret — redacting it turned the run header's SHA into "[REDACT" (the launcher omits
  // the sha, so the server resolves the full 40‑hex HEAD, which matched this pattern).
  {
    // The negative lookbehinds exclude lockfile INTEGRITY hashes (npm/yarn `sha512-<base64>`,
    // `sha1-`, …): their base64 body is not a secret, and redacting it corrupts the diff the
    // model reads. The skip still drops pure-hex runs (git SHAs / digests).
    name: "base64-secret",
    p: /(?<![A-Za-z0-9+/=])(?<!sha1-)(?<!sha256-)(?<!sha384-)(?<!sha512-)[A-Za-z0-9+/=]{40,}(?![A-Za-z0-9+/=])/g,
    skip: (m) => /^[0-9a-f]+$/i.test(m),
  },
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
  for (const { name, p, skip } of NAMED_SECRET_PATTERNS) {
    let redactions = 0;
    out = out.replace(p, (m) => {
      if (skip?.(m)) return m; // a recognised non-secret (e.g. a git SHA) — leave it intact
      redactions++;
      return "[REDACTED_SECRET]";
    });
    if (redactions > 0) {
      matchedPatterns.push(name);
      totalRedactions += redactions;
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
