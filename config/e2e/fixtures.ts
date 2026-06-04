// Shared toolbox (Filter A). Every spec imports `test`/`expect` and the helpers
// from here instead of starting from scratch. It standardizes login, namespaced
// data, cleanup and the app's own capabilities (geolocation, mobile/offline,
// cookies/cache, photo upload).
//
// Hybrid model: the skeleton is shared (this file); the app-specific parts (the
// real Keycloak login selectors, etc.) are filled in by the agent and persisted
// in git. For the "how" of each capability, see the `playwright-authoring` skill.

import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";

export interface QaFixtures {
  namespace: string; // the run's data prefix (qa-bot-<sha>)
  authenticate: () => Promise<void>; // the app's real login (Keycloak)
  cleanup: (undo: () => Promise<void>) => void; // registers undo steps (LIFO, automatic)
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
});

export { expect };

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
