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
  **two ways**: (1) a direct longest-path-suffix match (unbundled dev servers), or (2) — for a
  **hashed, bundled production deploy** (Angular/React, `main.a1b2c3.js`) whose URL never matches a
  repo path — by decoding the script's **source map** (`src/qa/source-map.ts`, a dependency-free
  base64-VLQ consumer) and translating covered bundle positions back to the original source files +
  lines. A bundle served **without** a source map still degrades to `unknown` (never falsely
  covered) — see *Activating the keystone* below.
- **e2e backend through the UI (microservices)** — line coverage of a remote DEV server is not
  available to the runner. This is the open frontier: a network-linkage proxy (the test caused the
  changed endpoint to be called + asserted its response) and an optional per-app DEV coverage
  sidecar are the next providers (see "Roadmap").

The raw dumps are **gitignored** and excluded from the publish pathspec, so they never bloat a PR
or trigger a false "the suite changed" commit. The committed metadata stays in `e2e/.qa/manifest.json`.

## Activating the keystone on a watched app (Angular + Spring)

The machinery is app-agnostic, but a real microservice system must serve the **one artifact** each
provider needs, or the keystone silently degrades to `unknown`. When the orchestrator detects this
(Playwright produced coverage but nothing mapped to a changed file), it logs a loud
`CHANGE-COVERAGE INACTIVE` diagnostic with the fix below — it never blocks the run.

- **Angular frontend (e2e) → enable source maps on the DEV build.** Production `ng build` sets
  `"sourceMap": false`, so the hashed bundle the keystone needs to map back to `*.component.ts` is
  absent. Enable it **for the DEV configuration only** — `ng build --source-map`, or in
  `angular.json` set `configurations.development.sourceMap: true` (or `{ "scripts": true, "vendor":
  false }` to keep the map small). The bundle stays minified/hashed (a realistic deploy); the map
  rides alongside and is fetched non-invasively. No production change is required.
- **Spring microservice (code mode) → add the JaCoCo plugin.** Native line coverage comes from
  `jacoco.xml`, which Maven/Gradle emit only when the plugin's report goal is bound. Maven: add
  `jacoco-maven-plugin` with the `prepare-agent` + `report` executions (report bound to `test`).
  Gradle: apply `jacoco` and run `test jacocoTestReport`. The orchestrator reads
  `target/site/jacoco/jacoco.xml` (Maven) or `build/reports/jacoco/test/jacocoTestReport.xml`
  (Gradle) automatically; no config change in `ai-pipeline` is needed.
- **Then turn on the gate.** Once a real run reports a **measured** ratio (not `unknown`), set
  `qa.changeCoverage.mode: enforce` for that app so a test that does not exercise the change blocks
  publishing. Keep `signal` while you confirm the false-positive rate is acceptable.

The global default stays `signal` deliberately: `enforce` blocks publishing, so it is opted into
**per app** once that app's coverage is proven measurable — promoting it to a global default before
a representative app proves measurability would surprise operators with unrequested gating, against
the project's "stable/deterministic over features" priority.

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

- `src/qa/change-coverage.ts` — the pure core (diff parsing, intersection, decision, lcov/Istanbul/V8/
  JaCoCo-XML parsers) + the default provider. Fully unit-tested, incl. an end-to-end test that maps a
  minified bundle's coverage back to the changed source through a real-shaped source map.
- `src/qa/source-map.ts` — the dependency-free base64-VLQ source-map consumer (bundled-deploy keystone).
- `src/pipeline.ts` — Filter D + the `enforce` gap-closing loop + the publish gate + the
  `CHANGE-COVERAGE INACTIVE` activation diagnostic.
- `config/e2e/fixtures.ts` — the system-owned V8 collection fixture (also captures each script's source map).
- `src/integrations/publish.ts` — excludes `e2e/.qa/coverage/**` from commits.
- `src/orchestrator/schemas.ts` — `qa.changeCoverage` config.
