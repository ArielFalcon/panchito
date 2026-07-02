import { test } from "node:test";
import assert from "node:assert/strict";
// PARITY: the lifted backstop must match pipeline.ts across the maxRetries/numObjectives domain
// until Plan 7 deletes the legacy original. This file imports src/pipeline.ts, so it is added to the
// qa-engine typecheck "exclude" list (parity-import pattern, same as legacy-pipeline.adapter.test.ts).
import { deriveCycleBackstop } from "@contexts/qa-run-orchestration/domain/helpers/derive-cycle-backstop.ts";
import { deriveCycleBackstop as legacy } from "../../../../../../src/pipeline.ts";

test("PARITY: deriveCycleBackstop matches legacy across maxRetries 0..6 (numObjectives=1 default)", () => {
  for (let r = 0; r <= 6; r++) {
    assert.equal(deriveCycleBackstop(r), legacy(r), `maxRetries=${r}`);
  }
});

test("PARITY: deriveCycleBackstop matches legacy across the numObjectives Phase-6b raise (1..4)", () => {
  for (let n = 1; n <= 4; n++) {
    assert.equal(deriveCycleBackstop(2, n), legacy(2, n), `numObjectives=${n}`);
  }
});
