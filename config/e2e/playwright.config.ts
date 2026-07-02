// Base Playwright config — harness SEED (Filter A). It is copied into the repo's
// `e2e/` folder the first time; from then on the repo owns it and the agent
// maintains it.
//
// qa-playwright-config-seed (system-owned marker: do not remove this comment).
// setup.ts's ensurePlaywrightEnvKeys keys off this exact literal to recognize an
// already-onboarded repo's e2e/playwright.config.ts as an unmodified copy of THIS
// seed version, so it can safely replace the whole file to backfill new env-passthrough
// keys (actionTimeout, testIdAttribute, ...). If the repo has edited this file, the
// marker (or the byte-identical match) will no longer hold and the repair is skipped —
// the repo owns its e2e/ after first PR; a customized config is never overwritten.
//
// The orchestrator injects via env: PW_BASE_URL (DEV) and PW_NAMESPACE.
// Two credential layers (do not confuse them):
//   - DEV_ENV_USER/PASS  → HTTP Basic Auth that protects the WHOLE DEV
//     environment (the browser's native user/password dialog). Goes in httpCredentials.
//   - DEV_TEST_USER/PASS → the APP login via Keycloak (a form). Goes in the
//     `authenticate` fixture (see fixtures.ts), NOT here.

import { defineConfig, devices } from "@playwright/test";

const appOrigin = process.env.PW_BASE_URL ?? "http://localhost";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 2, // retries = flakiness SIGNAL (Filter C), not a fix
  // Whole-run ceiling: Playwright exits cleanly on its own, comfortably under the
  // orchestrator's 15-min kill-tree (QA_E2E_TIMEOUT_MS) so the SIGKILL never fires
  // in the normal slow-run case.
  globalTimeout: 12 * 60 * 1000, // 12 min
  reporter: [["json"]],
  use: {
    baseURL: process.env.PW_BASE_URL,
    trace: "on-first-retry",
    // Bound the action auto-wait so a missing/fabricated selector fails fast with
    // Playwright's own "resolved to 0 elements" error instead of consuming the full
    // per-test timeout (the default actionTimeout is 0 = unbounded → a click/fill on a
    // non-existent element eats the whole 30s). This turns a fabricated selector into a
    // cheap, real failure the regeneration loop can act on. Calibrated above real DEV
    // render latency; the occasional slow-but-real element is absorbed by retries (2).
    // Env-overridable per target; navigation is deliberately left at the default because
    // a first page load can legitimately be slow.
    actionTimeout: Number(process.env.PW_ACTION_TIMEOUT_MS ?? 8000),
    testIdAttribute: process.env.PW_TEST_ID_ATTRIBUTE ?? "data-testid",
    // Layer 1: gets past the DEV environment's HTTP Basic gate. `origin` scopes it
    // to the app so these credentials are NOT sent to Keycloak (a different origin).
    httpCredentials: process.env.DEV_ENV_USER
      ? {
          username: process.env.DEV_ENV_USER,
          password: process.env.DEV_ENV_PASS ?? "",
          origin: appOrigin,
        }
      : undefined,
    // Deterministic default geolocation (the app places the user on a map). Tests
    // that need another location use setLocation() (see fixtures.ts).
    permissions: ["geolocation"],
    geolocation: {
      latitude: Number(process.env.PW_GEO_LAT ?? 40.4168),
      longitude: Number(process.env.PW_GEO_LNG ?? -3.7038),
    },
  },
  // Grounding (DOM capture / selector catalog) is desktop-only today — a mobile
  // project would execute ungrounded. Re-add per-project grounding before restoring mobile.
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
  ],
});
