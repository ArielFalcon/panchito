# Locators, waiting and flakiness

Adapted from [TestDino playwright-skill](https://github.com/testdino-hq/playwright-skill) (MIT).

## Locators (best to worst)

1. `getByTestId("...")` — **when a `-> [attr]` hint appears on the injected tree line**. The hint signals a stable test-id attribute (e.g. `data-testid=submit` or `data-cy=submit`). Use `getByTestId('submit')` — Playwright resolves it via the per-app `testIdAttribute` config. This is the most stable selector and MUST be preferred when available. NEVER use `locator('[data-cy=X]')` or `locator('[data-testid=X]')` as a substitute — `getByTestId` resolves the attribute name via the per-app `testIdAttribute` Playwright config; raw CSS form hardcodes the attribute name and breaks when the app configures a non-default attribute.
2. `getByRole("button", { name: /publish/i })` — semantic, accessible. Preferred when no test-id hint is present.
3. `getByLabel`, `getByPlaceholder`, `getByText` — for forms/content when role+name is unavailable.
4. Scoped locator (`section.locator("th")`) — when neither test-id nor role is present.
5. ❌ Raw CSS/XPath, auto-generated classes, `nth-child` — fragile, forbidden.

## Authoring-only attributes — never assert at runtime

Some attributes exist **only in the component source template** and are stripped or transformed before the browser parses the DOM. Asserting them always fails at runtime because they are absent from the live accessibility tree.

**The authoring-only class:** these are framework binding attributes written by a developer in a template to wire up routing, conditional rendering, or form control — they are compiler/framework inputs, not rendered HTML attributes.

Examples by framework (illustrative — the principle applies to any component framework):

- **Angular:** `routerLink="/home"` is transformed by the router into a rendered `href` attribute — assert `href`, not `routerlink`. Directives `*ngIf`, `ng-reflect-*`, and `formControlName` do not appear in the live DOM; use `getByLabel`, `getByTestId`, or `getByRole` targeting the rendered element instead. Explicitly forbidden: `toHaveAttribute("routerlink", ...)` and `locator("[formControlName=X]")`.
- **Vue:** `v-bind` and `v-model` directive attributes are not exposed as DOM attributes — assert the rendered value or element instead.
- **React:** JSX props are not automatically forwarded as DOM attributes unless the component explicitly spreads them; `className` renders as `class` but most custom props are prop-only and invisible to Playwright.

**Values oracle:** The browser (or injected DOM snapshot) is the ONLY oracle for rendered values — formatted dates, computed totals, status labels, translated strings. Reimplementing app formatting logic in the test produces a value that drifts on a CORRECT app. Always take the expected string from what you observed in the DOM, not from the source code or test data.

## Dynamic-DOM awareness (CRITICAL)

**The injected tree is a STATIC snapshot of initial page load.** The real DOM is DYNAMIC — modals, dynamic lists, and multi-step forms appear only AFTER user interaction. Do NOT assert that a post-interaction element exists in this static tree.

After an action (click, fill, submit), assert the resulting transition with Playwright's built-in **auto-waiting**:
- `await expect(locator).toBeVisible()` — waits until the element is visible
- `await page.waitForURL(/\/success/)` — waits until the URL changes

**Never** use `waitForTimeout(ms)` (static sleep). **Never** assume a post-interaction element was in the initial snapshot.

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

`getByRole({ name })` and `getByText` assertions are i18n-fragile — the accessible name or visible text changes when locale or translation bundle changes, silently breaking the test on a CORRECT app. Prefer selectors stable across locales: `getByTestId` (when a test-id attribute exists), `getByLabel` (when the label is a stable key), or a scoped locator anchored to a stable landmark/heading. If a name-based selector is unavoidable, add a code comment acknowledging i18n fragility (e.g. `// i18n-fragile: breaks if locale changes`).

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
