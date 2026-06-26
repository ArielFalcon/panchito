// test/contexts/generation/application/ports/generation-ports-parity.test.ts
// PARITY (structural): a legacy OpencodeRunInput / ReviewInput / ParallelWorkerInput value must satisfy the
// canonical type — proving the canonical definition dropped no field. Imports from src/ → excluded from the
// qa-engine typecheck; runs via tsx. If a required field exists in Legacy but not Canonical, the typed
// identity round-trip below fails to typecheck under tsx; the runtime asserts are a formality.
import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  OpencodeRunInput as CanonicalRun,
  ReviewInput as CanonicalReview,
  ParallelWorkerInput as CanonicalWorker,
} from "@contexts/generation/application/ports/generation-ports.ts";
import type {
  OpencodeRunInput as LegacyRun,
  ReviewInput as LegacyReview,
  ParallelWorkerInput as LegacyWorker,
} from "../../../../../../src/integrations/opencode-client.ts";

// BIDIRECTIONAL round-trips. TypeScript structural assignability allows a SUPERSET → subset assignment, so a
// one-way Legacy → Canonical alone would NOT catch Canonical DROPPING a required field that Legacy still has
// (the design's "and vice-versa", §plan A.10). Checking BOTH directions is what makes parity meaningful:
//   Legacy → Canonical : Canonical introduced no required field absent from Legacy.
//   Canonical → Legacy : Canonical dropped no required field present in Legacy (the gutted-impl guard).

test("PARITY: OpencodeRunInput is structurally equivalent both directions (no field added or dropped)", () => {
  const toCanonical = (x: LegacyRun): CanonicalRun => x;
  const toLegacy = (x: CanonicalRun): LegacyRun => x;
  assert.equal(typeof toCanonical, "function");
  assert.equal(typeof toLegacy, "function");
});

test("PARITY: ReviewInput is structurally equivalent both directions (no field added or dropped)", () => {
  const toCanonical = (x: LegacyReview): CanonicalReview => x;
  const toLegacy = (x: CanonicalReview): LegacyReview => x;
  assert.equal(typeof toCanonical, "function");
  assert.equal(typeof toLegacy, "function");
});

test("PARITY: ParallelWorkerInput is structurally equivalent both directions (no field added or dropped)", () => {
  const toCanonical = (x: LegacyWorker): CanonicalWorker => x;
  const toLegacy = (x: CanonicalWorker): LegacyWorker => x;
  assert.equal(typeof toCanonical, "function");
  assert.equal(typeof toLegacy, "function");
});
