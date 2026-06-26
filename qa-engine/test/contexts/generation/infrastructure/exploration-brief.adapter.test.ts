// test/contexts/generation/infrastructure/exploration-brief.adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ExplorationBriefAdapter } from "@contexts/generation/infrastructure/exploration-brief.adapter.ts";

const MINIMAL_BRIEF = {
  builtForSha: "abc1234",
  objective: "test the login flow",
  blastRadius: [{ symbol: "LoginService.login", file: "src/login.ts", role: "handles auth" }],
};

test("parse delegates to the injected parseExplorationBrief fn", () => {
  let seenText = "";
  const adapter = new ExplorationBriefAdapter({
    parseExplorationBrief: (text) => { seenText = text; return MINIMAL_BRIEF; },
    coerceExplorationBrief: (raw) => raw as never,
    renderExplorationBrief: (brief) => `## ${brief.objective}`,
  });
  const result = adapter.parse('{"blastRadius":[],"builtForSha":"x","objective":"y"}');
  assert.equal(seenText, '{"blastRadius":[],"builtForSha":"x","objective":"y"}');
  assert.ok(result, "must return the brief from the injected fn");
  assert.equal(result?.objective, "test the login flow");
});

test("coerce delegates to the injected coerceExplorationBrief fn", () => {
  let seenRaw: unknown = null;
  const adapter = new ExplorationBriefAdapter({
    parseExplorationBrief: () => null,
    coerceExplorationBrief: (raw) => { seenRaw = raw; return MINIMAL_BRIEF; },
    renderExplorationBrief: (brief) => `## ${brief.objective}`,
  });
  const result = adapter.coerce({ blastRadius: [], builtForSha: "x", objective: "y" });
  assert.ok(seenRaw, "coerceExplorationBrief must be called");
  assert.equal(result?.objective, "test the login flow");
});

test("render delegates to the injected renderExplorationBrief fn", () => {
  let seenBrief: unknown = null;
  const adapter = new ExplorationBriefAdapter({
    parseExplorationBrief: () => null,
    coerceExplorationBrief: () => null,
    renderExplorationBrief: (brief, opts) => { seenBrief = brief; return `RENDER:${brief.objective}`; },
  });
  const out = adapter.render(MINIMAL_BRIEF, { suppressFeBe: true });
  assert.ok(seenBrief, "renderExplorationBrief must be called");
  assert.equal(out, "RENDER:test the login flow");
});

test("parse returns null when the injected fn returns null (parse-miss pass-through)", () => {
  const adapter = new ExplorationBriefAdapter({
    parseExplorationBrief: () => null,
    coerceExplorationBrief: () => null,
    renderExplorationBrief: () => "",
  });
  const result = adapter.parse("garbage that has no brief JSON");
  assert.equal(result, null);
});
