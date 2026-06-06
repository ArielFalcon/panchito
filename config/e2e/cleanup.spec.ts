// e2e/cleanup.spec.ts
// ── Orphaned data cleanup ────────────────────────────────────────────────────
// Run by the orchestrator ON ITS OWN (not as part of the normal suite) BEFORE a new
// run when the PREVIOUS run was interrupted (SIGKILL, crash, docker restart). It is
// invoked with PW_CLEANUP=1 and PW_NAMESPACE = the interrupted run's namespace, so it
// only executes during that dedicated cleanup pass; in a normal run it skips.
//
// This spec must be IDEMPOTENT (no entities → pass) — the orchestrator treats cleanup
// failures as warnings and never blocks the new run.
//
// TO IMPLEMENT for your app: delete every entity whose name carries the `namespace`
// prefix, using the app's own deletion flow. Example for a CRUD app:
//
//   await page.goto("/admin/entities");
//   await page.getByPlaceholder("Search").fill(namespace);
//   const items = page.locator(`[data-qa-namespace="${namespace}"]`);
//   for (let i = 0; i < await items.count(); i++) {
//     await items.nth(0).getByRole("button", { name: /delete/i }).click();
//     await page.getByRole("button", { name: /confirm/i }).click();
//   }

import { test } from "./fixtures";

test("cleanup orphaned data from interrupted run", async ({ namespace }) => {
  // Only runs during the orchestrator's dedicated cleanup pass.
  test.skip(!process.env.PW_CLEANUP, "cleanup pass only (set PW_CLEANUP=1)");

  // TO IMPLEMENT: delete entities whose name starts with `namespace`. The seed leaves
  // this empty (a no-op that passes) — implement your app's deletion flow above.
  void namespace;
});
