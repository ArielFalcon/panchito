import test from "node:test";
import assert from "node:assert/strict";
import { aggregateStaticSignal } from "./aggregate";
import { SUPPORTED_LANGUAGES } from "./languages";
test("a new language is added by ONE registry entry (guard: ruby unsupported today)", async () => {
  assert.equal(SUPPORTED_LANGUAGES.has("ruby" as never), false);
  const sig = await aggregateStaticSignal({ sha: "x", repoDir: "/r", changedFiles: ["app.rb"], diff: "" }, {});
  assert.deepEqual(sig.languages, []);
  assert.match(sig.skipped.join(" "), /no changed file is in a supported language/);
});
test("signal is project-agnostic: no app/config reference in the module", async () => {
  const { readFileSync, readdirSync } = await import("node:fs");
  for (const f of readdirSync(import.meta.dirname).filter((n) => n.endsWith(".ts") && !n.endsWith(".test.ts"))) {
    const src = readFileSync(`${import.meta.dirname}/${f}`, "utf8");
    assert.equal(/config\/apps|portfolio|petclinic/.test(src), false, `${f} must be project-agnostic`);
  }
});
