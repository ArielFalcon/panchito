# F1 — Core cross-repo support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One e2e app can declare microservice repos (`services[]`); a deploy-event webhook from a service repo triggers an e2e run of the front app with the service's diff as blast radius.

**Architecture:** `AppConfigSchema` gains `services[]`; webhook routing becomes 1:N (`loadAppConfigsByRepo` with roles); the pipeline grows a cross-repo branch (service mirror for diff/classify/gate, primary mirror at `baseBranch` HEAD for suite/publish); the agent prompt gains a cross-repo section; Issues open in the triggering repo. Spec: `docs/superpowers/specs/2026-06-09-multi-repo-robustness-design.md` §1–§4, §6.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), `tsx` runtime, `node:test` + `node:assert/strict`, Zod v4, better-sqlite3.

**Conventions you must follow:**
- Tests are colocated `*.test.ts`, run with `node --import tsx --test <file>`.
- Every side effect enters through an injected `*Deps` interface (see `PipelineDeps` in `src/pipeline.ts:80`).
- `npm test` (319 tests) and `npm run typecheck` must be green before every commit.
- Everything in English. Comments describe the final state, never the change.

---

### Task 1: `services[]` in the app config schema

**Files:**
- Modify: `src/orchestrator/schemas.ts` (the `AppConfigSchema` object, lines 6–48)
- Test: `src/orchestrator/schemas.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `src/orchestrator/schemas.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { AppConfigSchema } from "./schemas";

const base = {
  name: "shop",
  repo: "org/shop-front",
  dev: { baseUrl: "https://dev.shop.io" },
  qa: { needsReview: true, testDataPrefix: "qa-shop" },
  report: { onFailure: "github-issue" },
};

test("accepts an app with services[] (repo + optional openapi/versionUrl/baseBranch)", () => {
  const cfg = AppConfigSchema.parse({
    ...base,
    services: [
      { repo: "org/orders-svc", openapi: "**/openapi/*.yaml", versionUrl: "https://dev-api.shop.io/orders/version" },
      { repo: "org/payments-svc", baseBranch: "develop" },
    ],
  });
  assert.equal(cfg.services?.length, 2);
  assert.equal(cfg.services?.[0]?.repo, "org/orders-svc");
  assert.equal(cfg.services?.[1]?.baseBranch, "develop");
});

test("an app without services still parses (backward compatible)", () => {
  const cfg = AppConfigSchema.parse(base);
  assert.equal(cfg.services, undefined);
});

test("rejects services on a code-mode app", () => {
  assert.throws(() =>
    AppConfigSchema.parse({
      ...base,
      dev: undefined,
      code: true,
      services: [{ repo: "org/orders-svc" }],
    }),
  );
});

test("rejects a service repo that duplicates the primary repo", () => {
  assert.throws(() =>
    AppConfigSchema.parse({ ...base, services: [{ repo: "org/shop-front" }] }),
  );
});

test("rejects duplicate service repos", () => {
  assert.throws(() =>
    AppConfigSchema.parse({
      ...base,
      services: [{ repo: "org/orders-svc" }, { repo: "org/orders-svc" }],
    }),
  );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test src/orchestrator/schemas.test.ts`
Expected: the services-related tests FAIL (unknown key is stripped by Zod, so `cfg.services` is `undefined` and the reject-tests do not throw).

- [ ] **Step 3: Implement the schema**

In `src/orchestrator/schemas.ts`, add `services` to the object (after the `openapi` field, before `dev`):

```ts
    // `services` (e2e apps only): the microservice repos that participate in this
    // app's flows. A deploy-event webhook from one of these repos triggers an e2e
    // run of THIS app with the service's diff as blast radius. openapi is a glob
    // INSIDE the service repo; versionUrl is an optional deploy-verification belt.
    services: z
      .array(
        z.object({
          repo: z.string().min(1, { error: "service repo is required (e.g. 'org/svc')" }),
          baseBranch: z.string().optional(),
          openapi: z.union([z.string(), z.array(z.string())]).optional(),
          versionUrl: z.url().optional(),
          pollIntervalMs: z.number().int().positive().optional(),
          deployTimeoutMs: z.number().int().positive().optional(),
        }),
      )
      .optional(),
```

After the existing `.refine((c) => c.code === true || c.dev !== undefined, ...)`, chain two more refines:

```ts
  .refine((c) => !(c.code === true && (c.services?.length ?? 0) > 0), {
    error: "services are only valid for e2e apps (code-mode apps have no E2E suite)",
    path: ["services"],
  })
  .refine(
    (c) => {
      const repos = [c.repo, ...(c.services ?? []).map((s) => s.repo)];
      return new Set(repos).size === repos.length;
    },
    { error: "service repos must be unique and different from the primary repo", path: ["services"] },
  );
```

At the bottom of the file, next to `ValidatedAppConfig`, export the element type:

```ts
export type ServiceConfig = NonNullable<ValidatedAppConfig["services"]>[number];
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --import tsx --test src/orchestrator/schemas.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Full gate + commit**

```bash
npm run typecheck && npm test
git add src/orchestrator/schemas.ts src/orchestrator/schemas.test.ts
git commit -m "feat(config): services[] in the app schema (multi-repo apps)"
```

---

### Task 2: webhook routing fan-out — `loadAppConfigsByRepo`

**Files:**
- Modify: `src/orchestrator/config-loader.ts` (replace `loadAppConfigByRepo`, lines 23–33)
- Test: `src/orchestrator/config-loader.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

Create `src/orchestrator/config-loader.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAppConfigsByRepo } from "./config-loader";

function makeRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "cfg-"));
  mkdirSync(join(root, "config", "apps"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, "config", "apps", name), content);
  }
  return root;
}

const FRONT = `
name: "shop"
repo: "org/shop-front"
dev:
  baseUrl: "https://dev.shop.io"
services:
  - repo: "org/orders-svc"
qa:
  needsReview: true
  testDataPrefix: "qa-shop"
report:
  onFailure: "github-issue"
`;

const ORDERS_CODE = `
name: "orders"
repo: "org/orders-svc"
code: true
qa:
  needsReview: false
  testDataPrefix: "qa-orders"
report:
  onFailure: "github-issue"
`;

test("primary repo matches with role primary", () => {
  const root = makeRoot({ "shop.yaml": FRONT });
  try {
    const matches = loadAppConfigsByRepo("org/shop-front", root);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.role, "primary");
    assert.equal(matches[0]?.app.name, "shop");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("service repo matches the owning app with role service", () => {
  const root = makeRoot({ "shop.yaml": FRONT });
  try {
    const matches = loadAppConfigsByRepo("org/orders-svc", root);
    assert.equal(matches.length, 1);
    assert.equal(matches[0]?.role, "service");
    assert.equal(matches[0]?.app.name, "shop");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("a repo that is both its own app and a service of another fans out to BOTH", () => {
  const root = makeRoot({ "shop.yaml": FRONT, "orders.yaml": ORDERS_CODE });
  try {
    const matches = loadAppConfigsByRepo("org/orders-svc", root);
    const roles = matches.map((m) => `${m.app.name}:${m.role}`).sort();
    assert.deepEqual(roles, ["orders:primary", "shop:service"]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("unknown repo returns no matches; a malformed yaml is skipped, not fatal", () => {
  const root = makeRoot({ "shop.yaml": FRONT, "broken.yaml": "name: [unclosed" });
  try {
    assert.deepEqual(loadAppConfigsByRepo("org/nobody", root), []);
    assert.equal(loadAppConfigsByRepo("org/shop-front", root).length, 1);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --import tsx --test src/orchestrator/config-loader.test.ts`
Expected: FAIL — `loadAppConfigsByRepo` is not exported.

- [ ] **Step 3: Implement `loadAppConfigsByRepo` and delete `loadAppConfigByRepo`**

In `src/orchestrator/config-loader.ts`, replace the whole `loadAppConfigByRepo` function (lines 23–33) with:

```ts
export type RepoRole = "primary" | "service";

export interface RepoMatch {
  app: AppConfig;
  role: RepoRole;
}

// Resolves EVERY app the event's repo participates in. A repo can be the primary
// of one app AND a service of another (its own code-mode app + the front's e2e app):
// the webhook enqueues one run per match. A malformed YAML is skipped (and logged),
// never hiding the other apps.
export function loadAppConfigsByRepo(repo: string, root = ROOT): RepoMatch[] {
  const dir = join(root, "config", "apps");
  if (!existsSync(dir)) return [];
  const out: RepoMatch[] = [];
  for (const file of readdirSync(dir)) {
    if (!file.endsWith(".yaml") || file.startsWith("example")) continue;
    let cfg: AppConfig;
    try {
      cfg = loadAppConfig(file.replace(/\.yaml$/, ""), root);
    } catch (err) {
      console.warn(`[qa] skipping malformed config ${file}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (cfg.repo === repo) out.push({ app: cfg, role: "primary" });
    else if (cfg.services?.some((s) => s.repo === repo)) out.push({ app: cfg, role: "service" });
  }
  return out;
}
```

Update the import in `src/index.ts:7` from `loadAppConfigByRepo` to `loadAppConfigsByRepo` (the call site is rewired in Task 4). Search for any other usage first: `grep -rn "loadAppConfigByRepo" src/` — update every hit.

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test src/orchestrator/config-loader.test.ts`
Expected: PASS (4 tests). Note: `npm run typecheck` will FAIL until Task 4 rewires `src/index.ts` — that is expected mid-task; do the temporary mechanical rename in index.ts now (`loadAppConfigsByRepo(repo)[0]?.app` keeps behavior identical) so the gate is green:

In `src/index.ts:892`, temporarily:

```ts
        const app = loadAppConfigsByRepo(repo)[0]?.app ?? null;
```

- [ ] **Step 5: Full gate + commit**

```bash
npm run typecheck && npm test
git add src/orchestrator/config-loader.ts src/orchestrator/config-loader.test.ts src/index.ts
git commit -m "feat(routing): loadAppConfigsByRepo — 1:N repo→app matches with roles"
```

---

### Task 3: `triggerRepo` plumbing (types, history, runner)

**Files:**
- Modify: `src/types.ts` (`RunOptions` lines 32–42, `RunRecord` lines 110–132)
- Modify: `src/server/history.ts` (runs schema + createRecord + row mapping)
- Modify: `src/server/runner.ts` (`RunRequest` lines 18–29, `enqueueTrackedRun`)
- Test: extend `src/server/history.test.ts`

- [ ] **Step 1: Write the failing test**

In `src/server/history.test.ts`, find how existing tests create records (they call `createRecord` with an opts object; the file sets `HISTORY_DB_PATH` to a temp file — follow the established setup of that file exactly). Add:

```ts
test("createRecord persists triggerRepo and getRecord returns it", () => {
  const rec = createRecord({ app: "shop", sha: "a1b2c3d", target: "e2e", mode: "diff", triggerRepo: "org/orders-svc" });
  assert.equal(getRecord(rec.id)?.triggerRepo, "org/orders-svc");
});

test("triggerRepo is optional and absent by default", () => {
  const rec = createRecord({ app: "shop", sha: "a1b2c3d", target: "e2e", mode: "diff" });
  assert.equal(getRecord(rec.id)?.triggerRepo, undefined);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test src/server/history.test.ts`
Expected: FAIL — `triggerRepo` is not a known option/column.

- [ ] **Step 3: Implement**

1. `src/types.ts` — add to `RunOptions`:

```ts
  triggerRepo?: string; // cross-repo: the service repo whose commit triggered this run
```

and to `RunRecord` (after `parentRunId`):

```ts
  triggerRepo?: string; // cross-repo runs: the service repo that originated the event
```

2. `src/server/history.ts` — `triggerRepo` is stored EXACTLY like `parentRunId`. Mechanical recipe (apply each):
   - In the `CREATE TABLE IF NOT EXISTS runs` block: add `trigger_repo TEXT,` after `parent_run_id TEXT,`.
   - Right after the `db.exec(...)` schema creation, add the migration for pre-existing databases:

```ts
  try {
    db.exec("ALTER TABLE runs ADD COLUMN trigger_repo TEXT");
  } catch {
    /* column already exists */
  }
```

   - In the `insertRun` prepared statement: add the `trigger_repo` column and its placeholder, mirroring `parent_run_id`.
   - In `createRecord(opts)`: extend the opts type with `triggerRepo?: string`, pass it into the insert (as `null` when undefined, exactly as `parent_run_id` does), and set it on the returned record.
   - In the row→record mapping function (the place that maps `parent_run_id` → `parentRunId`): add `triggerRepo: row.trigger_repo ?? undefined`.

3. `src/server/runner.ts`:
   - `RunRequest` gains `triggerRepo?: string;` (after `parentRunId`).
   - In `enqueueTrackedRun`, pass it to `createRecord({ ..., triggerRepo: req.triggerRepo })` (line 58) and into the pipeline options object (line 109): add `triggerRepo: req.triggerRepo`.

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test src/server/history.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run typecheck && npm test
git add src/types.ts src/server/history.ts src/server/runner.ts src/server/history.test.ts
git commit -m "feat(history): triggerRepo on RunRecord/RunRequest/RunOptions (cross-repo provenance)"
```

---

### Task 4: webhook fan-out in `src/index.ts`

**Files:**
- Modify: `src/index.ts` (`enqueueApiRun` lines 131–139; webhook block lines 891–903)

No isolated unit test: this block is the thin HTTP wiring (the routing logic was tested in Task 2, the funnel in runner.test.ts). The behavior is verified by the full gate plus the F1 smoke at the end.

- [ ] **Step 1: Extend `enqueueApiRun`**

```ts
function enqueueApiRun(app: string, sha: string, target: string, mode: RunMode, guidance?: string, shadow?: boolean, triggerRepo?: string): string {
  if (shuttingDown) {
    console.warn(`[qa] rejecting run ${app}@${sha} — shutting down`);
    return "";
  }
  // Orphan-data cleanup is reconstructed inside enqueueTrackedRun (the single funnel), so
  // every trigger gets it — not just this webhook path.
  return enqueueTrackedRun(queue, { app, sha, target: target as TestTarget, mode, guidance, shadow, source: "webhook", triggerRepo });
}
```

- [ ] **Step 2: Rewire the webhook block**

Replace the temporary Task-2 shim (lines 891–903) with the fan-out. Service-triggered runs are ALWAYS e2e + diff (a `complete`/`exhaustive` of the front is requested via the front repo, not via a micro):

```ts
        const { repo, sha, mode, guidance } = result.payload;
        const matches = loadAppConfigsByRepo(repo);
        if (matches.length === 0) console.warn(`[qa] no config/apps entry for ${repo}; event ignored`);
        for (const m of matches) {
          try {
            if (m.role === "primary") {
              enqueueApiRun(m.app.name, sha, m.app.code ? "code" : "e2e", mode, guidance);
            } else {
              enqueueApiRun(m.app.name, sha, "e2e", "diff", guidance, undefined, repo);
            }
          } catch (err) {
            console.error("[qa] webhook enqueue failed:", err instanceof Error ? err.message : String(err));
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ message: "internal error — run could not be enqueued" }));
            return;
          }
        }
```

- [ ] **Step 3: Full gate + commit**

```bash
npm run typecheck && npm test
git add src/index.ts
git commit -m "feat(webhook): fan out one run per repo match (primary + service roles)"
```

---

### Task 5: `ensureMirrorAtBranch` in repo-mirror

**Files:**
- Modify: `src/integrations/repo-mirror.ts`
- Test: extend `src/integrations/repo-mirror.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/integrations/repo-mirror.test.ts`, follow the existing stub pattern of the file (it builds a `MirrorDeps` with a recording fake `git` and an `exists` stub — reuse the same helpers). Add:

```ts
test("ensureMirrorAtBranch clones when missing and checks out origin/<branch>", async () => {
  const calls: string[][] = [];
  const deps = { git: async (args: string[]) => { calls.push(args); return ""; }, exists: () => false, root: "/work" };
  const dir = await ensureMirrorAtBranch("org/shop-front", "main", deps);
  assert.equal(dir, "/work/org__shop-front");
  assert.deepEqual(calls[0]?.[0], "clone");
  assert.ok(calls.some((c) => c.includes("checkout") && c.includes("origin/main")));
  assert.ok(calls.some((c) => c.includes("clean")));
});

test("ensureMirrorAtBranch fetches when the mirror exists", async () => {
  const calls: string[][] = [];
  const deps = { git: async (args: string[]) => { calls.push(args); return ""; }, exists: () => true, root: "/work" };
  await ensureMirrorAtBranch("org/shop-front", "main", deps);
  assert.ok(calls.some((c) => c.includes("fetch")));
  assert.ok(!calls.some((c) => c[0] === "clone"));
});

test("ensureMirrorAtBranch rejects a branch name that could be parsed as a git option", async () => {
  const deps = { git: async () => "", exists: () => true, root: "/work" };
  await assert.rejects(() => ensureMirrorAtBranch("org/x", "--upload-pack=evil", deps));
  await assert.rejects(() => ensureMirrorAtBranch("org/x", "a..b", deps));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test src/integrations/repo-mirror.test.ts`
Expected: FAIL — `ensureMirrorAtBranch` is not exported.

- [ ] **Step 3: Implement**

In `src/integrations/repo-mirror.ts`, after `ensureMirror` (line 66), add:

```ts
// A branch name passed to git as a positional arg must never be parseable as an
// option (no leading '-') nor as a rev range ('..'). Same injection-closing rationale
// as assertHexSha for SHAs coming from an attacker-controlled webhook.
const BRANCH_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
export function assertBranchName(branch: string): void {
  if (!BRANCH_RE.test(branch) || branch.includes("..")) {
    throw new Error(`invalid branch name: ${JSON.stringify(branch)}`);
  }
}

// Pristine working copy at the HEAD of origin/<branch> (not at a specific SHA).
// Used for the PRIMARY repo of a cross-repo run: the triggering commit belongs to a
// service repo, so the front is checked out at its own base branch instead.
export async function ensureMirrorAtBranch(repo: string, branch: string, deps: MirrorDeps): Promise<string> {
  assertBranchName(branch);
  const root = deps.root ?? workdirRoot();
  const dir = join(root, repo.replaceAll("/", "__"));
  if (!deps.exists(dir)) {
    await deps.git(["clone", remoteUrl(repo), dir]);
  } else {
    await deps.git([...authHeaderArgs(), "fetch", "origin"], dir);
  }
  await deps.git(["checkout", "-f", `origin/${branch}`], dir);
  await deps.git(["clean", "-fd", "-e", "node_modules"], dir);
  return dir;
}
```

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test src/integrations/repo-mirror.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run typecheck && npm test
git add src/integrations/repo-mirror.ts src/integrations/repo-mirror.test.ts
git commit -m "feat(mirror): ensureMirrorAtBranch — primary working copy at baseBranch HEAD"
```

---

### Task 6: pipeline cross-repo branch

**Files:**
- Modify: `src/pipeline.ts` (gate lines 345–363, prepare lines 365–369, `GenerateInput` lines 58–78, `PipelineDeps` lines 80–127, `defaultPipelineDeps` generate/prepare, decide-step issue targets lines 964–1005, `report()` lines 1055–1081, coverage gate line 812)
- Test: extend `src/pipeline.test.ts`

- [ ] **Step 1: Write the failing tests**

`src/pipeline.test.ts` builds stub `PipelineDeps` — reuse its existing `makeDeps`-style helper (read the top of the file first and match it; the helper returns a full deps object you can override per test). Add these tests (adapt ONLY the helper name/shape, keep the assertions):

```ts
test("cross-repo: service trigger prepares BOTH mirrors and gates on the service versionUrl", async () => {
  const prepared: string[] = [];
  const gated: string[] = [];
  const deps = makeDeps({
    prepare: async (repo: string, sha: string) => { prepared.push(`${repo}@${sha}`); return { mirrorDir: "/m/svc", diff: "diff --git a/x b/x\n+code", message: "feat: svc change" }; },
    prepareAtBranch: async (repo: string, branch: string) => { prepared.push(`${repo}#${branch}`); return { mirrorDir: "/m/front" }; },
    waitForDeploy: async (t: { versionUrl: string }) => { gated.push(t.versionUrl); },
  });
  const app = makeApp({
    repo: "org/shop-front",
    services: [{ repo: "org/orders-svc", versionUrl: "https://svc/version" }],
  });
  await runPipeline(app, "a1b2c3d", deps, "webhook", { mode: "diff", triggerRepo: "org/orders-svc", runId: "r1" });
  assert.deepEqual(gated, ["https://svc/version"]);
  assert.ok(prepared.includes("org/orders-svc@a1b2c3d"));
  assert.ok(prepared.includes("org/shop-front#main"));
});

test("cross-repo: a fail opens the Issue in the TRIGGERING service repo", async () => {
  const issues: string[] = [];
  const deps = makeDeps({
    prepare: async () => ({ mirrorDir: "/m/svc", diff: "diff --git a/x b/x\n+code", message: "feat: svc change" }),
    prepareAtBranch: async () => ({ mirrorDir: "/m/front" }),
    execute: async () => ({ sha: "ns", verdict: "fail" as const, passed: false, cases: [{ name: "t", status: "fail" as const }], logs: "" }),
    openIssue: async (repo: string) => { issues.push(repo); return { url: "http://issue" }; },
  });
  const app = makeApp({ repo: "org/shop-front", services: [{ repo: "org/orders-svc" }], shadow: false });
  await runPipeline(app, "a1b2c3d", deps, "webhook", { mode: "diff", triggerRepo: "org/orders-svc", runId: "r1" });
  assert.deepEqual(issues, ["org/orders-svc"]);
});

test("cross-repo: triggerRepo not declared as a service throws (mis-routed event must be loud)", async () => {
  const deps = makeDeps({});
  const app = makeApp({ repo: "org/shop-front", services: [{ repo: "org/orders-svc" }] });
  await assert.rejects(
    () => runPipeline(app, "a1b2c3d", deps, "webhook", { mode: "diff", triggerRepo: "org/other-svc" }),
    /not a declared service/,
  );
});

test("cross-repo: generate receives service {repo, mirrorDir}; change-coverage is skipped", async () => {
  let genInput: GenerateInput | undefined;
  let coverageCalled = false;
  const deps = makeDeps({
    prepare: async () => ({ mirrorDir: "/m/svc", diff: "diff --git a/x b/x\n+code", message: "feat: svc change" }),
    prepareAtBranch: async () => ({ mirrorDir: "/m/front" }),
    generate: async (i: GenerateInput) => { genInput = i; return { output: "", specs: ["flows/a.spec.ts"], reviewed: false, approved: true }; },
    collectCoverage: async () => { coverageCalled = true; return new Map(); },
  });
  const app = makeApp({ repo: "org/shop-front", services: [{ repo: "org/orders-svc", openapi: "api/*.yaml" }] });
  await runPipeline(app, "a1b2c3d", deps, "webhook", { mode: "diff", triggerRepo: "org/orders-svc", runId: "r1" });
  assert.equal(genInput?.service?.repo, "org/orders-svc");
  assert.equal(genInput?.service?.mirrorDir, "/m/svc");
  assert.equal(genInput?.mirrorDir, "/m/front");
  assert.equal(coverageCalled, false);
});
```

If `makeApp` does not exist in the test file, define it next to the other helpers:

```ts
function makeApp(overrides: Record<string, unknown> = {}): AppConfig {
  return {
    name: "shop",
    repo: "org/shop-front",
    baseBranch: "main",
    dev: { baseUrl: "https://dev.shop.io" },
    qa: { needsReview: false, testDataPrefix: "qa", shadow: false },
    report: { onFailure: "github-issue" },
    ...overrides,
  } as AppConfig;
}
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test src/pipeline.test.ts`
Expected: the four new tests FAIL (`prepareAtBranch` unknown, no `service` on GenerateInput, Issue goes to the primary repo).

- [ ] **Step 3: Implement**

1. `GenerateInput` (src/pipeline.ts:58) — add:

```ts
  service?: { repo: string; mirrorDir: string; openapi?: string | string[] }; // cross-repo: the triggering microservice
```

2. `PipelineDeps` — add after `prepare`:

```ts
  // Cross-repo runs: the PRIMARY repo at the HEAD of its base branch (the triggering
  // SHA belongs to the service repo and does not exist in the primary).
  prepareAtBranch(repo: string, branch: string): Promise<{ mirrorDir: string }>;
```

3. `defaultPipelineDeps()` — wire it:

```ts
    prepareAtBranch: async (repo, branch) => ({ mirrorDir: await ensureMirrorAtBranch(repo, branch, defaultMirrorDeps) }),
```

(import `ensureMirrorAtBranch` from `./integrations/repo-mirror`), and in `generate` copy the field into `ocInput`: `service: input.service,`.

4. In `runPipeline`, right after `const isCode = ...` (line 306), resolve the trigger:

```ts
  // Cross-repo: a run whose triggering commit belongs to a declared service repo, not
  // to the primary. The service mirror provides diff/classify/gate; the primary mirror
  // (at baseBranch HEAD) hosts the suite, the execution, and the publish.
  const triggerService =
    opts.triggerRepo && opts.triggerRepo !== app.repo
      ? app.services?.find((s) => s.repo === opts.triggerRepo)
      : undefined;
  if (opts.triggerRepo && opts.triggerRepo !== app.repo && !triggerService) {
    throw new Error(`trigger repo ${opts.triggerRepo} is not a declared service of app ${app.name}`);
  }
  const issueRepo = triggerService ? triggerService.repo : app.repo;
```

5. Gate (lines 345–363) — insert a cross-repo branch between the `isCode` and the primary-gate branches:

```ts
  if (isCode) {
    log("[qa] code mode: no web environment; skipping the deploy gate and health checks.");
  } else if (triggerService) {
    if (triggerService.versionUrl) {
      log(`[qa] waiting for ${triggerService.repo} to serve ${sha} on DEV...`);
      await deps.waitForDeploy(
        {
          name: `${app.name}/${triggerService.repo}`,
          versionUrl: triggerService.versionUrl,
          pollIntervalMs: triggerService.pollIntervalMs ?? 10_000,
          deployTimeoutMs: triggerService.deployTimeoutMs ?? 600_000,
        },
        sha,
      );
    } else {
      log(`[qa] deploy-event trigger from ${triggerService.repo} without versionUrl; trusting the event (gate skipped).`);
    }
  } else if (versionUrl && app.dev) {
    // ... existing primary gate unchanged ...
```

6. Prepare (lines 365–369) — replace with:

```ts
  log("[qa] preparing working copy and diff...");
  let mirrorDir: string;
  let diff: string;
  let message: string;
  let serviceMirrorDir: string | undefined;
  if (triggerService) {
    const svc = await deps.prepare(triggerService.repo, sha);
    serviceMirrorDir = svc.mirrorDir;
    diff = svc.diff;
    message = svc.message;
    mirrorDir = (await deps.prepareAtBranch(app.repo, app.baseBranch ?? "main")).mirrorDir;
  } else {
    ({ mirrorDir, diff, message } = await deps.prepare(app.repo, sha));
  }
```

7. `baseGenInput` (line 581) — add:

```ts
    service: triggerService
      ? { repo: triggerService.repo, mirrorDir: serviceMirrorDir!, openapi: triggerService.openapi }
      : undefined,
```

8. Change-coverage gate (line 812) — add `&& !triggerService` to the condition, and immediately before it:

```ts
  if (triggerService && mode === "diff" && run.verdict === "pass") {
    log(`[qa] change-coverage: skipped — the changed lines live in ${triggerService.repo}; browser coverage maps only the frontend (status=unknown).`);
  }
```

9. Issue targets — replace `app.repo` with `issueRepo` in: the `report(...)` helper (pass `issueRepo` as a new parameter and use it in both `issueOrShadow` calls inside it), and the two decide-step `issueOrShadow(shadow, deps, log, app.repo, ...)` calls at lines 974–992. New `report` signature:

```ts
async function report(
  app: AppConfig,
  issueRepo: string,
  sha: string,
  run: QaRunResult,
  deps: PipelineDeps,
  log: (m: string) => void,
  shadow: boolean,
  isCode: boolean,
  ctx: IssueContext = {},
): Promise<void> {
```

Update every `report(app, sha, ...)` call site in runPipeline to `report(app, issueRepo, sha, ...)` (there are five: validation-invalid, validation-infra, pre-flight infra, no-dev infra, final non-pass).

10. Every existing test stub of `PipelineDeps` in `src/pipeline.test.ts` now needs `prepareAtBranch`. Add it once to the shared `makeDeps` helper default:

```ts
    prepareAtBranch: async () => ({ mirrorDir: "/m/front" }),
```

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test src/pipeline.test.ts`
Expected: PASS (all pre-existing + 4 new).

- [ ] **Step 5: Full gate + commit**

```bash
npm run typecheck && npm test
git add src/pipeline.ts src/pipeline.test.ts
git commit -m "feat(pipeline): cross-repo runs — service gate, two mirrors, issue to triggering repo"
```

---

### Task 7: the agent sees the service (prompt section)

**Files:**
- Modify: `src/integrations/opencode-client.ts` (`OpencodeRunInput` lines 188–209, `buildTask` diff branch lines 1049–1073)
- Test: extend `src/integrations/opencode-client.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/integrations/opencode-client.test.ts` (match the file's existing import style; `buildPrompt` is exported):

```ts
test("buildPrompt renders the cross-repo service section in diff mode", () => {
  const text = buildPrompt({
    repo: "org/shop-front",
    sha: "a1b2c3d",
    diff: "+ x",
    mirrorDir: "/m/front",
    e2eRelDir: "e2e",
    namespace: "qa-1",
    needsReview: false,
    target: "e2e",
    mode: "diff",
    appName: "shop",
    baseUrl: "https://dev.shop.io",
    service: { repo: "org/orders-svc", mirrorDir: "/m/svc", openapi: "api/*.yaml" },
  });
  assert.match(text, /Cross-repo change \(microservice\)/);
  assert.match(text, /org\/orders-svc/);
  assert.match(text, /\/m\/svc/);
  assert.match(text, /api\/\*\.yaml/);
  assert.match(text, /ONLY through the frontend UI/);
});

test("buildPrompt has no cross-repo section without a service", () => {
  const text = buildPrompt({
    repo: "org/shop-front", sha: "a1b2c3d", diff: "+ x", mirrorDir: "/m", e2eRelDir: "e2e",
    namespace: "qa-1", needsReview: false, target: "e2e", mode: "diff", appName: "shop",
  });
  assert.doesNotMatch(text, /Cross-repo change/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test src/integrations/opencode-client.test.ts`
Expected: FAIL — `service` is not a known field / section absent.

- [ ] **Step 3: Implement**

1. `OpencodeRunInput` — add:

```ts
  service?: { repo: string; mirrorDir: string; openapi?: string | string[] }; // cross-repo: the triggering microservice
```

2. In `buildTask` (the diff branch, line 1049), build the service block and insert it after the `## Commit diff` block (before `## Architecture context`):

```ts
  const svcOpenapi = Array.isArray(input.service?.openapi) ? input.service.openapi.join(", ") : input.service?.openapi;
  const serviceBlock = input.service
    ? [
        ``,
        `## Cross-repo change (microservice)`,
        `The commit under test belongs to the microservice ${input.service.repo}, NOT to this frontend repo.`,
        `- The service's working copy (READ-ONLY) is at: ${input.service.mirrorDir}`,
        ...(svcOpenapi ? [`- The service's OpenAPI contract(s): ${svcOpenapi} (paths relative to that working copy)`] : []),
        `- Use the architecture context below (operations whose service matches this repo) plus the`,
        `  service's code and contract to find which frontend routes and flows this change affects.`,
        `- Exercise the backend ONLY through the frontend UI at the LIVE DEV URL — never call the service directly.`,
      ]
    : [];
```

and in the returned array of the diff branch, after the closing ` ``` ` of the diff block:

```ts
    ...serviceBlock,
```

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test src/integrations/opencode-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run typecheck && npm test
git add src/integrations/opencode-client.ts src/integrations/opencode-client.test.ts
git commit -m "feat(agent): cross-repo service section in the diff-mode prompt"
```

---

### Task 8: docs + example config

**Files:**
- Modify: `config/apps/example.yaml`
- Modify: `CLAUDE.md` (the "Onboarding a watched app" bullet and the run-flow intro)

- [ ] **Step 1: Document `services[]` in example.yaml**

After the `openapi:` comment block in `config/apps/example.yaml`, add:

```yaml
# Optional (e2e apps only): the microservice repos that participate in this app's
# flows. A webhook from one of these repos — sent by ITS CI/CD AFTER deploying to
# DEV (deploy-event semantics) — triggers an e2e run of THIS app with the service
# commit's diff as blast radius. versionUrl is an optional verification belt: when
# present, the gate polls it for the service SHA before testing.
# services:
#   - repo: "org/orders-svc"
#     openapi: "**/openapi/*.yaml"      # glob INSIDE the service repo
#     versionUrl: "https://dev-api.example.internal/orders/version"
#   - repo: "org/payments-svc"
```

- [ ] **Step 2: Update CLAUDE.md**

In the Architecture section, after the run-flow list, add one paragraph:

```markdown
**Cross-repo runs (microservices).** An e2e app may declare `services[]` in its
YAML. A webhook from a service repo (sent by its CI **after** deploy — deploy-event
semantics) triggers an e2e run of the app: diff/classify/gate come from the service
mirror at the event SHA, while the suite runs from the primary mirror at `baseBranch`
HEAD. Issues open in the triggering service repo; the suite PR always targets the
primary repo. Change-coverage is `unknown` for these runs (browser coverage cannot
map service-repo lines).
```

- [ ] **Step 3: Full gate + commit**

```bash
npm run typecheck && npm test
git add config/apps/example.yaml CLAUDE.md
git commit -m "docs: services[] onboarding + cross-repo run semantics"
```

---

### F1 exit criteria

- `npm test` green (319 + ~15 new), `npm run typecheck` green.
- A webhook POST `{repo: "<service-repo>", sha}` enqueues an e2e run on the front app with `triggerRepo` set, visible in the TUI history.
- Apps without `services` behave byte-for-byte as before (the portfolio shadow run is the regression check: `npm run qa -- --app portfolio --sha <sha>`).
