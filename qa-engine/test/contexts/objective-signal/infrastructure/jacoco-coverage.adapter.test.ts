import { test } from "node:test";
import assert from "node:assert/strict";
import { JacocoCoverageAdapter } from "@contexts/objective-signal/infrastructure/jacoco-coverage.adapter.ts";

// Minimal JaCoCo XML fixture
const JACOCO_XML = `<?xml version="1.0" encoding="UTF-8" ?>
<report name="app">
  <package name="com/example">
    <sourcefile name="Service.java">
      <line nr="10" mi="0" ci="3" mb="0" cb="0"/>
      <line nr="11" mi="2" ci="0" mb="0" cb="0"/>
      <line nr="12" mi="0" ci="1" mb="0" cb="0"/>
    </sourcefile>
  </package>
</report>`;

const CHANGED_FILES = ["src/main/java/com/example/Service.java"];

test("parses injected JaCoCo XML into a CoverageReport (only lines with ci>0)", async () => {
  const adapter = new JacocoCoverageAdapter(
    async () => [{ path: "/repo/target/site/jacoco/jacoco.xml", text: JACOCO_XML }],
    CHANGED_FILES,
  );
  const report = await adapter.collect("/repo/e2e", "qa-abc");
  const file = report.covered.find((c) => c.file === CHANGED_FILES[0]);
  assert.ok(file, "should find the matched changed file");
  assert.ok(file!.lines.includes(10), "line 10 should be covered (ci=3)");
  assert.ok(file!.lines.includes(12), "line 12 should be covered (ci=1)");
  assert.ok(!file!.lines.includes(11), "line 11 should NOT be covered (ci=0)");
});

test("returns an empty report when no jacoco xml files found (fail-open)", async () => {
  const adapter = new JacocoCoverageAdapter(async () => [], CHANGED_FILES);
  const report = await adapter.collect("/repo/e2e", "qa-abc");
  assert.deepEqual(report.covered, []);
});
