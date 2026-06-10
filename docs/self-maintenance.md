# Self-maintenance & autonomous self-merge — safety architecture

ai-pipeline can diagnose and fix incidents in **its own** codebase, then deploy the fix to
the running service **without a human in the loop**. That is a powerful but dangerous
capability: a self-modifying service must never ship a change that breaks itself *and*
removes its own ability to recover (an irrecoverable state). This document describes the
defense-in-depth that makes autonomous self-merge safe enough to opt into.

> Toggle: `SELF_MAINTAINER_AUTOMERGE` (default `false`). Set to `true` to let verified fixes
> auto-deploy; left at `false`, every fix stops at an open PR for a human to review and merge.

## The flow at a glance

```
incident detected (health poller / log scraper / report API)
        │
        ▼
qa-maintainer agent edits files IN PLACE on a fix branch  (read-only on watched repos;
        │                                                  the orchestrator owns all git)
        ▼
orchestrator: commit → push → open PR
        │
        ▼  ── pre-deploy SAFETY GATES (all must pass; any failure ⇒ leave PR for a human) ──
        │   1. justification mandatory   (rootCause / whyNecessary / whyMinimal)
        │   2. ops kill-switch           (SELF_MAINTAINER_AUTOMERGE)
        │   3. scope / protected-path    (cannot touch the recovery net or build/topology)
        │   4. change-size               (≤ 15 files / 400 lines)
        │   5. rate / loop               (≤ 3 deploys/hour, 5-min cooldown; persisted)
        │   6. self-test                 (npm install + typecheck + test on the fix branch)
        ▼
CANARY: hot-swap the fix into the RUNNING service (backup + boot-guard armed) → restart
        │
        ▼
post-restart health check  ──unhealthy──▶  rollback to backup, restart; PR stays unmerged
        │ healthy                                     (main never touched)
        ▼
PROMOTE: merge the PR to main, gated by the OUTER GUARD (required `ci` check)
```

The keystone is **canary before promote**: `main` — the source of truth a fresh,
ephemeral container clones — is only ever updated *after* the fix has booted healthy in
production. An unverified fix can never poison `main`, so the system can always recover by
re-cloning the last known-good `main`.

## The layers

### 1–6. In-process pre-deploy gates (`src/server/merge-guard.ts`)
Pure, unit-tested decisions; the irreversible actions are taken in `src/index.ts` only after
all of them pass.

- **Scope / protected-path guard.** A fix may **never** modify the recovery net
  (`boot-guard.mjs`, `src/server/self-update.ts`, `src/server/merge-guard.ts`) or
  build/topology the in-process canary cannot verify (`Dockerfile`s, `docker-compose.yml`,
  `.github/`). This is what guarantees the rollback machinery itself stays immutable to the
  agent — the core *“can always recover”* property.
- **Change-size guard.** A maintainer fix is a small, targeted repair; anything larger is by
  definition not minimal and is left for a human.
- **Rate / loop guard.** A persisted ledger (`data/maintainer-deploys.json`, survives the
  hot-swap restart) caps self-deploys per window and enforces a cooldown, so a fix that
  doesn’t actually fix cannot loop the system into endless self-modification.
- **Self-test gate.** `npm install + typecheck + test` on the fix branch HEAD.

### 7. Canary + boot-guard rollback (`src/server/self-update.ts`, `boot-guard.mjs`)
`performSwap` backs up the live tree (`src.bak` + `package*.bak`) and arms a marker before
staging the new code. On restart:

- **Boots & serves** → `confirmSwapAfterBoot` clears the marker/backups and promotes (below).
- **Boots but not serving** → `confirmSwapAfterBoot` rolls back to the backup and restarts.
- **Crash-loops** (never reaches the app) → `boot-guard.mjs` (repo-root, **never swapped**, so
  it always runs intact) restores the backup after `MAX_BOOT_ATTEMPTS`.

In every failure case the PR is still **unmerged**, so `main` stays known-good.

### 8. Outer guard — required `ci` check on `main`
The gates above run *inside* the orchestrator (the very process that is self-modifying). The
**outer guard** is a GitHub-side, independent check so that even if those in-process gates
were ever weakened by a bad self-edit, GitHub itself refuses a bad merge:

- `.github/workflows/ci.yml` runs the same gate (typecheck + tests) on every PR and push.
- Branch protection makes the `ci` check **required** on `main`.
- Promotion (`promote()` in `index.ts`) prefers **GitHub-native auto-merge**, so GitHub
  merges only once the required check passes. Without branch protection it falls back to
  self-enforcing the guard (poll CI, merge only on green).

#### One-time setup
```bash
GITHUB_TOKEN=<admin-token> ./scripts/setup-branch-protection.sh ArielFalcon/ai-pipeline
```
This enables “Allow auto-merge” and requires the `ci` check on `main` (strict, enforced on
admins, no human-review requirement — the gate is CI + the layered safety gates, since the
point is autonomous repair).

### 9. Learning from failures (so it doesn’t break the same way twice)
Every time a fix is rejected or rolled back — pre-deploy gate, canary unhealthy, boot crash-loop,
or a red/timed-out required CI check — the orchestrator appends a record to a persistent failure
memory (`data/maintainer-failures.json`, survives the restart). The next maintainer prompt opens
with a **“Past fix attempts that FAILED — do NOT repeat these mistakes”** section listing the
recent failures, what each one *assumed* the root cause was, what it changed, and why it failed.

The crash-loop case is bridged from `boot-guard.mjs` (which can’t use the app’s modules): on
rollback it drops `data/last-rollback.json`, and the restored, healthy app folds it into the
failure memory on its next boot (`recoverRollbackRecord`).

## Deployment (so the hot-swap actually works)
The hot-swap rewrites `src/` + the package files in place. A **bind-mounted** `src/` is a
mountpoint (and the package files are bind-files), which `rmSync`/`cpSync` cannot replace
(`EBUSY`) — so the swap only works when those paths come from the **baked image**:

- **Production:** `docker compose -f docker-compose.yml up --build` — runs the image's baked
  `src/`; hot-swap + rollback work.
- **Local dev:** `docker compose up` — auto-loads `docker-compose.override.yml`, which
  bind-mounts the host source for live editing. Hot-swap is a deliberate **no-op** here (it
  fails safe: no swap, no restart); dev doesn't self-update.

The hot-swap is **ephemeral** (it writes the container's writable layer; a *recreate* without a
rebuild reverts to the image's `src/`). `main` is the durable source of truth — rebuild the image
from `main` (CI/CD) to bake in merged fixes. This is consistent with canary-before-promote: a
fresh container always clones/builds a known-good `main`.

## Networking notes
- **DNS:** both containers pin public resolvers (`dns: [1.1.1.1, 8.8.8.8]` in
  `docker-compose.yml`) so egress to `github.com` / the model gateway / the DEV site is
  deterministic under VPN/split-DNS. All GitHub git+API calls run in the **orchestrator** (the
  agent has no token and never pushes), so a `github.com` DNS failure is an orchestrator problem.
- **Proxy:** Node’s `fetch` doesn’t honor `HTTP_PROXY` by itself; `src/util/net.ts` installs
  undici’s `EnvHttpProxyAgent` globally (a no-op when no proxy env is set), so the system is
  proxy-ready without code changes.

## Threat model — why this can’t reach an irrecoverable state
| Failure | Caught by | End state |
|---|---|---|
| Fix breaks tests/typecheck | self-test gate (6) **and** outer `ci` (8) | not deployed / not merged |
| Fix boots but doesn’t serve | canary check (7) | rolled back; `main` untouched |
| Fix crash-loops | boot-guard (7) | rolled back; `main` untouched |
| Fix that doesn’t fix → retries forever | rate/loop guard (5) | stops; human asked |
| Over-large rewrite | size guard (4) | left for a human |
| Fix that disables the rollback net | protected-path guard (3) | left for a human |
| In-process gates weakened by a self-edit | outer `ci` check (8) | GitHub refuses the merge |
| Bad code already on `main` (it never gets there) | canary-before-promote | fresh clone is good |
