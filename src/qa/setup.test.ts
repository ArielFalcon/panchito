import { test } from "node:test";
import assert from "node:assert/strict";
import { setupE2eProject, SetupDeps } from "./setup";

test("repo con proyecto e2e: instala, no bootstrapea", async () => {
  const seq: string[] = [];
  const deps: SetupDeps = {
    hasManifest: () => true,
    bootstrap: () => seq.push("bootstrap"),
    install: async () => {
      seq.push("install");
    },
  };
  await setupE2eProject("/mirror/e2e", deps);
  assert.deepEqual(seq, ["install"]);
});

test("repo sin proyecto e2e: siembra el seed y luego instala", async () => {
  const seq: string[] = [];
  let seeded = "";
  const deps: SetupDeps = {
    hasManifest: () => false,
    bootstrap: (d) => {
      seeded = d;
      seq.push("bootstrap");
    },
    install: async () => {
      seq.push("install");
    },
  };
  await setupE2eProject("/mirror/e2e", deps);
  assert.deepEqual(seq, ["bootstrap", "install"]); // bootstrap ANTES de install
  assert.equal(seeded, "/mirror/e2e");
});
