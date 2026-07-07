# F5 — TUI onboarding & deletion via the control API Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the broken onboarding wizard (it calls `github.getRepo()` in the TUI process where `GITHUB_TOKEN` does not exist — OnboardWizard.tsx:58 → github.ts:48) by moving repo validation, YAML write, and secret handling server-side (`POST /api/apps`, `DELETE /api/apps/:name`); the wizard becomes a thin client and gains `services[]` + env-var steps and a Delete-project flow.

**Architecture:** New `src/server/app-admin.ts` owns create/delete logic behind injected deps (DI pattern); `src/server/onboard.ts` (moved from `src/tui/`) builds the YAML incl. `services[]`; `src/server/env-store.ts` applies env vars to `process.env` AND persists them to `.env` (own line, no inline comments — known compose gotcha); api.ts adds thin handlers; client.ts adds `validateRepo`/`createApp`/`deleteApp`; the wizard and a new delete dialog consume them. Spec §9. **Depends on F1** (`services[]` schema).

**Tech Stack:** TypeScript strict, `node:test`, Ink (React) TUI, Zod v4.

**Security invariants:** env values are NEVER echoed back in API responses or logs; `name` and env keys are format-validated before any filesystem path/file is built; new endpoints inherit the existing auth wrapping of `handleApi` (src/index.ts:857) — no separate auth path.

---

### Task 1: move `onboard.ts` server-side and add `services[]` to the YAML

**Files:**
- Move: `src/tui/onboard.ts` → `src/server/onboard.ts` (git mv; update importers)
- Move: `src/tui/onboard.test.ts` → `src/server/onboard.test.ts`
- Modify: `src/server/onboard.ts` (`OnboardInput`, `buildYaml`)

- [ ] **Step 1: Move the module**

```bash
git mv src/tui/onboard.ts src/server/onboard.ts
git mv src/tui/onboard.test.ts src/server/onboard.test.ts
grep -rn "from \"../onboard\"\|from \"./onboard\"\|tui/onboard" src/
```

Update every importer found (at minimum `src/tui/components/OnboardWizard.tsx:8` → `../../server/onboard`; the wizard import shrinks further in Task 8).

- [ ] **Step 2: Write the failing test**

In `src/server/onboard.test.ts` (keep the existing tests; they must still pass):

```ts
test("buildYaml renders services[] for e2e apps", () => {
  const yaml = buildYaml({
    name: "shop", repo: "org/shop-front", baseBranch: "main",
    baseUrl: "https://dev.shop.io", target: "e2e", needsReview: true, shadow: true,
    testDataPrefix: "qa-shop",
    services: [
      { repo: "org/orders-svc", openapi: "api/*.yaml", versionUrl: "https://svc/version" },
      { repo: "org/payments-svc" },
    ],
  });
  assert.match(yaml, /services:/);
  assert.match(yaml, /- repo: "org\/orders-svc"/);
  assert.match(yaml, /openapi: "api\/\*\.yaml"/);
  assert.match(yaml, /versionUrl: "https:\/\/svc\/version"/);
  assert.match(yaml, /- repo: "org\/payments-svc"/);
});

test("buildYaml omits services when absent or in code mode", () => {
  const none = buildYaml({ name: "a", repo: "o/a", baseBranch: "main", baseUrl: "https://x", target: "e2e", needsReview: true, shadow: true, testDataPrefix: "qa" });
  assert.doesNotMatch(none, /services:/);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --import tsx --test src/server/onboard.test.ts`
Expected: the new tests FAIL (`services` unknown).

- [ ] **Step 4: Implement**

In `src/server/onboard.ts`:

```ts
export interface OnboardServiceInput {
  repo: string;
  openapi?: string;
  versionUrl?: string;
}

export interface OnboardInput {
  name: string;
  repo: string;
  baseBranch: string;
  baseUrl: string;
  versionUrl?: string;
  target: TestTarget;
  needsReview: boolean;
  shadow: boolean;
  testDataPrefix: string;
  services?: OnboardServiceInput[];
}
```

In `buildYaml`, after the `dev:` block (and only when `input.target !== "code"`), render:

```ts
  if (input.target !== "code" && input.services?.length) {
    lines.push("", "services:");
    for (const s of input.services) {
      lines.push(`  - repo: "${s.repo}"`);
      if (s.openapi) lines.push(`    openapi: "${s.openapi}"`);
      if (s.versionUrl) lines.push(`    versionUrl: "${s.versionUrl}"`);
    }
  }
```

- [ ] **Step 5: Run + gate + commit**

```bash
node --import tsx --test src/server/onboard.test.ts
npm run typecheck && npm test
git add -A src/server/onboard.ts src/server/onboard.test.ts src/tui
git commit -m "refactor(onboard): move YAML builder server-side; render services[]"
```

---

### Task 2: `env-store` — apply + persist secrets

**Files:**
- Create: `src/server/env-store.ts`
- Test: `src/server/env-store.test.ts` (create)

- [ ] **Step 1: Write the failing tests**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { applyEnvVars } from "./env-store";

function makeFs(initial: string | null) {
  let content = initial;
  return {
    read: () => content,
    write: (c: string) => { content = c; },
    get: () => content,
  };
}

test("applies to env object and appends each var on its OWN line (no inline comments)", () => {
  const fs = makeFs("EXISTING=1\n");
  const env: Record<string, string | undefined> = {};
  const applied = applyEnvVars({ SHOP_DEV_PASSWORD: "s3cr3t", API_KEY: "k" }, { fs, env });
  assert.deepEqual(applied.sort(), ["API_KEY", "SHOP_DEV_PASSWORD"]);
  assert.equal(env.SHOP_DEV_PASSWORD, "s3cr3t");
  assert.match(fs.get()!, /^EXISTING=1$/m);
  assert.match(fs.get()!, /^SHOP_DEV_PASSWORD=s3cr3t$/m);
  assert.match(fs.get()!, /^API_KEY=k$/m);
});

test("replaces an existing line instead of duplicating it", () => {
  const fs = makeFs("API_KEY=old\n");
  const env: Record<string, string | undefined> = {};
  applyEnvVars({ API_KEY: "new" }, { fs, env });
  const lines = fs.get()!.split("\n").filter((l) => l.startsWith("API_KEY="));
  assert.deepEqual(lines, ["API_KEY=new"]);
});

test("rejects invalid keys and values with newlines BEFORE touching anything", () => {
  const fs = makeFs("");
  const env: Record<string, string | undefined> = {};
  assert.throws(() => applyEnvVars({ "bad-key": "v" }, { fs, env }));
  assert.throws(() => applyEnvVars({ GOOD: "line1\nline2" }, { fs, env }));
  assert.equal(env.GOOD, undefined); // nothing half-applied
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test src/server/env-store.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement**

Create `src/server/env-store.ts`:

```ts
// Applies operator-provided env vars to the LIVE process env (config expansion reads
// process.env at load time — no restart needed) and persists them to .env so they
// survive a restart. Each var goes on its OWN line with no inline comment: docker
// compose env_file does NOT strip inline comments (a known gotcha — see CLAUDE.md).
// Doppler users must ALSO add the var in Doppler; .env only covers local boots.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const KEY_RE = /^[A-Z][A-Z0-9_]*$/;

export interface EnvStoreFs {
  read(): string | null;
  write(content: string): void;
}

export function defaultEnvStoreFs(envPath = join(process.env.PANCHITO_ROOT ?? process.cwd(), ".env")): EnvStoreFs {
  return {
    read: () => (existsSync(envPath) ? readFileSync(envPath, "utf8") : null),
    write: (c) => writeFileSync(envPath, c, "utf8"),
  };
}

export function applyEnvVars(
  vars: Record<string, string>,
  opts: { fs: EnvStoreFs; env: Record<string, string | undefined> },
): string[] {
  const entries = Object.entries(vars);
  // Validate EVERYTHING first: a failure must leave no half-applied state.
  for (const [key, value] of entries) {
    if (!KEY_RE.test(key)) throw new Error(`invalid env key (expected [A-Z][A-Z0-9_]*): ${JSON.stringify(key)}`);
    if (/[\r\n]/.test(value)) throw new Error(`env value for ${key} must be a single line`);
  }

  const existing = opts.fs.read() ?? "";
  const lines = existing.length ? existing.split("\n") : [];
  for (const [key, value] of entries) {
    const line = `${key}=${value}`;
    const idx = lines.findIndex((l) => l.startsWith(`${key}=`));
    if (idx >= 0) lines[idx] = line;
    else {
      if (lines.length && lines[lines.length - 1] === "") lines.pop();
      lines.push(line);
    }
  }
  opts.fs.write(lines.join("\n") + "\n");

  for (const [key, value] of entries) opts.env[key] = value;
  return entries.map(([k]) => k);
}
```

- [ ] **Step 4: Run the tests** — Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run typecheck && npm test
git add src/server/env-store.ts src/server/env-store.test.ts
git commit -m "feat(server): env-store — apply env vars live and persist to .env"
```

---

### Task 3: `deleteAppHistory` in history

**Files:**
- Modify: `src/server/history.ts`
- Test: extend `src/server/history.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
test("deleteAppHistory removes the app's runs (and cascades cases) but not other apps'", () => {
  const mine = createRecord({ app: "doomed", sha: "a1b2c3d", target: "e2e", mode: "diff" });
  addCase(mine.id, { name: "t1", status: "pass" });
  const other = createRecord({ app: "alive", sha: "a1b2c3d", target: "e2e", mode: "diff" });
  const n = deleteAppHistory("doomed");
  assert.ok(n >= 1);
  assert.equal(getRecord(mine.id), undefined);
  assert.ok(getRecord(other.id));
});
```

- [ ] **Step 2: Run to verify failure** — `node --import tsx --test src/server/history.test.ts` → FAIL.

- [ ] **Step 3: Implement**

In `src/server/history.ts` (next to `clearDatabase`, line 414). Foreign keys are ON with `ON DELETE CASCADE` (runs schema line 84), so deleting runs cascades cases/specs/activity. Also clear the app's learning artifacts:

```ts
// Deletes EVERYTHING history holds for an app: runs (cases/specs/activity cascade),
// outcomes, learning rules, curriculum, scorecard. Used by DELETE /api/apps/:name?purge=1.
export function deleteAppHistory(app: string): number {
  ensureDb();
  const info = db.prepare("DELETE FROM runs WHERE app = ?").run(app);
  for (const table of ["run_outcomes", "learning_rules", "curricula", "scorecards"]) {
    try {
      db.prepare(`DELETE FROM ${table} WHERE app = ?`).run(app);
    } catch {
      /* table name differs or doesn't exist in this schema version — runs are the contract */
    }
  }
  return info.changes;
}
```

Before committing, check the actual table names in the `db.exec` schema of this file (search `CREATE TABLE`) and use the real ones instead of the guessed list — replace the loop with the literal tables that have an `app` column.

- [ ] **Step 4: Run the test** — Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run typecheck && npm test
git add src/server/history.ts src/server/history.test.ts
git commit -m "feat(history): deleteAppHistory for app purge"
```

---

### Task 4: `app-admin` — create/delete logic behind deps

**Files:**
- Create: `src/server/app-admin.ts`
- Test: `src/server/app-admin.test.ts` (create)
- Modify: `src/orchestrator/config-loader.ts` (export `expandEnv`)

- [ ] **Step 1: Export `expandEnv`**

In `src/orchestrator/config-loader.ts:52`, change `function expandEnv` to `export function expandEnv` and let it take the env source:

```ts
export function expandEnv(s: string, env: Record<string, string | undefined> = process.env): string {
  return s.replace(/\$\{([A-Z0-9_]+)\}/g, (_, key) => {
    const val = env[key];
    if (val === undefined) throw new Error(`config references unset env var \${${key}}`);
    return val;
  });
}
```

(Existing internal callers keep working — the parameter defaults to `process.env`.)

- [ ] **Step 2: Write the failing tests**

Create `src/server/app-admin.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { createApp, deleteApp, AppAdminDeps } from "./app-admin";

function makeDeps(overrides: Partial<AppAdminDeps> = {}): AppAdminDeps & { written: Record<string, string>; removed: string[] } {
  const written: Record<string, string> = {};
  const removed: string[] = [];
  return {
    written,
    removed,
    getRepoInfo: async (repo) => ({ name: repo.split("/")[1]!, fullName: repo, private: false, defaultBranch: "main", description: null }),
    configExists: () => false,
    writeConfig: (name, yaml) => { written[name] = yaml; return `/app/config/apps/${name}.yaml`; },
    deleteConfig: (name) => { removed.push(`config:${name}`); },
    deleteMirror: (repo) => { removed.push(`mirror:${repo}`); },
    deleteHistory: (app) => { removed.push(`history:${app}`); return 1; },
    applyEnv: (vars) => Object.keys(vars),
    loadApp: (name) => ({ name, repo: "org/shop-front", qa: { needsReview: true, testDataPrefix: "qa" }, report: { onFailure: "github-issue" }, dev: { baseUrl: "https://x" } }) as never,
    env: {},
    ...overrides,
  };
}

test("validateOnly returns repoInfo without writing anything", async () => {
  const deps = makeDeps();
  const r = await createApp({ repo: "org/shop-front", validateOnly: true }, deps);
  assert.equal(r.ok, true);
  assert.equal(r.repoInfo?.defaultBranch, "main");
  assert.deepEqual(deps.written, {});
});

test("dryRun returns the YAML (with services) without writing", async () => {
  const deps = makeDeps();
  const r = await createApp(
    {
      repo: "org/shop-front", name: "shop", baseUrl: "https://dev.shop.io", target: "e2e",
      needsReview: true, shadow: true, testDataPrefix: "qa-shop",
      services: [{ repo: "org/orders-svc", openapi: "api/*.yaml" }],
      dryRun: true,
    },
    deps,
  );
  assert.equal(r.ok, true);
  assert.match(r.yaml ?? "", /- repo: "org\/orders-svc"/);
  assert.deepEqual(deps.written, {});
});

test("create applies env FIRST, validates the expanded YAML, then writes", async () => {
  const order: string[] = [];
  const deps = makeDeps({
    applyEnv: (vars) => { order.push("env"); return Object.keys(vars); },
    writeConfig: (name, yaml) => { order.push("write"); return `/x/${name}.yaml`; },
  });
  const r = await createApp(
    {
      repo: "org/shop-front", name: "shop", baseUrl: "https://dev.shop.io", target: "e2e",
      needsReview: true, shadow: true, testDataPrefix: "qa-shop",
      env: { SHOP_TOKEN: "t" },
    },
    deps,
  );
  assert.equal(r.ok, true);
  assert.deepEqual(order, ["env", "write"]);
  assert.deepEqual(r.envApplied, ["SHOP_TOKEN"]);
  assert.equal(JSON.stringify(r).includes("\"t\""), false); // the secret value never leaves
});

test("invalid config returns the Zod errors and writes nothing", async () => {
  const deps = makeDeps();
  const r = await createApp(
    { repo: "org/shop-front", name: "shop", baseUrl: "not-a-url", target: "e2e", needsReview: true, shadow: true, testDataPrefix: "qa" },
    deps,
  );
  assert.equal(r.ok, false);
  assert.ok((r.errors ?? []).length > 0);
  assert.deepEqual(deps.written, {});
});

test("duplicate name or invalid name is rejected", async () => {
  const dup = await createApp({ repo: "o/r", name: "shop", baseUrl: "https://x", target: "e2e", needsReview: true, shadow: true, testDataPrefix: "qa" }, makeDeps({ configExists: () => true }));
  assert.equal(dup.ok, false);
  const bad = await createApp({ repo: "o/r", name: "../evil", baseUrl: "https://x", target: "e2e", needsReview: true, shadow: true, testDataPrefix: "qa" }, makeDeps());
  assert.equal(bad.ok, false);
});

test("deleteApp removes the config; purge also removes the PRIMARY mirror and history", () => {
  const deps = makeDeps();
  const plain = deleteApp("shop", false, deps);
  assert.deepEqual(plain.removed, ["config:shop"]);
  const deps2 = makeDeps();
  const purged = deleteApp("shop", true, deps2);
  assert.deepEqual(purged.removed, ["config:shop", "mirror:org/shop-front", "history:shop"]);
});
```

- [ ] **Step 3: Run to verify failure**

Run: `node --import tsx --test src/server/app-admin.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 4: Implement**

Create `src/server/app-admin.ts`:

```ts
// Server-side app onboarding/deletion. EVERYTHING that needs secrets or writes
// config runs here (the orchestrator has the tokens; the TUI does not — that was
// the root cause of the broken wizard). All side effects are injected (AppAdminDeps)
// so the logic is unit-tested with stubs.

import { parse } from "yaml";
import { AppConfigSchema } from "../orchestrator/schemas";
import { expandEnv, type AppConfig } from "../orchestrator/config-loader";
import { buildYaml, suggestName, type OnboardInput, type OnboardServiceInput } from "./onboard";
import type { RepoInfo } from "../integrations/github";
import type { TestTarget } from "../types";

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

export interface AppAdminDeps {
  getRepoInfo(repo: string): Promise<RepoInfo>;
  configExists(name: string): boolean;
  writeConfig(name: string, yaml: string): string;
  deleteConfig(name: string): void;
  deleteMirror(repo: string): void;
  deleteHistory(app: string): number;
  applyEnv(vars: Record<string, string>): string[];
  loadApp(name: string): AppConfig;
  env: Record<string, string | undefined>;
}

export interface CreateAppInput {
  repo: string;
  name?: string;
  baseUrl?: string;
  versionUrl?: string;
  target?: TestTarget;
  needsReview?: boolean;
  shadow?: boolean;
  testDataPrefix?: string;
  services?: OnboardServiceInput[];
  env?: Record<string, string>;
  dryRun?: boolean;
  validateOnly?: boolean;
}

export interface CreateAppResult {
  ok: boolean;
  errors?: string[];
  repoInfo?: RepoInfo;
  yaml?: string; // dryRun: the YAML the server would write
  name?: string;
  path?: string;
  envApplied?: string[]; // KEY names only — values never travel back
  warnings?: string[];
}

export async function createApp(input: CreateAppInput, deps: AppAdminDeps): Promise<CreateAppResult> {
  let repoInfo: RepoInfo;
  try {
    repoInfo = await deps.getRepoInfo(input.repo);
  } catch (err) {
    return { ok: false, errors: [`repo validation failed: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (input.validateOnly) return { ok: true, repoInfo };

  const name = input.name ?? suggestName(input.repo);
  if (!NAME_RE.test(name)) return { ok: false, errors: [`invalid app name '${name}' (expected [a-z0-9][a-z0-9-]*)`] };
  if (!input.dryRun && deps.configExists(name)) return { ok: false, errors: [`app '${name}' already exists`] };

  const onboard: OnboardInput = {
    name,
    repo: repoInfo.fullName,
    baseBranch: repoInfo.defaultBranch,
    baseUrl: input.baseUrl || `https://github.com/${repoInfo.fullName}`,
    versionUrl: input.versionUrl || undefined,
    target: input.target ?? "e2e",
    needsReview: input.needsReview ?? true,
    shadow: input.shadow ?? true,
    testDataPrefix: input.testDataPrefix || "qa-bot",
    services: input.services,
  };
  const yaml = buildYaml(onboard);

  // Validate what loadAppConfig will see: env-expanded YAML against the schema. For a
  // dryRun, expansion uses the PROVIDED env over the live one without applying anything.
  const expansionEnv = { ...deps.env, ...(input.env ?? {}) };
  try {
    AppConfigSchema.parse(parse(expandEnv(yaml, expansionEnv)));
  } catch (err) {
    return { ok: false, errors: [err instanceof Error ? err.message : String(err)], yaml };
  }

  if (input.dryRun) return { ok: true, repoInfo, name, yaml };

  let envApplied: string[] = [];
  if (input.env && Object.keys(input.env).length > 0) {
    envApplied = deps.applyEnv(input.env);
  }
  const path = deps.writeConfig(name, yaml);
  const warnings = envApplied.length
    ? ["env vars persisted to .env and applied live — if you deploy with Doppler, add them in Doppler too or they die with the container"]
    : [];
  return { ok: true, repoInfo, name, path, envApplied, warnings };
}

export function deleteApp(name: string, purge: boolean, deps: AppAdminDeps): { removed: string[] } {
  if (!NAME_RE.test(name)) throw new Error(`invalid app name: ${JSON.stringify(name)}`);
  const app = deps.loadApp(name); // throws 404-style if not onboarded
  const removed: string[] = [];
  deps.deleteConfig(name);
  removed.push(`config:${name}`);
  if (purge) {
    // ONLY the primary mirror: a service repo's mirror may be shared with another app,
    // and mirrors are regenerable caches anyway.
    deps.deleteMirror(app.repo);
    removed.push(`mirror:${app.repo}`);
    deps.deleteHistory(name);
    removed.push(`history:${name}`);
  }
  return { removed };
}
```

- [ ] **Step 5: Run the tests** — Expected: PASS.

- [ ] **Step 6: Full gate + commit**

```bash
npm run typecheck && npm test
git add src/server/app-admin.ts src/server/app-admin.test.ts src/orchestrator/config-loader.ts
git commit -m "feat(server): app-admin — server-side app create/delete behind injected deps"
```

---

### Task 5: API endpoints

**Files:**
- Modify: `src/server/api.ts` (`ApiDeps` lines 20–34, route table lines 45–93, new handlers)
- Test: extend `src/server/api.test.ts` (follow its existing stub-deps + fake req/res pattern)

- [ ] **Step 1: Write the failing tests**

```ts
test("POST /api/apps delegates to createApp and 201s on success", async () => {
  const deps = makeApiDeps({
    createApp: async (input: CreateAppInput) => ({ ok: true, name: input.name, path: "/x/shop.yaml", envApplied: ["K"] }),
  });
  const res = await dispatch(deps, "POST", "/api/apps", { repo: "org/shop-front", name: "shop" });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, "shop");
});

test("POST /api/apps maps a validation failure to 422", async () => {
  const deps = makeApiDeps({ createApp: async () => ({ ok: false, errors: ["bad url"] }) });
  const res = await dispatch(deps, "POST", "/api/apps", { repo: "org/x" });
  assert.equal(res.status, 422);
  assert.deepEqual(res.body.errors, ["bad url"]);
});

test("POST /api/apps without the dep returns 501", async () => {
  const res = await dispatch(makeApiDeps({}), "POST", "/api/apps", { repo: "org/x" });
  assert.equal(res.status, 501);
});

test("DELETE /api/apps/:name passes purge and 200s", async () => {
  let got: { name: string; purge: boolean } | undefined;
  const deps = makeApiDeps({
    deleteApp: (name: string, purge: boolean) => { got = { name, purge }; return { removed: [`config:${name}`] }; },
  });
  const res = await dispatch(deps, "DELETE", "/api/apps/shop?purge=1");
  assert.equal(res.status, 200);
  assert.deepEqual(got, { name: "shop", purge: true });
});

test("DELETE /api/apps/:name on a missing app returns 404", async () => {
  const deps = makeApiDeps({ deleteApp: () => { throw new Error("config/apps/shop.yaml not found — is the app onboarded?"); } });
  const res = await dispatch(deps, "DELETE", "/api/apps/shop");
  assert.equal(res.status, 404);
});
```

(`makeApiDeps`/`dispatch` are this test file's existing helpers for stub deps and fake IncomingMessage/ServerResponse — reuse them exactly; if the file names them differently, match the file.)

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test src/server/api.test.ts`
Expected: FAIL — routes don't exist.

- [ ] **Step 3: Implement**

1. `ApiDeps` — add two optional members (501 when absent, same pattern as `cancelRun`):

```ts
  createApp?: (input: CreateAppInput) => Promise<CreateAppResult>;
  deleteApp?: (name: string, purge: boolean) => { removed: string[] };
```

with `import type { CreateAppInput, CreateAppResult } from "./app-admin";`.

2. Route table — inside `handleApi`, before the `appMatch` GET (line 62):

```ts
  if (req.method === "POST" && path === "/api/apps") {
    return await handleCreateApp(req, res, deps);
  }
  if (req.method === "DELETE" && appMatch) {
    return handleDeleteApp(res, deps, appMatch[1]!, url.searchParams.get("purge") === "1");
  }
```

(move the `const appMatch = ...` line above these routes).

3. Handlers (bottom of the file):

```ts
async function handleCreateApp(req: IncomingMessage, res: ServerResponse, deps: ApiDeps): Promise<boolean> {
  if (!deps.createApp) {
    json(res, 501, { error: "app onboarding is not available" });
    return true;
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    json(res, 400, { error: "invalid JSON" });
    return true;
  }
  if (typeof body.repo !== "string" || !body.repo.includes("/")) {
    json(res, 400, { error: "'repo' is required in 'org/name' form" });
    return true;
  }
  try {
    const result = await deps.createApp(body as unknown as CreateAppInput);
    if (!result.ok) {
      json(res, 422, { errors: result.errors ?? ["invalid app config"] });
      return true;
    }
    // env VALUES never travel back; CreateAppResult only carries the key names.
    json(res, body.dryRun || body.validateOnly ? 200 : 201, result);
  } catch (err) {
    json(res, 500, { error: redactError(err) });
  }
  return true;
}

function handleDeleteApp(res: ServerResponse, deps: ApiDeps, name: string, purge: boolean): boolean {
  if (!deps.deleteApp) {
    json(res, 501, { error: "app deletion is not available" });
    return true;
  }
  try {
    json(res, 200, deps.deleteApp(name, purge));
  } catch (err) {
    const msg = redactError(err);
    json(res, msg.includes("not found") ? 404 : 500, { error: msg });
  }
  return true;
}
```

- [ ] **Step 4: Run the tests** — Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run typecheck && npm test
git add src/server/api.ts src/server/api.test.ts
git commit -m "feat(api): POST /api/apps and DELETE /api/apps/:name (server-side onboarding)"
```

---

### Task 6: wire the real deps in `src/index.ts`

**Files:**
- Modify: `src/index.ts` (the `apiDeps` object — find it with `grep -n "apiDeps" src/index.ts`)

- [ ] **Step 1: Implement**

Where `apiDeps` is built, add:

```ts
import { createApp as adminCreateApp, deleteApp as adminDeleteApp, type AppAdminDeps } from "./server/app-admin";
import { writeConfig, configExists } from "./server/onboard";
import { applyEnvVars, defaultEnvStoreFs } from "./server/env-store";
import { deleteAppHistory } from "./server/history";
import { rmSync, unlinkSync } from "node:fs";

const appAdminDeps: AppAdminDeps = {
  getRepoInfo: (repo) => github.getRepo(repo),
  configExists: (name) => configExists(name),
  writeConfig: (name, yaml) => writeConfig(name, yaml),
  deleteConfig: (name) => unlinkSync(join(process.env.PANCHITO_ROOT ?? process.cwd(), "config", "apps", `${name}.yaml`)),
  deleteMirror: (repo) => rmSync(join(process.env.MIRROR_DIR ?? join(process.cwd(), ".mirrors"), repo.replaceAll("/", "__")), { recursive: true, force: true }),
  deleteHistory: (app) => deleteAppHistory(app),
  applyEnv: (vars) => applyEnvVars(vars, { fs: defaultEnvStoreFs(), env: process.env }),
  loadApp: (name) => loadAppConfig(name),
  env: process.env,
};
```

and on `apiDeps`:

```ts
  createApp: (input) => adminCreateApp(input, appAdminDeps),
  deleteApp: (name, purge) => adminDeleteApp(name, purge, appAdminDeps),
```

(`github` and `loadAppConfig` are already imported in index.ts; `join` too — verify and reuse.)

- [ ] **Step 2: Full gate + commit**

```bash
npm run typecheck && npm test
git add src/index.ts
git commit -m "feat(server): wire app-admin into the control API"
```

---

### Task 7: TUI client methods

**Files:**
- Modify: `src/tui/client.ts` (`QaClient` lines 76–86, `createClient` returns lines 121–132)
- Test: extend `src/tui/client.test.ts` (it stubs `fetchImpl` — follow that pattern)

- [ ] **Step 1: Write the failing tests**

```ts
test("validateRepo POSTs /api/apps with validateOnly", async () => {
  let captured: { url: string; body: unknown } | undefined;
  const client = createClient({
    host: "h:1", fetchImpl: (async (url: string, init: RequestInit) => {
      captured = { url, body: JSON.parse(String(init.body)) };
      return new Response(JSON.stringify({ ok: true, repoInfo: { fullName: "o/r", defaultBranch: "main", private: false, name: "r", description: null } }), { status: 200 });
    }) as typeof fetch,
  });
  const r = await client.validateRepo("o/r");
  assert.equal(captured?.url, "http://h:1/api/apps");
  assert.deepEqual(captured?.body, { repo: "o/r", validateOnly: true });
  assert.equal(r.repoInfo?.defaultBranch, "main");
});

test("deleteApp DELETEs with the purge flag", async () => {
  let url = "";
  const client = createClient({
    host: "h:1", fetchImpl: (async (u: string, init: RequestInit) => {
      url = u;
      assert.equal(init.method, "DELETE");
      return new Response(JSON.stringify({ removed: ["config:shop"] }), { status: 200 });
    }) as typeof fetch,
  });
  const r = await client.deleteApp("shop", true);
  assert.equal(url, "http://h:1/api/apps/shop?purge=1");
  assert.deepEqual(r.removed, ["config:shop"]);
});
```

- [ ] **Step 2: Run to verify failure** — `node --import tsx --test src/tui/client.test.ts` → FAIL.

- [ ] **Step 3: Implement**

Add the shared types and methods to `src/tui/client.ts`:

```ts
export interface OnboardServiceInput {
  repo: string;
  openapi?: string;
  versionUrl?: string;
}

export interface CreateAppRequest {
  repo: string;
  name?: string;
  baseUrl?: string;
  versionUrl?: string;
  target?: "e2e" | "code";
  needsReview?: boolean;
  shadow?: boolean;
  testDataPrefix?: string;
  services?: OnboardServiceInput[];
  env?: Record<string, string>;
  dryRun?: boolean;
  validateOnly?: boolean;
}

export interface CreateAppResponse {
  ok: boolean;
  errors?: string[];
  repoInfo?: { name: string; fullName: string; private: boolean; defaultBranch: string; description: string | null };
  yaml?: string;
  name?: string;
  path?: string;
  envApplied?: string[];
  warnings?: string[];
}
```

`QaClient` gains:

```ts
  validateRepo(repo: string): Promise<CreateAppResponse>;
  createApp(input: CreateAppRequest): Promise<CreateAppResponse>;
  deleteApp(name: string, purge: boolean): Promise<{ removed: string[] }>;
```

and the implementation object:

```ts
    validateRepo: (repo) => request<CreateAppResponse>("POST", "/api/apps", { repo, validateOnly: true }),
    createApp: (input) => request<CreateAppResponse>("POST", "/api/apps", input),
    deleteApp: (name, purge) =>
      request<{ removed: string[] }>("DELETE", `/api/apps/${encodeURIComponent(name)}${purge ? "?purge=1" : ""}`),
```

- [ ] **Step 4: Run the tests** — Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run typecheck && npm test
git add src/tui/client.ts src/tui/client.test.ts
git commit -m "feat(tui): client methods for app create/validate/delete"
```

---

### Task 8: wizard rework + delete dialog

**Files:**
- Modify: `src/tui/components/OnboardWizard.tsx`
- Create: `src/tui/components/DeleteProjectDialog.tsx`
- Modify: `src/tui/components/HomeScreen.tsx` and `src/tui/app.tsx` (pass the client; add the delete action)
- Test: update `src/tui/components/OnboardWizard.test.tsx` (it uses ink-testing-library — keep its render/stdin pattern)

- [ ] **Step 1: Rework the wizard to be a thin client**

Changes to `OnboardWizard.tsx` (keep the existing rendering style):

1. Props gain the client; remove the direct `github` and fs imports:

```tsx
import { QaClient, CreateAppResponse, OnboardServiceInput } from "../client";
import { suggestName } from "../../server/onboard";

export function OnboardWizard({ client, onDone, onCancel }: { client: QaClient; onDone: (appName: string) => void; onCancel: () => void }): React.ReactElement {
```

2. `Step` union becomes:

```ts
type Step =
  | "repo" | "validating" | "repo-error"
  | "dev-url" | "dev-version"
  | "qa-target" | "qa-review" | "qa-shadow" | "qa-prefix"
  | "svc-ask" | "svc-repo" | "svc-openapi" | "svc-version"
  | "env-ask" | "env-entry"
  | "review" | "committing" | "done" | "write-error";
```

3. New state:

```ts
  const [repoInfo, setRepoInfo] = useState<CreateAppResponse["repoInfo"] | null>(null);
  const [services, setServices] = useState<OnboardServiceInput[]>([]);
  const [svcDraft, setSvcDraft] = useState<OnboardServiceInput>({ repo: "" });
  const [envVars, setEnvVars] = useState<Record<string, string>>({});
  const [envDraft, setEnvDraft] = useState("");
  const [yamlPreview, setYamlPreview] = useState("");
```

4. `validateRepo` goes through the server:

```ts
  const validateRepo = useCallback(async () => {
    const trimmed = repoInput.trim();
    if (!trimmed.includes("/")) {
      setError("repo must be in 'org/name' format (e.g. 'facebook/react')");
      setStep("repo-error");
      return;
    }
    setLoading(true);
    setStep("validating");
    try {
      const r = await client.validateRepo(trimmed);
      if (!r.ok || !r.repoInfo) throw new Error(r.errors?.join("; ") ?? "validation failed");
      setRepoInfo(r.repoInfo);
      setAppName(suggestName(trimmed));
      setStep("dev-url");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("repo-error");
    } finally {
      setLoading(false);
    }
  }, [repoInput, client]);
```

5. After `qa-prefix`, route to `svc-ask` instead of `review` (e2e target only; code target jumps to `env-ask`). The services loop:

```tsx
  if (step === "svc-ask") {
    const items: SelectItem[] = [
      { label: services.length ? `Add another service (${services.length} added)` : "Add a microservice repo (multi-repo app)", value: "add" },
      { label: "Continue — no more services", value: "next" },
    ];
    return (
      <Box flexDirection="column">
        <Text bold>Microservice repos (optional):</Text>
        {services.map((s) => <Text key={s.repo} dimColor>  ✓ {s.repo}{s.openapi ? ` (openapi: ${s.openapi})` : ""}</Text>)}
        <SelectInput items={items} onSelect={(i) => {
          if (i.value === "add") { setSvcDraft({ repo: "" }); setStep("svc-repo"); }
          else setStep("env-ask");
        }} />
      </Box>
    );
  }
```

with `svc-repo` / `svc-openapi` / `svc-version` as free-text steps using the SAME `useInput` text pattern as `dev-url` (Enter advances; `svc-version` Enter pushes the draft):

```ts
    if (step === "svc-repo") {
      if (key.return && svcDraft.repo.trim().includes("/")) { setStep("svc-openapi"); return; }
      if (key.backspace || key.delete) { setSvcDraft((p) => ({ ...p, repo: p.repo.slice(0, -1) })); return; }
      if (char.length === 1 && char >= " ") { setSvcDraft((p) => ({ ...p, repo: p.repo + char })); }
      return;
    }
    if (step === "svc-openapi") {
      if (key.return) { setStep("svc-version"); return; }
      if (key.backspace || key.delete) { setSvcDraft((p) => ({ ...p, openapi: (p.openapi ?? "").slice(0, -1) || undefined })); return; }
      if (char.length === 1 && char >= " ") { setSvcDraft((p) => ({ ...p, openapi: (p.openapi ?? "") + char })); }
      return;
    }
    if (step === "svc-version") {
      if (key.return) {
        setServices((prev) => [...prev, { ...svcDraft, repo: svcDraft.repo.trim() }]);
        setStep("svc-ask");
        return;
      }
      if (key.backspace || key.delete) { setSvcDraft((p) => ({ ...p, versionUrl: (p.versionUrl ?? "").slice(0, -1) || undefined })); return; }
      if (char.length === 1 && char >= " ") { setSvcDraft((p) => ({ ...p, versionUrl: (p.versionUrl ?? "") + char })); }
      return;
    }
```

(and matching render blocks copied from the `dev-version` pattern, with titles "Service repo (org/name):", "Service OpenAPI glob (optional, Enter to skip):", "Service version endpoint (optional, Enter to skip):").

6. Env-vars loop — `env-ask` mirrors `svc-ask` ("Add an env var the config/agent needs (KEY=value)" / "Continue"); `env-entry` accepts one `KEY=value` line:

```ts
    if (step === "env-entry") {
      if (key.return) {
        const eq = envDraft.indexOf("=");
        if (eq > 0) {
          const k = envDraft.slice(0, eq).trim();
          const v = envDraft.slice(eq + 1);
          setEnvVars((prev) => ({ ...prev, [k]: v }));
        }
        setEnvDraft("");
        setStep("env-ask");
        return;
      }
      if (key.backspace || key.delete) { setEnvDraft((p) => p.slice(0, -1)); return; }
      if (char.length === 1 && char >= " ") { setEnvDraft((p) => p + char); }
      return;
    }
```

Render env values MASKED: `<Text dimColor>  ✓ {key}=••••</Text>`. `env-ask` continues to `review`.

7. The `review` step fetches the authoritative YAML from the server (dryRun) on entry, then shows it; `commit` does the real POST:

```ts
  const buildRequest = useCallback((flags: { dryRun?: boolean }) => ({
    repo: repoInfo?.fullName ?? repoInput.trim(),
    name: appName,
    baseUrl: baseUrl || undefined,
    versionUrl: versionUrl || undefined,
    target,
    needsReview,
    shadow,
    testDataPrefix: testPrefix || "qa-bot",
    services: target === "e2e" && services.length ? services : undefined,
    env: Object.keys(envVars).length ? envVars : undefined,
    ...flags,
  }), [repoInfo, repoInput, appName, baseUrl, versionUrl, target, needsReview, shadow, testPrefix, services, envVars]);

  const loadPreview = useCallback(async () => {
    try {
      const r = await client.createApp(buildRequest({ dryRun: true }));
      if (!r.ok) throw new Error(r.errors?.join("; ") ?? "invalid configuration");
      setYamlPreview(r.yaml ?? "");
      setStep("review");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("write-error");
    }
  }, [client, buildRequest]);

  const commit = useCallback(async () => {
    setStep("committing");
    try {
      const r = await client.createApp(buildRequest({}));
      if (!r.ok) throw new Error(r.errors?.join("; ") ?? "creation failed");
      setStep("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("write-error");
    }
  }, [client, buildRequest]);
```

`env-ask`'s "Continue" calls `loadPreview()`; the review render shows `yamlPreview` instead of the locally-built YAML; `committing` renders a spinner like `validating`. Delete the now-unused local `buildYaml`/`writeConfig`/`configExists` imports and the old sync `commit`.

- [ ] **Step 2: Delete dialog**

Create `src/tui/components/DeleteProjectDialog.tsx`:

```tsx
import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import SelectInput from "ink-select-input";
import Spinner from "ink-spinner";
import { QaClient } from "../client";

type Phase = "choose" | "confirm" | "deleting" | "done" | "error";

export function DeleteProjectDialog({
  client,
  appName,
  onDone,
  onCancel,
}: {
  client: QaClient;
  appName: string;
  onDone: () => void;
  onCancel: () => void;
}): React.ReactElement {
  const [phase, setPhase] = useState<Phase>("choose");
  const [purge, setPurge] = useState(false);
  const [removed, setRemoved] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  useInput((_, key) => {
    if (key.escape) {
      if (phase === "done") onDone();
      else onCancel();
    }
    if (phase === "done" && key.return) onDone();
  });

  const run = async () => {
    setPhase("deleting");
    try {
      const r = await client.deleteApp(appName, purge);
      setRemoved(r.removed);
      setPhase("done");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase("error");
    }
  };

  if (phase === "choose") {
    return (
      <Box flexDirection="column">
        <Text bold>Delete project '{appName}' — what should be removed?</Text>
        <SelectInput
          items={[
            { label: "Config only (config/apps/*.yaml; keeps run history + mirror)", value: "config" },
            { label: "Config + mirror + run history (full purge)", value: "purge" },
            { label: "Cancel", value: "cancel" },
          ]}
          onSelect={(i) => {
            if (i.value === "cancel") return onCancel();
            setPurge(i.value === "purge");
            setPhase("confirm");
          }}
        />
      </Box>
    );
  }

  if (phase === "confirm") {
    return (
      <Box flexDirection="column">
        <Text bold color="#c0392b">This removes:</Text>
        <Text>  - config/apps/{appName}.yaml</Text>
        {purge ? <Text>  - the repo mirror (regenerable cache)</Text> : null}
        {purge ? <Text>  - ALL run history for '{appName}' (not recoverable)</Text> : null}
        <Text dimColor>  The watched repo itself is NEVER touched.</Text>
        <SelectInput
          items={[
            { label: "Yes — delete", value: "yes" },
            { label: "No — cancel", value: "no" },
          ]}
          onSelect={(i) => (i.value === "yes" ? void run() : onCancel())}
        />
      </Box>
    );
  }

  if (phase === "deleting") return <Text color="cyan"><Spinner type="dots" /> deleting…</Text>;

  if (phase === "error") {
    return (
      <Box flexDirection="column">
        <Text color="#c0392b">✗ {error}</Text>
        <Text dimColor>Esc to go back</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Text color="#3b7a57">✓ deleted: {removed.join(", ")}</Text>
      <Text dimColor>Enter/Esc to continue</Text>
    </Box>
  );
}
```

- [ ] **Step 3: Integrate**

- `src/tui/app.tsx:154` and `src/tui/components/HomeScreen.tsx:150` already render `<OnboardWizard onDone=... onCancel=.../>` — add the `client` prop using the SAME client instance each file already uses for its data fetching (grep `createClient(` in both files and reuse that variable).
- In `HomeScreen.tsx`, add a "Delete Project" action next to the existing "Add New Project" entry (same menu structure), which opens `<DeleteProjectDialog client={client} appName={selectedApp} onDone={refreshApps} onCancel={closeDialog} />` for the selected app. Mirror exactly how the onboarding entry toggles its `onboarding` state — introduce a `deleting` state alongside it.

- [ ] **Step 4: Update the wizard test**

`src/tui/components/OnboardWizard.test.tsx` mocked the old direct-fs flow. Update it to pass a stub client:

```tsx
const stubClient = {
  validateRepo: async () => ({ ok: true, repoInfo: { name: "r", fullName: "org/r", private: false, defaultBranch: "main", description: null } }),
  createApp: async (input: CreateAppRequest) => (input.dryRun ? { ok: true, yaml: "name: r" } : { ok: true, name: "r" }),
  deleteApp: async () => ({ removed: [] }),
} as unknown as QaClient;
```

and render `<OnboardWizard client={stubClient} onDone={...} onCancel={...} />`. Keep/adapt the file's existing stdin-driving assertions; add one flow test that walks: repo → (e2e defaults) → svc-ask "Continue" → env-ask "Continue" → review shows `name: r`.

- [ ] **Step 5: Run the TUI tests**

Run: `node --import tsx --test src/tui/components/OnboardWizard.test.tsx`
Expected: PASS.

- [ ] **Step 6: Full gate + commit**

```bash
npm run typecheck && npm test
git add src/tui src/server/onboard.ts
git commit -m "feat(tui): server-backed onboarding wizard (services + env vars) and delete-project flow"
```

---

### Task 9: docs + manual verification

**Files:**
- Modify: `docs/interactive-layer.md` (API surface section), `src/server/help.ts` (the onboarding help text, lines 45–79)

- [ ] **Step 1: Document the endpoints**

Add to the API surface in `docs/interactive-layer.md`:

```markdown
- `POST /api/apps` — server-side onboarding: validates the repo against GitHub (the
  token lives in the orchestrator, NOT the TUI), validates the YAML against the schema,
  writes `config/apps/<name>.yaml`. Body flags: `validateOnly` (repo check → repoInfo),
  `dryRun` (returns the YAML, writes nothing), `env` (vars applied live + persisted to
  `.env`; values are never echoed back). With Doppler, persist the vars there too.
- `DELETE /api/apps/:name[?purge=1]` — removes the app config; purge also removes the
  PRIMARY repo mirror (service mirrors may be shared) and the app's run history.
```

Update `src/server/help.ts` "How to onboard a project" to mention the services and env steps.

- [ ] **Step 2: Manual smoke (the bug this fixes)**

```bash
doppler run -- docker compose up --build -d
npx tsx src/tui/index.tsx       # on the host, WITHOUT GITHUB_TOKEN in the host env
```

Walk: Add New Project → enter a public repo → must validate WITHOUT a token error (server does it) → add one service → add one env var → review shows the server YAML → confirm → `config/apps/<name>.yaml` exists. Then Delete Project (config only) → file gone, history intact. If you cannot run the TUI interactively, say so in the PR notes instead of claiming verification.

- [ ] **Step 3: Full gate + commit**

```bash
npm run typecheck && npm test
git add docs/interactive-layer.md src/server/help.ts
git commit -m "docs: server-side onboarding/deletion API + TUI flow"
```

---

### F5 exit criteria

- The wizard works on a host with NO `GITHUB_TOKEN` (the original bug).
- `services[]` and env vars can be declared during onboarding; secrets land in `.env` (own line) AND the live process env; values never appear in any API response.
- Delete Project removes the YAML; purge also removes the primary mirror + history; the watched repo is never touched.
- `npm test` + `npm run typecheck` green.
