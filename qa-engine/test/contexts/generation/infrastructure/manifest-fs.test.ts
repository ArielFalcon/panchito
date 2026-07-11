// qa-engine/test/contexts/generation/infrastructure/manifest-fs.test.ts
// Behavioral tests for the real, src/-free readManifest/reconcileManifest fns (Sub-Plan 7.2 item 3).
// Ported from src/integrations/opencode-client.ts's realManifestFs (fs.read/fs.write) + upsertManifest
// (upsert-by-id, JSON array read/write) — proven here against REAL temp-dir fixtures, not stubs, so
// the port is a behavioral proof, not a type-shape proof.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { readManifest, reconcileManifest } from "@contexts/generation/infrastructure/manifest-fs.ts";
import type { ManifestEntry } from "@contexts/generation/application/ports/index.ts";

function makeSpecDir(): string {
  return mkdtempSync(join(tmpdir(), "qa-engine-manifest-fs-"));
}

function manifestPath(specDir: string): string {
  return join(specDir, ".qa", "manifest.json");
}

// Writes a real (dummy-content) spec file under specDir so a ManifestEntry naming it survives the
// on-disk phantom-drop safety filter reconcileManifest now runs before every merge.
function writeSpecFile(specDir: string, relPath: string): void {
  const full = join(specDir, relPath);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, "// dummy spec content\n");
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
    writeSpecFile(specDir, "e2e/checkout.spec.ts");
    const entries = [{ id: "checkout", file: "e2e/checkout.spec.ts", flow: "checkout", objective: "o", targets: ["t"], changeRef: { sha: "s", type: "feat" } }];
    const out = await reconcileManifest(specDir, entries);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.id, "checkout");
    assert.ok(out[0]?.sha256, "surviving entry is stamped with a sha256 checksum");
    assert.equal(existsSync(manifestPath(specDir)), true);
    const onDisk = JSON.parse(readFileSync(manifestPath(specDir), "utf8"));
    assert.deepEqual(onDisk, out);
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("reconcileManifest upserts by id — an existing id is overwritten, a new id is added", async () => {
  const specDir = makeSpecDir();
  try {
    mkdirSync(join(specDir, ".qa"), { recursive: true });
    writeSpecFile(specDir, "e2e/login.spec.ts");
    writeSpecFile(specDir, "e2e/checkout.spec.ts");
    const seeded = [
      { id: "login", file: "e2e/login.spec.ts", flow: "login", objective: "old objective" },
      { id: "logout", file: "e2e/logout.spec.ts", flow: "logout", objective: "o" },
    ];
    writeFileSync(manifestPath(specDir), JSON.stringify(seeded, null, 2));

    const out = await reconcileManifest(specDir, [
      { id: "login", file: "e2e/login.spec.ts", flow: "login", objective: "NEW objective", targets: ["t"], changeRef: { sha: "s", type: "feat" } },
      { id: "checkout", file: "e2e/checkout.spec.ts", flow: "checkout", objective: "o", targets: ["t"], changeRef: { sha: "s", type: "feat" } },
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
    writeSpecFile(specDir, "e2e/checkout.spec.ts");
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
    writeSpecFile(specDir, "e2e/checkout.spec.ts");
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
    writeSpecFile(specDir, "e2e/a.spec.ts");
    const entries = [{ id: "a", file: "e2e/a.spec.ts", flow: "a", objective: "o", targets: ["t"], changeRef: { sha: "s", type: "feat" } }];
    const out = await reconcileManifest(specDir, entries);
    assert.equal(out.length, 1);
    assert.equal(out[0]?.id, "a");
    assert.ok(out[0]?.sha256);
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});

// ── phantom-drop + schema-validation safety nets (task #41, ported from opencode-client.ts:764-810) ──

test("reconcileManifest drops a specMeta whose file is NOT on disk (phantom), and logs a warning", async () => {
  const specDir = makeSpecDir();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: string) => { warnings.push(String(msg)); };
  try {
    writeSpecFile(specDir, "e2e/real.spec.ts");
    const out = await reconcileManifest(specDir, [
      { id: "real", file: "e2e/real.spec.ts", flow: "real", objective: "o", targets: ["t"], changeRef: { sha: "s", type: "feat" } },
      { id: "phantom", file: "e2e/phantom.spec.ts", flow: "phantom", objective: "o", targets: ["t"], changeRef: { sha: "s", type: "feat" } },
    ]);

    const ids = out.map((e) => e.id);
    assert.deepEqual(ids, ["real"], "the phantom entry is absent from the written manifest");
    assert.ok(
      warnings.some((w) => w.includes("phantom") && w.includes("e2e/phantom.spec.ts")),
      "a warning names the dropped phantom entry — never silent",
    );

    const onDisk = JSON.parse(readFileSync(manifestPath(specDir), "utf8"));
    assert.deepEqual(onDisk.map((e: { id: string }) => e.id), ["real"]);
  } finally {
    console.warn = originalWarn;
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("reconcileManifest stamps sha256 on a surviving entry whose file IS on disk", async () => {
  const specDir = makeSpecDir();
  try {
    writeSpecFile(specDir, "e2e/real.spec.ts");
    const out = await reconcileManifest(specDir, [
      { id: "real", file: "e2e/real.spec.ts", flow: "real", objective: "o", targets: ["t"], changeRef: { sha: "s", type: "feat" } },
    ]);
    assert.equal(out.length, 1);
    assert.equal(typeof out[0]?.sha256, "string");
    assert.equal(out[0]?.sha256?.length, 64, "sha256 hex digest is 64 chars");
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("reconcileManifest drops a malformed entry (empty objective) even when its file IS on disk, and logs a warning", async () => {
  const specDir = makeSpecDir();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: string) => { warnings.push(String(msg)); };
  try {
    writeSpecFile(specDir, "e2e/bad.spec.ts");
    const out = await reconcileManifest(specDir, [
      { id: "bad", file: "e2e/bad.spec.ts", flow: "bad", objective: "", targets: ["t"], changeRef: { sha: "s", type: "feat" } },
    ]);
    assert.deepEqual(out, [], "malformed entry dropped — nothing written");
    assert.equal(existsSync(manifestPath(specDir)), false, "no manifest file created for an all-dropped batch");
    assert.ok(
      warnings.some((w) => w.includes("bad") && w.includes("schema")),
      "a warning names the dropped malformed entry — never silent",
    );
  } finally {
    console.warn = originalWarn;
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("reconcileManifest drops a malformed entry (empty targets) with a warning", async () => {
  const specDir = makeSpecDir();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: string) => { warnings.push(String(msg)); };
  try {
    writeSpecFile(specDir, "e2e/bad.spec.ts");
    const out = await reconcileManifest(specDir, [
      { id: "bad", file: "e2e/bad.spec.ts", flow: "bad", objective: "o", targets: [], changeRef: { sha: "s", type: "feat" } },
    ]);
    assert.deepEqual(out, []);
    assert.ok(warnings.some((w) => w.includes("bad") && w.includes("schema")));
  } finally {
    console.warn = originalWarn;
    rmSync(specDir, { recursive: true, force: true });
  }
});

// ── migration-tier-4b Slice 2 (THE manifest reconciliation) ────────────────────────────────────

// GIVEN a manifest entry missing `file` (a hypothetical pre-4b or hand-edited entry) — `file` is
// now OPTIONAL on the canonical ManifestEntry. It must NOT be silently dropped as a phantom (the
// pre-Slice-2 shape, where `file` was type-required, never had to distinguish "no file declared"
// from "file declared but not on disk" — collapsing both into "no sha256 => drop" would now
// falsely flag every file-less entry).
test("reconcileManifest does NOT drop an entry with no 'file' field as a false phantom", async () => {
  const specDir = makeSpecDir();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: string) => { warnings.push(String(msg)); };
  try {
    const out = await reconcileManifest(specDir, [
      { id: "no-file", flow: "checkout", objective: "user can checkout", targets: ["CheckoutService.pay"], changeRef: { sha: "s", type: "feat" } },
    ]);
    assert.deepEqual(out.map((e) => e.id), ["no-file"], "a file-less entry survives — it is not a phantom");
    assert.equal(out[0]?.sha256, undefined, "sha256 is never fabricated for an entry with no file to hash");
    assert.ok(
      !warnings.some((w) => w.includes("phantom")),
      "no phantom warning must fire for an entry that never declared a file",
    );
  } finally {
    console.warn = originalWarn;
    rmSync(specDir, { recursive: true, force: true });
  }
});

// GIVEN an entry with criticality:"urgent" (not in the enum) WHEN written via reconcile THEN it is
// rejected AT WRITE TIME — the write path (manifestEntryViolation, now canonical-schema-backed)
// validates enum fields for the first time (the pre-Slice-2 hand-rolled manifestEntryViolation only
// checked the 5 required-field presences, never enum shapes).
test("reconcileManifest rejects criticality:\"urgent\" (not in the enum) at WRITE time, with a warning", async () => {
  const specDir = makeSpecDir();
  const warnings: string[] = [];
  const originalWarn = console.warn;
  console.warn = (msg: string) => { warnings.push(String(msg)); };
  try {
    writeSpecFile(specDir, "e2e/bad-enum.spec.ts");
    // A runtime-only value (e.g. a hand-edited on-disk entry) can carry an out-of-enum
    // criticality even though the TYPE forbids it — cast through `unknown` to exercise the
    // runtime zod check, mirroring how a real malformed value would arrive (JSON.parse, not a
    // typed literal).
    const badEntry = {
      id: "bad-enum", file: "e2e/bad-enum.spec.ts", flow: "checkout", objective: "o",
      targets: ["t"], changeRef: { sha: "s", type: "feat" }, criticality: "urgent",
    } as unknown as ManifestEntry;
    const out = await reconcileManifest(specDir, [badEntry]);
    assert.deepEqual(out, [], "the enum-violating entry is dropped — never silently written");
    assert.ok(
      warnings.some((w) => w.includes("bad-enum") && w.includes("schema")),
      "a warning names the dropped entry — never silent",
    );
  } finally {
    console.warn = originalWarn;
    rmSync(specDir, { recursive: true, force: true });
  }
});

test("reconcileManifest still merges valid entries by id while dropping a phantom sibling in the same batch", async () => {
  const specDir = makeSpecDir();
  try {
    mkdirSync(join(specDir, ".qa"), { recursive: true });
    writeSpecFile(specDir, "e2e/login.spec.ts");
    const seeded = [
      { id: "logout", file: "e2e/logout.spec.ts", flow: "logout", objective: "old", targets: ["t"], changeRef: { sha: "s0", type: "chore" } },
    ];
    writeFileSync(manifestPath(specDir), JSON.stringify(seeded, null, 2));

    const out = await reconcileManifest(specDir, [
      { id: "login", file: "e2e/login.spec.ts", flow: "login", objective: "NEW", targets: ["t2"], changeRef: { sha: "s1", type: "feat" } },
      { id: "ghost", file: "e2e/ghost.spec.ts", flow: "ghost", objective: "o", targets: ["t"], changeRef: { sha: "s1", type: "feat" } },
    ]);

    const byId = new Map(out.map((e) => [e.id, e]));
    assert.equal(byId.get("login")?.objective, "NEW", "valid entry merged in");
    assert.equal(byId.get("logout")?.flow, "logout", "prior enriched entry preserved across the batch");
    assert.equal(byId.has("ghost"), false, "phantom sibling dropped, doesn't block its valid batch-mate");
    assert.equal(out.length, 2);
  } finally {
    rmSync(specDir, { recursive: true, force: true });
  }
});
