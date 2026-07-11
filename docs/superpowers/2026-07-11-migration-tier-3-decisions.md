# migration-tier-3 — Decisions of Record

Date: 2026-07-11. Change: `migration-tier-3` (branch `fix/migration-tier-3`). Scope: the triage
doc's Tier-3 candidate list (`docs/superpowers/2026-07-09-src-qa-engine-migration-triage.md`,
§4) — `deploy-gate.ts`, `validate.ts`/`code-validate.ts`, `metadata.ts`, `playwright-report.ts`,
`reexplore.ts`, `learning/learning-rule.ts`. Gated design review: `sdd/migration-tier-3/design-
review` (discovery, engram id #1276), fresh-context adversarial pass, GATE PASS with no defects.

---

## 1. In-scope migrated (1 module — deploy-gate REDUCE)

| # | Module | Destination | Commit | HEAD evidence |
|---|---|---|---|---|
| 1 | `src/env/deploy-gate.ts` | `shaMatches` → `qa-engine/src/shared-kernel/sha.ts` (byte-identical body, co-located with the `Sha` value object) | `73ce0a1` | Only importer/caller was `src/server/rewritten-engine-factory.ts:137` (import) / `:1124` (call site), rg-confirmed repo-wide before deletion. The rest of the module (`waitForDeploy`/`DeployTarget`/`VersionInfo`/`DeployTimeoutError`/`GateDeps`/`defaultDeps`) had NO consumer besides its own test — the live gate is, and already was, `DeployGatePortAdapter.waitUntilServing` (`deploy-gate-port.adapter.ts:44-52`), its own independent poll loop. `src/env/deploy-gate.ts` and `src/env/deploy-gate.test.ts` deleted whole; the shaMatches unit matrix (equal / short-vs-full prefix either way, case-insensitive / different-SHA / too-short-prefix / empty / undefined) moved verbatim into `qa-engine/test/shared-kernel/sha.test.ts` (extended, not created — it already existed hosting `Sha`'s own tests). No new port was needed — unlike the triage doc's original "needs a new port" note for this module, the live poll loop already existed pre-migration; this slice only relocated the pure `shaMatches` helper and deleted the now-fully-dead shell. |

Non-change, noted for the record: `src/errors.ts:45/50` and `qa-engine/src/shared-kernel/domain-
error.ts:39` both do a duck-typed `err.name === "DeployTimeoutError"` string check. Neither imports
the deleted `DeployTimeoutError` class — it's a name-string comparison against whatever error
reaches that branch — so the deletion doesn't break compilation, and both checks are pre-existing
dead code (the live `DeployGatePortAdapter.waitUntilServing` returns `err(new InfraError(...))` on
timeout, never throws a `DeployTimeoutError`-named error). Left untouched per the design-review
rider — out of scope for this change, unrelated to and unaffected by the deletion.

---

## 2. THE GATE decision: co-defer the whole validate cluster (Option B), not a partial migrate (Option A)

| Option | Trade-off | Verdict |
|---|---|---|
| (a) migrate `validate.ts`+`metadata.ts`, keep a minimal `runCheck` shell in `src/` for `code-validate.ts` | Honest ONLY if the residue left behind is small and self-contained | REJECTED |
| (b) co-defer the whole validate cluster; Tier-3 = deploy-gate alone | Honest when a partial move would fabricate a half-module | CHOSEN |

`validate.ts` carries TWO independent Tier-4 couplings, either of which alone would already be
enough to reject a mechanical move:

1. **`runCheck`/`CheckResult`/`ValidationResult`** are shared with `code-validate.ts`, which has
   a hard dependency on `code-runner.ts` (`detectCodeProject`/`resolveChangedModules`/
   `effectiveChangedFiles`/`gitWorkingChanges`/`DEFAULT_CODE_MODE_TIMEOUT_MS`/`CodeProject`/
   `Command`/`DetectDeps`) — a Tier-4 module, unmigrated.
2. **`checkManifest` → `validateManifest`** (`metadata.ts:36`) → `ManifestSchema`
   (`src/orchestrator/schemas.ts:241`, built from `ManifestEntrySchema:193`) — a shared zod hub,
   itself not a Tier-3 candidate. qa-engine's own generation context ALREADY uses a genuinely
   DIVERGENT `ManifestEntry` shape for the same `e2e/.qa/manifest.json` file
   (`manifest-fs.ts::manifestEntryViolation` deliberately re-declared a local validator instead of
   importing the schema, specifically to stay src-free). See §4 below for the full shape diff —
   reconciling the two is a deliberate Tier-4 design decision, not a mechanical move.

A partial migration (Option A) would have moved `runCheck`/`validateSpecs` into qa-engine while
either (a) stranding the manifest concern in `src/`, or (b) fabricating a THIRD manifest validator
to avoid importing `src/orchestrator/schemas.ts` from qa-engine — leaving `validate.ts` a
grab-bag of two unrelated leftovers, each still bound to a different unmigrated Tier-4 hub. That
is exactly the "fabricated half-module" failure mode the design names as the (b) trigger. The
oracle-types REDUCE precedent (`migration-tier-1-2`, `src/qa/learning/oracle-types.ts`) justifies
keeping a shell only for a SMALL, SELF-CONTAINED, single-concern residue; this is neither small
nor single-concern. The original proposal called `metadata.ts` "pure" — true in the side-effect
sense, but it is schema-coupled, and that coupling was under-weighted when the proposal scoped
"validate + metadata MIGRATE".

**Result**: Tier-3 for this change = deploy-gate REDUCE alone (§1). `validate.ts`, `code-
validate.ts`, and `metadata.ts` join the deferral register (§3) as DEFER-Tier-4, alongside the
three modules the original triage/proposal already flagged as deferred.

---

## 3. Deferral register (6 modules — HEAD evidence)

Re-verified against HEAD in the design's fresh-context gate review (`sdd/migration-tier-3/design-
review`, discovery #1276) immediately before this apply. No import direction changed for any of
these six; `npm run arch:check` stayed at 0 violations (172 modules, 428 dependencies) before and
after this slice.

| Module | Sole HEAD consumer | Class | Revisit condition |
|---|---|---|---|
| `src/qa/validate.ts` | `rewritten-engine-factory.ts` (`StaticGateAdapter` wiring) + `code-validate.ts` | DEFER-Tier-4 | With `code-runner.ts` migration + `schemas.ts` decomposition + the manifest-shape reconcile (§4) |
| `src/qa/code-validate.ts` | `rewritten-engine-factory.ts:733` (`CodeValidationStrategy` ctor) | DEFER-Tier-4 | With `code-runner.ts` migration |
| `src/qa/metadata.ts` | `src/qa/validate.ts` (`checkManifest` → `validateManifest`) | DEFER-Tier-4 | With `schemas.ts` decomposition; reconcile `QaTestMeta`/`ManifestEntrySchema` vs qa-engine's local `ManifestEntry` (§4) |
| `src/qa/playwright-report.ts` | `src/qa/execute.ts:13` (`parsePlaywrightReport`) | DEFER-Tier-4 | `execute.ts` decomposition |
| `src/integrations/reexplore.ts` | `src/integrations/opencode-client.ts:25` | DEFER-Tier-4 | `opencode-client.ts` decomposition |
| `src/qa/learning/learning-rule.ts` | `src/server/history.ts:15` + `intelligence-view.ts:1` | DEFER (D8) | D8 learning-store duality converges (`migration-remediation` decisions doc D8 — `history.ts` and `SqliteLearningRepository` remain two separate stores by deliberate decision) |

Note: the original proposal's "Out of Scope" section listed exactly 4 deferred modules
(`code-validate.ts`, `playwright-report.ts`, `reexplore.ts`, `learning-rule.ts`). The gate decision
in §2 (Option B) adds `validate.ts` and `metadata.ts` to the register — 4 + 2 = 6, matching the
table above. An earlier "7" hypothesis floated during the design-review pass was checked and
rejected: it double-counted `code-validate.ts`, which was already among the original 4, not a new
addition.

---

## 4. Manifest-shape divergence — intel for the Tier-4 proposal

Load-bearing evidence for the eventual Tier-4 reconciliation of `validate.ts`/`metadata.ts`,
confirmed against HEAD in the design-review pass (discovery #1276). Both shapes read/write the
SAME file (`e2e/.qa/manifest.json`) but are two independently-declared, structurally different
types.

**Shape A — the static gate's schema** (`src/orchestrator/schemas.ts:193-241`, consumed via
`src/qa/metadata.ts:36`'s `validateManifest` → `checkManifest` in `src/qa/validate.ts`):

```typescript
export const ManifestEntrySchema = z.object({
  id: z.string().min(1, { error: "manifest entry missing 'id'" }),
  objective: z.string().min(1, { error: "manifest entry missing 'objective'" }),
  flow: z.string().min(1, { error: "manifest entry missing 'flow'" }),
  useCase: z.string().optional(),
  targets: z.array(z.string()).min(1, { error: "manifest entry has empty 'targets'" }),
  changeRef: z.object({
    sha: z.string().min(1),
    type: z.string().min(1),
    pr: z.number().optional(),
    ticket: z.string().optional(),
  }),
  sha256: z.string().optional(),
  criticality: z.enum(["critical", "normal"]).optional(),
  owner: z.string().optional(),
  createdAt: z.string().optional(),
  coverage: z.object({ files: z.array(z.string()).optional(), functions: z.array(z.string()).optional() }).optional(),
  sensitivity: z.object({ status: z.enum(["pass", "fail", "unknown"]), method: z.string().optional(), at: z.string().optional() }).optional(),
  stability: z.object({ runs: z.number(), flakyRuns: z.number() }).optional(),
  ledger: z.object({ caughtRegressions: z.number(), falsePositives: z.number() }).optional(),
  merit: z.number().optional(),
});
export const ManifestSchema = z.array(ManifestEntrySchema);
```

**Shape B — qa-engine's local generation-side type** (`qa-engine/src/contexts/generation/
application/ports/index.ts:21-29`, validated at read-time by `manifest-fs.ts:44`'s deliberately
re-declared `manifestEntryViolation`, NOT by importing Shape A):

```typescript
export interface ManifestEntry {
  id: string;
  file: string;
  flow: string;
  objective: string;
  targets?: string[];
  changeRef?: { sha: string; type: string };
  sha256?: string;
}
```

**The gap, precisely:**

- **`file` field** — present in Shape B, absent from Shape A entirely. Shape A has no equivalent
  field at all (not even under a different name).
- **`objective` requirement** — required + non-empty in both, but Shape A enforces `.min(1)` with a
  custom error message; Shape B's TypeScript `string` gives no runtime enforcement of its own
  (enforcement happens in `manifestEntryViolation`, a hand-rolled twin of the zod check).
- **`targets`** — required, non-empty array in Shape A (`.min(1)`); OPTIONAL (`targets?: string[]`)
  in Shape B's type declaration, though `manifest-fs.ts:48`'s `manifestEntryViolation` independently
  enforces non-empty at runtime — so the enforcement exists but lives in a second, hand-written
  place instead of the type/schema.
- **`changeRef`** — required object in Shape A, with `sha`/`type` required and `pr`/`ticket`
  optional. Shape B's `changeRef` is itself OPTIONAL (`changeRef?: {...}`) and, when present, only
  carries `sha`/`type` — no `pr`/`ticket` fields exist on Shape B at all.
- **Fields entirely absent from Shape B**: `useCase`, `criticality`, `owner`, `createdAt`,
  `coverage`, `sensitivity`, `stability`, `ledger`, `merit`. None of these round-trip through
  qa-engine's generation-side manifest handling today.

Two independently-maintained validators for one on-disk contract is exactly the kind of coupling
this change's Decision 1 (§2) treats as disqualifying for a mechanical move — reconciling them
(single schema, or a documented narrow/wide-alias split like the `ErrorClass` precedent in
`migration-tier-1-2`) is Tier-4 design work, not a Tier-3 relocation.

---

## 5. Triage doc update

`docs/superpowers/2026-07-09-src-qa-engine-migration-triage.md` §4's Tier-3 row is updated in the
same commit as this doc: `deploy-gate.ts` moves to DONE (this change, §1 above); `validate.ts`/
`code-validate.ts`/`metadata.ts`/`playwright-report.ts`/`reexplore.ts`/`learning/learning-rule.ts`
move to the Tier-4 DEFER register (§3 above) with their revisit conditions.
