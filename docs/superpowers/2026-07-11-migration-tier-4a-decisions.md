# migration-tier-4a — Decisions of Record

Date: 2026-07-11. Change: `migration-tier-4a` (branch `fix/migration-tier-4a`). Scope: the
triage doc's Tier-4 candidates `src/integrations/github.ts` (publication verbs), `src/integrations/
repo-mirror.ts` (write side), `src/qa/setup.ts` — the first sub-change of the `migration-tier-4`
program (`sdd/migration-tier-4/proposal`, engram id #1277). Gated design review: `sdd/
migration-tier-4a/design` (engram id #1281), fresh-context adversarial pass, GATE PASS.

---

## 1. In-scope migrated (3 slices, 3 work-unit commits)

| # | Slice | Destination | Commit | HEAD evidence |
|---|---|---|---|---|
| 1 | `src/integrations/github.ts` — `createPullRequest`/`enableAutoMerge`/`mergePullRequest`/`openIssue` HTTP + clamp | `GitHubPrAdapter`/`GitHubIssueAdapter` (qa-engine `workspace-and-publication/infrastructure/`) now own the fetch call directly; new `github-http.ts` (GitHubHttpDeps type + duplicated clamp) | `52eb2a2` | Confirmed via `rg` before deleting `openIssue`: only `github.test.ts` and the retiring factory closure (`rewritten-engine-factory.ts:1074`, pre-slice) referenced it. `createPullRequest`/`enableAutoMerge`/`mergePullRequest`/`getPrStatus`/`getPullRequest`/`getRepo`/`listRepos` verified consumed by `src/server/maintainer-runtime.ts` and `src/index.ts` (onboarding/admin) — left byte-identical. |
| 2 | `src/integrations/repo-mirror.ts` — `ensureMirror`/`ensureMirrorAtBranch` provisioning ARGV | `MirrorProvisionAdapter` (qa-engine `workspace-and-publication/infrastructure/`); `repo-mirror.ts` keeps both functions exported as thin delegating wrappers (see §2 below — NOT a full delete) | `096e42c` | `repo-mirror.test.ts`'s 46 tests pass UNMODIFIED against the wrapper (byte-identical behavior proof). |
| 3 | `src/qa/setup.ts` — full body (bootstrap/install/ensureSpecDir/ensureFailureCapture/ensurePlaywrightEnvKeys) | `SetupAdapter` (qa-engine `workspace-and-publication/infrastructure/`), bound into `SetupPortAdapter.e2e` | `f467f71` | `rg`-confirmed before deleting: only `rewritten-engine-factory.ts` and `setup.test.ts` itself consumed `src/qa/setup.ts`'s exports. Full deletion (`src/qa/setup.ts` + `setup.test.ts` both removed). |

Every slice: `npm test` + `npm run typecheck` + `npm run arch:check` green before its commit,
Strict TDD (RED confirmed before each new adapter existed, then GREEN). Final state: 3739/3740
tests pass (1 pre-existing skip, unrelated), typecheck clean across all 5 programs, `arch:check`
0 violations (175 modules, 436 dependencies — up from 172/430 baseline).

---

## 2. Design correction: setup.ts is `SetupPort`, not `WorkspacePort`

The proposal's own scope line said "setup.ts→WorkspacePort". The gated design (`sdd/
migration-tier-4a/design`) flagged and corrected this before apply: `WorkspacePort.prepare`
(qa-engine's checkout contract) is checkout-only — it resolves a mirror to a working directory at
a SHA/branch. `setup.ts`'s `setupE2eProject` is a DIFFERENT concern (seed bootstrap + dependency
install, run AFTER checkout, BEFORE generation) with its own existing port
(`SetupPort`/`SetupPortAdapter`, already wired in `qa-run-orchestration`). The design bound the
new `SetupAdapter` into the EXISTING `SetupPortAdapter.e2e` slot rather than inventing a
`WorkspacePort`-shaped home — the context is still literally "workspace" (working-copy lifecycle
+ VCS/GitHub egress + security seam), so `SetupAdapter` lives in
`workspace-and-publication/infrastructure/` alongside `MirrorProvisionAdapter`/`GitHubPr/
IssueAdapter`/`VcsWriteAdapter`, but it implements `SetupPort`, not `WorkspacePort`. This keeps
every working-copy WRITE (checkout/seed/install/commit/push) under the ONE arch-lint-guarded
security seam (`no-vcs-write-in-agent-contexts`) without conflating two genuinely different port
contracts.

---

## 3. github.ts split: dual transport accepted, no shared `githubFetch` helper

The design's open question ("accept dual transport, or extract a shared shell `githubFetch`
helper?") resolved to **dual transport, accepted**:

| Trust domain | Owner | Verbs | Rationale |
|---|---|---|---|
| Watched-repo publish (agent-generated suite) | qa-engine's `GitHubPrAdapter`/`GitHubIssueAdapter` | createPullRequest/enableAutoMerge/mergePullRequest/openIssue — own HTTP directly, `{fetch, authHeaders}` injected by the factory | This is the path that ships an LLM-generated test suite into a repo the agent has NEVER been granted write access to (CLAUDE.md's read-only-agent invariant); it belongs behind the SAME structural seam as `VcsWriteAdapter`/`MirrorProvisionAdapter`. |
| Maintainer self-repair + onboarding/admin | `src/integrations/github.ts`'s `github` object (unchanged) | createPullRequest/enableAutoMerge/mergePullRequest (byte-identical) + getPrStatus/getPullRequest/getRepo/listRepos | `src/server/maintainer-runtime.ts` fixes THIS repo, not a watched one — a categorically different trust boundary (D1: `src/agent-runtime` and its self-maintenance callers are declared permanent shell survivors, `migration-remediation` Slice 8.D). `src/index.ts`'s onboarding/admin repo-discovery reads are shell-forever by the same governing boundary (`2026-07-09 triage doc`, "control-plane server is shell-forever"). |

Both transports call the real GitHub REST/GraphQL API with an independently-built request
(clamp, headers, endpoint) — accepted, minor duplication over a shared internal helper that would
otherwise blur the trust-domain boundary the split exists to enforce. `GITHUB_MAX_TITLE`/
`GITHUB_MAX_BODY`/`clampTitle`/`clampBody` are duplicated (not shared) between
`src/integrations/github.ts` and qa-engine's new `github-http.ts`, for the structural reason
`arch:check`'s `no-src-import-in-qa-engine` rule forces on every relocated leaf: qa-engine may
never import `src/`.

---

## 4. Shell-survivor declarations

Per the design's decision table, DECLARED (not migrated, not incidental) shell survivors after
this slice:

- **`src/integrations/repo-mirror.ts`** — the credentialed-git supplier: `realGit`,
  `authHeaderArgs`, `tokenlessUrl`, `hardenGitArgs`, `scrubGitError`, `assertHexSha`,
  `assertBranchName`, `workdirRoot`, `defaultMirrorDeps`, plus every READ-side helper
  (`getCommitDiff`, `getCommitMessage`, `listChangedSpecs`, `getCommitsBehind`,
  `getChangedFilesInRange`, `getRangeDiff`, `resolveRef`). `GITHUB_TOKEN`/`GIT_REMOTE_BASE`/
  `MIRROR_DIR` env reads never leave this module. `ensureMirror`/`ensureMirrorAtBranch` stay
  exported here too (see §5 — NOT a clean move) but their provisioning ARGV now lives in
  qa-engine's `MirrorProvisionAdapter`.
- **`src/integrations/github.ts`** — the maintainer/onboarding/admin trust-domain functions
  (`createPullRequest`, `enableAutoMerge`, `mergePullRequest`, `getPrStatus`, `getPullRequest`,
  `getRepo`, `listRepos`), byte-identical, per §3 above.

---

## 5. Design-gap finding: `repo-mirror.ts` is NOT a full delete (deviation, justified)

The design's own File Changes table said `src/integrations/repo-mirror.ts` | Modify | "Slim to
credentialed-git supplier + guards + shell read helpers" — read at apply time as: delete
`ensureMirror`/`ensureMirrorAtBranch` from `repo-mirror.ts` entirely, with the factory calling
`MirrorProvisionAdapter` directly.

Re-verifying every consumer against HEAD before deleting (the proven lesson this program's own
Approach section names: "triage lists are stale candidates") surfaced a production consumer the
design's decision table did not account for: **`src/index.ts`'s onboarding job calls
`ensureMirrorAtBranch(repo, baseBranch, defaultMirrorDeps)` directly** (`src/index.ts:483-484`,
wired into `createOnboardingJob`'s `ensureMirrorAtBranch` collaborator) — a SECOND production call
site beyond the composition factory's `checkout` closure.

**Resolution**: `repo-mirror.ts` keeps `ensureMirror`/`ensureMirrorAtBranch` exported with their
ORIGINAL byte-identical 3-argument signature (`(repo, sha|branch, deps: MirrorDeps) =>
Promise<string>`), now as thin wrappers (`toProvisionDeps` adapts `MirrorDeps` into
`MirrorProvisionDeps`, decorating the injected `git` fn to prepend `authHeaderArgs()` for
clone/fetch only — mirroring the factory's own `withPublishGitDecorations` precedent) that
delegate to `MirrorProvisionAdapter`. Zero changes were needed to `src/index.ts`, to the
factory's `checkout` closure (still calls `mirror.ensureMirror(repo, sha, defaultMirrorDeps)`,
3-arg), or to any of the 15+ pre-existing `rewritten-engine-factory.test.ts` mirror-seam tests —
all confirmed green, unmodified, alongside `repo-mirror.test.ts`'s 46 tests.

**Lesson for the remaining `migration-tier-4` sub-changes (4b/4c/4d)**: a design's enumerated
caller list is a snapshot, not a guarantee — `rg` every candidate module's exports against the
CURRENT HEAD immediately before deleting, even when the design already did a consumer pass. This
is the third time this exact class of gap has surfaced in this migration program (see
`2026-07-09-src-qa-engine-migration-triage.md`'s own framing quote: "the proven lesson (triage
lists are stale candidates)").

---

## 6. Triage doc update

`docs/superpowers/2026-07-09-src-qa-engine-migration-triage.md` §4's Tier-4 bullet is updated in
the same commit as this doc: `repo-mirror.ts` (write side), `github.ts` (adapters — closures
replaced), and `setup.ts` move to DONE (this change, §1 above). Remaining Tier-4 candidates
(`code-runner.ts`, `execute.ts`, `src/agent-runtime/*`, `prompts.ts`, `opencode-client.ts`, plus
the composition/seam-parity dissolution) are unchanged, carried forward to `migration-tier-4b`/
`4c`/`4d` per the program's chained-sub-change plan.
