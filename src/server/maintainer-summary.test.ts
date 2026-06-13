import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMaintainerSummary, validJustification } from "./maintainer-summary";

const just = {
  rootCause: "the deploy gate polled the wrong url field",
  whyNecessary: "without it every gated run times out and never tests",
  whyMinimal: "one field rename, no behavior change beyond the fix",
};

test("parseMaintainerSummary extracts the JSON between the markers", () => {
  const text = `some PR prose\n<!--MAINTAINER_SUMMARY ${JSON.stringify({ fixed: true, changes: ["src/x.ts"], prTitle: "fix: gate", justification: just })} END_MAINTAINER_SUMMARY-->\nmore`;
  const s = parseMaintainerSummary(text);
  assert.equal(s.fixed, true);
  assert.deepEqual(s.changes, ["src/x.ts"]);
  assert.equal(s.prTitle, "fix: gate");
  assert.ok(s.justification);
});

test("parseMaintainerSummary returns a not-fixed default when the markers are absent or JSON is invalid", () => {
  assert.deepEqual(parseMaintainerSummary("no markers here"), { fixed: false, changes: [] });
  assert.deepEqual(parseMaintainerSummary("<!--MAINTAINER_SUMMARY {bad json END_MAINTAINER_SUMMARY-->"), { fixed: false, changes: [] });
});

test("validJustification requires all three non-trivial arguments (gates self-merge)", () => {
  assert.ok(validJustification(just));
  assert.equal(validJustification({ rootCause: "x", whyNecessary: just.whyNecessary, whyMinimal: just.whyMinimal }), undefined); // too short
  assert.equal(validJustification({ rootCause: just.rootCause }), undefined); // missing args
  assert.equal(validJustification(null), undefined);
});
