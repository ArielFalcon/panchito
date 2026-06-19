---
name: test-value-review
description: How to judge whether an E2E test ADDS VALUE (not just whether it is green). Catalog of false-positive anti-patterns and how to detect them. Use it when reviewing tests (qa-reviewer role).
---

# Reviewing a test's VALUE

A green test is worthless if it **would not turn red when the functionality
breaks**. Your job is not to confirm the test passes: it is to **try to prove the
test is useless**. Assume bad faith from the test until it proves otherwise.

## The central question

> *Is there any way the feature could be broken and this test still be green?*

If the answer is yes, the test is a false positive → `approved: false` with a
concrete correction.

## Anti-pattern catalog (reject if you see any)

1. **Missing or trivial assert.** Only clicks/navigates; or asserts something that
   is always true (`toBeVisible()` on something already there, `expect(true)`,
   checking that the URL exists). → Require an assert on the flow's **outcome**.
2. **Assert not tied to the change.** The objective says "X" but the assert checks
   an unrelated "Y". → The test does not cover what it claims to.
3. **Would accept the broken path.** If the action failed silently, the test would
   pass anyway (e.g. asserts a button appears, not that the operation happened). →
   Assert the effect, not the mere presence of UI.
4. **Tautology / depends on its own mock.** Checks something the test itself set
   up, or mocks the network (forbidden here) and verifies the mock. → No value.
5. **Pre-existing data.** Assumes a real entity exists ("admin user", "order 42")
   instead of creating it namespaced. → Fragile and not isolated.
6. **Non-deterministic.** `waitForTimeout`, implicit ordering between tests,
   fragile CSS/XPath locators, no cleanup. → Guaranteed flaky.
7. **Ambiguous selector / no scope.** Any `getByText`, `locator`, or `getByRole`
   that targets the ENTIRE page (`page.getByText(...)`) instead of first scoping
   to a section container (e.g. locate the section by heading, then narrow within
   it: `section.getByText(...)`). Also: regex patterns that match inside other
   strings — `/:h/` matches inside `:hi`, `/:about/` inside `:about-me`. → Use
   `getByRole` with `{ name }` or `getByText(":h", { exact: true })` for literal
   matches. For regex, prefer word boundaries (`/\b:h\b/`) or anchors (`/^:h$/`).
   If the same text legitimately appears in multiple sections (e.g. "TypeScript"
   in both Skills and Projects), scope to the target section first — never
   assert on `page.getByText("TypeScript")` alone. → Reject: any test where a
   `getByText` or regex could match >1 element at runtime (strict-mode violation).
8. **No cleanup (ONLY when a delete affordance exists).** Creates data and ignores an available
   UI delete affordance. → Dirties DEV. But if the app has NO delete affordance, namespaced data
   left behind is acceptable (the run is namespace-isolated) — do NOT reject for it. And NEVER
   accept a fabricated direct API/curl DELETE as "cleanup": it invents an endpoint that may not
   exist and breaks the UI-only contract — reject THAT instead.
9. **Coverage that ignores the change.** The diff touches a flow the test does not
   exercise. → The affected-flow test is missing.
10. **Incoherent metadata.** The manifest's `objective`/`targets` do not match what
    the test actually does.
11. **Weak oracle.** Verifies an intermediate state instead of the final outcome
    the user observes.

## How you emit the verdict

For each problem, one **specific, actionable** correction (what to change and why).
If and only if you find none after genuinely trying, approve.

```json
{ "approved": false, "corrections": ["The test asserts that the 'Publish' button is visible, but not that the photo was published: it would pass even if the upload fails. Assert that the created post appears with its namespaced id."] }
```
