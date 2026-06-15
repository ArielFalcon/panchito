# Locators, waiting and flakiness

Adapted from [TestDino playwright-skill](https://github.com/testdino-hq/playwright-skill) (MIT).

## Locators (best to worst)

1. `getByRole("button", { name: /publish/i })` — semantic, accessible. **Preferred.**
2. `getByLabel`, `getByPlaceholder`, `getByText` — for forms/content.
3. `getByTestId("...")` — when there is no clear role (`data-testid` attribute).
4. ❌ Raw CSS/XPath, auto-generated classes, `nth-child` — fragile, forbidden.

## ⚠ CRITICAL: `getByRole` matches the ACCESSIBILITY TREE, not the HTML tag

A role-locator resolves ONLY if that role is present in the **live accessibility tree** — which
is NOT the same as the HTML element's implied role. CSS (`display:block/flex/grid` on a `<table>`,
Bootstrap's `.table`, custom widgets) routinely STRIPS or changes implicit ARIA roles, so an
element that "should" have a role often does not:

- A `<th>` is frequently **NOT** exposed as `columnheader` (very common with `.table`/styled tables).
- `<table>`/`<tr>`/`<td>` may lose `table`/`row`/`cell`; `<ul>`/`<li>` may lose `list`/`listitem`.

So **NEVER infer a role from the HTML tag.** With the Playwright MCP, take a `browser_snapshot` of
the page under test and use ONLY the roles + accessible names that LITERALLY appear in that snapshot.
If the role you want is absent there, do NOT use `getByRole` for it — fall back (in order) to
`getByText` / `getByLabel`, or a SCOPED stable locator (`page.getByRole("table").locator("td")`,
`section.locator("th")`), anchored to a heading/landmark first. A `getByRole` that matches **0**
elements is the single most common cause of a spec that looks green in review but TIMES OUT on
execution (observed: `getByRole("columnheader", { name: /name/i })` matched 0 on a Bootstrap table
whose `<th>Name</th>` was real but not exposed as a columnheader).

## Hard rules for selectors (MANDATORY)

- **Always scope to a section.** Never use `page.getByText("X")` without first
  locating the containing section. Locate the section by its heading or landmark
  role, then narrow within it:
  ```ts
  // ❌ WRONG — "TypeScript" matches 8 elements across the whole page
  await expect(page.getByText("TypeScript")).toBeVisible();
  
  // ✅ RIGHT — scoped to the Skills section
  const skills = page.getByRole("heading", { name: "Skills" }).locator("..");
  await expect(skills.getByText("TypeScript")).toBeVisible();
  ```
- **Regex must be unambiguous.** A pattern like `/:h/` matches inside `:hi`,
  `/:about/` inside `:about-me`. When using `getByText` with a regex:
  ```ts
  // ❌ WRONG — /:h/ also matches ":hi" text, causing strict-mode violation
  await expect(page.getByText(/:h/)).toBeVisible();
  
  // ✅ RIGHT — use exact text match or word boundaries
  await expect(page.getByText(":h", { exact: true })).toBeVisible();
  // or
  await expect(page.getByText(/\b:h\b/)).toBeVisible();
  ```
- **Prefer `getByRole` with `{ name }` over `getByText` with regex.** Role-based
  selectors are inherently scoped to interactive/semantic elements and less prone
  to ambiguity.
- **When the same text appears in multiple sections** (e.g. "TypeScript" in Skills,
  Projects, and Education), scope to the target section FIRST — never assert on
  the whole page.

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
