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

// GATE (structural, key-set): the round-trip above proves REQUIRED-field lockstep and value-mapping
// correctness, but a one-sided OPTIONAL field passes BOTH the round-trip AND full `npm run typecheck`
// unnoticed — structural assignability never requires an optional property to exist on both sides of
// an identity-cast round-trip. This gate closes that gap: the symmetric key DIFFERENCE between the two
// mirrors' `keyof` sets must be `never`, in BOTH directions. `AssertNever` forces a type error the
// moment either side adds a key the other lacks; the error NAMES the drifted key (e.g. Type
// '"contractDrift"' does not satisfy the constraint 'never'). A chained-satisfies gate (re-`satisfies`ing
// an already-typed variable against the other side's type) does NOT catch this — re-satisfying a
// TYPED variable never runs excess-property checking (fresh-literal-only), so it silently passes a
// one-sided key addition. This gate compares the two `keyof` sets directly instead.
type AssertNever<T extends never> = T;
type ParallelWorkerInputKeyDrift =
  | Exclude<keyof CanonicalWorker, keyof LegacyWorker>
  | Exclude<keyof LegacyWorker, keyof CanonicalWorker>;
// eslint-disable-next-line @typescript-eslint/no-unused-vars
type _ParallelWorkerInputKeyGate = AssertNever<ParallelWorkerInputKeyDrift>;
