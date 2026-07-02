// qa-engine/test/contexts/generation/infrastructure/manifest-fs.test.ts
// Behavioral tests for the real, src/-free readManifest/reconcileManifest fns (Sub-Plan 7.2 item 3).
// Ported from src/integrations/opencode-client.ts's realManifestFs (fs.read/fs.write) + upsertManifest
// (upsert-by-id, JSON array read/write) — proven here against REAL temp-dir fixtures, not stubs, so
// the port is a behavioral proof, not a type-shape proof.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readManifest, reconcileManifest } from "@contexts/generation/infrastructure/manifest-fs.ts";

function makeSpecDir(): string {
  return mkdtempSync(join(tmpdir(), "qa-engine-manifest-fs-"));
}

function manifestPath(specDir: string): string {
  return join(specDir, ".qa", "manifest.json");
}

test("readManifest returns [] when the manifest file does not exist", async () => {
  const specDir = makeSpecDir();
  try {
    const entries = await readManifest(specDir);
    assert.deepEqual(entries, []);
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("readManifest returns [] on corrupt (non-JSON) manifest content — fail-open, never throws", async () => {
  const specDir = makeSpecDir();
  try {
    mkdirSync(join(specDir, ".qa"), { recursive: true });
    writeFileSync(manifestPath(specDir), "{ not valid json ][");
    const entries = await readManifest(specDir);
    assert.deepEqual(entries, []);
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("readManifest returns [] when the on-disk JSON is not an array", async () => {
  const specDir = makeSpecDir();
  try {
    mkdirSync(join(specDir, ".qa"), { recursive: true });
    writeFileSync(manifestPath(specDir), JSON.stringify({ not: "an array" }));
    const entries = await readManifest(specDir);
    assert.deepEqual(entries, []);
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("readManifest reads back real entries written to disk", async () => {
  const specDir = makeSpecDir();
  try {
    mkdirSync(join(specDir, ".qa"), { recursive: true });
    const seeded = [{ id: "login", file: "e2e/login.spec.ts", flow: "login", objective: "given creds, then dashboard" }];
    writeFileSync(manifestPath(specDir), JSON.stringify(seeded, null, 2));
    const entries = await readManifest(specDir);
    assert.deepEqual(entries, seeded);
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("reconcileManifest creates the manifest file (with .qa/ dir) when none exists", async () => {
  const specDir = makeSpecDir();
  try {
    const entries = [{ id: "checkout", file: "e2e/checkout.spec.ts", flow: "checkout", objective: "o" }];
    const out = await reconcileManifest(specDir, entries);
    assert.deepEqual(out, entries);
    assert.equal(existsSync(manifestPath(specDir)), true);
    const onDisk = JSON.parse(readFileSync(manifestPath(specDir), "utf8"));
    assert.deepEqual(onDisk, entries);
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("reconcileManifest upserts by id — an existing id is overwritten, a new id is added", async () => {
  const specDir = makeSpecDir();
  try {
    mkdirSync(join(specDir, ".qa"), { recursive: true });
    const seeded = [
      { id: "login", file: "e2e/login.spec.ts", flow: "login", objective: "old objective" },
      { id: "logout", file: "e2e/logout.spec.ts", flow: "logout", objective: "o" },
    ];
    writeFileSync(manifestPath(specDir), JSON.stringify(seeded, null, 2));

    const out = await reconcileManifest(specDir, [
      { id: "login", file: "e2e/login.spec.ts", flow: "login", objective: "NEW objective" },
      { id: "checkout", file: "e2e/checkout.spec.ts", flow: "checkout", objective: "o" },
    ]);

    const byId = new Map(out.map((e) => [e.id, e]));
    assert.equal(byId.get("login")?.objective, "NEW objective"); // overwritten
    assert.equal(byId.get("logout")?.flow, "logout"); // preserved (unrelated entry survives)
    assert.equal(byId.get("checkout")?.flow, "checkout"); // added
    assert.equal(out.length, 3);
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("reconcileManifest returns [] and writes nothing when given an empty entries array (upsertManifest no-op)", async () => {
  const specDir = makeSpecDir();
  try {
    const out = await reconcileManifest(specDir, []);
    assert.deepEqual(out, []);
    // upsertManifest's real behavior: entries.length === 0 short-circuits before any fs.write —
    // ported verbatim, so no manifest file is created for a no-op reconcile.
    assert.equal(existsSync(manifestPath(specDir)), false);
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});

// ── manifest-enrichment fix: reconcile preserves prior enriched fields on merge ────────────────
// The use-case's upsert (generate-tests.use-case.ts) now stamps targets/changeRef per entry.
// reconcileManifest's merge is `{ ...byId.get(e.id), ...e }` — a re-upserted id's NEW fields win,
// but a re-upsert with a DIFFERENT id must never touch an unrelated id's previously-enriched
// targets/changeRef. Pins that invariant explicitly for the widened (targets/changeRef) shape.
test("reconcileManifest preserves an unrelated entry's targets/changeRef when a different id is re-upserted", async () => {
  const specDir = makeSpecDir();
  try {
    mkdirSync(join(specDir, ".qa"), { recursive: true });
    const seeded = [
      {
        id: "login", file: "e2e/login.spec.ts", flow: "login", objective: "given creds, then dashboard",
        targets: ["AuthService.login"], changeRef: { sha: "sha1", type: "feat" },
      },
    ];
    writeFileSync(manifestPath(specDir), JSON.stringify(seeded, null, 2));

    const out = await reconcileManifest(specDir, [
      {
        id: "checkout", file: "e2e/checkout.spec.ts", flow: "checkout", objective: "user can checkout",
        targets: ["CheckoutService.pay"], changeRef: { sha: "sha2", type: "fix" },
      },
    ]);

    const byId = new Map(out.map((e) => [e.id, e]));
    assert.deepEqual(byId.get("login")?.targets, ["AuthService.login"], "unrelated entry's targets preserved");
    assert.deepEqual(byId.get("login")?.changeRef, { sha: "sha1", type: "feat" }, "unrelated entry's changeRef preserved");
    assert.deepEqual(byId.get("checkout")?.targets, ["CheckoutService.pay"]);
    assert.deepEqual(byId.get("checkout")?.changeRef, { sha: "sha2", type: "fix" });
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});

// A re-upsert of the SAME id with a NEW changeRef must win (matches the spread-merge order
// `{ ...byId.get(e.id), ...e }` — the new entry's fields overwrite the old).
test("reconcileManifest overwrites targets/changeRef when the SAME id is re-upserted with new values", async () => {
  const specDir = makeSpecDir();
  try {
    mkdirSync(join(specDir, ".qa"), { recursive: true });
    const seeded = [
      {
        id: "checkout", file: "e2e/checkout.spec.ts", flow: "checkout", objective: "old objective",
        targets: ["OldService.old"], changeRef: { sha: "sha-old", type: "chore" },
      },
    ];
    writeFileSync(manifestPath(specDir), JSON.stringify(seeded, null, 2));

    const out = await reconcileManifest(specDir, [
      {
        id: "checkout", file: "e2e/checkout.spec.ts", flow: "checkout", objective: "user can checkout",
        targets: ["CheckoutService.pay"], changeRef: { sha: "sha-new", type: "feat" },
      },
    ]);

    assert.equal(out.length, 1);
    assert.deepEqual(out[0]?.targets, ["CheckoutService.pay"]);
    assert.deepEqual(out[0]?.changeRef, { sha: "sha-new", type: "feat" });
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("reconcileManifest rebuilds from the given entries when the existing manifest is corrupt", async () => {
  const specDir = makeSpecDir();
  try {
    mkdirSync(join(specDir, ".qa"), { recursive: true });
    writeFileSync(manifestPath(specDir), "not json at all");
    const entries = [{ id: "a", file: "e2e/a.spec.ts", flow: "a", objective: "o" }];
    const out = await reconcileManifest(specDir, entries);
    assert.deepEqual(out, entries);
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});
