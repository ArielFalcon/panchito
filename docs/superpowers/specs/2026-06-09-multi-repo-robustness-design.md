# Multi-repo robustness — design

**Date:** 2026-06-09
**Status:** approved (user), pending implementation
**Goal:** make the pipeline robust for a real microservices + frontend application:
cross-repo context for the agent, cross-repo triggering, diff-mode parallel
generation, reviewer-feedback learning, and a working TUI onboarding/deletion flow.

## Context

The capability audit (2026-06-09) found four gaps for the microservices + front
use case:

1. A watched app is fundamentally single-repo (`AppConfig.repo: string`); the
   agent never sees context from more than one repo in a run.
2. Reviewer rejections regenerate within a run (max 2 rounds) but never feed
   persistent learning — only oracles produce `LearningRule`s.
3. Agent fan-out (plan → up to 5 `qa-worker`s) exists only in
   `complete`/`exhaustive` mode; `diff` (the webhook path) is single-agent.
4. The TUI onboarding wizard is unusable: it calls `github.getRepo()` in the TUI
   process, which requires `GITHUB_TOKEN` on the host — but secrets live only in
   the containers (Doppler). It also writes config bypassing the control API.

Key existing building block: `ArchitectureContext` (`e2e/.qa/context.json`,
`src/qa/context.ts`) already models the FE↔BE join and `ApiOperation.service`
already names an owning microservice — but the map is built from one repo only.

## Decisions

- **Model: app with `services[]`** (chosen over separate-apps-with-triggers and
  a federated workspace concept). One e2e app (the front) declares its
  microservice repos. One suite, one publish target (the primary repo).
- **Trigger semantics: deploy-event.** For services, the CI/CD sends the webhook
  POST *after* a successful deploy to DEV. The payload shape is unchanged
  (`{repo, sha}`). An optional per-service `versionUrl` adds a verification belt.
- **TUI becomes a thin client.** Everything that needs secrets or writes config
  runs server-side through the control API.

## 1. Config & schema

`AppConfigSchema` (`src/orchestrator/schemas.ts`) gains:

```yaml
services:                       # optional; e2e apps only
  - repo: "org/orders-svc"      # required, unique across primary + services
    openapi: "**/openapi/*.yaml"  # optional glob INSIDE the service repo
    versionUrl: "https://..."     # optional deploy-verification endpoint
    pollIntervalMs: 10000         # optional, defaults as today
    deployTimeoutMs: 600000       # optional, defaults as today
qa:
  parallelDiff: true            # optional, default false (see §7)
```

Validation rules:
- `services` is rejected when `code: true` (code-mode apps have no E2E suite).
- `repo` values must be unique across the primary repo and all services.
- Apps without `services` behave exactly as today (zero change for `portfolio`).

## 2. Webhook routing & fan-out

- `loadAppConfigByRepo(repo)` → `loadAppConfigsByRepo(repo)` returning **all**
  matches with a role: `{ app, role: "primary" | "service" }`. A repo may be a
  service of one app *and* its own (e.g. code-mode) app; the webhook enqueues one
  run per match. The sequential queue serializes them — no queue changes.
- `RunRequest` / `RunRecord` gain `triggerRepo?: string`. For service-triggered
  runs, `app` is the e2e app, `sha` is the **service's** commit SHA, and
  `triggerRepo` names the service repo (TUI/history show the origin).
- Documented contract: for services, the webhook is sent by CI/CD **after
  deploy** (deploy-event semantics chosen by the user).

## 3. Deploy gate

- If the triggering repo (primary or service) declares a `versionUrl`, the gate
  polls it for the SHA (belt over the deploy event).
- Without `versionUrl`, the gate is skipped — we trust the deploy event (same
  behavior as today's static-site apps).
- The pre-execute health check against the app's `dev.versionUrl` is unchanged.

## 4. Cross-repo preparation (two mirrors)

For a run triggered by a service commit:

- **Primary mirror:** the front repo at the HEAD of `baseBranch` (the service
  SHA does not exist there; the suite and publish base live here).
- **Service mirror:** `ensureMirror(service.repo, sha)`; `diff`, `message` and
  `classifyCommit` come from it. A `docs:`/`style:` commit in a micro is still
  `skipped` without spending a token.
- **Other services are NOT cloned in diff runs** (their context comes from the
  map). All services are cloned only in `context` mode (§5).

## 5. Multi-repo agent context

- **`context` mode extended:** the orchestrator mirrors every `services[]` repo
  and passes their paths + `openapi` globs to the agent, which extracts
  `ApiOperation`s per service (filling the existing `service` field) and joins
  them to the front's routes. One `context.json`, committed to the primary repo.
  `validateContext` is unchanged (it already supports `service`).
- **`diff` mode cross-repo:** `GenerateInput` gains
  `service?: { repo: string; mirrorDir: string; openapi?: string | string[] }`.
  `buildTask` renders a cross-repo section: the change happened in service X
  (code read-only at `<mirrorDir>`); use the context map (`operations` with
  `service = X`) plus the service's OpenAPI to find affected routes/flows;
  exercise the backend **only through the UI**. The opencode container already
  sees the service mirror (shared `mirrors` volume).
- **Map absent or service unmapped:** inject a warning into the prompt and
  continue — the map is an authoring aid, never a gate (existing invariant).

**Honest limitation:** change-coverage measures front code (browser V8). In
service-triggered runs the changed lines live in the service, so change-coverage
reports `unknown` (signal); `enforce` never blocks these runs. Documented in
`docs/change-coverage.md` when implemented.

## 6. Failure reporting

- On `fail`, the Issue opens in the **triggering repo** (the service whose
  commit broke the flow), referencing the run and the front specs that failed.
- The PR with tests always targets the **primary repo** (the suite lives there).
- The agent remains read-only on **all** mirrors; only the orchestrator writes.

## 7. Diff-mode parallelism

- `useParallel` (`src/pipeline.ts:166`) extends to `diff` mode when
  `qa.parallelDiff: true`: the plan phase (scoped to the diff's blast radius,
  not the whole repo) splits work into objectives; with ≥ 2 objectives, fan out
  `qa-worker`s via the existing `runOpencodeParallel` (bounded concurrency 5);
  with 1, fall back to the single-agent path.
- Default **off** — protects cost/determinism for simple apps; recommended for
  apps with `services`.
- Re-generation passes (`fixCases`, `reviewCorrections`, `coverageGap`) remain
  single-agent, as today.

## 8. Reviewer → learning

- After a run whose reviewer rejected (non-empty
  `RunOutcome.gateSignals.reviewerCorrections`), a new off-path step distills
  each correction into a `LearningRule` candidate through the existing path
  (`deduplicateRules` / `upsertLearningRule`, `src/qa/learning/distiller.ts`).
- New `ErrorClass` `reviewer-rejection` added to the taxonomy if absent.
- Rules are retrieved into future prompts by the existing `retrieveRules` →
  `learnedRules` injection. Off-path: failures never block the run (same
  contract as `saveOutcome`).

## 9. TUI onboarding & deletion (via control API)

**Root cause of the current bug:** `OnboardWizard` calls `github.getRepo()` in
the TUI process (`OnboardWizard.tsx:58` → `github.ts:48`
`requireEnv("GITHUB_TOKEN")`), which throws on the host where Doppler does not
inject secrets. It also writes YAML from the TUI's cwd, bypassing the control
API.

**Fix — server-side onboarding:**

- **`POST /api/apps`** — body: onboarding input (name, repo, dev, target, qa
  flags, `services[]`, `env` map). The server validates the repo against GitHub
  (its token), builds the YAML, validates it with `AppConfigSchema`, writes
  `config/apps/<name>.yaml` (the `./config` mount makes it visible on the
  host), and returns the app view + warnings. A `dryRun` flag returns the YAML
  without writing (used by the wizard's review step).
- **Secrets:** any `${VAR}` the config needs is collected by the wizard and sent
  in `env`. The server applies them to `process.env` (immediate effect —
  `expandEnv` reads at config-load time) and persists them to `.env`, each on
  its own line with no inline comment (known compose gotcha). Values are never
  echoed back (responses redact). Doppler users get a warning in the response:
  persist the var in Doppler too or it dies with the container.
- **`DELETE /api/apps/:name`** — deletes the YAML. With `?purge=1`, also deletes
  the app's mirror (regenerable cache) and its run history. Default keeps
  history (audit trail).
- **Wizard rework:** thin client over `src/tui/client.ts`. New steps: repeatable
  "add service" (repo + OpenAPI glob + optional versionUrl), env-var collection,
  review (server `dryRun` YAML), commit. `buildYaml` stays pure/shared for
  preview; the authoritative build + write is the server's.
- **TUI "Delete project"** action with a confirmation screen listing exactly
  what will be removed (config file; optionally mirror + history).

## Error handling

- Unknown repo in webhook → warn + ignore (as today).
- Service mirror clone/fetch failure → `infra-error` (not a code bug).
- Missing/unparseable context map → warning in prompt, run continues.
- `POST /api/apps` with invalid config → 422 with the Zod errors; nothing
  written.
- Secrets write failure (`.env` not writable) → 500 with explicit error; the
  in-process env is NOT applied (no half-applied state).

## Security invariants (unchanged, restated)

- The agent is read-only on all watched repos, services included. Only the
  deterministic orchestrator does git writes; publish targets only the primary
  repo.
- Service diffs pass through `src/orchestrator/sanitizer.ts` before reaching
  the model (same path as today).
- The control API accepts secrets only over the operator's trusted network
  (same exposure as the existing API; no new surface).

## Testing strategy

Every new side effect enters through `PipelineDeps` / `*Deps` (existing DI
pattern) and is unit-tested with stubs:

- routing fan-out (`loadAppConfigsByRepo`: primary, service, both, none)
- schema validation (`services[]` rules, `parallelDiff`)
- pipeline cross-repo branches (two mirrors, gate selection, classify on the
  service commit, issue target, coverage `unknown`)
- diff parallelism gating (flag off/on, 1 vs ≥2 objectives, re-gen stays single)
- reviewer-corrections distillation (dedup, off-path failure tolerance)
- API handlers (`POST`/`DELETE /api/apps`, dryRun, env redaction, purge)

`npm test` and `npm run typecheck` stay green per phase.

## Phases (each independently shippable)

1. **F1 — core cross-repo:** schema `services[]`, webhook fan-out routing,
   deploy gate per triggering repo, two-mirror prepare, GenerateInput.service,
   issue-to-triggering-repo. (§1–§4, §6)
2. **F2 — multi-service context map:** context mode mirrors all services and
   builds the joined map. (§5)
3. **F3 — diff parallelism:** `qa.parallelDiff` + diff-scoped planning. (§7)
4. **F4 — reviewer → learning:** corrections distillation + taxonomy class. (§8)
5. **F5 — TUI onboarding/deletion:** API endpoints + wizard rework + delete
   flow. Depends on F1 (services in the schema). (§9)

## Out of scope

- Measuring change-coverage inside service repos (would require service-side
  instrumentation).
- Doppler API integration for secrets (manual step, warned in the API response).
- Concurrent runs (the sequential queue is an invariant).
- A federated multi-app "system" concept (rejected as YAGNI).
