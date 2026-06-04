// Base Playwright config — harness SEED (Filter A). It is copied into the repo's
// `e2e/` folder the first time; from then on the repo owns it and the agent
// maintains it.
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
  reporter: [["json"]],
  use: {
    baseURL: process.env.PW_BASE_URL,
    trace: "on-first-retry",
    testIdAttribute: "data-testid",
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
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    // Mobile mode: mobile tests run with this project, or with
    // test.use({ ...devices["iPhone 13"] }) per test.
    { name: "mobile", use: { ...devices["iPhone 13"] } },
  ],
});
