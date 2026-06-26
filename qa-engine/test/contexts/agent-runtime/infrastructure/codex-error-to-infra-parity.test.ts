// PARITY: the lifted classifier must match codex-strategy.ts byte-for-byte until Plan 7 deletes the
// legacy original. Imports from src/ — excluded from qa-engine typecheck; runs via tsx.
import { test } from "node:test";
import assert from "node:assert/strict";
import { codexErrorToInfra } from "@contexts/agent-runtime/infrastructure/codex-error-to-infra.ts";
import { codexErrorToInfra as legacy } from "../../../../../src/agent-runtime/codex-strategy.ts";

test("PARITY: classification matches legacy across a sample error table", () => {
  const samples: unknown[] = [
    new Error("Codex prompt timed out after 30000ms"),
    new Error("401 unauthorized"),
    new Error("authentication failed: invalid token"),
    new Error("403 forbidden"),
    new Error("402 out of credits"),
    new Error("429 too many requests rate-limit exceeded"),
    new Error("process was aborted"),
    new Error("SIGTERM received"),
    new Error("the model produced no JSON verdict"),
    new Error("ENOENT no such file"),
    "a string error",
    null,
    { code: "ETIMEDOUT" },
  ];
  for (const e of samples) {
    // Compare the CLASSIFICATION (infra vs not), not object identity — both construct fresh errors.
    assert.equal(
      Boolean(codexErrorToInfra(e)),
      Boolean(legacy(e)),
      `classification mismatch for: ${JSON.stringify(String(e))}`,
    );
  }
});
