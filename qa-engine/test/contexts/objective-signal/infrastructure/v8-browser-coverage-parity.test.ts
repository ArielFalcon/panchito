// test/contexts/objective-signal/infrastructure/v8-browser-coverage-parity.test.ts
// PARITY: defaultParseV8Coverage must match parseV8Coverage from src/qa/change-coverage.ts.
// Excluded from qa-engine typecheck; runs via tsx.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseV8Coverage } from "../../../../../src/qa/change-coverage.ts";
import { defaultParseV8Coverage } from "@contexts/objective-signal/infrastructure/v8-browser-coverage.adapter.ts";

const CHANGED_FILES = ["src/svc.ts", "src/util.ts"];

// OS-04: an INDEPENDENT base64-VLQ encoder (the inverse of the inlined decoder), lifted from the
// legacy ORACLE-03 keystone in src/qa/change-coverage.test.ts. It lets the source-map fixture below
// feed BOTH parsers real round-tripped data a bundler emits, not just a hand-picked smoke string —
// pinning the previously-unguarded bundled-deploy branch (coveredOriginalLines / decodeVlq) against
// the legacy original.
const VLQ_B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function encodeVlq(num: number): string {
  let vlq = num < 0 ? (-num << 1) | 1 : num << 1;
  let out = "";
  do {
    let digit = vlq & 31;
    vlq >>>= 5;
    if (vlq > 0) digit |= 32; // continuation bit
    out += VLQ_B64[digit];
  } while (vlq > 0);
  return out;
}
// segs[genLine] = list of ABSOLUTE [genCol, srcIdx, origLine, origCol] tuples (0-based). Encodes the
// source-map v3 deltas: genCol resets per generated line; srcIdx/origLine/origCol are cumulative.
function encodeMappings(segs: number[][][]): string {
  let srcIdx = 0, origLine = 0, origCol = 0;
  return segs
    .map((line) => {
      let genCol = 0;
      return line
        .map(([gc, si, ol, oc]) => {
          const seg = [gc! - genCol, si! - srcIdx, ol! - origLine, oc! - origCol].map(encodeVlq).join("");
          genCol = gc!; srcIdx = si!; origLine = ol!; origCol = oc!;
          return seg;
        })
        .join(",");
    })
    .join(";");
}

// A minified-bundle source map mirroring the legacy keystone: two original files collapsed onto a
// 2-line bundle, tokens at distinct columns, and source lines OUT OF ORDER (negative origLine delta
// on the [4,1,0,0] segment) — the shape a real Angular deploy emits. Plus webpack:/// sourceRoot and
// ./ prefixes so the normalizeSourcePath chain is exercised end to end.
const BUNDLE_SOURCE = "aaa;bbb;ccc\nddd;eee"; // line0 bytes 0..10, '\n' at 11, line1 bytes 12..18
const BUNDLE_MAPPINGS = encodeMappings([
  [[0, 0, 2, 0], [4, 0, 3, 0], [8, 0, 4, 0]], // genLine 0: src0 original lines 3,4,5 (0-based 2,3,4)
  [[0, 0, 7, 0], [4, 1, 0, 0]],               // genLine 1: src0 line 8, then src1 line 1 (negative delta)
]);

// source: "export function f() {\n  return 1;\n}\n"
//   line 1 starts at offset 0,  newline at 21
//   line 2 starts at offset 22, newline at 33
//   line 3 starts at offset 34, newline at 35
const SOURCE = "export function f() {\n  return 1;\n}\n";

const fixtures = [
  // Simple unbundled URL suffix match — lines 1-2 covered, line 3 not
  {
    entries: [{
      url: "https://dev/src/svc.ts",
      source: SOURCE,
      functions: [{
        ranges: [
          { startOffset: 0, endOffset: 34, count: 3 },
          { startOffset: 34, endOffset: 36, count: 0 },
        ],
      }],
    }],
    changedFiles: CHANGED_FILES,
    label: "unbundled URL suffix match",
  },
  // URL that matches no changed file → no output
  {
    entries: [{
      url: "https://dev/unrelated.js",
      source: SOURCE,
      functions: [{ ranges: [{ startOffset: 0, endOffset: 36, count: 5 }] }],
    }],
    changedFiles: CHANGED_FILES,
    label: "no URL match",
  },
  // No functions → empty output
  {
    entries: [{
      url: "https://dev/src/svc.ts",
      source: SOURCE,
      functions: [],
    }],
    changedFiles: CHANGED_FILES,
    label: "no functions",
  },
  // Empty entries
  {
    entries: [],
    changedFiles: CHANGED_FILES,
    label: "empty entries",
  },
  // count=0 for all ranges → nothing covered
  {
    entries: [{
      url: "https://dev/src/svc.ts",
      source: SOURCE,
      functions: [{ ranges: [{ startOffset: 0, endOffset: 36, count: 0 }] }],
    }],
    changedFiles: CHANGED_FILES,
    label: "all count=0",
  },
  // OS-04: SOURCE-MAP smoke (ORACLE-03 keystone). Hashed bundle URL matches no repo path, so coverage
  // must be mapped back through the source map. mappings "AAAA;ACEA": bundle (l0,c0)→src0 line0,
  // bundle (l1,c0)→src1 line2. Only bundle byte 0 executed → only src/a.ts:1 covered. Pins the
  // bundled/else-if branch (coveredOriginalLines) that every prior fixture skipped.
  {
    entries: [{
      url: "https://app.example.com/main.a1b2c3d4.js", // hashed bundle — no suffix match to any repo file
      source: "ab\ncd",
      functions: [{ ranges: [{ startOffset: 0, endOffset: 2, count: 1 }] }],
      map: { version: 3, sources: ["src/a.ts", "src/b.ts"], mappings: "AAAA;ACEA" },
    }],
    changedFiles: ["src/a.ts", "src/b.ts"],
    label: "source-map smoke (ORACLE-03 keystone)",
  },
  // OS-04: SOURCE-MAP realistic minified bundle. Round-tripped VLQ mappings with a NEGATIVE origLine
  // delta and webpack:/// sourceRoot + ./ prefixes — exercises decodeVlq, decodeMappings, the
  // normalizeSourcePath chain, and per-byte covered attribution. byte 0 (login:3) and byte 8 (login:5)
  // and byte 12 (login:8) executed; byte 4 (login:4) and byte 16 (util) did not.
  {
    entries: [{
      url: "https://app.example.com/main.9f8e7d6c.js", // hashed bundle — matches no repo path
      source: BUNDLE_SOURCE,
      functions: [{
        ranges: [
          { startOffset: 0, endOffset: 4, count: 1 },
          { startOffset: 4, endOffset: 8, count: 0 },
          { startOffset: 8, endOffset: 11, count: 1 },
          { startOffset: 12, endOffset: 16, count: 1 },
          { startOffset: 16, endOffset: 19, count: 0 },
        ],
      }],
      map: {
        version: 3,
        sourceRoot: "webpack:///",
        sources: ["./src/app/login.component.ts", "./src/app/util.ts"],
        mappings: BUNDLE_MAPPINGS,
      },
    }],
    changedFiles: ["src/app/login.component.ts"],
    label: "source-map realistic minified bundle (VLQ + webpack sourceRoot)",
  },
];

test("PARITY: defaultParseV8Coverage matches parseV8Coverage across fixtures", () => {
  for (const { entries, changedFiles, label } of fixtures) {
    // The legacy parseV8Coverage takes V8Entry[] from its internal type; we use `as never`
    // to bridge the structural type since the shape is identical.
    const legacy = parseV8Coverage(entries as never, changedFiles);
    const local = defaultParseV8Coverage(entries as never, changedFiles);
    const toObj = (m: Map<string, Set<number>>) =>
      Object.fromEntries([...m].map(([k, v]) => [k, [...v].sort((a, b) => a - b)]));
    assert.deepEqual(toObj(local), toObj(legacy), `fixture: ${label}`);
  }
});
