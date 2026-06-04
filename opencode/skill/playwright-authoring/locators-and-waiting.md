# Locators, waiting and flakiness

Adapted from [TestDino playwright-skill](https://github.com/testdino-hq/playwright-skill) (MIT).

## Locators (best to worst)

1. `getByRole("button", { name: /publish/i })` — semantic, accessible. **Preferred.**
2. `getByLabel`, `getByPlaceholder`, `getByText` — for forms/content.
3. `getByTestId("...")` — when there is no clear role (`data-testid` attribute).
4. ❌ Raw CSS/XPath, auto-generated classes, `nth-child` — fragile, forbidden.

Chain by context to disambiguate: `page.getByRole("listitem").filter({ hasText: "X" })`.

## Web-first waiting (auto-retry)

Playwright retries assertions until they hold or the timeout elapses. Use it:

```ts
await expect(page.getByRole("status")).toHaveText(/ready/i);
await expect(page.getByRole("row")).toHaveCount(3);
```

- ❌ **Never** `page.waitForTimeout(ms)` (sleep): the #1 source of flakiness.
- ❌ Avoid `waitForLoadState("networkidle")`: unreliable.
- ✅ Wait for an **observable** state (a visible element, a text, a URL):
  `await page.waitForURL(/\/success/)`.

## Actions with auto-waiting

`click`, `fill`, etc. already wait for the element to be actionable. Do not add
manual waits before them. If an action "needs" a sleep to work, the problem is the
locator or an unexpected state, not timing.

## Diagnosing flakiness

The config saves a **trace on-first-retry**. If a test is flaky, open the trace
(`npx playwright show-trace`) and look at the exact failing step: it is almost
always an ambiguous locator, an assertion on something not yet rendered, or
non-namespaced data that collides. Fix it at the source; do **not** raise retries
or add sleeps.
