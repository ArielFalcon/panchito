# Architecture as explicit knowledge (`ai-context`)

> Status: **foundation implemented** (the schema + deterministic validator). The
> generation mode, consumption, and cadence are designed below and sequenced as the
> next slices. Built against the invariants in `CLAUDE.md`.

## The problem it solves

A Playwright E2E test targets a **user journey** (a route/flow), and a journey in an
Angular + Spring system crosses a boundary that nothing in the current stack can see:

- **Serena** gives blast radius **within one repo and one language**. It cannot cross
  from an Angular `HttpClient` call (TypeScript) to the `@RestController` (Java) it hits.
- The **commit diff** shows changed symbols, not the *journey* they belong to.
- **engram** holds volatile lessons, not the fixed structure.

So the agent re-derives "which flow / which backend does this change touch?" from raw
code on every run — expensive, and it under-scopes the blast radius (a frontend commit's
true impact often includes backend behaviour, and vice-versa).

`ai-context` makes that connective tissue **explicit, small, and versioned**, so the
agent reads a distilled map instead of re-deriving it.

## What it is

A git-versioned artifact in the watched app repo: **`e2e/.qa/context.json`** (sibling of
`manifest.json` and the `complete`-mode `analysis.json`). Schema + validator:
[`src/qa/context.ts`](../src/qa/context.ts). Sections:

| Section | What | Source it is extracted from |
|---|---|---|
| `routes` | Frontend entry URLs (the unit an E2E targets) + the component each renders | Angular routing (`Routes`) |
| `api` | Backend operations (`operationId`, method, path, service) | the microservices' OpenAPI specs |
| `feBe` | **The join**: route → `operationId` it exercises (via which client symbol) | generated API clients (the `operationId` is the join key) |
| `flows` | *(optional)* named user flows grouping routes + operations | agent labelling |

Plus `builtAtSha` for provenance/staleness. The validator enforces that **every `feBe`
link resolves** to a known route and a known operation — the join is the whole point, so
a dangling link is an error.

## Design decisions (and why)

- **Extracted, not invented.** Every section comes from a structured source (routing,
  OpenAPI, generated clients). It is an **authoring aid, never a quality gate** — it
  scopes work, it does not decide what ships. So its residual error is bounded and it
  does **not** reintroduce the §3 Goodhart risk (unlike a map that fed a merit signal).
- **Agent generates it; a deterministic schema gates it.** The extraction is
  language/framework-specific (Angular lazy routes, Spring), so it cannot live in `src/`
  (invariant: nothing app-specific in `src/`). The agent is precisely the cross-language
  tool for it. Determinism is recovered three ways: (1) `validateContext` is a deterministic
  gate; (2) the artifact is committed via PR → human-reviewable; (3) it is regenerated from
  source, so it self-heals. `src/qa/context.ts` stays generic (schema only).
- **Fixed knowledge → git** (per the project's git-vs-engram split): the map lives in the
  app repo, versioned and reviewable. engram still holds only volatile lessons.
- **Scoped to what an E2E needs.** Only routes / API / FE↔BE / flows. **Excluded** on
  purpose: bounded contexts, k8s/service topology, CI/CD — that is documentation for
  humans, not input to a Playwright spec (and would blow the context budget).
- **Generated on cadence, read per-commit.** Building the map is a maintenance task
  (scheduled, or on a routing/OpenAPI change), not per-commit work. Per commit the agent
  only **reads the relevant slice**.

## Build sequence

1. **[DONE] Schema + deterministic validator** — `src/qa/context.ts` (+ `.test.ts`, 8 tests).
   The gate that keeps the agent-produced map internally consistent.
2. **[NEXT] `context` run mode** — add `"context"` to `RunMode` (`src/types.ts`), the CLI
   flag (`src/cli.ts`), and a `buildTask` branch (`src/integrations/opencode-client.ts`)
   instructing the agent to (re)build `e2e/.qa/context.json` from the structured sources.
   Pipeline path: build → `validateContext` (Filter B) → publish the `e2e/` change via PR;
   **skip Filter C** (no specs to execute). This is the one piece that touches the core
   pipeline — keep it small and fully unit-tested with stubs, like the existing modes.
3. **[NEXT] Agent generation procedure** — a new skill `opencode/skill/architecture-mapping`
   + a `context`-mode procedure in `qa-generator.md`: extract `routes` from Angular routing,
   `api` from OpenAPI (reuse the OpenAPI-context convention already in `AGENTS.md`), and
   `feBe` by following each generated client method to its `operationId`.
4. **[NEXT] Consumption in `diff` mode** — at generate time, the agent reads the slice of
   `context.json` whose routes/operations intersect the changed files, to (a) derive the
   journey to test and (b) widen the blast radius across the FE↔BE boundary. The orchestrator
   passes a location hint (same pattern as the `openapi` hint), never parsing the file.
5. **[NEXT] Cadence** — a scheduled `context` run (cron) + invalidate when a diff touches
   routing or an OpenAPI spec. Until then it can be refreshed on demand via the CLI.
6. **[LATER] Harness wiring** — when `context.json` is present, fold `validateContext` into
   the static gate so a malformed map is caught like a bad manifest.

## Open decisions

- **Single file vs folder.** Started as one `context.json` (simplest to validate/consume).
  Split into `context/{routes,api,fe-be}.json` only if a single file gets unwieldy per service.
- **Fold into `complete` mode vs a dedicated `context` mode.** Kept separate (single
  responsibility; `complete`/`exhaustive` can *read* the map). Revisit if the overlap grows.
- **Slice granularity for consumption.** Map changed file → route/operation: by component
  ownership (frontend) and by handler file (backend). Needs the generated-client convention
  to be consistent across services.
