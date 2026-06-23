// Shared toolbox (Filter A). Every spec imports `test`/`expect` and the helpers
// from here instead of starting from scratch. It standardizes login, namespaced
// data, cleanup and the app's own capabilities (geolocation, mobile/offline,
// cookies/cache, photo upload).
//
// Hybrid model: the skeleton is shared (this file); the app-specific parts (the
// real Keycloak login selectors, etc.) are filled in by the agent and persisted
// in git. For the "how" of each capability, see the `playwright-authoring` skill.

import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// system-owned: do not edit. A V8 coverage entry plus its (best-effort) source map. The
// orchestrator uses `map` to translate covered bundle bytes back to original source files.
interface CoverageEntry {
  url?: string;
  source?: string;
  map?: unknown;
}

// system-owned: do not edit. For each script, parse its `//# sourceMappingURL=` and attach the
// resolved source map (inline data-URI decoded; external .map fetched from DEV). Best-effort: any
// failure leaves `map` unset and the orchestrator falls back to URL-suffix resolution.
async function attachSourceMaps(entries: CoverageEntry[]): Promise<void> {
  for (const e of entries) {
    if (!e.source || !e.url) continue;
    // The LAST sourceMappingURL comment wins (source-map spec): a minified bundle can inline an
    // earlier library chunk's own `//# sourceMappingURL=` in a string, which must not be mistaken
    // for the bundle's real (trailing) map reference.
    const all = e.source.match(/\/\/[#@]\s*sourceMappingURL=(\S+)/g);
    if (!all || all.length === 0) continue;
    const ref = /sourceMappingURL=(\S+)/.exec(all[all.length - 1]!)![1]!;
    try {
      if (ref.startsWith("data:")) {
        const comma = ref.indexOf(",");
        const meta = ref.slice(5, comma);
        const data = ref.slice(comma + 1);
        const json = meta.includes("base64") ? Buffer.from(data, "base64").toString("utf8") : decodeURIComponent(data);
        e.map = JSON.parse(json);
      } else {
        const mapUrl = new URL(ref, e.url).toString();
        const res = await fetch(mapUrl);
        if (res.ok) e.map = await res.json();
      }
    } catch {
      /* best-effort: no map → URL-suffix fallback */
    }
  }
}

export interface QaFixtures {
  namespace: string; // PER-ATTEMPT data prefix `qa-bot-<sha>-w<worker>r<retry>` (use to NAME/find created
                     // entities). The run-level BASE is `process.env.PW_NAMESPACE` (no -wXrY) — match by THAT
                     // for cleanup/teardown so all workers' and retries' data is covered.
  authenticate: () => Promise<void>; // the app's real login (Keycloak)
  cleanup: (undo: () => Promise<void>) => void; // registers undo steps (LIFO, automatic)
  // system-owned: do not edit — the orchestrator reads these dumps for change-coverage.
  _coverage: void;
  // system-owned: do not edit — the orchestrator's response-oracle pass (QA_FAULT_INJECT).
  _faultInject: void;
}

export const test = base.extend<QaFixtures>({
  namespace: async ({}, use, testInfo) => {
    const base = process.env.PW_NAMESPACE ?? "qa-bot-local";
    // Per-ATTEMPT uniqueness, not just per-run. A data-creating test that retries (Playwright
    // retry) or runs across parallel workers must NOT reuse the same namespace: on a DEV app with
    // no delete affordance, each attempt creates a duplicate entity with an IDENTICAL name, so a
    // later `getByRole("link", { name })` matches multiple rows → strict-mode violation — and the
    // retry trips over the collision it itself just created. Folding in worker + retry makes every
    // attempt's data unique while keeping the run prefix (`base`) intact for orphan cleanup/coverage.
    await use(`${base}-w${testInfo.workerIndex}r${testInfo.retry}`);
  },

  // App login via Keycloak: pressing login redirects to the Keycloak domain
  // (outside the app), the username/password are entered, and it returns.
  // ADJUST the marked selectors to the app's real login. For PUBLIC pages, simply
  // do not call authenticate(). Recommended optimization (see skill): do it once
  // and cache storageState.
  authenticate: async ({ page }, use) => {
    await use(async () => {
      const user = process.env.DEV_TEST_USER;
      const pass = process.env.DEV_TEST_PASS;
      if (!user || !pass) {
        // No creds configured → treat the app as PUBLIC and skip login (no-op). A public app
        // (e.g. PetClinic) needs no auth; throwing here would fail every spec that defensively
        // calls authenticate(). Set DEV_TEST_USER/PASS only if the app actually requires Keycloak login.
        console.warn("[qa] authenticate(): DEV_TEST_USER/PASS not set — app treated as PUBLIC, skipping login.");
        return;
      }
      await page.goto("/");
      await page.getByRole("link", { name: /log ?in|sign ?in/i }).click(); // ADJUST to the real button
      // Now on the Keycloak domain (a different origin):
      await page.locator("#username").fill(user); // standard Keycloak selectors
      await page.locator("#password").fill(pass);
      await page.locator("#kc-login, [type=submit]").first().click();
      await page.waitForURL((url) => !/\/(auth|realms)\//.test(url.pathname)); // back in the app
    });
  },

  // Automatic cleanup (LIFO, best-effort): each test registers how to undo what it
  // creates, so namespaced data does not accumulate on DEV.
  cleanup: [
    async ({}, use) => {
      const undos: Array<() => Promise<void>> = [];
      await use((undo) => undos.push(undo));
      for (const undo of undos.reverse()) {
        try {
          await undo();
        } catch (e) {
          console.error("[cleanup] failed to undo test data:", e);
        }
      }
    },
    { auto: true },
  ],

  // system-owned: do not edit. Collects V8 JS coverage (Chromium) per test and dumps it to
  // .qa/coverage/, which the orchestrator intersects with the diff for change-coverage. Best
  // effort: a no-op on non-Chromium browsers or when coverage is disabled (PW_COVERAGE=0); never
  // fails a test. Disabled automatically during the cleanup-only pass (PW_CLEANUP).
  _coverage: [
    async ({ page }, use, testInfo) => {
      const enabled = process.env.PW_COVERAGE !== "0" && !process.env.PW_CLEANUP && !!page.coverage;
      if (enabled) {
        try {
          await page.coverage.startJSCoverage({ resetOnNavigation: false });
        } catch {
          /* unsupported → skip */
        }
      }
      await use();
      if (enabled) {
        try {
          const entries = await page.coverage.stopJSCoverage();
          // Attach each script's SOURCE MAP so the orchestrator can map covered BUNDLE bytes back
          // to original source files+lines. Without this, a hashed/bundled deploy (Angular/React
          // prod) is permanently "unknown" — the served URL never matches a repo path. Best-effort:
          // a missing map just falls back to URL-suffix resolution (unbundled/dev).
          await attachSourceMaps(entries as unknown as CoverageEntry[]);
          // Per-namespace subdir (qa-bot-<sha>): the orchestrator reads only this run's dumps.
          const dir = join(process.cwd(), ".qa", "coverage", process.env.PW_NAMESPACE ?? "local");
          mkdirSync(dir, { recursive: true });
          const safe = testInfo.titlePath.join("-").replace(/[^a-z0-9]+/gi, "-").slice(0, 60);
          writeFileSync(join(dir, `${safe}-${testInfo.workerIndex}-${testInfo.repeatEachIndex}.json`), JSON.stringify(entries));
        } catch {
          /* best effort — coverage is a signal, never a blocker */
        }
      }
    },
    { auto: true },
  ],

  // system-owned: do not edit. The orchestrator's RESPONSE-ORACLE pass sets QA_FAULT_INJECT=1 and
  // re-runs the green suite with corrupted JSON response VALUES (numbers/booleans flipped; status,
  // shape, strings/ids preserved so auth and refs survive). A spec that stays green under corrupted
  // data has a weak oracle (it would accept a backend regression). No-op in a normal run.
  // It also dumps how many responses were ACTUALLY corrupted to .qa/fault-injection/<ns>/, so the
  // orchestrator can tell "no JSON API surface to corrupt" (oracle not applicable → no score)
  // apart from "corruption happened and the suite stayed green" (score 0 — a weak oracle).
  _faultInject: [
    async ({ page }, use) => {
      let corrupted = 0;
      if (process.env.QA_FAULT_INJECT === "1") {
        await page.route("**", async (route) => {
          const type = route.request().resourceType();
          if (type !== "xhr" && type !== "fetch") return route.continue();
          let res;
          try {
            res = await route.fetch();
          } catch {
            return route.continue();
          }
          const ct = res.headers()["content-type"] ?? "";
          if (!ct.includes("json")) return route.fulfill({ response: res });
          let body: unknown;
          try {
            body = await res.json();
          } catch {
            return route.fulfill({ response: res });
          }
          corrupted++;
          return route.fulfill({ response: res, json: corruptValues(body) });
        });
      }
      await use();
      if (corrupted > 0) {
        try {
          const dir = join(process.cwd(), ".qa", "fault-injection", process.env.PW_NAMESPACE ?? "local");
          mkdirSync(dir, { recursive: true });
          writeFileSync(join(dir, `injected-${process.pid}.json`), JSON.stringify({ corrupted }));
        } catch {
          /* best effort — the marker is a signal, never a test failure */
        }
      }
    },
    { auto: true },
  ],
});

export { expect };

// >>> qa-failure-capture (system-owned: do not edit) >>>
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
let errorResponses: { url: string; status: number; resourceType: string }[] = [];
test.beforeEach(async ({ page }) => {
  if (!process.env.QA_FAILURE_CAPTURE_DIR) return; // no-op when capture is disabled (zero overhead)
  errorResponses = [];                               // reset unconditionally so reused pages never cross-attribute
  try {
    page.on('response', (r) => {
      try { const s = r.status(); if (s >= 400) errorResponses.push({ url: r.url(), status: s, resourceType: r.request().resourceType() }); } catch {}
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
    // `file › describe › test`, whose trailing segments equal this title's segments.
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
    const hash = createHash("sha1").update(`${file}/${title}`).digest("hex").slice(0, 12);
    const safeProject = project.replace(/[^a-z0-9]+/gi, "-").slice(0, 40);
    // D1/D2: compute finalUrl (sync, always available in afterEach) and the attributed httpStatus
    // via the D2 heuristic (5xx-only, resource-type-gated, same-origin correlated, last).
    // (Path-family intentionally omitted: in a SPA the finalUrl is the UI route (e.g. /orders) while
    // the causing 5xx is the API call (e.g. /api/orders) — different path segments — so path-family
    // would drop legitimate API 5xxs; same-origin is the correct, not-too-tight correlation.)
    const finalUrl = page.url();
    let httpStatus: number | undefined;
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
      if (survivors.length > 0) httpStatus = survivors[survivors.length - 1]!.status; // last survivor
    } catch {}
    writeFileSync(
      join(dir, `${safeProject}__${hash}__${testInfo.retry}.json`),
      JSON.stringify({ project, file, title, retry: testInfo.retry, yaml, finalUrl, httpStatus }),
    );
  } catch { /* page may be closed on a nav-crash — best-effort, never fail the run */ }
});
// <<< qa-failure-capture <<<

// Recursively corrupts JSON VALUES (numbers, booleans) while preserving structure, strings, nulls
// and keys — so tokens/ids (usually strings) survive and the app keeps flowing, but any numeric or
// boolean datum the UI shows is now wrong. Used only by the _faultInject response-oracle pass.
function corruptValues(v: unknown): unknown {
  if (typeof v === "number") return Number.isFinite(v) ? (v === 0 ? 1 : v + 1) : v;
  if (typeof v === "boolean") return !v;
  if (Array.isArray(v)) return v.map(corruptValues);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) out[k] = corruptValues(val);
    return out;
  }
  return v;
}

// Names a test entity with the run's prefix: ns("qa-bot-x", "user").
export function ns(namespace: string, name: string): string {
  return `${namespace}-${name}`;
}

// --- App capabilities (helpers) --------------------------------------------

// Geolocation: the app places the user on a map and lists nearby places when
// uploading a photo. Forces a deterministic location that the browser API detects.
export async function setLocation(context: BrowserContext, latitude: number, longitude: number): Promise<void> {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude, longitude });
}

// Offline mode (the app has an offline mode). Remember to restore with goOnline().
export async function goOffline(context: BrowserContext): Promise<void> {
  await context.setOffline(true);
}
export async function goOnline(context: BrowserContext): Promise<void> {
  await context.setOffline(false);
}

// Reading cookies/storage (some tests assert on these).
export async function readCookies(context: BrowserContext, name?: string) {
  const cookies = await context.cookies();
  return name ? cookies.filter((c) => c.name === name) : cookies;
}
export async function readStorage(page: Page, key?: string) {
  return page.evaluate((k) => (k ? localStorage.getItem(k) : { ...localStorage }), key);
}

// Photo upload: resolves the path of an asset under e2e/assets/ to upload it. Each
// asset's optional metadata (what to test) lives in e2e/assets/assets.json.
export function asset(name: string): string {
  return new URL(`./assets/${name}`, import.meta.url).pathname;
}
