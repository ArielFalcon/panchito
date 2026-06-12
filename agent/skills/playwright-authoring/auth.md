# Authentication (two layers)

This app has **two distinct credentials**. Do not confuse them.

## Layer 1 — DEV environment gate (HTTP Basic Auth)

The whole DEV environment is protected by the browser's native dialog
(username/password). **You do not interact with that dialog**: it is handled by
`httpCredentials`, already configured in `playwright.config.ts` from
`DEV_ENV_USER`/`DEV_ENV_PASS` and scoped to the app origin. You do not need to do
anything in the spec; just know that this is why DEV is "already open".

## Layer 2 — App login (Keycloak, external redirect)

Pressing the login button **redirects to the Keycloak domain** (outside the app),
where the username and password are entered (`DEV_TEST_USER`/`DEV_TEST_PASS`), and
on success it **returns to the app**.

The `authenticate()` fixture already performs this flow; **adjust the selectors**
to the real login (the app's button and, in Keycloak, usually `#username`,
`#password`, `#kc-login`). Cross-domain works within the same context.

```ts
test("private area visible after login", async ({ page, authenticate }) => {
  await authenticate();
  await expect(page.getByRole("heading", { name: /my profile/i })).toBeVisible();
});
```

## Public pages (no login)

The app has public navigation. For those tests **do not call `authenticate()`**
(you will still pass layer 1, which belongs to the environment).

## Optimization: cache the session with storageState

The Keycloak login is slow. To avoid repeating it in every test, do it **once** in
a setup and save the state, then reuse it:

```ts
// auth.setup.ts (a setup project)
import { test as setup } from "../fixtures";
setup("login", async ({ page, authenticate, context }) => {
  await authenticate();
  await context.storageState({ path: "e2e/.auth/user.json" });
});
```
Then authenticated tests use `test.use({ storageState: "e2e/.auth/user.json" })`.
Add `.auth/` to the e2e project's `.gitignore` (it is session state, not code).
