---
name: playwright-authoring
description: How to write robust, deterministic Playwright E2E tests (locators, waiting, fixtures, authentication, geolocation, mobile/offline, cookies/cache, file upload). Use it WHENEVER you generate or fix a spec.
---

# Playwright E2E authoring

Craft knowledge for writing specs that pass the harness on the first try and are
not flaky. Base pattern: **fixtures** (not Page Object Model). Reference material
adapted from [TestDino playwright-skill](https://github.com/testdino-hq/playwright-skill) (MIT).

> **Precedence:** the rules in `AGENTS.md` and the agent prompt OVERRIDE any guide
> here. In particular: **no network mocks** (we exercise the real DEV), namespaced
> data, mandatory `cleanup`, role/testid locators.

## Hard rules (always)

- **Locators**: `getByRole` (preferred), `getByLabel`, `getByTestId`. Never fragile
  CSS/XPath. **Always scope to a section**: locate the section by heading/landmark
  first, then narrow within it — never do `page.getByText(...)` without scope.
  See `locators-and-waiting.md` for the full selector rules.
- **Web-first waiting**: use `expect(locator).toBeVisible()` etc. with auto-retry.
  **No `waitForTimeout`** (sleep) and no `networkidle`.
- **One real assert** on the observable outcome, not just clicks.
- **Repo fixtures** (`./fixtures`): `test`, `expect`, `ns`, and the helpers
  (`setLocation`, `goOffline`, `readCookies`, `readStorage`, `asset`).
- **Determinism**: no implicit ordering between tests; each one stands on its own.

## When to read each reference (progressive disclosure)

These references are **generic patterns with illustrative examples**. Whether the app
under test actually has a given capability — and its real selectors/flow — comes from
**the repo's own `e2e/` (`fixtures.ts`, README) and the live DOM (Playwright MCP)**, not
from here. Read the specific file only when the test needs that pattern:

- **`auth.md`** — patterns for app login: an environment HTTP Basic gate, a redirect-based
  IdP login (e.g. Keycloak/OAuth), caching the session with storageState, and testing
  public pages. Use whichever the app actually uses (public pages need no login at all).
- **`browser-conditions.md`** — geolocation, mobile/offline modes, and browser permissions —
  for apps that use them.
- **`storage-and-uploads.md`** — reading cookies/cache/localStorage for assertions, and
  file uploads — for apps that use them.
- **`locators-and-waiting.md`** — fine-grained locator and waiting patterns, and how to
  diagnose flakiness (trace viewer). Applies to every app.

## Structure of a spec

```ts
import { test, expect, ns } from "../fixtures";

test("checkout with >10 items completes the payment", async ({ page, namespace, authenticate, cleanup }) => {
  await authenticate();                         // omit this in public tests
  const item = ns(namespace, "item");           // namespaced data
  cleanup(async () => { /* delete `item` */ });  // clean up what you create
  // ... exercise the real flow against DEV ...
  await expect(page.getByRole("status")).toHaveText(/payment complete/i); // real assert
});
```
