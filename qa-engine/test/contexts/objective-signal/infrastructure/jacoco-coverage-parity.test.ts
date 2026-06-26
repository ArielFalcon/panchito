// test/contexts/objective-signal/infrastructure/jacoco-coverage-parity.test.ts
// PARITY: defaultParseJacocoXml must match parseJacocoXml from src/qa/change-coverage.ts.
// Excluded from qa-engine typecheck; runs via tsx.
import { test } from "node:test";
import assert from "node:assert/strict";
import { parseJacocoXml } from "../../../../../src/qa/change-coverage.ts";
import { defaultParseJacocoXml } from "@contexts/objective-signal/infrastructure/jacoco-coverage.adapter.ts";

const CHANGED_FILES = [
  "src/main/java/com/example/Service.java",
  "src/main/java/com/example/Controller.java",
];

const JACOCO_XML = `<?xml version="1.0" encoding="UTF-8" ?>
<report name="app">
  <package name="com/example">
    <sourcefile name="Service.java">
      <line nr="10" mi="0" ci="3" mb="0" cb="0"/>
      <line nr="11" mi="2" ci="0" mb="0" cb="0"/>
      <line nr="12" mi="0" ci="1" mb="0" cb="0"/>
    </sourcefile>
    <sourcefile name="Controller.java">
      <line nr="5" mi="0" ci="2" mb="0" cb="0"/>
      <line nr="6" mi="0" ci="0" mb="0" cb="0"/>
    </sourcefile>
    <sourcefile name="Unrelated.java">
      <line nr="1" mi="0" ci="5" mb="0" cb="0"/>
    </sourcefile>
  </package>
</report>`;

const fixtures: Array<{ xml: string; changedFiles: string[] }> = [
  { xml: JACOCO_XML, changedFiles: CHANGED_FILES },
  { xml: JACOCO_XML, changedFiles: [] },       // no changed files → all skipped
  { xml: "", changedFiles: CHANGED_FILES },     // empty xml
];

test("PARITY: defaultParseJacocoXml matches parseJacocoXml across fixtures", () => {
  for (const { xml, changedFiles } of fixtures) {
    const legacy = parseJacocoXml(xml, changedFiles);
    const local = defaultParseJacocoXml(xml, changedFiles);
    const toObj = (m: Map<string, Set<number>>) =>
      Object.fromEntries([...m].map(([k, v]) => [k, [...v].sort((a, b) => a - b)]));
    assert.deepEqual(toObj(local), toObj(legacy), `fixture changedFiles: ${changedFiles.length}`);
  }
});
