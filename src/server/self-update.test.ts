import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  performSwap,
  confirmSwapHealthy,
  bootGuardDecision,
  rollback,
  SwapFs,
  SwapMarker,
  MAX_BOOT_ATTEMPTS,
  writePendingPromote,
  readPendingPromote,
  clearPendingPromote,
} from "./self-update";

test("pending-promote survives the swap marker being cleared, and is cleared on terminal outcome (SELF-03)", () => {
  const dir = mkdtempSync(join(tmpdir(), "promote-"));
  try {
    assert.equal(readPendingPromote(dir), null);
    const p = { promote: { repo: "o/r", prNumber: 7, nodeId: "PR_node" }, prUrl: "https://x/pull/7", at: "t" };
    writePendingPromote(dir, p);
    assert.deepEqual(readPendingPromote(dir), p); // durable across the marker clear / a restart
    clearPendingPromote(dir);
    assert.equal(readPendingPromote(dir), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// An in-memory fake fs that records copy/remove operations and holds a marker.
function fakeFs(present: Set<string> = new Set()): SwapFs & { ops: string[]; marker: SwapMarker | null } {
  let marker: SwapMarker | null = null;
  const ops: string[] = [];
  return {
    ops,
    get marker() {
      return marker;
    },
    exists: (p) => present.has(p),
    rm: (p) => {
      present.delete(p);
      ops.push(`rm ${p}`);
    },
    cp: (from, to) => {
      present.add(to);
      ops.push(`cp ${from} -> ${to}`);
    },
    readMarker: () => marker,
    writeMarker: (_p, m) => {
      marker = m;
    },
    removeMarker: () => {
      marker = null;
    },
  };
}

test("performSwap backs up the live tree before overwriting it, then arms the marker", () => {
  const fs = fakeFs(new Set(["/app/src", "/app/package.json", "/app/package-lock.json", "/work/src", "/work/package.json", "/work/package-lock.json"]));
  performSwap("/app", "/work", "/data", { at: "t1", prUrl: "u" }, fs);
  // backup happened BEFORE the live src was removed/overwritten
  const backupIdx = fs.ops.findIndex((o) => o === "cp /app/src -> /app/src.bak");
  const removeIdx = fs.ops.findIndex((o) => o === "rm /app/src");
  assert.ok(backupIdx >= 0 && removeIdx >= 0 && backupIdx < removeIdx, "backup must precede removing live src");
  assert.ok(fs.ops.includes("cp /work/src -> /app/src"), "new code copied into place");
  assert.deepEqual(fs.marker, { at: "t1", attempt: 0, prUrl: "u", promote: undefined, fix: undefined });
});

test("performSwap records promote + fix info for the canary-before-merge flow", () => {
  const fs = fakeFs(new Set(["/app/src", "/app/package.json", "/work/src", "/work/package.json"]));
  performSwap(
    "/app",
    "/work",
    "/data",
    { at: "t2", prUrl: "u2", promote: { repo: "o/r", prNumber: 7, nodeId: "PR_node" }, fix: { prTitle: "fix: x", changes: ["a.ts"], rootCause: "r" } },
    fs,
  );
  assert.deepEqual(fs.marker, {
    at: "t2",
    attempt: 0,
    prUrl: "u2",
    promote: { repo: "o/r", prNumber: 7, nodeId: "PR_node" },
    fix: { prTitle: "fix: x", changes: ["a.ts"], rootCause: "r" },
  });
});

test("bootGuardDecision: none/increment/rollback by attempt count", () => {
  assert.deepEqual(bootGuardDecision(null), { action: "none" });
  assert.deepEqual(bootGuardDecision({ at: "t", attempt: 0 }), { action: "increment", next: { at: "t", attempt: 1 } });
  assert.deepEqual(bootGuardDecision({ at: "t", attempt: MAX_BOOT_ATTEMPTS - 1 }), {
    action: "increment",
    next: { at: "t", attempt: MAX_BOOT_ATTEMPTS },
  });
  assert.deepEqual(bootGuardDecision({ at: "t", attempt: MAX_BOOT_ATTEMPTS }), { action: "rollback" });
});

test("a healthy swap is confirmed: marker + backups removed", () => {
  const fs = fakeFs(new Set(["/app/src.bak", "/app/package.json.bak", "/app/package-lock.json.bak"]));
  fs.writeMarker("", { at: "t", attempt: 1 });
  confirmSwapHealthy("/app", "/data", fs);
  assert.equal(fs.marker, null);
  assert.ok(fs.ops.includes("rm /app/src.bak"));
});

test("rollback restores the backup over the live tree and clears state", () => {
  const fs = fakeFs(new Set(["/app/src.bak", "/app/package.json.bak"]));
  fs.writeMarker("", { at: "t", attempt: MAX_BOOT_ATTEMPTS });
  const ok = rollback("/app", "/data", fs);
  assert.equal(ok, true);
  assert.ok(fs.ops.includes("cp /app/src.bak -> /app/src"), "restored src from backup");
  assert.ok(fs.ops.includes("cp /app/package.json.bak -> /app/package.json"));
  assert.equal(fs.marker, null);
});

test("rollback is a no-op (returns false) when there is no backup", () => {
  const fs = fakeFs(new Set());
  assert.equal(rollback("/app", "/data", fs), false);
});
