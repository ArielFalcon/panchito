# Change-coverage — the value keystone

The harness proves a test runs **green**; it does not prove the test **covers the change**. This
is the Goodhart risk in `CLAUDE.md`: optimize "green" and the suite can grow into noise that never
catches a regression. Change-coverage is the first **ground-truth signal** that closes that gap —
it measures, deterministically, whether executing the generated tests actually exercises the lines
the commit changed.

## How it works (Filter D)

After a green **diff**-mode run, `runPipeline` runs Filter D:

1. `parseDiffHunks(diff)` → the changed lines per file (new-file side, = the working copy at the SHA).
2. `collectCoverage(...)` → the lines actually exercised by the run (the injected boundary).
3. `computeChangeCoverage(changed, covered)` → ratio + the uncovered changed lines.
4. `decideCoverage(...)` → `pass` / `fail` / `unknown`, and the policy decides what to do.

**Determinism over zeal:** if no usable coverage is produced, the status is `unknown`, which
**never blocks**. A measurement gap is never a false failure.

## Policy (per app, `config/apps/<app>.yaml` → `qa.changeCoverage`)

| mode | behavior |
|---|---|
| `off` | skip Filter D entirely |
| `signal` (default) | measure + log + record; **never blocks** — gather data |
| `enforce` | additionally: make ONE bounded attempt to close the gap (regenerate targeting the uncovered lines → re-run), and if it stays below `minRatio`, **block publishing** and open an Issue |

`minRatio` (default 0.7) is the fraction of changed lines that must be exercised to `pass`.

Rollout: start `signal` on real repos to measure the false-positive rate, then move trusted apps
to `enforce`.

## Coverage providers (app-agnostic, tiered)

Coverage is obtained **non-invasively** — providers read artifacts the run already produced; they
never change how the suite runs.

- **code mode → native coverage.** `lcov` (universal: c8/nyc/jest, `coverage.py lcov`, JaCoCo) is
  read first, then Istanbul `coverage-final.json`. Conventional paths under the repo
  (`coverage/lcov.info`, …). Absent → `unknown`.
- **e2e frontend → V8 browser coverage.** A **system-owned fixture** in the seed
  (`config/e2e/fixtures.ts`) collects Chromium V8 coverage per test and dumps it to
  `e2e/.qa/coverage/<namespace>/` (per-run, so stale dumps never pollute a later run). The
  orchestrator maps the covered byte ranges to source lines and resolves script URLs to repo files
  by longest path suffix (works for unbundled dev servers; bundled-without-sourcemaps → the file is
  simply unmeasured, never falsely covered).
- **e2e backend through the UI (microservices)** — line coverage of a remote DEV server is not
  available to the runner. This is the open frontier: a network-linkage proxy (the test caused the
  changed endpoint to be called + asserted its response) and an optional per-app DEV coverage
  sidecar are the next providers (see "Roadmap").

The raw dumps are **gitignored** and excluded from the publish pathspec, so they never bloat a PR
or trigger a false "the suite changed" commit. The committed metadata stays in `e2e/.qa/manifest.json`.

## What it is and is NOT

Covering a line is **necessary but not sufficient** — executing a line is not the same as
*asserting* its behavior. Change-coverage raises the floor (it catches "tests for the wrong thing"
and "the change isn't exercised at all"); the agent + the independent reviewer still own the
assertion quality. The gold standard — **mutation of the changed lines** to prove a test goes red
when the change breaks — is the roadmap's end state.

## Roadmap (not yet implemented)

- **Network-linkage + DEV coverage sidecar** for backend-through-UI changes.
- **Per-test attribution → manifest `sensitivity`/`merit`** (today the signal is run-level), feeding
  dedup and impact-based test selection.
- **Targeted mutation** on the changed lines for true sensitivity.

## Code map

- `src/qa/change-coverage.ts` — the pure core (diff parsing, intersection, decision, lcov/Istanbul/V8
  parsers) + the default provider. Fully unit-tested.
- `src/pipeline.ts` — Filter D + the `enforce` gap-closing loop + the publish gate.
- `config/e2e/fixtures.ts` — the system-owned V8 collection fixture.
- `src/integrations/publish.ts` — excludes `e2e/.qa/coverage/**` from commits.
- `src/orchestrator/schemas.ts` — `qa.changeCoverage` config.
