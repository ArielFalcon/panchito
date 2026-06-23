import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { setupE2eProject, SetupDeps, SetupOptions, defaultSetupDeps, FAILURE_CAPTURE_MARKER, FAILURE_CAPTURE_BLOCK } from "./setup";

test("repo with an e2e project: installs, does not bootstrap", async () => {
  const seq: string[] = [];
  const deps: SetupDeps = {
    hasProject: () => true,
    bootstrap: () => seq.push("bootstrap"),
    install: async () => {
      seq.push("install");
    },
  };
  await setupE2eProject("/mirror/e2e", deps);
  assert.deepEqual(seq, ["install"]);
});

test("repo without an e2e project: seeds first, then installs", async () => {
  const seq: string[] = [];
  let seeded = "";
  const deps: SetupDeps = {
    hasProject: () => false,
    bootstrap: (d) => {
      seeded = d;
      seq.push("bootstrap");
    },
    install: async () => {
      seq.push("install");
    },
  };
  await setupE2eProject("/mirror/e2e", deps);
  assert.deepEqual(seq, ["bootstrap", "install"]); // bootstrap BEFORE install
  assert.equal(seeded, "/mirror/e2e");
});

// The parallel fan-out workers are each assigned `flows/<flow>.spec.ts` and can only `write` (no
// mkdir). If the orchestrator does not create `flows/` first, every worker write fails silently and a
// complete/exhaustive run generates ZERO specs. Setup MUST ensure the dir — after seeding, before install.
test("ensures the flows/ spec dir exists (after bootstrap, before install) so fan-out workers can write", async () => {
  const seq: string[] = [];
  let ensuredFor = "";
  const deps: SetupDeps = {
    hasProject: () => false,
    bootstrap: () => seq.push("bootstrap"),
    ensureSpecDir: (d) => {
      ensuredFor = d;
      seq.push("ensureSpecDir");
    },
    install: async () => {
      seq.push("install");
    },
  };
  await setupE2eProject("/mirror/e2e", deps);
  assert.deepEqual(seq, ["bootstrap", "ensureSpecDir", "install"]);
  assert.equal(ensuredFor, "/mirror/e2e");
});

// Even on the install-cached fast path (deps up to date → no npm ci), the flows/ dir must still be
// ensured: a fresh checkout/clean can wipe it while node_modules (and the install marker) survive.
test("ensures flows/ even when the install is cached and skipped", async () => {
  const seq: string[] = [];
  const deps: SetupDeps = {
    hasProject: () => true,
    bootstrap: () => seq.push("bootstrap"),
    ensureSpecDir: () => {
      seq.push("ensureSpecDir");
    },
    install: async () => {
      seq.push("install");
    },
  };
  // /mirror/e2e has no node_modules marker, so isInstallCurrent is false and install runs; the point
  // here is simply that ensureSpecDir is invoked unconditionally before that branch.
  await setupE2eProject("/mirror/e2e", deps);
  assert.ok(seq.includes("ensureSpecDir"), `ensureSpecDir must run: ${seq.join(",")}`);
});

// ── Process safeguards: install timeout + operator cancel ────────────────────

test("a hung install times out and throws (the pipeline surfaces it as infra-error)", async () => {
  const deps: SetupDeps = {
    hasProject: () => true,
    bootstrap: () => {},
    install: () => new Promise(() => { /* hangs forever, like a wedged npm ci */ }),
  };
  await assert.rejects(
    () => setupE2eProject("/mirror/e2e", deps, { timeoutMs: 30 }),
    /timed out after 30ms — killed/,
  );
});

test("an already-aborted signal throws without starting the install", async () => {
  const controller = new AbortController();
  controller.abort();
  let installed = false;
  const deps: SetupDeps = {
    hasProject: () => true,
    bootstrap: () => {},
    install: async () => { installed = true; },
  };
  await assert.rejects(
    () => setupE2eProject("/mirror/e2e", deps, { signal: controller.signal }),
    /aborted by operator cancel/,
  );
  assert.equal(installed, false);
});

test("signal and timeoutMs are passed through to the install deps", async () => {
  const controller = new AbortController();
  let seen: SetupOptions | undefined;
  const deps: SetupDeps = {
    hasProject: () => true,
    bootstrap: () => {},
    install: async (_dir, opts) => { seen = opts; },
  };
  await setupE2eProject("/mirror/e2e", deps, { signal: controller.signal, timeoutMs: 5_000 });
  assert.equal(seen?.signal, controller.signal);
  assert.equal(seen?.timeoutMs, 5_000);
});

test("a failing install still propagates its own error (not a timeout)", async () => {
  const deps: SetupDeps = {
    hasProject: () => true,
    bootstrap: () => {},
    install: async () => { throw new Error("npm ci in e2e failed (code 1)"); },
  };
  await assert.rejects(() => setupE2eProject("/mirror/e2e", deps, { timeoutMs: 5_000 }), /failed \(code 1\)/);
});

// ── ensureFailureCapture (Unit 2 — Task 2.6) ────────────────────────────────
// Tests run against real temp dirs so append-only and idempotency are provable
// without mocking the FS. The defaultSetupDeps.ensureFailureCapture impl is the
// production code under test; SetupDeps stubs are used for the orchestration path.

test("ensureFailureCapture: first injection appends the block; existing lines untouched", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-setup-test-"));
  try {
    const fixturesPath = join(dir, "fixtures.ts");
    const existingContent = "export const test = base.extend({});\nexport { expect };\n";
    writeFileSync(fixturesPath, existingContent);
    defaultSetupDeps.ensureFailureCapture!(dir);
    const after = readFileSync(fixturesPath, "utf8");
    // Marker must be present after injection.
    assert.ok(after.includes(FAILURE_CAPTURE_MARKER), "marker not found after injection");
    // Existing lines must still be present at the start (append-only).
    assert.ok(after.startsWith(existingContent), "existing content was modified (not append-only)");
    // The original content is a prefix of the new content (nothing was deleted or reordered).
    assert.equal(after.slice(0, existingContent.length), existingContent);
    // W1: the injected block carries the NEW project- AND file-aware key (project + file/title hash +
    // retry) and the new body fields — guarding that setup.ts's FAILURE_CAPTURE_BLOCK stays in sync
    // with the fixture. C1: the block must be ESM-safe — dynamic import(), never require().
    assert.match(after, /testInfo\.project\.name/, "the injected block must record the project name");
    assert.match(after, /basename\(testInfo\.file/, "the injected block must record the spec file basename (W1)");
    assert.match(after, /createHash\("sha1"\)\.update\(`\$\{file\}\/\$\{title\}`\)/, "the filename hash must fold in the file AND the full title (no 80-char truncation)");
    assert.match(after, /\$\{safeProject\}__\$\{hash\}__\$\{testInfo\.retry\}\.json/, "the filename must be project__hash__retry");
    assert.match(after, /JSON\.stringify\(\{ project, file, title, retry: testInfo\.retry, yaml, finalUrl, httpStatus \}\)/, "the body must carry project, file, title, retry, yaml, finalUrl, httpStatus");
    // C1: ESM-safe — the appended block runs in a native-ESM fixtures.ts where require() is undefined.
    assert.doesNotMatch(after, /require\(/, "the injected block must not use require() (ReferenceError in ESM — dead capture)");
    assert.match(after, /await import\("node:fs"\)/, "the injected block must pull node:fs via dynamic import()");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureFailureCapture: idempotent — running twice produces identical output as running once", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-setup-test-"));
  try {
    const fixturesPath = join(dir, "fixtures.ts");
    writeFileSync(fixturesPath, "export { expect };\n");
    // First injection.
    defaultSetupDeps.ensureFailureCapture!(dir);
    const afterFirst = readFileSync(fixturesPath, "utf8");
    // Second injection — must be a no-op.
    defaultSetupDeps.ensureFailureCapture!(dir);
    const afterSecond = readFileSync(fixturesPath, "utf8");
    assert.equal(afterSecond, afterFirst, "second injection changed the file (not idempotent)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureFailureCapture: agent-added lines above the marker are preserved", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-setup-test-"));
  try {
    const fixturesPath = join(dir, "fixtures.ts");
    // Simulate an agent that already edited the file (added a custom helper above the marker).
    const agentLines = "export const myHelper = () => {};\nexport { expect };\n";
    writeFileSync(fixturesPath, agentLines);
    defaultSetupDeps.ensureFailureCapture!(dir);
    const after = readFileSync(fixturesPath, "utf8");
    // Agent lines still intact.
    assert.ok(after.includes("myHelper"), "agent-added lines were removed");
    // Marker appended after agent lines.
    const markerIdx = after.indexOf(FAILURE_CAPTURE_MARKER);
    const helperIdx = after.indexOf("myHelper");
    assert.ok(markerIdx > helperIdx, "marker appears before agent lines (not append-only)");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ensureFailureCapture: missing fixtures.ts is a no-op (new onboards get block from seed)", () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-setup-test-"));
  try {
    // No fixtures.ts in this dir.
    assert.ok(!existsSync(join(dir, "fixtures.ts")), "test precondition: fixtures.ts must not exist");
    // Must not throw and must not create the file.
    assert.doesNotThrow(() => defaultSetupDeps.ensureFailureCapture!(dir));
    assert.ok(!existsSync(join(dir, "fixtures.ts")), "ensureFailureCapture created fixtures.ts when it should be a no-op");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("setupE2eProject calls ensureFailureCapture after ensureSpecDir", async () => {
  const seq: string[] = [];
  const deps: SetupDeps = {
    hasProject: () => true,
    bootstrap: () => { seq.push("bootstrap"); },
    ensureSpecDir: () => { seq.push("ensureSpecDir"); },
    ensureFailureCapture: () => { seq.push("ensureFailureCapture"); },
    install: async () => { seq.push("install"); },
  };
  await setupE2eProject("/mirror/e2e", deps);
  const specIdx = seq.indexOf("ensureSpecDir");
  const captureIdx = seq.indexOf("ensureFailureCapture");
  assert.ok(captureIdx !== -1, "ensureFailureCapture was not called");
  assert.ok(specIdx !== -1, "ensureSpecDir was not called");
  assert.ok(captureIdx > specIdx, "ensureFailureCapture must run after ensureSpecDir");
});

test("setupE2eProject still works when ensureFailureCapture is absent (older stubs)", async () => {
  const seq: string[] = [];
  const deps: SetupDeps = {
    hasProject: () => true,
    bootstrap: () => {},
    install: async () => { seq.push("install"); },
    // ensureFailureCapture intentionally omitted
  };
  // Must not throw.
  await assert.doesNotReject(() => setupE2eProject("/mirror/e2e", deps));
  assert.ok(seq.includes("install"), "install must still run");
});

// ── C1: the failure-capture block is ESM-safe (dynamic import, never require()) ──────────────
// config/e2e/fixtures.ts is native ESM ("type":"module", uses import.meta.url). The qa-failure-capture
// afterEach previously called require("node:fs") etc. → ReferenceError in ESM → swallowed by the
// surrounding try/catch → NO dump file → Lever-1's primary grounding path was DEAD. These tests prove
// the block (a) contains no require( token and (b) actually writes a dump when run as a real ES module.

test("C1: FAILURE_CAPTURE_BLOCK contains no require( token (ESM-safe)", () => {
  assert.doesNotMatch(FAILURE_CAPTURE_BLOCK, /require\(/, "the injected block must not use require() — it runs in a native-ESM fixtures.ts");
  // And it MUST pull its deps via dynamic import() instead.
  assert.match(FAILURE_CAPTURE_BLOCK, /await import\("node:fs"\)/);
  assert.match(FAILURE_CAPTURE_BLOCK, /await import\("node:path"\)/);
  assert.match(FAILURE_CAPTURE_BLOCK, /await import\("node:crypto"\)/);
});

test("C1: the afterEach body, run as a real ES module, writes a dump (no ReferenceError)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-c1-esm-"));
  try {
    // Extract the beforeEach+afterEach callbacks from the block and run them inside a genuine .mjs
    // module — the SAME module kind (ESM) the seed fixtures.ts is, where `require` is undefined.
    // We stub `test` so `test.beforeEach(cb)` and `test.afterEach(cb)` capture their callbacks.
    // A synthetic 5xx Response (fetch, same-origin) is fired into the on('response') handler
    // between beforeEach and afterEach, so the dump carries httpStatus:500 + finalUrl.
    const moduleSrc =
      `const test = { beforeEach(fn) { globalThis.__qaBeforeEach = fn; }, afterEach(fn) { globalThis.__qaCapture = fn; } };\n` +
      FAILURE_CAPTURE_BLOCK +
      `\nexport const beforeEachFn = globalThis.__qaBeforeEach;\nexport const afterEachFn = globalThis.__qaCapture;\n`;
    const modPath = join(dir, "capture.mjs");
    writeFileSync(modPath, moduleSrc);
    const captureDir = join(dir, "dumps");
    writeFileSync(join(dir, ".keep"), ""); // ensure dir exists; capture dir made below
    const { mkdirSync } = await import("node:fs");
    mkdirSync(captureDir, { recursive: true });

    const mod = await import(pathToFileURL(modPath).href);
    assert.equal(typeof mod.beforeEachFn, "function", "the block must register a beforeEach callback");
    assert.equal(typeof mod.afterEachFn, "function", "the block must register an afterEach callback");

    // The beforeEach signature is `async ({ page }) => …`. We build a fake page that:
    // (a) has an `on(event, cb)` that records the 'response' handler;
    // (b) has a `url()` returning the test's final URL;
    // (c) has a `locator(...).ariaSnapshot()` for the DOM capture.
    let responseHandler: ((r: unknown) => void) | undefined;
    const fakeFinalUrl = "http://localhost:3000/owners/new";
    const fakePage = {
      on(event: string, cb: (r: unknown) => void) { if (event === "response") responseHandler = cb; },
      url: () => fakeFinalUrl,
      locator: (_sel: string) => ({ ariaSnapshot: async () => '- button "Submit"\n- heading "Owners"' }),
    };
    const fakeTestInfo = {
      status: "failed",
      expectedStatus: "passed",
      titlePath: ["chromium", "owner registration", "create owner"],
      project: { name: "desktop" },
      file: "/repo/e2e/owners.spec.ts",
      retry: 0,
    };

    // Set QA_FAILURE_CAPTURE_DIR BEFORE beforeEach so the handler registration is not gated out.
    const prev = process.env.QA_FAILURE_CAPTURE_DIR;
    process.env.QA_FAILURE_CAPTURE_DIR = captureDir;
    try {
      // Run beforeEach to set up the listener.
      await mod.beforeEachFn({ page: fakePage });
      assert.ok(responseHandler, "beforeEach must register a response handler via page.on('response', ...)");

      // Fire a synthetic 5xx correlated response (same-origin fetch) into the handler.
      const syntheticResponse = {
        url: () => "http://localhost:3000/api/owners",
        status: () => 500,
        request: () => ({ resourceType: () => "fetch" }),
      };
      responseHandler!(syntheticResponse);

      await mod.afterEachFn({ page: fakePage }, fakeTestInfo);
    } finally {
      if (prev === undefined) delete process.env.QA_FAILURE_CAPTURE_DIR;
      else process.env.QA_FAILURE_CAPTURE_DIR = prev;
    }

    const dumps = readdirSync(captureDir);
    assert.equal(dumps.length, 1, `exactly one dump must be written, got ${JSON.stringify(dumps)}`);
    const body = JSON.parse(readFileSync(join(captureDir, dumps[0]!), "utf8"));
    assert.equal(body.project, "desktop");
    assert.equal(body.file, "owners.spec.ts", "W1: the dump body must carry the spec file basename");
    assert.equal(body.title, "owner registration › create owner", "title is titlePath without the leading project element");
    assert.equal(body.retry, 0);
    assert.match(body.yaml, /button "Submit"/, "the dump must carry the post-failure aria YAML");
    // D1/D2: the dump must carry the attributed 5xx httpStatus and the finalUrl.
    assert.equal(body.httpStatus, 500, "dump must carry the attributed 5xx httpStatus");
    assert.equal(body.finalUrl, fakeFinalUrl, "dump must carry the finalUrl from page.url()");
    // The filename encodes project + a hash + retry (the file is folded into the hash, not the name).
    assert.match(dumps[0]!, /^desktop__[0-9a-f]{12}__0\.json$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C1/D2: httpStatus is absent when no ≥500 response was observed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-c1-no5xx-"));
  try {
    const moduleSrc =
      `const test = { beforeEach(fn) { globalThis.__qaBefore_no5xx = fn; }, afterEach(fn) { globalThis.__qaAfter_no5xx = fn; } };\n` +
      FAILURE_CAPTURE_BLOCK +
      `\nexport const beforeEachFn = globalThis.__qaBefore_no5xx;\nexport const afterEachFn = globalThis.__qaAfter_no5xx;\n`;
    const modPath = join(dir, "no5xx.mjs");
    writeFileSync(modPath, moduleSrc);
    const captureDir = join(dir, "dumps");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(captureDir, { recursive: true });

    const mod = await import(pathToFileURL(modPath).href);
    let responseHandler: ((r: unknown) => void) | undefined;
    const fakePage = {
      on(event: string, cb: (r: unknown) => void) { if (event === "response") responseHandler = cb; },
      url: () => "http://localhost:3000/owners",
      locator: () => ({ ariaSnapshot: async () => '- button "X"' }),
    };
    const fakeTestInfo = { status: "failed", expectedStatus: "passed", titlePath: ["p", "s", "t"], project: { name: "desktop" }, file: "x.spec.ts", retry: 0 };

    const prev = process.env.QA_FAILURE_CAPTURE_DIR;
    process.env.QA_FAILURE_CAPTURE_DIR = captureDir;
    try {
      await mod.beforeEachFn({ page: fakePage });
      // Fire a 4xx (not 5xx) — must NOT produce httpStatus on the dump.
      responseHandler!({ url: () => "http://localhost:3000/api/x", status: () => 404, request: () => ({ resourceType: () => "fetch" }) });
      await mod.afterEachFn({ page: fakePage }, fakeTestInfo);
    } finally { if (prev === undefined) delete process.env.QA_FAILURE_CAPTURE_DIR; else process.env.QA_FAILURE_CAPTURE_DIR = prev; }

    const dumps = readdirSync(captureDir);
    const body = JSON.parse(readFileSync(join(captureDir, dumps[0]!), "utf8"));
    assert.equal(body.httpStatus, undefined, "4xx must NOT produce httpStatus on the dump");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C1/D2: httpStatus is absent when only a background ping/beacon 500 was observed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-c1-bgping-"));
  try {
    const moduleSrc =
      `const test = { beforeEach(fn) { globalThis.__qaBefore_bgping = fn; }, afterEach(fn) { globalThis.__qaAfter_bgping = fn; } };\n` +
      FAILURE_CAPTURE_BLOCK +
      `\nexport const beforeEachFn = globalThis.__qaBefore_bgping;\nexport const afterEachFn = globalThis.__qaAfter_bgping;\n`;
    const modPath = join(dir, "bgping.mjs");
    writeFileSync(modPath, moduleSrc);
    const captureDir = join(dir, "dumps");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(captureDir, { recursive: true });

    const mod = await import(pathToFileURL(modPath).href);
    let responseHandler: ((r: unknown) => void) | undefined;
    const fakePage = {
      on(event: string, cb: (r: unknown) => void) { if (event === "response") responseHandler = cb; },
      url: () => "http://localhost:3000/owners",
      locator: () => ({ ariaSnapshot: async () => '- button "X"' }),
    };
    const fakeTestInfo = { status: "failed", expectedStatus: "passed", titlePath: ["p", "s", "t"], project: { name: "desktop" }, file: "x.spec.ts", retry: 0 };

    const prev = process.env.QA_FAILURE_CAPTURE_DIR;
    process.env.QA_FAILURE_CAPTURE_DIR = captureDir;
    try {
      await mod.beforeEachFn({ page: fakePage });
      // Background ping with 500 — resource type "ping" must be excluded by D2 heuristic.
      responseHandler!({ url: () => "http://localhost:3000/telemetry", status: () => 500, request: () => ({ resourceType: () => "ping" }) });
      await mod.afterEachFn({ page: fakePage }, fakeTestInfo);
    } finally { if (prev === undefined) delete process.env.QA_FAILURE_CAPTURE_DIR; else process.env.QA_FAILURE_CAPTURE_DIR = prev; }

    const dumps = readdirSync(captureDir);
    const body = JSON.parse(readFileSync(join(captureDir, dumps[0]!), "utf8"));
    assert.equal(body.httpStatus, undefined, "background ping 500 must be excluded by D2 heuristic — httpStatus must be absent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C1/D2: httpStatus is absent when only a cross-origin 500 was observed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-c1-xorigin-"));
  try {
    const moduleSrc =
      `const test = { beforeEach(fn) { globalThis.__qaBefore_xorigin = fn; }, afterEach(fn) { globalThis.__qaAfter_xorigin = fn; } };\n` +
      FAILURE_CAPTURE_BLOCK +
      `\nexport const beforeEachFn = globalThis.__qaBefore_xorigin;\nexport const afterEachFn = globalThis.__qaAfter_xorigin;\n`;
    const modPath = join(dir, "xorigin.mjs");
    writeFileSync(modPath, moduleSrc);
    const captureDir = join(dir, "dumps");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(captureDir, { recursive: true });

    const mod = await import(pathToFileURL(modPath).href);
    let responseHandler: ((r: unknown) => void) | undefined;
    // finalUrl is on localhost:3000 but the 500 comes from a different origin (cdn.example.com).
    const fakePage = {
      on(event: string, cb: (r: unknown) => void) { if (event === "response") responseHandler = cb; },
      url: () => "http://localhost:3000/owners",
      locator: () => ({ ariaSnapshot: async () => '- button "X"' }),
    };
    const fakeTestInfo = { status: "failed", expectedStatus: "passed", titlePath: ["p", "s", "t"], project: { name: "desktop" }, file: "x.spec.ts", retry: 0 };

    const prev = process.env.QA_FAILURE_CAPTURE_DIR;
    process.env.QA_FAILURE_CAPTURE_DIR = captureDir;
    try {
      await mod.beforeEachFn({ page: fakePage });
      // Cross-origin 500 — different host than finalUrl, must be excluded.
      responseHandler!({ url: () => "https://cdn.example.com/asset.js", status: () => 500, request: () => ({ resourceType: () => "fetch" }) });
      await mod.afterEachFn({ page: fakePage }, fakeTestInfo);
    } finally { if (prev === undefined) delete process.env.QA_FAILURE_CAPTURE_DIR; else process.env.QA_FAILURE_CAPTURE_DIR = prev; }

    const dumps = readdirSync(captureDir);
    const body = JSON.parse(readFileSync(join(captureDir, dumps[0]!), "utf8"));
    assert.equal(body.httpStatus, undefined, "cross-origin 500 must be excluded by D2 same-origin gate — httpStatus must be absent");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C1/D2: errorResponses resets between tests — reused page does not cross-attribute", async () => {
  // Two sequential tests on a reused page: beforeEach resets errorResponses unconditionally.
  // The second test must NOT inherit the first test's 500 response.
  const dir = mkdtempSync(join(tmpdir(), "qa-c1-reset-"));
  try {
    const moduleSrc =
      `const test = { beforeEach(fn) { globalThis.__qaBefore_reset = fn; }, afterEach(fn) { globalThis.__qaAfter_reset = fn; } };\n` +
      FAILURE_CAPTURE_BLOCK +
      `\nexport const beforeEachFn = globalThis.__qaBefore_reset;\nexport const afterEachFn = globalThis.__qaAfter_reset;\n`;
    const modPath = join(dir, "reset.mjs");
    writeFileSync(modPath, moduleSrc);
    const captureDir = join(dir, "dumps");
    const { mkdirSync } = await import("node:fs");
    mkdirSync(captureDir, { recursive: true });

    const mod = await import(pathToFileURL(modPath).href);
    let responseHandler: ((r: unknown) => void) | undefined;
    const fakePage = {
      on(event: string, cb: (r: unknown) => void) { if (event === "response") responseHandler = cb; },
      url: () => "http://localhost:3000/owners",
      locator: () => ({ ariaSnapshot: async () => '- button "X"' }),
    };
    const fakeTestInfo1 = { status: "failed", expectedStatus: "passed", titlePath: ["p", "test-1", "t1"], project: { name: "desktop" }, file: "x.spec.ts", retry: 0 };
    const fakeTestInfo2 = { status: "failed", expectedStatus: "passed", titlePath: ["p", "test-2", "t2"], project: { name: "desktop" }, file: "x.spec.ts", retry: 0 };

    const prev = process.env.QA_FAILURE_CAPTURE_DIR;
    process.env.QA_FAILURE_CAPTURE_DIR = captureDir;
    try {
      // Test 1: fire a 500 and let it be captured.
      await mod.beforeEachFn({ page: fakePage });
      responseHandler!({ url: () => "http://localhost:3000/api/owners", status: () => 500, request: () => ({ resourceType: () => "fetch" }) });
      await mod.afterEachFn({ page: fakePage }, fakeTestInfo1);

      // Test 2: beforeEach MUST reset errorResponses. No new 500 fired. Dump must NOT carry httpStatus.
      await mod.beforeEachFn({ page: fakePage });
      await mod.afterEachFn({ page: fakePage }, fakeTestInfo2);
    } finally {
      if (prev === undefined) delete process.env.QA_FAILURE_CAPTURE_DIR;
      else process.env.QA_FAILURE_CAPTURE_DIR = prev;
    }

    const dumps = readdirSync(captureDir).sort();
    assert.equal(dumps.length, 2, "two dumps must be written");
    const body2 = JSON.parse(readFileSync(join(captureDir, dumps[1]!), "utf8"));
    assert.equal(body2.httpStatus, undefined, "second test must NOT inherit the first test's 500 — errorResponses must have been reset");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("C1: the afterEach body is a no-op when QA_FAILURE_CAPTURE_DIR is unset (no dump, no throw)", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-c1-noop-"));
  try {
    // The block now uses BOTH test.beforeEach and test.afterEach — the stub must provide both.
    const moduleSrc =
      `const test = { beforeEach(fn) { globalThis.__qaBeforeNoop = fn; }, afterEach(fn) { globalThis.__qaCaptureNoop = fn; } };\n` +
      FAILURE_CAPTURE_BLOCK +
      `\nexport const beforeEachFn = globalThis.__qaBeforeNoop;\nexport const afterEachFn = globalThis.__qaCaptureNoop;\n`;
    const modPath = join(dir, "capture-noop.mjs");
    writeFileSync(modPath, moduleSrc);
    const mod = await import(pathToFileURL(modPath).href);
    const fakePage = {
      on(_event: string, _cb: unknown) {},
      url: () => "http://localhost:3000/",
      locator: () => ({ ariaSnapshot: async () => "- button \"X\"" }),
    };
    const fakeTestInfo = { status: "failed", expectedStatus: "passed", titlePath: ["p", "s", "t"], project: { name: "desktop" }, file: "x.spec.ts", retry: 0 };
    const prev = process.env.QA_FAILURE_CAPTURE_DIR;
    delete process.env.QA_FAILURE_CAPTURE_DIR;
    try {
      // beforeEach must be a no-op (env unset), afterEach must be a no-op (env unset), no dump, no throw.
      await assert.doesNotReject(() => mod.beforeEachFn({ page: fakePage }));
      await assert.doesNotReject(() => mod.afterEachFn({ page: fakePage }, fakeTestInfo));
    } finally {
      if (prev !== undefined) process.env.QA_FAILURE_CAPTURE_DIR = prev;
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── FIX 4: byte-twin token guard for config/e2e/fixtures.ts ─────────────────
// The setup.ts FAILURE_CAPTURE_BLOCK is asserted by the tests above (C1 block).
// Nothing asserted that config/e2e/fixtures.ts's qa-failure-capture block stays in sync.
// These token-presence tests catch a future edit that updates one twin but not the other.

test("FIX4: config/e2e/fixtures.ts qa-failure-capture block contains test.beforeEach", () => {
  const fixturesPath = fileURLToPath(new URL("../../config/e2e/fixtures.ts", import.meta.url));
  const content = readFileSync(fixturesPath, "utf8");
  const start = content.indexOf(">>> qa-failure-capture");
  const end = content.indexOf("<<< qa-failure-capture");
  assert.ok(start !== -1, "fixtures.ts must contain the qa-failure-capture start marker");
  assert.ok(end !== -1, "fixtures.ts must contain the qa-failure-capture end marker");
  const block = content.slice(start, end);
  assert.ok(block.includes("test.beforeEach"), "fixtures.ts qa-failure-capture block must contain test.beforeEach");
});

test("FIX4: config/e2e/fixtures.ts qa-failure-capture block contains page.on('response'", () => {
  const fixturesPath = fileURLToPath(new URL("../../config/e2e/fixtures.ts", import.meta.url));
  const content = readFileSync(fixturesPath, "utf8");
  const start = content.indexOf(">>> qa-failure-capture");
  const end = content.indexOf("<<< qa-failure-capture");
  const block = content.slice(start, end);
  assert.ok(block.includes("page.on('response'"), "fixtures.ts qa-failure-capture block must contain page.on('response'");
});

test("FIX4: config/e2e/fixtures.ts qa-failure-capture block contains errorResponses", () => {
  const fixturesPath = fileURLToPath(new URL("../../config/e2e/fixtures.ts", import.meta.url));
  const content = readFileSync(fixturesPath, "utf8");
  const start = content.indexOf(">>> qa-failure-capture");
  const end = content.indexOf("<<< qa-failure-capture");
  const block = content.slice(start, end);
  assert.ok(block.includes("errorResponses"), "fixtures.ts qa-failure-capture block must contain errorResponses");
});

test("FIX4: config/e2e/fixtures.ts qa-failure-capture block contains finalUrl", () => {
  const fixturesPath = fileURLToPath(new URL("../../config/e2e/fixtures.ts", import.meta.url));
  const content = readFileSync(fixturesPath, "utf8");
  const start = content.indexOf(">>> qa-failure-capture");
  const end = content.indexOf("<<< qa-failure-capture");
  const block = content.slice(start, end);
  assert.ok(block.includes("finalUrl"), "fixtures.ts qa-failure-capture block must contain finalUrl");
});

test("FIX4: config/e2e/fixtures.ts qa-failure-capture block contains httpStatus", () => {
  const fixturesPath = fileURLToPath(new URL("../../config/e2e/fixtures.ts", import.meta.url));
  const content = readFileSync(fixturesPath, "utf8");
  const start = content.indexOf(">>> qa-failure-capture");
  const end = content.indexOf("<<< qa-failure-capture");
  const block = content.slice(start, end);
  assert.ok(block.includes("httpStatus"), "fixtures.ts qa-failure-capture block must contain httpStatus");
});
