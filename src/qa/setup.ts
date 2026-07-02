// Prepares the repo's `e2e/` project to run the harness, BEFORE Filters B/C:
//   1. Bootstrap: if the repo has no `e2e/` project yet (first time), copy the
//      SEED (config/e2e: base Playwright config, fixtures, lint, tsconfig). That
//      scaffold lands in the first PR → from then on the repo owns it.
//   2. Install: install the e2e project's dependencies.
// Disk/process operations are injected, so the logic is verifiable; the real
// copy / `npm ci` are the boundary not covered by unit tests.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scrubEnv } from "./code-runner";
import { killTree } from "./execute";

// Default wall-clock budget for the e2e dependency install. A hung `npm ci` must
// never freeze the sequential queue; on expiry the process TREE is SIGKILLed and
// setup throws — the pipeline surfaces that as infra-error, never a code verdict.
export const DEFAULT_E2E_INSTALL_TIMEOUT_MS = 600_000; // 10 min

// Idempotency marker used by ensureFailureCapture to avoid double-injection.
// The seed config/e2e/fixtures.ts carries this literal; the same string in an
// existing repo's fixtures.ts means the block was already injected.
export const FAILURE_CAPTURE_MARKER = ">>> qa-failure-capture (system-owned: do not edit) >>>";

// Ownership marker used by ensurePlaywrightEnvKeys to recognize an already-onboarded
// repo's e2e/playwright.config.ts as a (possibly older) unmodified copy of the seed —
// see config/e2e/playwright.config.ts's header comment for the full rationale. Unlike
// fixtures.ts (whose repairs are append-only), playwright.config.ts is a single inline
// `export default defineConfig({...})` call: there is no block to append that would
// retroactively mutate the exported object, so the repair here is whole-file replacement,
// gated on this marker so a customized config is never overwritten.
export const PLAYWRIGHT_CONFIG_SEED_MARKER = "qa-playwright-config-seed";

// The managed env-passthrough keys the seed's playwright.config.ts carries. Repos
// onboarded before a key was added to the seed never receive it (bootstrap only runs
// once, on first onboard) — ensurePlaywrightEnvKeys checks for BOTH literal key names
// to decide whether a repair is needed. Kept as a simple substring check (not AST
// parsing — too fragile for a config file the repo may reformat) against the managed
// keys' exact source text in the current seed.
const PLAYWRIGHT_CONFIG_MANAGED_KEYS = ["actionTimeout", "testIdAttribute"] as const;

// The afterEach block injected into existing repos' e2e/fixtures.ts. Not injected
// into new onboards (the seed already carries it). Append-only: prepended newline
// so there is always a blank separator from any agent-written lines above.
// Exported so the test suite can assert it is byte-identical to the seed fixture and
// ESM-safe (no require()), without re-reading the file off disk.
export const FAILURE_CAPTURE_BLOCK = `
// ${FAILURE_CAPTURE_MARKER}
// Captures the aria snapshot of the page at the failure point, the page's final URL, and the HTTP
// status of the most-recent correlated 5xx server error, writing them to QA_FAILURE_CAPTURE_DIR so
// the orchestrator can ground the fix-loop regeneration and surface runtime evidence to the adjudicator
// and reviewer. Best-effort only: the page may be closed on a nav-crash (try/catch swallows), and the
// entire block is a no-op when QA_FAILURE_CAPTURE_DIR is unset.
//
// SELF-CONTAINED: this exact block is also appended (append-only) into existing repos'
// fixtures.ts by the orchestrator, so it CANNOT assume any top-level import is present.
// node:fs/path/crypto are pulled in via dynamic import() INSIDE the async afterEach —
// a CommonJS-style synchronous load is not defined in this native-ESM module
// ("type":"module") and would throw a ReferenceError that the catch would swallow.
let errorResponses = [];
// Feature B (app-defect detection): browser console \`error\`-level entries and uncaught \`pageerror\`
// exceptions observed during the current test. Reset per-test (mirrors errorResponses) so a reused
// page never cross-attributes a PRIOR test's runtime errors to the current one. Best-effort: the
// orchestrator's classifyRuntimeErrors (src/qa/failure-adjudicator.ts) turns this into a diagnostic
// signal ONLY — it never blocks or masks a real generated-test defect (see that module's doc).
let runtimeErrors = [];
test.beforeEach(async ({ page }) => {
  if (!process.env.QA_FAILURE_CAPTURE_DIR) return; // no-op when capture is disabled (zero overhead)
  errorResponses = [];                               // reset unconditionally so reused pages never cross-attribute
  runtimeErrors = [];                                 // Feature B: same per-test reset discipline
  try {
    page.on('response', (r) => {
      try { const s = r.status(); if (s >= 400) errorResponses.push({ url: r.url(), status: s, resourceType: r.request().resourceType() }); } catch {}
    });
  } catch {}
  try {
    page.on('console', (msg) => {
      try {
        if (msg.type() !== 'error') return; // only error-level; warnings/logs are not runtime evidence
        runtimeErrors.push({ type: 'error', text: msg.text() });
      } catch {}
    });
  } catch {}
  try {
    page.on('pageerror', (err) => {
      try { runtimeErrors.push({ type: 'pageerror', text: err.message ?? String(err) }); } catch {}
    });
  } catch {}
});
test.afterEach(async ({ page }, testInfo) => {
  const dir = process.env.QA_FAILURE_CAPTURE_DIR;
  if (!dir) return;                                   // degrade to no-op when the orchestrator did not ask
  if (testInfo.status === testInfo.expectedStatus) return; // only on unexpected status (a real failure)
  try {
    const { writeFileSync } = await import("node:fs");
    const { join, basename } = await import("node:path");
    const { createHash } = await import("node:crypto");
    const yaml = await page.locator("body").ariaSnapshot(); // the REAL post-failure page state
    // title = the describe › test chain (drop the leading project element), MATCHING the stream
    // reporter's _name. The orchestrator's harvest keys off this: the JSON report's case name is
    // \`file › describe › test\`, whose trailing segments equal this title's segments.
    const title = testInfo.titlePath.filter(Boolean).slice(1).join(" › ");
    const project = testInfo.project.name;
    // file = the spec's basename. Two tests with the SAME describe › test chain in DIFFERENT spec
    // files share a title; the file disambiguates them so neither the dump identity nor the harvest
    // match attaches the wrong DOM. Stored in the body AND folded into the filename hash below.
    const file = basename(testInfo.file ?? "");
    // Filename: project + a short hash of file + title + retry. The project keeps two projects
    // (desktop/mobile) running the same spec from clobbering each other; the (file + title) HASH
    // (not an 80-char truncation) keeps two long titles sharing an 80-char prefix — or two same-titled
    // tests in different files — from colliding. The body is authoritative for matching (project/file/
    // title); the filename only guarantees uniqueness + retry.
    const hash = createHash("sha1").update(\`\${file}/\${title}\`).digest("hex").slice(0, 12);
    const safeProject = project.replace(/[^a-z0-9]+/gi, "-").slice(0, 40);
    // D1/D2: compute finalUrl (sync, always available in afterEach) and the attributed httpStatus
    // via the D2 heuristic (5xx-only, resource-type-gated, same-origin correlated, last).
    // (Path-family intentionally omitted: in a SPA the finalUrl is the UI route (e.g. /orders) while
    // the causing 5xx is the API call (e.g. /api/orders) — different path segments — so path-family
    // would drop legitimate API 5xxs; same-origin is the correct, not-too-tight correlation.)
    const finalUrl = page.url();
    let httpStatus = undefined;
    try {
      let finalUrlOrigin = '';
      try { finalUrlOrigin = new URL(finalUrl).origin; } catch {}
      const FOREGROUND = new Set(['document', 'fetch', 'xhr']);
      const BACKGROUND = new Set(['ping', 'beacon', 'image', 'stylesheet', 'font', 'media']);
      const survivors = errorResponses.filter((e) => {
        if (e.status < 500 || e.status > 599) return false; // 5xx only
        if (BACKGROUND.has(e.resourceType)) return false;    // exclude background resource types
        if (!FOREGROUND.has(e.resourceType)) return false;   // keep only foreground interactions
        try {
          const eOrigin = new URL(e.url).origin;
          return eOrigin === finalUrlOrigin;                  // same-origin correlation
        } catch { return false; }
      });
      if (survivors.length > 0) httpStatus = survivors[survivors.length - 1].status; // last survivor
    } catch {}
    // Feature B: dedupe (same type+text pair collapses to one entry — a repeated framework error
    // firing on every change-detection cycle would otherwise flood the dump), cap at ~15 entries
    // (the orchestrator only needs enough to classify, not an exhaustive log), and truncate each
    // entry's text to ~200 chars (the classifier only needs the first line/signature, not a full
    // stack). Best-effort: any failure here still lets the rest of the dump (yaml/finalUrl/httpStatus)
    // write normally.
    let dedupedRuntimeErrors = [];
    try {
      const RUNTIME_ERRORS_CAP = 15;
      const RUNTIME_ERROR_TEXT_CAP = 200;
      const seen = new Set();
      for (const e of runtimeErrors) {
        const text = e.text.length > RUNTIME_ERROR_TEXT_CAP ? e.text.slice(0, RUNTIME_ERROR_TEXT_CAP) : e.text;
        const key = \`\${e.type} \${text}\`;
        if (seen.has(key)) continue;
        seen.add(key);
        dedupedRuntimeErrors.push({ type: e.type, text });
        if (dedupedRuntimeErrors.length >= RUNTIME_ERRORS_CAP) break;
      }
    } catch { dedupedRuntimeErrors = []; }
    writeFileSync(
      join(dir, \`\${safeProject}__\${hash}__\${testInfo.retry}.json\`),
      JSON.stringify({ project, file, title, retry: testInfo.retry, yaml, finalUrl, httpStatus, runtimeErrors: dedupedRuntimeErrors }),
    );
  } catch { /* page may be closed on a nav-crash — best-effort, never fail the run */ }
});
// <<< qa-failure-capture <<<
`;

export interface SetupOptions {
  signal?: AbortSignal; // operator cancel: kills the install tree and throws
  timeoutMs?: number;   // wall-clock budget; defaults to DEFAULT_E2E_INSTALL_TIMEOUT_MS
}

export interface SetupDeps {
  hasProject(e2eDir: string): boolean; // does the e2e project already exist?
  bootstrap(e2eDir: string): void; // copy the seed into the repo
  install(e2eDir: string, opts?: SetupOptions): Promise<void>;
  // Create the `flows/` subdir the parallel fan-out writes into. Injected (not a bare mkdirSync) so
  // the orchestration logic stays unit-testable without touching the real FS. Optional: when absent
  // (older test stubs) the step is skipped; defaultSetupDeps always provides it for production.
  ensureSpecDir?(e2eDir: string): void;
  // Inject the system-owned qa-failure-capture afterEach block into an existing repo's
  // e2e/fixtures.ts (marker-guarded, append-only, idempotent). New onboards get the block
  // from the seed copy already; this only runs for repos that predate this change.
  // Optional: absent stubs skip it; defaultSetupDeps always provides it for production.
  ensureFailureCapture?(e2eDir: string): void;
  // Backfill the managed env-passthrough keys (actionTimeout, testIdAttribute) into an
  // already-onboarded repo's e2e/playwright.config.ts (Task D5). Marker-guarded whole-file
  // replacement (see PLAYWRIGHT_CONFIG_SEED_MARKER doc) — idempotent, never touches a
  // customized config. Optional: absent stubs skip it; defaultSetupDeps always provides it
  // for production.
  ensurePlaywrightEnvKeys?(e2eDir: string): void;
}

export async function setupE2eProject(e2eDir: string, deps: SetupDeps, opts?: SetupOptions): Promise<void> {
  if (!deps.hasProject(e2eDir)) deps.bootstrap(e2eDir); // first time: seed it
  // Guarantee the `flows/` subdir the parallel fan-out writes into. Each worker is assigned
  // `flows/<flow>.spec.ts` (specFileForFlow) and can ONLY `write` (no bash, no mkdir, cheap model);
  // the seed ships no `flows/` dir and a fresh checkout/clean wipes any prior one, so a worker's
  // write to a non-existent subdir fails silently → every spec is a phantom and a complete/exhaustive
  // run generates ZERO tests (observed: 7/7 workers phantom). The deterministic layer must create the
  // dir — the worker cannot. Idempotent; runs on every setup, including the install-cached early return.
  deps.ensureSpecDir?.(e2eDir);
  deps.ensureFailureCapture?.(e2eDir);
  deps.ensurePlaywrightEnvKeys?.(e2eDir);
  if (isInstallCurrent(e2eDir)) {
    console.log("[qa] e2e dependencies up to date; skipping npm ci");
    return;
  }
  if (opts?.signal?.aborted) throw new Error("e2e dependency install aborted by operator cancel");

  // Race the install against a timeout at the orchestration level (defense in depth:
  // the real spawn in defaultSetupDeps also SIGKILLs the tree). On timeout we throw,
  // which the pipeline maps to infra-error — same pattern as setupCodeProject.
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_E2E_INSTALL_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`e2e dependency install timed out after ${timeoutMs}ms — killed`)), timeoutMs);
  });
  try {
    await Promise.race([deps.install(e2eDir, opts), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
  markInstallCurrent(e2eDir);
}

// ── install caching ─────────────────────────────────────────────────────────
// ensureMirror preserves node_modules across runs (git clean -e node_modules),
// but npm ci unconditionally removes and reinstalls them. We skip the install
// when node_modules exists and the lockfile hasn't changed since the last
// successful install — the same intent the -e flag already expresses.
function getLockHash(e2eDir: string): string | null {
  const lockPath = join(e2eDir, "package-lock.json");
  if (!existsSync(lockPath)) return null;
  return createHash("sha256").update(readFileSync(lockPath)).digest("hex");
}

function isInstallCurrent(e2eDir: string): boolean {
  const nodeModules = join(e2eDir, "node_modules");
  const markerPath = join(nodeModules, ".install-hash");
  if (!existsSync(nodeModules) || !existsSync(markerPath)) return false;
  const currentHash = getLockHash(e2eDir);
  if (!currentHash) return false;
  try {
    return readFileSync(markerPath, "utf8").trim() === currentHash;
  } catch {
    return false;
  }
}

function markInstallCurrent(e2eDir: string): void {
  const hash = getLockHash(e2eDir);
  if (!hash) return;
  mkdirSync(join(e2eDir, "node_modules"), { recursive: true });
  writeFileSync(join(e2eDir, "node_modules", ".install-hash"), hash);
}

function seedDir(): string {
  return join(process.env.AI_PIPELINE_ROOT ?? process.cwd(), "config", "e2e");
}

export const defaultSetupDeps: SetupDeps = {
  hasProject: (e2eDir) => existsSync(join(e2eDir, "package.json")),
  ensureSpecDir: (e2eDir) => mkdirSync(join(e2eDir, "flows"), { recursive: true }),
  // Injects the qa-failure-capture afterEach block into an existing repo's e2e/fixtures.ts.
  // Idempotent (marker-guarded): if the block is already present (from the seed OR a prior
  // injection) it is a no-op. Append-only: existing lines are never modified or removed.
  // New onboards get the block from the seed cpSync (config/e2e/fixtures.ts → e2e/fixtures.ts),
  // so this only runs for repos bootstrapped before this change was introduced.
  ensureFailureCapture: (e2eDir) => {
    const path = join(e2eDir, "fixtures.ts");
    if (!existsSync(path)) return; // a fresh onboard gets it from the seed copy already
    const src = readFileSync(path, "utf8");
    if (src.includes(FAILURE_CAPTURE_MARKER)) return; // already present — idempotent no-op
    appendFileSync(path, FAILURE_CAPTURE_BLOCK); // never rewrites existing lines (append-only)
  },
  // Backfills the managed env-passthrough keys into an already-onboarded repo's
  // e2e/playwright.config.ts (Task D5). Repos onboarded before a key was added to the
  // seed only ever get it via bootstrap (which runs once, on first onboard) — this
  // closes that gap for repos that predate the key.
  //
  // Whole-file replacement, not append: playwright.config.ts is a single inline
  // `export default defineConfig({...})` call, so there is no block that can be appended
  // to retroactively mutate the exported object (unlike fixtures.ts). The replacement is
  // gated on PLAYWRIGHT_CONFIG_SEED_MARKER so a customized config is never overwritten —
  // the repo owns its e2e/ after first PR. A missing file is a no-op (a fresh onboard
  // gets the current seed from the bootstrap cpSync already).
  ensurePlaywrightEnvKeys: (e2eDir) => {
    const path = join(e2eDir, "playwright.config.ts");
    if (!existsSync(path)) return; // a fresh onboard gets it from the seed copy already
    const src = readFileSync(path, "utf8");
    const hasAllManagedKeys = PLAYWRIGHT_CONFIG_MANAGED_KEYS.every((key) => src.includes(key));
    if (hasAllManagedKeys) return; // already has every managed key — idempotent no-op
    if (!src.includes(PLAYWRIGHT_CONFIG_SEED_MARKER)) {
      const missing = PLAYWRIGHT_CONFIG_MANAGED_KEYS.filter((key) => !src.includes(key));
      console.warn(
        `[qa] ${path} is missing managed env-passthrough key(s) [${missing.join(", ")}] but carries no ` +
          `seed ownership marker — the config has been customized (or predates the marker), so it will ` +
          `NOT be overwritten. Add the missing key(s) manually if this repo wants them.`,
      );
      return;
    }
    // Recognized as an unmodified (possibly older) copy of the seed: safe to replace wholesale.
    // env-passthrough only — the seed file itself reads process.env at runtime, so this never
    // bakes a concrete value into the repo's config.
    cpSync(join(seedDir(), "playwright.config.ts"), path);
  },
  bootstrap: (e2eDir) =>
    cpSync(seedDir(), e2eDir, {
      recursive: true,
      filter: (src) => !src.includes("node_modules"),
    }),
  install: (e2eDir, opts) =>
    new Promise((resolve, reject) => {
      // `npm ci` when there is a lockfile; otherwise `npm install`.
      const useCi = existsSync(join(e2eDir, "package-lock.json"));
      // The e2e install runs the seed + repo lifecycle scripts: scrub orchestrator secrets.
      // `detached: true` makes the child its own process-group leader so killTree can
      // reap the grandchildren npm forks (lifecycle scripts, node-gyp, ...).
      const child = spawn("npm", [useCi ? "ci" : "install"], { cwd: e2eDir, env: scrubEnv(/^DEV_/), detached: true });
      let settled = false;
      const settle = (err?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (onAbort) opts?.signal?.removeEventListener("abort", onAbort);
        err ? reject(err) : resolve();
      };
      // A hung install must not block the sequential queue: kill the tree and throw
      // (the pipeline surfaces this as infra-error, not a code defect).
      const timeoutMs = opts?.timeoutMs ?? DEFAULT_E2E_INSTALL_TIMEOUT_MS;
      const timer = setTimeout(() => {
        killTree(child);
        settle(new Error(`npm ${useCi ? "ci" : "install"} in e2e timed out after ${timeoutMs}ms — killed`));
      }, timeoutMs);
      const onAbort = opts?.signal
        ? () => {
            killTree(child);
            settle(new Error("e2e dependency install aborted by operator cancel"));
          }
        : undefined;
      if (onAbort) opts!.signal!.addEventListener("abort", onAbort, { once: true });
      child.on("error", (err) => settle(err instanceof Error ? err : new Error(String(err))));
      child.on("close", (code) =>
        settle(code === 0 ? undefined : new Error(`npm ${useCi ? "ci" : "install"} in e2e failed (code ${code})`)),
      );
    }),
};
