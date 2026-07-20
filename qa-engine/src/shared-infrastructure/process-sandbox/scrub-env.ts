// qa-engine/src/shared-infrastructure/process-sandbox/scrub-env.ts
// Builds a scrubbed environment for an UNTRUSTED spawn (the watched repo's own test/install commands,
// or agent-written specs). Drops the orchestrator's secrets, keeps OS + language vars. Moved from
// src/qa/code-runner.ts (1 definition + ~8 import sites) — the canonical home; src/ callers migrate
// in Plan 6. Body is byte-for-byte identical EXCEPT the allowlist base and the signature — see the
// per-trust-domain note below (migration-tier-4b, Slice 1, gate DEFECT-2 fix).
//
// PER-TRUST-DOMAIN ALLOWLIST (DEFECT-2 fix): the BASE set below is the NARROW legacy set from
// src/qa/code-runner.ts's own scrubEnv — it does NOT include CBM_CACHE_DIR. Before this fix this
// module's base carried CBM_CACHE_DIR (needed only by the codebase-memory-spawning consumer), which
// would have SILENTLY WIDENED every migrated code-execution/validate consumer's allowlist the moment
// they re-pointed here. Each caller now widens the base explicitly and only for its own spawns:
// `extraExact` for a caller-specific exact var (codebase-memory-client.ts injects CBM_CACHE_DIR for
// its own spawn only), `extraAllowed` for a prefix family (e2e/setup keep passing /^DEV_/). A caller
// that needs neither passes no options — identical to calling `scrubEnv()` before this change.

// Secret FAMILIES that must never reach untrusted code (prefix match). Defense-in-depth: the allowlist
// is the real gate, but blocking secrets explicitly guards against an allowlist entry widening to one.
const BLOCKED_ENV_PREFIX = /^(?:GITHUB_TOKEN|GH_TOKEN|OPENCODE_API_KEY|WEBHOOK_SECRET|QA_API_TOKEN|DOPPLER_|AWS_|AZURE_|GCP_|GOOGLE_APPLICATION_CREDENTIALS|NPM_TOKEN|NODE_AUTH_TOKEN)/;

// Allowed exact var names (OS + language essentials that are single vars, not families). This is the
// NARROW legacy set (src/qa/code-runner.ts) — no CBM_CACHE_DIR here; see the per-trust-domain note above.
const ALLOWED_ENV_EXACT = new Set([
  "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "TMPDIR", "TEMPDIR", "TMP", "TEMP",
  "NODE_ENV", "CI", "PYTHON", "VIRTUAL_ENV", "GOPATH", "GOROOT", "GOPRIVATE", "GOPROXY",
  "GONOSUMCHECK", "GOFLAGS", "GOCACHE", "JAVA_HOME", "M2_HOME", "M2_REPO", "M2", "NVM_DIR", "NODE_PATH", "NODE_OPTIONS",
  "DISPLAY", "SSH_AUTH_SOCK", "COLORTERM", "NO_COLOR", "FORCE_COLOR", "DEBUG",
  "PKG_CONFIG_PATH", "LD_LIBRARY_PATH", "DYLD_LIBRARY_PATH",
  // Playwright's browsers are baked at a NON-default path in the orchestrator image; without
  // forwarding it the child loses the path and every e2e run fails with "Executable doesn't exist".
  "PLAYWRIGHT_BROWSERS_PATH",
]);

// Allowed var FAMILIES (prefix match — npm/cargo/gradle/maven/locale config the toolchain needs).
const ALLOWED_ENV_PREFIX = /^(?:LC_|npm_config_|PIP_|CGO_|CARGO_|RUSTUP_|RUST_|GRADLE_|MAVEN_|PNPM_|YARN_|COREPACK_)/;

export interface ScrubEnvOptions {
  // A caller-specific EXACT var name to keep, on top of the narrow base — e.g. codebase-memory-
  // client.ts injects CBM_CACHE_DIR for its own spawn only, never widening every other consumer.
  extraExact?: Set<string>;
  // A caller-specific prefix FAMILY to keep, on top of the narrow base — e.g. e2e/setup pass
  // /^DEV_/ so the app's login creds reach the fixtures without widening every other consumer.
  extraAllowed?: RegExp;
}

export function scrubEnv(opts?: ScrubEnvOptions): Record<string, string> {
  const env: Record<string, string> = {};
  const dropped: string[] = [];
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (BLOCKED_ENV_PREFIX.test(key)) continue; // secrets are blocked even if extraAllowed matches
    if (
      ALLOWED_ENV_EXACT.has(key) ||
      ALLOWED_ENV_PREFIX.test(key) ||
      (opts?.extraExact?.has(key) ?? false) ||
      (opts?.extraAllowed?.test(key) ?? false)
    ) {
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
