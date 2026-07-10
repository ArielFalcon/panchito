import { test } from "node:test";
import assert from "node:assert/strict";
import { WriteConfinementService } from "@contexts/workspace-and-publication/domain/write-confinement.service.ts";

const svc = new WriteConfinementService();

test("parseStatusOutput handles rename lines and quoted paths", () => {
  const parsed = svc.parseStatusOutput('R  old.ts -> new.ts\n?? "spa ced.ts"\n M e2e/a.spec.ts');
  // A rename/copy line emits TWO records (old + new) — see the rename-over-revert regression:
  // collapsing to only the new path orphaned the legitimate origin's staged deletion.
  assert.deepEqual(parsed.map((p) => p.path), ["old.ts", "new.ts", "spa ced.ts", "e2e/a.spec.ts"]);
});

test("parseStatusOutput's rename record for each side carries the counterpart path, so both can be classified/reverted as a unit", () => {
  const parsed = svc.parseStatusOutput("R  old.ts -> new.ts");
  assert.deepEqual(parsed, [
    { xy: "R ", path: "old.ts", renameCounterpart: "new.ts" },
    { xy: "R ", path: "new.ts", renameCounterpart: "old.ts" },
  ]);
});

test("parseStatusOutput strips quotes independently from each side of a quoted rename", () => {
  const parsed = svc.parseStatusOutput('R  "old spaced.ts" -> "new spaced.ts"');
  assert.deepEqual(parsed.map((p) => p.path), ["old spaced.ts", "new spaced.ts"]);
});

test("parseStatusOutput is quote-aware when the OLD path itself literally contains ' -> ' — git C-style-quotes such a path, and the split must skip past the quoted span, not first-match inside it", () => {
  const parsed = svc.parseStatusOutput('R  "e2e/weird -> name.spec.ts" -> e2e/renamed.spec.ts');
  assert.deepEqual(parsed, [
    { xy: "R ", path: "e2e/weird -> name.spec.ts", renameCounterpart: "e2e/renamed.spec.ts" },
    { xy: "R ", path: "e2e/renamed.spec.ts", renameCounterpart: "e2e/weird -> name.spec.ts" },
  ]);
});

// ── C-style quote decoding regression (Judgment Day round 3) ───────────────────────────────────
//
// stripQuotes only stripped the surrounding `"` — it never decoded git's C-style quoting content.
// With the git DEFAULT core.quotePath=true, a non-ASCII byte in a path is octal-escaped
// (`\NNN` per byte); `\"` and `\\` escape a literal quote/backslash embedded in the name itself.
// Leaving those escapes undecoded means the returned path is not the real on-disk path, so a
// revert built from it (`git clean -f --`, `git restore -- ...`) silently matches nothing.

test("parseStatusOutput decodes git's octal byte-escaping for a non-ASCII path (core.quotePath default)", () => {
  // Raw git porcelain output for `café.spec.ts` under core.quotePath=true: é (U+00E9) is UTF-8
  // bytes 0xC3 0xA9 = octal 303 251, so git emits the literal 8 characters `\303\251` in the quoted
  // path — the JS source below uses `\\` to produce that single literal backslash per escape.
  const parsed = svc.parseStatusOutput('?? "caf\\303\\251.spec.ts"\n');
  assert.deepEqual(parsed.map((p) => p.path), ["café.spec.ts"]);
});

test("parseStatusOutput decodes an embedded escaped quote and backslash inside a git-quoted path", () => {
  const parsed = svc.parseStatusOutput('?? "weird\\"quote.spec.ts"\n?? "back\\\\slash.spec.ts"\n');
  assert.deepEqual(parsed.map((p) => p.path), ['weird"quote.spec.ts', "back\\slash.spec.ts"]);
});

test("parseStatusOutput leaves an unquoted path unchanged", () => {
  const parsed = svc.parseStatusOutput(" M e2e/plain.spec.ts\n");
  assert.deepEqual(parsed.map((p) => p.path), ["e2e/plain.spec.ts"]);
});

test("parseStatusOutput decodes octal-escaped quoted paths independently on each side of a rename", () => {
  const parsed = svc.parseStatusOutput('R  "caf\\303\\251-old.spec.ts" -> "caf\\303\\251-new.spec.ts"\n');
  assert.deepEqual(parsed, [
    { xy: "R ", path: "café-old.spec.ts", renameCounterpart: "café-new.spec.ts" },
    { xy: "R ", path: "café-new.spec.ts", renameCounterpart: "café-old.spec.ts" },
  ]);
});

test("parseStatusOutput: an UNSTAGED rename shows as an independent D + ?? pair (git only emits R when staged/detected) — parsing does not merge them", () => {
  const parsed = svc.parseStatusOutput(" D e2e/existing.spec.ts\n?? stray.spec.ts");
  assert.deepEqual(parsed, [
    { xy: " D", path: "e2e/existing.spec.ts" },
    { xy: "??", path: "stray.spec.ts" },
  ]);
});

test("isE2eStray flags anything outside e2e/", () => {
  assert.equal(svc.isE2eStray("src/x.ts"), true);
  assert.equal(svc.isE2eStray("e2e/a.spec.ts"), false);
  assert.equal(svc.isE2eStray("e2e"), false);
});

test("isCodeDenied flags the denylist (.env, Dockerfile, .github/, docker-compose*)", () => {
  assert.equal(svc.isCodeDenied(".env"), true);
  assert.equal(svc.isCodeDenied(".env.local"), true);
  assert.equal(svc.isCodeDenied("docker-compose.yml"), true);
  assert.equal(svc.isCodeDenied("src/app.ts"), false);
});

test("isDangerousPath flags secret files regardless of target", () => {
  assert.equal(svc.isDangerousPath(".env"), true);
  assert.equal(svc.isDangerousPath("secrets.env"), true);
  assert.equal(svc.isDangerousPath("e2e/a.spec.ts"), false);
});

test("classifyStrays: a rename out of the allowed area reverts BOTH sides as a unit (e2e target)", () => {
  const changes = svc.parseStatusOutput("R  e2e/existing.spec.ts -> stray.spec.ts");
  const { tracked, untracked } = svc.classifyStrays(changes, false);

  assert.deepEqual(tracked.slice().sort(), ["e2e/existing.spec.ts", "stray.spec.ts"]);
  assert.deepEqual(untracked, []);
});

test("classifyStrays: a rename fully INSIDE the allowed area is not a stray — neither side reverted", () => {
  const changes = svc.parseStatusOutput("R  e2e/a.spec.ts -> e2e/b.spec.ts");
  const { tracked, untracked } = svc.classifyStrays(changes, false);

  assert.deepEqual(tracked, []);
  assert.deepEqual(untracked, []);
});

test("classifyStrays: a rename INTO a denylisted destination reverts BOTH sides (code target)", () => {
  const changes = svc.parseStatusOutput("R  src/legit.ts -> .github/workflows/x.yml");
  const { tracked } = svc.classifyStrays(changes, true);

  assert.deepEqual(tracked.slice().sort(), [".github/workflows/x.yml", "src/legit.ts"]);
});
