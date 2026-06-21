import test from "node:test";
import assert from "node:assert/strict";
import { renderStaticSignal } from "./render";
import { EMPTY_STATIC_SIGNAL } from "./types";
test("renderStaticSignal returns empty string when no signal present", () => {
  assert.equal(renderStaticSignal(EMPTY_STATIC_SIGNAL("abc1234")), "");
});
test("renderStaticSignal lists symbols, relations, complexity, patterns", () => {
  const sig = EMPTY_STATIC_SIGNAL("abc1234");
  sig.languages = ["typescript"];
  sig.symbols = [{ file: "src/pay.ts", name: "pay", kind: "function", signature: "function pay(x: Cart): Order", line: 4 }];
  sig.relations = [{ from: "src/pay.ts", to: "src/order.ts", via: "OrderService" }];
  sig.complexity = [{ file: "src/pay.ts", function: "pay", ccn: 12, nloc: 40, line: 4 }];
  sig.patterns = [{ file: "src/pay.ts", pattern: "api-call", source: "ast-grep" }];
  const out = renderStaticSignal(sig);
  assert.match(out, /Static analysis/);
  assert.match(out, /function pay\(x: Cart\): Order/);
  assert.match(out, /src\/pay\.ts → src\/order\.ts/);
  assert.match(out, /ccn 12/);
  assert.match(out, /api-call/);
});
