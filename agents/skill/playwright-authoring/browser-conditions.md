# Browser conditions: geolocation, mobile, offline

## Geolocation

The app places the user on a map and, when uploading a photo, lists **nearby
places**. There is a deterministic default location in the config. To force a
different one (e.g. so specific places appear), use the helper:

```ts
import { setLocation } from "../fixtures";

test("shows places near the location", async ({ page, context }) => {
  await setLocation(context, 41.3874, 2.1686);   // Barcelona
  await page.goto("/map");
  await expect(page.getByRole("list", { name: /nearby places/i })).toBeVisible();
});
```
The `geolocation` permission is already granted in the config. `setLocation` also
grants it in case the test created a new context.

## Mobile mode

Two options:
- Run the spec in the **`mobile` project** (already defined in the config), or
- Force it per test with device emulation:

```ts
import { devices } from "@playwright/test";
test.use({ ...devices["iPhone 13"] });

test("the menu collapses on mobile", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /menu/i })).toBeVisible();
});
```

## Offline mode

```ts
import { goOffline, goOnline } from "../fixtures";

test("shows an offline notice", async ({ page, context }) => {
  await page.goto("/");
  await goOffline(context);
  await page.getByRole("button", { name: /reload/i }).click();
  await expect(page.getByText(/no connection/i)).toBeVisible();
  await goOnline(context);   // restore for teardown
});
```
Always go back online before finishing so teardown does not break.
