// test/characterization/shadow-run-args.test.ts
// RED-first (Task F.2): parseShadowRunArgs(argv) extracts --app/--sha for the operator script.
// Pure — no process.env, no filesystem, no network. Mirrors the style of src/cli.ts parseArgs
// (a flat --key value scan), scoped to the two flags shadow-run.operator.ts needs.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseShadowRunArgs } from "./shadow-run-args.ts";

test("parseShadowRunArgs reads --app and --sha", () => {
  const out = parseShadowRunArgs(["--app", "petclinic", "--sha", "abc1234"]);
  assert.equal(out.app, "petclinic");
  assert.equal(out.sha, "abc1234");
});

test("parseShadowRunArgs accepts the flags in either order", () => {
  const out = parseShadowRunArgs(["--sha", "deadbeef", "--app", "jhipster-store"]);
  assert.equal(out.app, "jhipster-store");
  assert.equal(out.sha, "deadbeef");
});

test("parseShadowRunArgs throws when --app is missing", () => {
  assert.throws(() => parseShadowRunArgs(["--sha", "abc1234"]), /--app/);
});

test("parseShadowRunArgs throws when --sha is missing", () => {
  assert.throws(() => parseShadowRunArgs(["--app", "petclinic"]), /--sha/);
});

test("parseShadowRunArgs throws on an empty argv", () => {
  assert.throws(() => parseShadowRunArgs([]), /--app/);
});

test("parseShadowRunArgs ignores unknown flags", () => {
  const out = parseShadowRunArgs(["--app", "petclinic", "--sha", "abc1234", "--verbose"]);
  assert.equal(out.app, "petclinic");
  assert.equal(out.sha, "abc1234");
});
