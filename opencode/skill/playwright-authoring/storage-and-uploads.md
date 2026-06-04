# Cookies/cache and photo upload

## Reading cookies, cache and localStorage

The app stores information in cookies and cache; some tests assert on it.

```ts
import { readCookies, readStorage } from "../fixtures";

test("stores the session in a cookie", async ({ page, context, authenticate }) => {
  await authenticate();
  const [session] = await readCookies(context, "session_id");
  expect(session?.value).toBeTruthy();

  const theme = await readStorage(page, "theme");   // a localStorage value
  expect(theme).toBe("dark");
});
```
For all cookies: `readCookies(context)`. For all of localStorage: `readStorage(page)`.

## Uploading photos (assets + their metadata)

Images live in `e2e/assets/` and their **optional metadata** (what to test with
each one) in `e2e/assets/assets.json`. Before writing an upload test, **read
`assets.json`** to pick the right asset and learn what to verify.

```ts
import { asset } from "../fixtures";

test("uploads a photo and suggests nearby places", async ({ page, authenticate, cleanup }) => {
  await authenticate();
  await page.goto("/upload");
  await page.getByLabel(/photo/i).setInputFiles(asset("beach.jpg"));
  // due to geolocation + EXIF, the app suggests nearby places:
  await expect(page.getByRole("list", { name: /nearby places/i })).toBeVisible();
  await page.getByRole("option").first().click();
  await page.getByRole("button", { name: /publish/i }).click();
  cleanup(async () => { /* delete the created post */ });
  await expect(page.getByText(/published/i)).toBeVisible();
});
```
If you need an asset that does not exist, create it in `e2e/assets/` and add it to
`assets.json` with its `whatToTest`.
