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

export interface QaFixtures {
  namespace: string; // the run's data prefix (qa-bot-<sha>)
  authenticate: () => Promise<void>; // the app's real login (Keycloak)
  cleanup: (undo: () => Promise<void>) => void; // registers undo steps (LIFO, automatic)
  // system-owned: do not edit — the orchestrator reads these dumps for change-coverage.
  _coverage: void;
  // system-owned: do not edit — the orchestrator's response-oracle pass (QA_FAULT_INJECT).
  _faultInject: void;
}

export const test = base.extend<QaFixtures>({
  namespace: async ({}, use) => {
    await use(process.env.PW_NAMESPACE ?? "qa-bot-local");
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
      if (!user || !pass) throw new Error("Missing DEV_TEST_USER/PASS (Keycloak login)");
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
