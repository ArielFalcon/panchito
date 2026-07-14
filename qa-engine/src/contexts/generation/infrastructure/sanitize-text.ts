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
// NOT port `recordAudit` or the `SECRET_AUDIT` diagnostic map — those are pipeline-boundary
// diagnostics (post-mortem only, no caller reads them back into a decision) with no caller in the
// grounding context-assembly path this sub-plan covers. If a future qa-engine slice needs them,
// port them then, at their own call site — do not widen this module's scope speculatively.
//
// migration-tier-4c Slice 5a: `containsSecrets` + `assertNoSecretLeak` ARE now ported (verbatim
// behavior) — exactly the "future qa-engine slice" this header anticipated. Their genuine new call
// site is prompts.ts's `cappedDiffText` (relocated from src/integrations/prompts.ts), which needs
// the post-redaction fail-loud guard at the diff→model boundary. `SecretLeakError` itself needed no
// porting — it already lives in `@kernel/ports/redaction.port.ts`, the SAME canonical class both
// src/orchestrator/sanitizer.ts and this module import (see that shared-kernel file's own header).
//
// sdd/migration-remediation Slice 6 (D-P2, RedactionPort unification): the replacement placeholder
// is imported from THIS module's own shared-kernel sibling (`@kernel/ports/redaction.port.ts`'s
// `REDACTED`, `[REDACTED]`) — the SAME canonical constant src/orchestrator/sanitizer.ts's twin
// implementation now also imports (from its own side of the src/qa-engine boundary; qa-engine
// cannot import src/, so the regex pattern set itself necessarily stays duplicated here — see
// sanitize-text-parity.test.ts, which keeps verifying the two stay behaviorally in lockstep). This
// module also exports `redactionAdapter`, a `RedactionPort`-conforming object, for any future
// qa-engine caller that wants the port abstraction instead of this file's own `sanitizeText` shape.

import { REDACTED, SecretLeakError, type RedactionPort } from "@kernel/ports/redaction.port.ts";

export interface SecretDetection {
  redacted: boolean;
  patterns: string[]; // which named patterns matched
  count: number; // total redactions across all patterns
}

// WS5.4a — two-tier sanitizer policy (PORT, verbatim behavior, of src/orchestrator/sanitizer.ts's own
// mode flag — see that file's header for the full rationale). "issue" (default) is byte-identical to
// this module's behavior before the split; "model" narrows ONLY the api-key-assignment pattern to
// require a quoted literal or a high-entropy bare token, so a diff→model prompt keeps code shapes
// like `password: string` / `token = getToken()` intact instead of redacting them as if they were
// real secret assignments.
export type SanitizeMode = "issue" | "model";

const CODE_KEYWORDS = new Set([
  "string", "number", "boolean", "undefined", "null", "any", "unknown", "never", "void", "object",
  "true", "false",
]);
function looksLikeCallExpression(value: string): boolean {
  return /^[A-Za-z_$][\w$]*(\.[A-Za-z_$][\w$]*)*\(.*\)$/.test(value);
}
function isHighEntropyBareToken(value: string): boolean {
  const trimmed = value.replace(/[;,)]+$/, ""); // strip trailing statement/call punctuation
  if (trimmed.length < 12) return false;
  if (CODE_KEYWORDS.has(trimmed.toLowerCase())) return false;
  if (looksLikeCallExpression(trimmed)) return false;
  if (!/^[A-Za-z0-9_-]+$/.test(trimmed)) return false; // not a bare identifier/token shape at all
  const hasDigit = /[0-9]/.test(trimmed);
  const hasUpper = /[A-Z]/.test(trimmed);
  const hasLower = /[a-z]/.test(trimmed);
  return hasDigit && hasUpper && hasLower;
}
const ASSIGNMENT_VALUE_RE = /[\"']?\s*[:=]\s*(\S+)$/;
function isModelModeSecretValue(match: string): boolean {
  const m = ASSIGNMENT_VALUE_RE.exec(match);
  const value = m?.[1] ?? "";
  if (!value) return false;
  if (/^["'`]/.test(value)) return true; // a quoted literal is the deliberate secret shape
  return isHighEntropyBareToken(value);
}

// Named secret patterns — the regex + a short stable identifier for the audit trail. Order matters:
// more specific patterns run first to avoid subsumption (e.g. Slack webhook URLs are more specific
// than the generic credential pattern). Ported verbatim from sanitizer.ts.
// `modelSkip` (WS5.4a): an ADDITIONAL skip predicate applied ONLY in "model" mode, on top of any
// unconditional `skip` — the two-tier policy's entire surface area.
const NAMED_SECRET_PATTERNS: Array<{ name: string; p: RegExp; skip?: (m: string) => boolean; modelSkip?: (m: string) => boolean }> = [
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
  // modelSkip (WS5.4a): see this file's own header — twin of sanitizer.ts's own modelSkip.
  { name: "api-key-assignment", p: /(?:api[_-]?key|token|secret|password|passwd|pwd)[\"']?\s*[:=]\s*\S+/gi, modelSkip: (m) => !isModelModeSecretValue(m) },
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
    skip: (m) => /^[0-9a-f]+$/i.test(m) || isPathLikeRun(m),
  },
];

// A >=40-char run of [A-Za-z0-9+/=] is ALSO exactly what real CODE looks like — the base64
// alphabet contains "/", so `src/main/java/es/.../CourseApplicationServiceImpl` matched
// base64-secret and was redacted, mangling real paths in diffs sent to the model AND in the
// structural blast-radius signal ("[REDACTED].java"); long Java identifiers
// (`populateCoursesDescriptionMultilingualUseCase`, 45 letters) matched it too. Two code-shaped
// escapes, both requiring no "+"/"=" (code never carries them; base64 blobs usually do):
//   - a PATH: >=3 slashes, every segment 1..80 chars (a genuine base64 blob hits >=3 slashes
//     only by chance — ~2% at 40 chars);
//   - a bare IDENTIFIER: a REAL camelCase/PascalCase shape, capped at 64 chars — NOT any
//     pure-letter run. A genuine identifier is made of real word segments (each >=2 chars, and at
//     least ONE >=3); a uniform-case run (no case transition) has no words at all. A base64 blob
//     with BOTH cases usually yields a 1-char segment at some flip — but NOT always: judgment-day
//     Monte Carlo (2M trials) measured ~3.8% of random pure-letter case-flip strings passing a
//     >=2-only rule, and a PERFECT 2-char alternation (AbCdEf...) passes it deterministically.
//     Hence the additional "some segment >=3" requirement: perfect alternation fails outright,
//     the random escape rate drops to near zero, and every real camelCase/PascalCase identifier
//     still passes (real names always carry a word of >=3 letters — populate/Courses/Description).
// Twin of src/orchestrator/sanitizer.ts's own isPathLikeRun — keep the two in lockstep.
const MAX_IDENTIFIER_LEN = 64;
const CASE_TRANSITION_RE = /[a-z][A-Z]/;
const WORD_SEGMENT_RE = /[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g;
function isIdentifierShape(m: string): boolean {
  if (m.length > MAX_IDENTIFIER_LEN) return false;
  if (/[0-9]/.test(m)) return false; // digits present — a random secret blob commonly carries them;
  // this narrow escape only needs to cover the pure-letter camelCase/PascalCase shape.
  if (!CASE_TRANSITION_RE.test(m)) return false; // uniform case run — no words, not an identifier
  const segments = m.match(WORD_SEGMENT_RE) ?? [];
  return segments.length > 0 && segments.every((s) => s.length >= 2) && segments.some((s) => s.length >= 3);
}
function isPathLikeRun(m: string): boolean {
  if (m.includes("+") || m.includes("=")) return false;
  if (!m.includes("/")) return isIdentifierShape(m);
  const segments = m.split("/");
  if (segments.length < 4) return false;
  return segments.every((s) => s.length >= 1 && s.length <= 80);
}

const INTERNAL_HOST_PATTERNS: RegExp[] = [
  // Private IPv4 ranges (10/8, 192.168/16, 172.16/12)
  /\b(?:10\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})\b/g,
];

// PII: email only. Broader patterns (phone numbers) would wreck diffs/code with
// false positives; an email is distinctive enough to redact safely.
const PII_PATTERNS: RegExp[] = [/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g];

// mode (WS5.4a): see this file's own header — twin of sanitizer.ts's own mode parameter.
export function sanitizeText(input: string, mode: SanitizeMode = "issue"): { text: string; detection: SecretDetection } {
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
  for (const { name, p, skip, modelSkip } of NAMED_SECRET_PATTERNS) {
    let redactions = 0;
    out = out.replace(p, (m) => {
      if (skip?.(m)) return m; // a recognised non-secret (e.g. a git SHA) — leave it intact
      if (mode === "model" && modelSkip?.(m)) return m; // model-mode-only: not a real secret shape
      redactions++;
      return REDACTED;
    });
    if (redactions > 0) {
      matchedPatterns.push(name);
      totalRedactions += redactions;
    }
  }

  // restore data URIs
  out = out.replace(/__SANITIZER_DATAURI_(\d+)__/g, (_, i) => dataUris[Number(i)] ?? "");

  // host / PII
  for (const p of INTERNAL_HOST_PATTERNS) out = out.replace(p, REDACTED);
  for (const p of PII_PATTERNS) out = out.replace(p, REDACTED);

  return {
    text: out,
    detection: {
      redacted: totalRedactions > 0,
      patterns: matchedPatterns,
      count: totalRedactions,
    },
  };
}

// migration-tier-4c Slice 5a: ported verbatim from src/orchestrator/sanitizer.ts's containsSecrets
// (AMENDMENT 1, mode-aware guard fix — mirrors sanitizeText's own skip decision exactly, including
// resetting the module-level /g regexes' lastIndex so repeated calls stay deterministic).
export function containsSecrets(text: string, mode: SanitizeMode = "issue"): boolean {
  if (!text) return false;
  const masked = text.replace(/data:[^;]+;base64,[A-Za-z0-9+/=]+/gi, "");
  for (const { p, skip, modelSkip } of NAMED_SECRET_PATTERNS) {
    p.lastIndex = 0;
    const hasConditionalSkip = Boolean(skip) || (mode === "model" && Boolean(modelSkip));
    if (hasConditionalSkip) {
      const ms = masked.match(p);
      const isRealSecret = (m: string): boolean => !(skip?.(m) ?? false) && !(mode === "model" && modelSkip?.(m));
      if (ms?.some(isRealSecret)) return true;
    } else if (p.test(masked)) {
      return true;
    }
  }
  return false;
}

// migration-tier-4c Slice 5a: ported verbatim from src/orchestrator/sanitizer.ts's assertNoSecretLeak
// — the diff→model boundary's post-redaction fail-loud guard. Runs AFTER sanitizeText/redact has
// already scrubbed the text; if a secret is STILL detectable, that is an invariant violation the
// caller must never launder into a silent send. `SecretLeakError` is the SAME shared-kernel class
// (imported above), so a caller on either side of the src/⇄qa-engine boundary throws/catches the
// identical error type.
export function assertNoSecretLeak(redactedText: string, mode: SanitizeMode, boundary: string): void {
  if (containsSecrets(redactedText, mode)) {
    console.error(`[sanitizer] ${boundary}: a secret survived redaction — refusing to proceed`);
    throw new SecretLeakError(`${boundary}: a secret survived redaction — refusing to proceed`);
  }
}

// sdd/migration-remediation Slice 6 (D-P2, RedactionPort unification): this file's own
// `RedactionPort`-conforming adapter — the "SAME port" (the shared-kernel type, not shared runtime
// code across the src/qa-engine boundary) this module's twin (src/orchestrator/sanitizer.ts's
// RedactionPortAdapter) also implements. `containsSecret` reuses `sanitizeText`'s own detection
// result (the SAME matching pass, not a second independent regex loop) rather than re-porting
// sanitizer.ts's separate `containsSecrets` function — this module's header already documents the
// deliberate decision NOT to widen scope by porting `containsSecrets` speculatively; deriving it
// from `sanitizeText`'s own detection avoids a second copy of the matching logic entirely.
export const redactionAdapter: RedactionPort = {
  redact: (text: string): string => sanitizeText(text).text,
  containsSecret: (text: string): boolean => sanitizeText(text).detection.redacted,
};
