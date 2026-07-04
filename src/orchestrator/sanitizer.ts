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
    skip: (m) => /^[0-9a-f]+$/i.test(m) || isPathLikeRun(m),
  },
];

// A >=40-char run of [A-Za-z0-9+/=] is ALSO exactly what real CODE looks like — the base64
// alphabet contains "/", so `src/main/java/es/.../CourseApplicationServiceImpl` matched
// base64-secret and was redacted, mangling real paths in diffs sent to the model AND in the
// structural blast-radius signal ("[REDACTED_SECRET].java"); long Java identifiers
// (`populateCoursesDescriptionMultilingualUseCase`, 46 letters) matched it too. Two code-shaped
// escapes, both requiring no "+"/"=" (code never carries them; base64 blobs usually do):
//   - a PATH: >=3 slashes, every segment 1..80 chars (a genuine base64 blob hits >=3 slashes
//     only by chance — ~2% at 40 chars);
//   - a bare IDENTIFIER: pure letters, no digits (a 40-char base64 blob with zero digits is
//     ~0.02% likely — camelCase class/method names are exactly this shape).
// Slash-bearing secrets in context stay covered by the env/assignment/key-specific rules above.
// Twin of qa-engine/src/contexts/generation/infrastructure/sanitize-text.ts's own isPathLikeRun —
// keep the two in lockstep.
function isPathLikeRun(m: string): boolean {
  if (m.includes("+") || m.includes("=")) return false;
  if (!m.includes("/")) return /^[A-Za-z]+$/.test(m);
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

export function containsSecrets(text: string): boolean {
  if (!text) return false;
  let masked = text.replace(/data:[^;]+;base64,[A-Za-z0-9+/=]+/gi, "");
  for (const { p, skip } of NAMED_SECRET_PATTERNS) {
    // These are module-level /g regexes; .test()/.exec() advance and persist lastIndex,
    // which would make repeated calls alternate — reset so detection is deterministic.
    p.lastIndex = 0;
    if (skip) {
      // Only a non-skipped match counts as a real secret (a git SHA must not trip this).
      const ms = masked.match(p);
      if (ms?.some((m) => !skip(m))) return true;
    } else if (p.test(masked)) {
      return true;
    }
  }
  return false;
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
function extractDiffFilePath(section: string): string {
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
