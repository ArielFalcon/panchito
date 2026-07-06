// qa-engine/src/shared-infrastructure/process-sandbox/scrub-env.ts
// Builds a scrubbed environment for an UNTRUSTED spawn (the watched repo's own test/install commands,
// or agent-written specs). Drops the orchestrator's secrets, keeps OS + language vars. Moved from
// src/qa/code-runner.ts (1 definition + ~8 import sites) — the canonical home; src/ callers migrate
// in Plan 6. Body is byte-for-byte identical so the move is behavior-preserving.

// Secret FAMILIES that must never reach untrusted code (prefix match). Defense-in-depth: the allowlist
// is the real gate, but blocking secrets explicitly guards against an allowlist entry widening to one.
const BLOCKED_ENV_PREFIX = /^(?:GITHUB_TOKEN|GH_TOKEN|OPENCODE_API_KEY|WEBHOOK_SECRET|QA_API_TOKEN|DOPPLER_|AWS_|AZURE_|GCP_|GOOGLE_APPLICATION_CREDENTIALS|NPM_TOKEN|NODE_AUTH_TOKEN)/;

// Allowed exact var names (OS + language essentials that are single vars, not families).
const ALLOWED_ENV_EXACT = new Set([
  "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "TMPDIR", "TEMPDIR", "TMP", "TEMP",
  "NODE_ENV", "CI", "PYTHON", "VIRTUAL_ENV", "GOPATH", "GOROOT", "GOPRIVATE", "GOPROXY",
  "GONOSUMCHECK", "GOFLAGS", "GOCACHE", "JAVA_HOME", "M2_HOME", "M2_REPO", "M2", "NVM_DIR", "NODE_PATH", "NODE_OPTIONS",
  "DISPLAY", "SSH_AUTH_SOCK", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "DEBUG",
  "PKG_CONFIG_PATH", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH",
  // Playwright's browsers are baked at a NON-default path in the orchestrator image; without
  // forwarding it the child loses the path and every e2e run fails with "Executable doesn't exist".
  "PLAYWRIGHT_BROWSERS_PATH",
  // codebase-memory's graph-store location. The docker volume mounts exactly here; dropping the
  // var would silently point the CLI at an unmounted container-FS default and kill persistence.
  // A cache path, not a secret — same forwarding rationale as PLAYWRIGHT_BROWSERS_PATH.
  "CBM_CACHE_DIR",
]);

// Allowed var FAMILIES (prefix match — npm/cargo/gradle/maven/locale config the toolchain needs).
const ALLOWED_ENV_PREFIX = /^(?:LC_|npm_config_|PIP_|CGO_|CARGO_|RUSTUP_|RUST_|GRADLE_|MAVEN_|PNPM_|YARN_|COREPACK_)/;

export function scrubEnv(extraAllowed?: RegExp): Record<string, string> {
  const env: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (BLOCKED_ENV_PREFIX.test(key)) continue; // secrets are blocked even if extraAllowed matches
    if (ALLOWED_ENV_EXACT.has(key) || ALLOWED_ENV_PREFIX.test(key) || (extraAllowed?.test(key) ?? false)) {
      env[key] = value;
    } else {
      dropped.push(key);
    }
  }
  if (dropped.length > 0) {
    console.warn(`[qa] scrubEnv dropped ${dropped.length} env var(s) not in allowlist: ${dropped.join(", ")}`);
  }
  return env;
}
