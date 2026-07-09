import { test } from "node:test";
import assert from "node:assert/strict";
import { stageServiceContext, serviceContextDir, type StageDeps, type ServiceContextManifest } from "./service-context";

// ── in-memory fake StageDeps ────────────────────────────────────────────────
// No real disk/git touched: `files` seeds the SOURCE mirror content, `written`/`removed`
// record what the pure logic did, so every test is deterministic and fast.
function fakeDeps(
  files: Record<string, string | Buffer>,
  overrides: Partial<StageDeps> = {},
): StageDeps & { written: Record<string, Buffer>; removed: string[]; gitCalls: Array<{ args: string[]; cwd?: string }> } {
  const written: Record<string, Buffer> = {};
  const removed: string[] = [];
  const dirs = new Set<string>();
  const gitCalls: Array<{ args: string[]; cwd?: string }> = [];
  const deps: StageDeps & { written: Record<string, Buffer>; removed: string[]; gitCalls: typeof gitCalls } = {
    written,
    removed,
    gitCalls,
    git: async (args, cwd) => {
      gitCalls.push({ args, cwd });
      return "";
    },
    exists: (p) => p in files || dirs.has(p) || p in written,
    mkdir: (p) => {
      dirs.add(p);
    },
    rm: (p) => {
      removed.push(p);
      for (const k of Object.keys(written)) if (k === p || k.startsWith(p + "/")) delete written[k];
      for (const d of [...dirs]) if (d === p || d.startsWith(p + "/")) dirs.delete(d);
    },
    listFiles: (dir) =>
      Object.keys(files)
        .filter((f) => f.startsWith(dir + "/"))
        .map((f) => f.slice(dir.length + 1)),
    readFile: (p) => {
      const v = files[p];
      if (v === undefined) throw new Error(`ENOENT: ${p}`);
      return Buffer.isBuffer(v) ? v : Buffer.from(v);
    },
    writeFile: (p, data) => {
      written[p] = Buffer.isBuffer(data) ? data : Buffer.from(data);
    },
    now: () => 1_700_000_000_000,
    ...overrides,
  };
  return deps;
}

function readManifest(deps: { written: Record<string, Buffer> }, dir: string): ServiceContextManifest {
  const raw = deps.written[`${dir}/manifest.json`];
  assert.ok(raw, `manifest.json must be written at ${dir}/manifest.json`);
  return JSON.parse(raw!.toString("utf8"));
}

// ── serviceContextDir: the pure formula shared with rewritten-engine-factory.ts ────────────

test("serviceContextDir: deterministic path under <workingCopyDir>/e2e/.qa/service-context/<repo-slug>", () => {
  assert.equal(
    serviceContextDir("/mirrors/org__front", "org/orders-svc"),
    "/mirrors/org__front/e2e/.qa/service-context/org__orders-svc",
  );
});

test("serviceContextDir: sanitizes repo names with slashes into '__' (mirrors repo-mirror.ts's own formula)", () => {
  assert.equal(
    serviceContextDir("/mirrors/org__front", "org/name-with-slash"),
    "/mirrors/org__front/e2e/.qa/service-context/org__name-with-slash",
  );
});

// ── hint-glob staging ────────────────────────────────────────────────────────

test("stages ONLY files matching the declared openapi hint, under contracts/", async () => {
  const deps = fakeDeps({
    "/mirrors/svc/openapi/orders.yaml": "openapi: 3.0.0",
    "/mirrors/svc/README.md": "# readme",
  });
  const result = await stageServiceContext(
    { workingCopyDir: "/work", service: { repo: "org/svc", mirrorDir: "/mirrors/svc", openapi: "openapi/orders.yaml" } },
    deps,
  );
  assert.equal(result.dir, "/work/e2e/.qa/service-context/org__svc");
  assert.equal(result.manifestPath, "/work/e2e/.qa/service-context/org__svc/manifest.json");
  assert.equal(deps.written[`${result.dir}/contracts/openapi/orders.yaml`]?.toString("utf8"), "openapi: 3.0.0");
  assert.equal(deps.written[`${result.dir}/contracts/README.md`], undefined, "non-matching files must never be staged");
  const manifest = readManifest(deps, result.dir);
  assert.deepEqual(manifest.contracts, ["openapi/orders.yaml"]);
  assert.equal(manifest.repo, "org/svc");
});

test("hint-glob staging: supports an array of openapi hints", async () => {
  const deps = fakeDeps({
    "/mirrors/svc/openapi/orders.yaml": "a",
    "/mirrors/svc/openapi/payments.yaml": "b",
    "/mirrors/svc/openapi/unrelated.yaml": "c",
  });
  const result = await stageServiceContext(
    {
      workingCopyDir: "/work",
      service: { repo: "org/svc", mirrorDir: "/mirrors/svc", openapi: ["openapi/orders.yaml", "openapi/payments.yaml"] },
    },
    deps,
  );
  const manifest = readManifest(deps, result.dir);
  assert.deepEqual(manifest.contracts.sort(), ["openapi/orders.yaml", "openapi/payments.yaml"]);
});

// ── default sweep (no openapi hint declared) ────────────────────────────────

test("default sweep: matches openapi/swagger/api-definition basenames case-insensitively, ignores everything else", async () => {
  const deps = fakeDeps({
    "/mirrors/svc/api/openapi.yaml": "a",
    "/mirrors/svc/docs/Swagger.JSON": "b",
    "/mirrors/svc/api-definition-v2.yml": "c",
    "/mirrors/svc/random.yaml": "d", // must NOT match
    "/mirrors/svc/src/index.ts": "e", // must NOT match
  });
  const result = await stageServiceContext(
    { workingCopyDir: "/work", service: { repo: "org/svc", mirrorDir: "/mirrors/svc" } },
    deps,
  );
  const manifest = readManifest(deps, result.dir);
  assert.deepEqual(
    manifest.contracts.sort(),
    ["api-definition-v2.yml", "api/openapi.yaml", "docs/Swagger.JSON"].sort(),
  );
});

// ── diff + changed-files staging ────────────────────────────────────────────

test("stages the commit diff as CHANGE.patch and each changed file's post-change content under changed/", async () => {
  const files = {
    "/mirrors/svc/src/orders.ts": "export const orders = 1;",
  };
  const deps = fakeDeps(files, {
    git: async (args) => {
      if (args[0] === "show" && args.includes("--patch")) return "diff --git a/src/orders.ts b/src/orders.ts\n+export const orders = 1;\n";
      if (args[0] === "show" && args.includes("--name-only")) return "src/orders.ts\nsrc/deleted-file.ts\n";
      return "";
    },
  });
  const result = await stageServiceContext(
    { workingCopyDir: "/work", service: { repo: "org/svc", mirrorDir: "/mirrors/svc" }, sha: "abc1234" },
    deps,
  );
  assert.equal(deps.written[`${result.dir}/CHANGE.patch`]?.toString("utf8").includes("orders = 1"), true);
  assert.equal(
    deps.written[`${result.dir}/changed/src/orders.ts`]?.toString("utf8"),
    "export const orders = 1;",
  );
  const manifest = readManifest(deps, result.dir);
  assert.deepEqual(manifest.changed, ["src/orders.ts"]);
  assert.equal(manifest.sha, "abc1234");
  // A file named in the commit but no longer present post-change (deleted) is omitted, not thrown.
  assert.ok(manifest.omitted.some((o) => o.path === "src/deleted-file.ts"));
});

test("no sha: diff/changed staging is skipped entirely (context-mode services carry no per-run commit)", async () => {
  const deps = fakeDeps({});
  const result = await stageServiceContext(
    { workingCopyDir: "/work", service: { repo: "org/svc", mirrorDir: "/mirrors/svc" } },
    deps,
  );
  assert.equal(deps.gitCalls.length, 0, "no git calls must be made when sha is absent");
  assert.equal(deps.written[`${result.dir}/CHANGE.patch`], undefined);
  const manifest = readManifest(deps, result.dir);
  assert.equal(manifest.sha, undefined);
  assert.deepEqual(manifest.changed, []);
});

// ── caps + omissions (determinism + boundedness) ────────────────────────────

test("caps: a single file over 512KB is omitted with reason, never staged", async () => {
  const big = Buffer.alloc(600 * 1024, "a");
  const deps = fakeDeps({ "/mirrors/svc/openapi/big.yaml": big });
  const result = await stageServiceContext(
    { workingCopyDir: "/work", service: { repo: "org/svc", mirrorDir: "/mirrors/svc", openapi: "openapi/big.yaml" } },
    deps,
  );
  assert.equal(deps.written[`${result.dir}/contracts/openapi/big.yaml`], undefined);
  const manifest = readManifest(deps, result.dir);
  assert.deepEqual(manifest.contracts, []);
  assert.equal(manifest.omitted.length, 1);
  assert.equal(manifest.omitted[0]?.path, "openapi/big.yaml");
  assert.match(manifest.omitted[0]?.reason ?? "", /large/i);
});

test("caps: binary files (NUL byte in the first 8KB) are omitted, never staged", async () => {
  const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0d, 0x0a]);
  const deps = fakeDeps({ "/mirrors/svc/openapi/binary.yaml": binary });
  const result = await stageServiceContext(
    { workingCopyDir: "/work", service: { repo: "org/svc", mirrorDir: "/mirrors/svc", openapi: "openapi/binary.yaml" } },
    deps,
  );
  const manifest = readManifest(deps, result.dir);
  assert.deepEqual(manifest.contracts, []);
  assert.match(manifest.omitted[0]?.reason ?? "", /binary/i);
});

test("caps: total staged bytes over 2MB stops further staging, omitting the rest", async () => {
  // Each file is 450KB (under the 512KB per-file cap) so this exercises the TOTAL cap alone:
  // 4 files = 1800KB (fits under 2048KB), the 5th pushes past it and must be omitted.
  const files: Record<string, Buffer> = {};
  for (let i = 0; i < 5; i++) files[`/mirrors/svc/openapi-part-${i}.yaml`] = Buffer.alloc(450 * 1024, "a");
  const deps = fakeDeps(files);
  const result = await stageServiceContext(
    { workingCopyDir: "/work", service: { repo: "org/svc", mirrorDir: "/mirrors/svc" } },
    deps,
  );
  const manifest = readManifest(deps, result.dir);
  assert.equal(manifest.contracts.length, 4, "only 4 of the 5 files fit under the 2MB total cap");
  assert.equal(manifest.omitted.length, 1);
  assert.match(manifest.omitted[0]?.reason ?? "", /size|total/i);
});

test("caps: at most 200 files are staged; the rest are listed as omitted, never silently dropped", async () => {
  const files: Record<string, string> = {};
  for (let i = 0; i < 205; i++) {
    files[`/mirrors/svc/openapi-part-${String(i).padStart(3, "0")}.yaml`] = "x";
  }
  const deps = fakeDeps(files);
  const result = await stageServiceContext(
    { workingCopyDir: "/work", service: { repo: "org/svc", mirrorDir: "/mirrors/svc" } },
    deps,
  );
  const manifest = readManifest(deps, result.dir);
  assert.equal(manifest.contracts.length, 200);
  assert.equal(manifest.omitted.length, 5);
  assert.ok(manifest.omitted.every((o) => /max.?files/i.test(o.reason)));
});

// ── idempotent re-stage (wipe) ───────────────────────────────────────────────

test("idempotent re-stage: a second call wipes the previous staged content before writing fresh content", async () => {
  const files: Record<string, string | Buffer> = { "/mirrors/svc/openapi-v1.yaml": "v1" };
  const deps = fakeDeps(files);
  const first = await stageServiceContext(
    { workingCopyDir: "/work", service: { repo: "org/svc", mirrorDir: "/mirrors/svc" } },
    deps,
  );
  assert.equal(deps.written[`${first.dir}/contracts/openapi-v1.yaml`]?.toString("utf8"), "v1");

  // Simulate the mirror moving on: v1.yaml is gone, v2.yaml appears. Same deps instance reused
  // across runs, matching production (a single defaultStageDeps handles every run).
  delete files["/mirrors/svc/openapi-v1.yaml"];
  files["/mirrors/svc/openapi-v2.yaml"] = "v2";
  const second = await stageServiceContext(
    { workingCopyDir: "/work", service: { repo: "org/svc", mirrorDir: "/mirrors/svc" } },
    deps,
  );
  assert.ok(deps.removed.includes(second.dir), "the stale staged dir must be wiped before re-staging");
  assert.equal(deps.written[`${second.dir}/contracts/openapi-v1.yaml`], undefined, "stale content must not survive a re-stage");
  assert.equal(deps.written[`${second.dir}/contracts/openapi-v2.yaml`]?.toString("utf8"), "v2");
});

// ── repo-name sanitization ──────────────────────────────────────────────────

test("repo-name sanitization: '/' in the repo name becomes '__' in the staged directory", async () => {
  const deps = fakeDeps({});
  const result = await stageServiceContext(
    { workingCopyDir: "/work", service: { repo: "org/name-with-slash", mirrorDir: "/mirrors/svc" } },
    deps,
  );
  assert.equal(result.dir, "/work/e2e/.qa/service-context/org__name-with-slash");
});

// ── manifest shape ───────────────────────────────────────────────────────────

test("manifest.json carries stagedAt from the injected clock, not a direct Date.now() read", async () => {
  const deps = fakeDeps({}, { now: () => 42 });
  const result = await stageServiceContext(
    { workingCopyDir: "/work", service: { repo: "org/svc", mirrorDir: "/mirrors/svc" } },
    deps,
  );
  const manifest = readManifest(deps, result.dir);
  assert.equal(manifest.stagedAt, new Date(42).toISOString());
});
