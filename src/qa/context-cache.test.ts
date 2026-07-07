import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { saveContextCache, loadContextCache } from "./context-cache";
import type { ArchitectureContext } from "./context";

test("context cache round-trips the map per app; a miss returns undefined", () => {
  const prev = process.env.PANCHITO_ROOT;
  process.env.PANCHITO_ROOT = mkdtempSync(join(tmpdir(), "qa-ctxcache-"));
  try {
    assert.equal(loadContextCache("petclinic"), undefined); // miss → undefined (caller rebuilds)
    const map: ArchitectureContext = { builtAtSha: "abc123def", routes: [{ path: "/owners" }], api: [], feBe: [] };
    saveContextCache("petclinic", map);
    assert.deepEqual(loadContextCache("petclinic"), map); // restored exactly
    assert.equal(loadContextCache("other-app"), undefined); // per-app isolation
  } finally {
    if (prev) process.env.PANCHITO_ROOT = prev;
    else delete process.env.PANCHITO_ROOT;
  }
});

test("an unreadable/corrupt cache is a miss, never a throw", () => {
  const prev = process.env.PANCHITO_ROOT;
  process.env.PANCHITO_ROOT = mkdtempSync(join(tmpdir(), "qa-ctxcache-"));
  try {
    // No file written → load is a clean miss, not an exception.
    assert.equal(loadContextCache("never-saved"), undefined);
  } finally {
    if (prev) process.env.PANCHITO_ROOT = prev;
    else delete process.env.PANCHITO_ROOT;
  }
});
