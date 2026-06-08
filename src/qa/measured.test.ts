import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readMeasured,
  writeMeasured,
  recordStability,
  recordCoverage,
  MeasuredStore,
  MeasuredFs,
} from "./measured";
import type { QaCase } from "../types";

function stubFs(initial?: MeasuredStore): MeasuredFs & { written(): string | null } {
  let stored = initial ? JSON.stringify(initial) : null;
  return {
    read: () => stored,
    write: (_path, content) => { stored = content; },
    written: () => stored,
  };
}

test("readMeasured returns empty store for missing or corrupt file", () => {
  const fs = stubFs();
  assert.deepEqual(readMeasured(fs, "/m.json"), {});
  fs.write("/m.json", "not json");
  assert.deepEqual(readMeasured(fs, "/m.json"), {});
  fs.write("/m.json", "[1,2,3]");
  assert.deepEqual(readMeasured(fs, "/m.json"), {});
});

test("readMeasured and writeMeasured round-trip", () => {
  const fs = stubFs();
  const store: MeasuredStore = {
    checkout: { stability: { runs: 3, flakyRuns: 1 }, coverage: { files: ["src/Checkout.tsx"] } },
  };
  writeMeasured(fs, "/m.json", store);
  assert.deepEqual(readMeasured(fs, "/m.json"), store);
});

test("recordStability increments runs for each flow that had cases", () => {
  const store: MeasuredStore = {};
  const flowCases = new Map<string, QaCase[]>();
  flowCases.set("login", [{ name: "login › works", status: "pass" }]);
  flowCases.set("checkout", [
    { name: "checkout › with items", status: "pass" },
    { name: "checkout › empty cart", status: "flaky" },
  ]);

  const next = recordStability(store, flowCases);

  assert.equal(next.login!.stability!.runs, 1);
  assert.equal(next.login!.stability!.flakyRuns, undefined);
  assert.equal(next.checkout!.stability!.runs, 1);
  assert.equal(next.checkout!.stability!.flakyRuns, 1);
});

test("recordStability accumulates on existing data across runs", () => {
  const store: MeasuredStore = {
    login: { stability: { runs: 4, flakyRuns: 2 } },
  };
  const flowCases = new Map<string, QaCase[]>();
  flowCases.set("login", [{ name: "login › works", status: "pass" }]);

  const next = recordStability(store, flowCases);

  assert.equal(next.login!.stability!.runs, 5);
  assert.equal(next.login!.stability!.flakyRuns, 2); // unchanged, no flaky this run
});

test("recordCoverage records covered files per flow", () => {
  const store: MeasuredStore = {};
  const next = recordCoverage(store, ["login", "checkout"], ["src/Login.tsx", "src/Checkout.tsx"]);

  assert.deepEqual(next.login!.coverage!.files, ["src/Login.tsx", "src/Checkout.tsx"]);
  assert.deepEqual(next.checkout!.coverage!.files, ["src/Login.tsx", "src/Checkout.tsx"]);
});

test("recordCoverage is a no-op when there are no covered files", () => {
  const store: MeasuredStore = { login: { stability: { runs: 1 } } };
  const next = recordCoverage(store, ["login"], []);
  assert.deepEqual(next, store); // unchanged
});
