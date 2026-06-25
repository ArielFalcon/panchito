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

// ── D4: byte-budget truncation at last newline boundary ─────────────────────
// Regression guard: output under MAX_LEN is unchanged (not truncated at all).
test("D4: renderStaticSignal output under MAX_LEN is not truncated", () => {
  const sig = EMPTY_STATIC_SIGNAL("abc1234");
  sig.languages = ["typescript"];
  sig.symbols = [{ file: "src/pay.ts", name: "pay", kind: "function", signature: "function pay(x: Cart): Order", line: 4 }];
  const out = renderStaticSignal(sig);
  assert.ok(!out.includes("…(static signal truncated)"), "short output must not carry a truncation marker");
  assert.ok(Buffer.byteLength(out, "utf8") <= 20_000, "short output must be well within the 20k byte budget");
});

// D4: when the output exceeds the byte budget, it must be cut at the last newline at or before
// the byte limit — no partial last line — and the byte length must be ≤ MAX_LEN.
test("D4: over-limit output is cut at a newline boundary and stays within the byte budget", () => {
  // Build a signal whose rendered form exceeds MAX_LEN (20_000 bytes).
  // Use a long signature (~90 bytes each) × 300 symbols → ~27k bytes rendered.
  const sig = EMPTY_STATIC_SIGNAL("abc1234");
  sig.languages = ["typescript"];
  sig.symbols = Array.from({ length: 300 }, (_, i) => ({
    file: `src/very/long/module/path/module_${i}.ts`,
    name: `veryLongFunctionName${i}`,
    kind: "function" as const,
    signature: `function veryLongFunctionName${i}(parameterOne: string, parameterTwo: number, parameterThree: boolean): Promise<ResultType>`,
    line: i + 1,
  }));
  const out = renderStaticSignal(sig);

  // Must carry the truncation marker.
  assert.ok(out.includes("…(static signal truncated)"), "over-limit output must carry the truncation marker");

  // Must be within the byte budget (not character limit).
  const byteLen = Buffer.byteLength(out, "utf8");
  assert.ok(byteLen <= 20_000, `truncated output (${byteLen} bytes) must be ≤ 20_000 bytes`);

  // The last line before the truncation marker must not be a partial entry.
  // Strip the marker line ("\n…(static signal truncated)") from the end.
  const markerStr = "\n…(static signal truncated)";
  const bodyEnd = out.lastIndexOf(markerStr);
  assert.ok(bodyEnd > 0, "marker must follow actual content");
  const body = out.slice(0, bodyEnd);
  // The body must end with a newline OR at a complete line (no dangling mid-line text).
  // A dangling partial line would have content after the last "\n" that is not an empty string.
  const lastNewline = body.lastIndexOf("\n");
  const afterLastNewline = body.slice(lastNewline + 1);
  // After the last newline there must be either nothing or a complete (non-empty) line — but
  // the cut must happen AT a newline, meaning lastNewline is the cut point. More precisely:
  // the body itself must end exactly at a "\n" boundary (i.e. lastNewline === body.length - 1
  // OR body.length === 0 — the cut left an empty body). We allow a trailing non-empty complete
  // line only if it's the header itself, but the safe invariant is: the truncation point is a
  // "\n", meaning afterLastNewline === "" (the body ends on a newline).
  // We enforce: the body ends with a newline (i.e. no partial last line).
  assert.equal(
    afterLastNewline,
    "",
    `truncation must land on a newline boundary; found dangling text after last newline: "${afterLastNewline.slice(0, 60)}"`,
  );
});
