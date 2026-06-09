# F2 — Multi-service context map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `context` mode mirrors every `services[]` repo and the agent builds ONE `context.json` joining the front's routes to ALL services' OpenAPI operations (filling the existing `ApiOperation.service` field).

**Architecture:** The pipeline's context-mode branch (src/pipeline.ts:414–477) prepares one read-only mirror per service via `prepareAtBranch` (built in F1) and passes the list to the agent; `buildContextTask` renders a per-service extraction section; after validation the orchestrator warns (never blocks) about configured services with zero mapped operations. Spec §5. **Depends on F1** (schema `services[]`, `prepareAtBranch`).

**Tech Stack:** TypeScript strict, `node:test`, existing DI pattern (`PipelineDeps`).

---

### Task 1: pipeline — mirror services in context mode and pass them to the agent

**Files:**
- Modify: `src/pipeline.ts` (`GenerateInput` lines 58–78, context-mode branch lines 414–477, `defaultPipelineDeps().generate`)
- Test: extend `src/pipeline.test.ts`

- [ ] **Step 1: Write the failing tests**

In `src/pipeline.test.ts`, reusing the same `makeDeps`/`makeApp` helpers from F1:

```ts
test("context mode with services mirrors each service and passes them to generate", async () => {
  const branched: string[] = [];
  let genInput: GenerateInput | undefined;
  const deps = makeDeps({
    prepare: async () => ({ mirrorDir: "/m/front", diff: "", message: "chore: ctx" }),
    prepareAtBranch: async (repo: string, branch: string) => { branched.push(`${repo}#${branch}`); return { mirrorDir: `/m/${repo.split("/")[1]}` }; },
    generate: async (i: GenerateInput) => { genInput = i; return { output: "", specs: ["e2e/.qa/context.json"], reviewed: false, approved: true }; },
    validateContextFn: () => ({ ok: true, errors: [] }),
  });
  const app = makeApp({
    repo: "org/shop-front",
    services: [
      { repo: "org/orders-svc", openapi: "api/*.yaml" },
      { repo: "org/payments-svc", baseBranch: "develop" },
    ],
    shadow: true,
  });
  await runPipeline(app, "a1b2c3d", deps, "manual", { mode: "context", runId: "r1" });
  assert.deepEqual(branched.sort(), ["org/orders-svc#main", "org/payments-svc#develop"]);
  assert.equal(genInput?.services?.length, 2);
  assert.equal(genInput?.services?.[0]?.repo, "org/orders-svc");
  assert.equal(genInput?.services?.[0]?.mirrorDir, "/m/orders-svc");
});

test("context mode without services passes no services (unchanged behavior)", async () => {
  let genInput: GenerateInput | undefined;
  const deps = makeDeps({
    prepare: async () => ({ mirrorDir: "/m/front", diff: "", message: "chore: ctx" }),
    generate: async (i: GenerateInput) => { genInput = i; return { output: "", specs: ["e2e/.qa/context.json"], reviewed: false, approved: true }; },
    validateContextFn: () => ({ ok: true, errors: [] }),
  });
  await runPipeline(makeApp({ shadow: true }), "a1b2c3d", deps, "manual", { mode: "context", runId: "r1" });
  assert.equal(genInput?.services, undefined);
});

test("context mode warns (does not fail) when a configured service has no mapped operations", async () => {
  const logs: string[] = [];
  const deps = makeDeps({
    prepare: async () => ({ mirrorDir: "/m/front", diff: "", message: "chore: ctx" }),
    prepareAtBranch: async () => ({ mirrorDir: "/m/svc" }),
    generate: async () => ({ output: "", specs: ["e2e/.qa/context.json"], reviewed: false, approved: true }),
    validateContextFn: () => ({ ok: true, errors: [] }),
    readBuiltContext: () => ({ builtAtSha: "a1b2c3d", routes: [], api: [], feBe: [] }),
    log: (m: string) => logs.push(m),
  });
  const app = makeApp({ repo: "org/shop-front", services: [{ repo: "org/orders-svc" }], shadow: true });
  const r = await runPipeline(app, "a1b2c3d", deps, "manual", { mode: "context", runId: "r1" });
  assert.equal(r.verdict, "pass");
  assert.ok(logs.some((l) => l.includes("no operations for service org/orders-svc")));
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test src/pipeline.test.ts`
Expected: the three new tests FAIL (`services` not on GenerateInput, no warning emitted).

- [ ] **Step 3: Implement**

1. `GenerateInput` — add (next to `service?` from F1):

```ts
  services?: Array<{ repo: string; mirrorDir: string; openapi?: string | string[] }>; // context mode: every declared service, mirrored read-only
```

2. In the context-mode branch (line 414), before building `genInput`, mirror the services:

```ts
    let serviceRefs: GenerateInput["services"];
    if (app.services?.length) {
      serviceRefs = [];
      for (const svc of app.services) {
        log(`[qa] context: mirroring service ${svc.repo}...`);
        const m = await deps.prepareAtBranch(svc.repo, svc.baseBranch ?? "main");
        serviceRefs.push({ repo: svc.repo, mirrorDir: m.mirrorDir, openapi: svc.openapi });
      }
    }
```

and add `services: serviceRefs,` to the `genInput` object literal (line 418).

3. After `log("[qa] context map validated: OK")` (line 463), add the per-service coverage warning. To keep it injectable for tests, add an optional dep next to `validateContextFn` in `PipelineDeps`:

```ts
  // Context mode: reads the built map back for the per-service coverage warning.
  // Absent ⇒ the warning step is skipped (unit tests that don't care).
  readBuiltContext?(e2eDir: string): ArchitectureContext | null;
```

wired in `defaultPipelineDeps()`:

```ts
    readBuiltContext: (e2eDir) => {
      try {
        return JSON.parse(readFileSync(join(e2eDir, ".qa", "context.json"), "utf8")) as ArchitectureContext;
      } catch {
        return null;
      }
    },
```

and in the context-mode branch:

```ts
    if (app.services?.length && deps.readBuiltContext) {
      const built = deps.readBuiltContext(e2eDir);
      const mapped = new Set((built?.api ?? []).map((o) => o.service).filter(Boolean));
      for (const svc of app.services) {
        if (!mapped.has(svc.repo)) {
          log(`[qa] WARNING: the context map has no operations for service ${svc.repo} — its OpenAPI was not found or not extracted. Cross-repo runs for it will lack the map.`);
        }
      }
    }
```

NOTE for the test in Step 1: `readBuiltContext` is a `PipelineDeps` member, so the test override `readBuiltContext: () => ({...})` works through `makeDeps`.

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test src/pipeline.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run typecheck && npm test
git add src/pipeline.ts src/pipeline.test.ts
git commit -m "feat(context): mirror services[] and pass them to the context-mode agent"
```

---

### Task 2: `buildContextTask` — per-service extraction sections

**Files:**
- Modify: `src/integrations/opencode-client.ts` (`OpencodeRunInput` lines 188–209, `buildContextTask` lines 962–1014)
- Test: extend `src/integrations/opencode-client.test.ts`

- [ ] **Step 1: Write the failing tests**

```ts
test("buildContextTask renders one extraction section per service", () => {
  const text = buildContextTask({
    repo: "org/shop-front", sha: "a1b2c3d", diff: "", mirrorDir: "/m/front", e2eRelDir: "e2e",
    namespace: "qa-1", needsReview: false, target: "e2e", mode: "context", appName: "shop",
    services: [
      { repo: "org/orders-svc", mirrorDir: "/m/orders", openapi: "api/*.yaml" },
      { repo: "org/payments-svc", mirrorDir: "/m/payments" },
    ],
  });
  assert.match(text, /Microservice repos \(2\)/);
  assert.match(text, /org\/orders-svc.*\/m\/orders/s);
  assert.match(text, /api\/\*\.yaml/);
  assert.match(text, /"service" field/);
});

test("buildContextTask without services is unchanged (no microservice section)", () => {
  const text = buildContextTask({
    repo: "org/shop-front", sha: "a1b2c3d", diff: "", mirrorDir: "/m/front", e2eRelDir: "e2e",
    namespace: "qa-1", needsReview: false, target: "e2e", mode: "context", appName: "shop",
  });
  assert.doesNotMatch(text, /Microservice repos/);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `node --import tsx --test src/integrations/opencode-client.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

1. `OpencodeRunInput` — add (next to `service?` from F1):

```ts
  services?: Array<{ repo: string; mirrorDir: string; openapi?: string | string[] }>; // context mode: every declared service, mirrored read-only
```

2. In `defaultPipelineDeps().generate` (src/pipeline.ts), copy it into `ocInput`: `services: input.services,`.

3. In `buildContextTask`, build the section and insert it between the `## What to produce` list and `## Procedure`:

```ts
  const serviceLines = input.services?.length
    ? [
        ``,
        `## Microservice repos (${input.services.length})`,
        `This app's backend is split into microservices. Each repo below is mirrored READ-ONLY;`,
        `extract its OpenAPI operations into the SAME context.json, setting each operation's`,
        `"service" field to the repo name shown here:`,
        ``,
        ...input.services.flatMap((s) => {
          const hint = Array.isArray(s.openapi) ? s.openapi.join(", ") : s.openapi;
          return [
            `- **${s.repo}** — working copy at: ${s.mirrorDir}`,
            ...(hint ? [`  OpenAPI hint: ${hint} (relative to that working copy)`] : [`  No OpenAPI hint — search that working copy for openapi/swagger files.`]),
          ];
        }),
        ``,
        `The feBe JOIN is still derived from THIS frontend repo's API clients: a client method's`,
        `operationId must match an operation extracted from one of the services above (or from`,
        `this repo's own specs). Do not invent links for services the frontend never calls.`,
      ]
    : [];
```

and in the returned array, after the `4. **flows** (optional) ...` line:

```ts
    ...serviceLines,
```

Also update Procedure step 3 to mention the services:

```ts
    `3. Find ALL OpenAPI spec files${openapiHint ? ` (start with ${openapiHint})` : ""}.${input.services?.length ? " Include every microservice repo listed above (their working copies are local paths you can read)." : ""}`,
```

- [ ] **Step 4: Run the tests**

Run: `node --import tsx --test src/integrations/opencode-client.test.ts`
Expected: PASS.

- [ ] **Step 5: Full gate + commit**

```bash
npm run typecheck && npm test
git add src/integrations/opencode-client.ts src/integrations/opencode-client.test.ts src/pipeline.ts
git commit -m "feat(context): per-service OpenAPI extraction sections in the context task"
```

---

### F2 exit criteria

- `npm test` + `npm run typecheck` green.
- A `context` run on an app with `services[]` produces ONE `e2e/.qa/context.json` whose `api[]` entries carry `service: "<org/svc>"`, validated by the existing `validateContext` (no schema change needed — the field already exists, src/qa/context.ts:28).
- A missing service contract logs a WARNING and never fails the run (the map is an aid, not a gate).
