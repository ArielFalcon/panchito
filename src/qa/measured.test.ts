import { test } from "node:test";
import assert from "node:assert/strict";
import {
  readMeasured,
  writeMeasured,
  recordStability,
  recordCoverage,
  SUITE_KEY,
  MeasuredStore,
  MeasuredFs,
} from "./measured";

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

// Measured data is recorded at SUITE scope, not per-flow: per-flow attribution would need
// per-test coverage + a case→flow map (neither exists), and crediting aggregate data to every
// flow was misleading. Suite-level is honest: "the suite ran N times, was flaky M times".
test("recordStability accumulates SUITE runs and flaky-run counts", () => {
  let store = recordStability({}, [
    { name: "login › works", status: "pass" },
    { name: "checkout › empty cart", status: "flaky" },
  ]);
  assert.equal(store[SUITE_KEY]!.stability!.runs, 1);
  assert.equal(store[SUITE_KEY]!.stability!.flakyRuns, 1); // this run was flaky
  store = recordStability(store, [{ name: "login › works", status: "pass" }]);
  assert.equal(store[SUITE_KEY]!.stability!.runs, 2);
  assert.equal(store[SUITE_KEY]!.stability!.flakyRuns, 1); // unchanged: this run was stable
});

test("recordStability omits flakyRuns until a run is actually flaky", () => {
  const store = recordStability({}, [{ name: "a", status: "pass" }]);
  assert.equal(store[SUITE_KEY]!.stability!.runs, 1);
  assert.equal(store[SUITE_KEY]!.stability!.flakyRuns, undefined);
});

test("recordCoverage records the covered files at suite level", () => {
  const store = recordCoverage({}, ["src/Login.tsx", "src/Checkout.tsx"]);
  assert.deepEqual(store[SUITE_KEY]!.coverage!.files, ["src/Login.tsx", "src/Checkout.tsx"]);
});

test("recordCoverage is a no-op when there are no covered files", () => {
  const store: MeasuredStore = { [SUITE_KEY]: { stability: { runs: 1 } } };
  assert.deepEqual(recordCoverage(store, []), store); // unchanged
});
