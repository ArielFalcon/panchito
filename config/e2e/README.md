# e2e project — harness SEED

This directory is the **seed**: the template the orchestrator **copies into the
app repo's `e2e/` folder** the first time that repo has no test project. From
then on, **the source of truth is `e2e/` in the repo** (versioned in git), and
the agent maintains and improves it run after run via PRs.

## What it seeds

| File | Purpose |
|---|---|
| `playwright.config.ts` | Base config: retries (flakiness signal), trace on-first-retry, JSON reporter, `data-testid`, single worker, `baseURL` from `PW_BASE_URL`, HTTP Basic gate, default geolocation, mobile project. |
| `fixtures.ts` | Toolbox the agent imports: `namespace` fixture, `authenticate`, `cleanup`, and helpers `setLocation`/`goOffline`/`readCookies`/`readStorage`/`asset`. |
| `eslint.config.js` | Filter B (lint): catches hard waits, element handles, tests without asserts. |
| `tsconfig.json` | Filter B (typecheck). |
| `package.json` | The project's deps (Playwright runner, eslint, tsc). |
| `.qa/manifest.json` | Per-test metadata registry (objective, flow, targets...). |
| `assets/` | Files uploaded by tests and their optional metadata. |

## Conventions (single app, standardized microservices)

- A **single shared fixtures library** (`fixtures.ts`) at the root of `e2e/`;
  specs are organized per microservice in subfolders.
- The agent **reuses and improves** what exists; it does not duplicate. The app's
  real login is implemented once by overriding the `authenticate` fixture.

## How the orchestrator invokes it

With `cwd` = the repo's `e2e/` and env `PW_BASE_URL` (DEV) + `PW_NAMESPACE`:

```
npm ci                               # setup (project deps)
npx tsc --noEmit                     # Filter B: typecheck
npx eslint .                         # Filter B: lint
npx playwright test --list           # Filter B: load
npx playwright test --reporter=json  # Filter C: run + detect flaky
```

On green, the agent commits `e2e/` into the app repo and a PR is opened against it
(auto-merge if the repo allows it). The tests live in the app's own git history, not
in panchito.
