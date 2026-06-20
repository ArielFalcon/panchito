// e2e/cleanup.spec.ts
// ── Orphaned data cleanup ────────────────────────────────────────────────────
// Run by the orchestrator ON ITS OWN (not as part of the normal suite) BEFORE a new
// run when the PREVIOUS run was interrupted (SIGKILL, crash, docker restart). It is
// invoked with PW_CLEANUP=1 and PW_NAMESPACE = the interrupted run's BASE prefix (no per-attempt
// -w<worker>r<retry> suffix), so it only executes during that dedicated cleanup pass; in a normal run it
// skips. Match orphaned entities by this base PREFIX — it covers every worker/retry the run used.
//
// This spec must be IDEMPOTENT (no entities → pass) — the orchestrator treats cleanup
// failures as warnings and never blocks the new run.
//
// TO IMPLEMENT for your app: delete every entity whose name starts with the run's BASE prefix
// (`process.env.PW_NAMESPACE`), using the app's own deletion flow. Match the BASE, NOT the per-attempt
// `namespace` fixture: a run creates data under `<base>-w<worker>r<retry>-...` across parallel workers
// and retries, and EVERY such name starts with the base — so one startsWith(base) prefix match catches
// all of it. Using the suffixed fixture value here would scope cleanup to a single worker/retry and
// orphan the rest. Example for a CRUD app:
//
//   const base = process.env.PW_NAMESPACE;
//   await page.goto("/admin/entities");
//   await page.getByPlaceholder("Search").fill(base);
//   const items = page.locator(`[data-qa-namespace^="${base}"]`); // prefix match, all workers/retries
//   for (let i = 0; i < await items.count(); i++) {
//     await items.nth(0).getByRole("button", { name: /delete/i }).click();
//     await page.getByRole("button", { name: /confirm/i }).click();
//   }

import { test } from "./fixtures";

test("cleanup orphaned data from interrupted run", async () => {
  // Only runs during the orchestrator's dedicated cleanup pass.
  test.skip(!process.env.PW_CLEANUP, "cleanup pass only (set PW_CLEANUP=1)");

  // TO IMPLEMENT: delete entities whose name starts with the run's BASE prefix (process.env.PW_NAMESPACE),
  // which spans every worker/retry suffix. The seed leaves this empty (a no-op that passes) — implement
  // your app's deletion flow above. NOTE: do NOT use the `namespace` fixture here (it is per-attempt).
  const base = process.env.PW_NAMESPACE;
  void base;
});
