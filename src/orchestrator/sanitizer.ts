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
//
// sdd/migration-remediation Slice 6 (D-P2, RedactionPort unification): the replacement placeholder
// is imported from qa-engine's shared-kernel redaction.port.ts (`REDACTED`, `[REDACTED]`) — the ONE
// canonical placeholder for every egress-path redaction. This file previously hardcoded THREE
// divergent placeholders ([REDACTED_SECRET]/[REDACTED_HOST]/[REDACTED_PII]); collapsed to one, per
// the port's own contract. `src/util/redact.ts`'s `[REDACTED_CREDENTIAL]` is a DIFFERENT mechanism
// (env-value-driven shell-layer scrubbing) and is explicitly OUT of scope — see the spec's Phase 2
// follow-up requirement.
import { REDACTED, SecretLeakError, type RedactionPort } from "../../qa-engine/src/shared-kernel/ports/redaction.port";

// Re-exported so src/ callers (prompts.ts, opencode-client.ts) import it from this module alongside
// sanitizeText/containsSecrets, matching the design's own placement — see SecretLeakError's own doc
// (qa-engine/src/shared-kernel/ports/redaction.port.ts) for why it is DEFINED in the shared kernel.
export { SecretLeakError };

export interface SecretDetection {
  redacted: boolean;
  patterns: string[]; // which named patterns matched
  count: number; // total redactions across all patterns
}

// WS5.4a — two-tier sanitizer policy. Model-bound and public-bound (Issue) surfaces have different
// threat models: an Issue body is the system's most public output (maximum scrubbing is correct
// there), but the SAME aggressive `api-key-assignment` catch-all also fires on ordinary CODE shapes
// that carry no secret at all — a type annotation (`password: string`) or a bare call expression
// (`token = getToken()`) — on the diff→model path, which is exactly the auth-flow code whose
// behavior most needs testing. "issue" (default) preserves today's aggressive behavior byte-for-byte
// (every existing caller is unaffected); "model" narrows ONLY the api-key-assignment pattern to
// require the value side be a quoted string literal or a high-entropy bare token.
export type SanitizeMode = "issue" | "model";

// A bare (unquoted) value is "high-entropy" enough to treat as a real secret in "model" mode when it
// looks nothing like ordinary code: mixed case AND at least one digit, length >= 12, and not one of
// the common type/literal keywords a type annotation or default value would use. This deliberately
// does NOT try to be a general-purpose entropy estimator — it only needs to separate "getToken()"/
// "string"/"undefined" (code) from "aZ9kP2mQ7xR4tL6vB8nH1cJ3s" (a real-looking secret blob).
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
// The model-mode replacer for the api-key-assignment pattern: only redact when the captured value
// (everything after the `key`/`token`/`password`=... separator) is a quoted literal or a high-entropy
// bare token — never a type annotation or a bare call expression. Re-parses the match instead of
// widening the regex itself, so the aggressive "issue" pattern stays untouched (single shared pattern
// object below; only the skip/keep decision differs by mode).
const ASSIGNMENT_VALUE_RE = /[\"']?\s*[:=]\s*(\S+)$/;
function isModelModeSecretValue(match: string): boolean {
  const m = ASSIGNMENT_VALUE_RE.exec(match);
  const value = m?.[1] ?? "";
  if (!value) return false;
  if (/^["'`]/.test(value)) return true; // a quoted literal is the deliberate secret shape
  return isHighEntropyBareToken(value);
}

// Named secret patterns — the regex + a short stable identifier for the audit
// trail. Order matters: more specific patterns run first to avoid subsumption
// (e.g. Slack webhook URLs are more specific than the generic credential pattern).
// `modelSkip`, when present, is an ADDITIONAL skip predicate applied ONLY in "model" mode (on top of
// any unconditional `skip`) — the two-tier policy's entire surface area.
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
  // modelSkip (WS5.4a): in "model" mode, skip a match whose value side is NOT a quoted literal or a
  // high-entropy bare token — e.g. `password: string` (type annotation) or `token = getToken()` (call
  // expression). In "issue" mode (default) this pattern behaves exactly as before (no modelSkip check).
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
// Slash-bearing secrets in context stay covered by the env/assignment/key-specific rules above.
// Twin of qa-engine/src/contexts/generation/infrastructure/sanitize-text.ts's own isPathLikeRun —
// keep the two in lockstep.
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

// mode (WS5.4a): "issue" (default) is the aggressive, public-surface (Issue-bound) policy — byte-
// identical to this function's behavior before the two-tier split, so every existing caller (logs →
// Issue, and every caller that predates this change) is unaffected. "model" is the diff→model path:
// narrower on api-key-assignment only (see isModelModeSecretValue), unchanged on every other pattern.
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

// AMENDMENT 1 (migration-wiring-phase-2 Slice 6a, mode-aware guard fix): as originally shipped this
// function destructured only `{ p, skip }` and never consulted `modelSkip` at all — every call
// behaved like "issue" mode regardless of what boundary it guarded. That re-applied the aggressive
// issue-mode api-key-assignment pattern to model-mode-sanitized text: `sanitizeText("secret: string",
// "model")` correctly leaves a type annotation untouched (modelSkip, by design), but the old
// `containsSecrets()` then flagged it anyway — a false positive on ordinary auth-shaped code (this
// repo's own src/server/auth.ts carries these exact shapes, and runs code-mode QA on itself). Now
// mode-aware: mirrors sanitizeText's own skip decision exactly — `mode` defaults to "issue" so every
// pre-existing caller (execute.ts:274, code-runner.ts:638, RedactionPortAdapter.containsSecret) is
// byte-identical; only an explicit "model" mode additionally consults modelSkip, the SAME two-tier
// policy sanitizeText already implements.
export function containsSecrets(text: string, mode: SanitizeMode = "issue"): boolean {
  if (!text) return false;
  const masked = text.replace(/data:[^;]+;base64,[A-Za-z0-9+/=]+/gi, "");
  for (const { p, skip, modelSkip } of NAMED_SECRET_PATTERNS) {
    // These are module-level /g regexes; .test()/.exec() advance and persist lastIndex,
    // which would make repeated calls alternate — reset so detection is deterministic.
    p.lastIndex = 0;
    const hasConditionalSkip = Boolean(skip) || (mode === "model" && Boolean(modelSkip));
    if (hasConditionalSkip) {
      // Only a match that neither `skip` (a recognised non-secret, e.g. a git SHA) nor, in "model"
      // mode, `modelSkip` (an ordinary code shape — a type annotation, a bare call expression)
      // excuses counts as a real secret.
      const ms = masked.match(p);
      const isRealSecret = (m: string): boolean => !(skip?.(m) ?? false) && !(mode === "model" && modelSkip?.(m));
      if (ms?.some(isRealSecret)) return true;
    } else if (p.test(masked)) {
      return true;
    }
  }
  return false;
}

// diff→model boundary (Slice 6b): the post-redaction fail-loud guard. Runs AFTER sanitizeText/redact
// has already scrubbed the text; if a secret is STILL detectable, that is an invariant violation the
// caller must never launder into a silent send — throw loudly rather than proceed. `boundary` is a
// short label for the error message only (e.g. "diff→model"), so the two egress boundaries (this
// one, and logs→Issue's own local mirror in publication-port.adapter.ts — qa-engine cannot import
// this function, see SecretLeakError's own doc) produce distinguishable, greppable failures.
export function assertNoSecretLeak(redactedText: string, mode: SanitizeMode, boundary: string): void {
  if (containsSecrets(redactedText, mode)) {
    console.error(`[sanitizer] ${boundary}: a secret survived redaction — refusing to proceed`);
    throw new SecretLeakError(`${boundary}: a secret survived redaction — refusing to proceed`);
  }
}

export const SECRET_AUDIT = new Map<string, number>();
// The audit map is an in-memory diagnostic that nothing reads back into a decision, so it must
// not grow without bound over a long-lived process. Cap it and evict in insertion order.
export const SECRET_AUDIT_MAX = 500;

export function recordAudit(runId: string, detection: SecretDetection): void {
  if (detection.redacted) {
    SECRET_AUDIT.set(runId, detection.count);
    while (SECRET_AUDIT.size > SECRET_AUDIT_MAX) {
      const oldest = SECRET_AUDIT.keys().next().value;
      if (oldest === undefined) break;
      SECRET_AUDIT.delete(oldest);
    }
  }
}

// sdd/migration-wiring-phase-2 Slice 7a (D-D a, env-value GAIN): env-driven verbatim secret-VALUE
// detection, ported from src/util/redact.ts's secretValues() — the oracle this slice closes the gap
// against. Kept OUT of the pure sanitizeText/containsSecrets functions (many callers invoke those
// directly and rely on their byte-for-byte pattern-only contract, unaffected by env); env is
// injected ONLY at this adapter boundary — this module is the ONE seam permitted to import
// process.env for redaction, so qa-engine (which never constructs this class itself) stays
// env-agnostic. Same NAME heuristic and length floor as redact.ts's secretValues, so nothing
// redact.ts already caught is lost when a consumer migrates (spec's "no detection class lost").
const ENV_SECRET_NAME = /(?:KEY|TOKEN|SECRET|PASSWORD|PASS)$/;
const MIN_ENV_SECRET_LEN = 6;

function envSecretValues(env: Record<string, string | undefined>): string[] {
  const values: string[] = [];
  for (const [name, value] of Object.entries(env)) {
    if (value && value.length >= MIN_ENV_SECRET_LEN && ENV_SECRET_NAME.test(name)) values.push(value);
  }
  // Longest first so a secret value that is itself a substring of another is fully masked.
  return values.sort((a, b) => b.length - a.length);
}

function stripEnvValues(text: string, env: Record<string, string | undefined>): string {
  let out = text;
  for (const value of envSecretValues(env)) {
    if (out.includes(value)) out = out.split(value).join(REDACTED);
  }
  return out;
}

// sdd/migration-remediation Slice 6 (D-P2, RedactionPort unification): the formal port adapter for
// the two egress boundaries (diff → model, logs → Issue). Wraps this module's own sanitizeText/
// containsSecrets ("issue" mode — the aggressive, public-surface policy every existing caller of
// this class expects) so the composition root (src/server/rewritten-engine-factory.ts) can inject
// ONE canonical collaborator instead of an ad hoc `(text) => sanitizeText(text).text` lambda.
// Callers that need the diff→model "model"-mode narrowing keep calling `sanitizeText(text, "model")`
// directly — this adapter's `redact` always uses the default "issue" mode, matching what
// PublicationPortAdapter.sanitize (the logs→Issue boundary) has always used.
//
// sdd/migration-wiring-phase-2 Slice 7 (D-D): the ctor now accepts an injectable `env` (defaults to
// `process.env`, so every pre-existing call site — e.g. `new RedactionPortAdapter()` in
// rewritten-engine-factory.ts — is unaffected). `redact()` = env-value-strip(text, this.env) THEN
// pattern-sanitizeText, per the design's explicit ordering. `redactText`/`redactError` are NEW
// adapter-level convenience methods (env+pattern) for the shell consumers migrating off
// src/util/redact.ts's `redactSecrets`/`redactError` (Slice 7b/7c) — same call shape, one canonical
// mechanism, `[REDACTED]` placeholder instead of `[REDACTED_CREDENTIAL]`.
export class RedactionPortAdapter implements RedactionPort {
  constructor(private readonly env: Record<string, string | undefined> = process.env) {}

  redact(text: string): string {
    return sanitizeText(stripEnvValues(text, this.env)).text;
  }

  // Alias for redact() with a name that mirrors redact.ts's old `redactSecrets` — shell consumers
  // migrating in Slice 7b/7c swap `redactSecrets(text, env)` for `redactionPort.redactText(text)`
  // with no other call-site restructuring (env is now bound at construction, not per-call).
  redactText(text: string): string {
    return this.redact(text);
  }

  // Mirrors redact.ts's old `redactError`: unwraps an Error's message (or stringifies any other
  // thrown value) before running the same env+pattern redaction as redact()/redactText().
  redactError(err: unknown): string {
    const raw = err instanceof Error ? err.message : String(err);
    return this.redact(raw);
  }

  containsSecret(text: string): boolean {
    return containsSecrets(text);
  }
}

// ── Diff prompt budget ───────────────────────────────────────────────────────
// The commit diff is the one LLM input with no natural size bound (a lockfile or merge
// commit can reach megabytes) and it is embedded in up to ~6 prompts per run (generate,
// plan, review rounds, retry, coverage-enforce). Cap it ONCE at the pipeline boundary:
// keep whole per-file sections in RELEVANCE ORDER until the budget is spent, then replace
// the rest with the list of omitted files. The agent always has the full diff available
// in its working copy (`git show <sha>`), so nothing is lost — only the prompt is bounded.
// Local consumers (the classifier, parseDiffHunks, change-coverage) keep using the raw diff.
//
// Slice G — relevance ordering (P9): changed-source hunks first; lockfiles, generated
// files, and binary/snapshot artifacts last (or omitted). This ensures that when the diff
// exceeds the cap, the agent always sees the changed application code, not lock-file noise
// that happened to sort first alphabetically. The same relevance-ordered form is fed to
// the generator, the reviewer, and change-coverage so coverage cannot demand lines the
// agent never saw (the unsatisfiable-coverage-gap).
export const MAX_PROMPT_DIFF_CHARS = 50_000;

// File patterns that classify a diff section as low-relevance (sorted last / omitted first
// when the budget is tight). A section matching ANY of these is low-relevance.
const LOW_RELEVANCE_PATTERNS = [
  // Lockfiles (npm, yarn, pnpm, pip, cargo, go, composer, poetry, gemfile)
  /^(package-lock|yarn\.lock|pnpm-lock|Pipfile\.lock|Cargo\.lock|go\.sum|composer\.lock|poetry\.lock|Gemfile\.lock)$/i,
  // Generated files (conventional suffixes / directory names)
  /\.(generated|gen|pb|pb\.go|pb_grpc\.go|swagger\.json|openapi\.json|openapi\.yaml)$/i,
  /\bgenerated?\b/i,
  // Snapshot / inline-snapshot test files
  /\.snap$/i,
  // Binary + media assets
  /\.(png|jpg|jpeg|gif|ico|svg|woff|woff2|ttf|eot|pdf|zip|tar|gz)$/i,
  // Build artefacts and caches
  /\/(dist|build|\.cache|__pycache__|\.next|\.nuxt|\.out|target)\/[^/]+\.(js|css|map|ts)$/i,
  // Source-map files
  /\.map$/i,
  // Changelog and migration artefacts
  /^(CHANGELOG|CHANGES|HISTORY)\.(md|txt)$/i,
];

function isLowRelevance(filePath: string): boolean {
  const basename = filePath.split("/").pop() ?? filePath;
  return LOW_RELEVANCE_PATTERNS.some((p) => p.test(filePath) || p.test(basename));
}

// Extracts the file path from a "diff --git a/... b/..." header line.
// Exported (judgment-day FIX 1) so prompts.ts's cappedDiffText can key its per-section sanitize
// MODE (issue vs. model) off the same target path capDiff itself already parses out — one shared
// extraction, no duplicated regex.
export function extractDiffFilePath(section: string): string {
  // "diff --git a/src/foo.ts b/src/foo.ts" — take the b/ path (post-rename destination)
  const m = /^diff --git a\/\S+ b\/(\S+)/m.exec(section);
  return m?.[1] ?? "";
}

export function capDiff(diff: string, maxChars: number = MAX_PROMPT_DIFF_CHARS): string {
  if (diff.length <= maxChars) return diff;
  // Split into per-file sections; the leading chunk (before the first header) stays first.
  const rawSections = diff.split(/^(?=diff --git )/m);

  // Relevance-order: high-relevance (changed source) first, low-relevance last.
  // Stable sort preserves the original file order within each group.
  const preamble = rawSections[0] ?? "";
  const fileSections = rawSections.slice(1);
  const highRelevance: string[] = [];
  const lowRelevance: string[] = [];
  for (const s of fileSections) {
    const filePath = extractDiffFilePath(s);
    if (isLowRelevance(filePath)) {
      lowRelevance.push(s);
    } else {
      highRelevance.push(s);
    }
  }
  // Ordered: preamble + high-relevance sections + low-relevance sections.
  const ordered = [preamble, ...highRelevance, ...lowRelevance];

  const kept: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const section of ordered) {
    if (omitted.length === 0 && used + section.length <= maxChars) {
      kept.push(section);
      used += section.length;
    } else {
      if (section === preamble) continue; // preamble has no file header to name
      const file = extractDiffFilePath(section) || (/^diff --git a\/(\S+)/.exec(section)?.[1] ?? "(unnamed section)");
      omitted.push(file);
    }
  }
  // Degenerate single-section overflow (one giant file): hard-truncate the first section.
  if (kept.filter((s) => s !== preamble).length === 0 && fileSections.length > 0) {
    const firstFile = highRelevance[0] ?? lowRelevance[0] ?? fileSections[0]!;
    kept.push(firstFile.slice(0, maxChars));
    const name = extractDiffFilePath(firstFile);
    omitted.splice(omitted.indexOf(name), 1);
  }
  return (
    kept.join("") +
    `\n[diff truncated for the prompt: ${omitted.length} file(s) omitted (${diff.length} chars total).` +
    ` Omitted: ${omitted.join(", ")}.` +
    ` Read the full change in the working copy with \`git show <sha>\`.]\n`
  );
}

export const MAX_PROMPT_BODY_CHARS = 4_000;

// Caps free-form prose (e.g. a commit body) before it enters a prompt. Unlike capDiff there is no
// per-file structure to preserve, so a single hard slice with a visible marker is correct. The
// commit body is fully attacker-influenceable (any contributor writes it) and, unlike the first
// line, has no natural length bound — so it MUST be capped before reaching the agent, exactly as
// the diff is. Local consumers keep the raw text; only the prompt is bounded.
export function capText(text: string, maxChars: number = MAX_PROMPT_BODY_CHARS): string {
  if (text.length <= maxChars) return text;
  return (
    text.slice(0, maxChars) +
    `\n[…body truncated: ${text.length - maxChars} more chars; read the full message with \`git show <sha>\`.]`
  );
}
