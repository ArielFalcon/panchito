import { test } from "node:test";
import assert from "node:assert/strict";
// PARITY: the lifted predicate must match pipeline.ts across isCode × every RunVerdict, until
// Plan 7 deletes the legacy original. This file imports src/pipeline.ts, so it is added to the
// qa-engine typecheck "exclude" list (parity-import pattern).
import { shouldDistillLearning } from "@contexts/qa-run-orchestration/domain/helpers/should-distill-learning.ts";
import { shouldDistillLearning as legacy } from "../../../../../../src/pipeline.ts";

const VERDICTS = ["pass", "fail", "flaky", "invalid", "infra-error", "skipped"] as const;

test("PARITY: shouldDistillLearning matches legacy across isCode × every RunVerdict", () => {
  for (const isCode of [true, false]) {
    for (const verdict of VERDICTS) {
      assert.equal(shouldDistillLearning(isCode, verdict), legacy(isCode, verdict), `isCode=${isCode} verdict=${verdict}`);
    }
  }
});
