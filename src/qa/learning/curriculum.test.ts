import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  initCurriculum,
  recordArchetypeHit,
  selectActiveArchetypes,
  renderArchetypesForPrompt,
  ALL_ARCHETYPES,
  type Curriculum,
} from "./curriculum";

describe("initCurriculum", () => {
  it("creates curriculum with all 10 archetypes as unproven", () => {
    const c = initCurriculum("test-app");
    assert.equal(c.archetypes.length, ALL_ARCHETYPES.length);
    assert.equal(c.archetypes.every((a) => !a.caughtRealBug), true);
    assert.equal(c.archetypes.every((a) => a.promotionCount === 0), true);
  });
});

describe("recordArchetypeHit", () => {
  it("marks an archetype as proven by a real bug", () => {
    const c = initCurriculum("test-app");
    const updated = recordArchetypeHit(c, "invalid-input");
    const entry = updated.archetypes.find((a) => a.archetype === "invalid-input")!;
    assert.equal(entry.caughtRealBug, true);
    assert.ok(entry.firstCaughtAt);
    assert.equal(entry.promotionCount, 1);
  });

  it("increments promotion count on repeated hits", () => {
    const c = initCurriculum("test-app");
    const c1 = recordArchetypeHit(c, "invalid-input");
    const c2 = recordArchetypeHit(c1, "invalid-input");
    const entry = c2.archetypes.find((a) => a.archetype === "invalid-input")!;
    assert.equal(entry.promotionCount, 2);
  });

  it("does not change firstCaughtAt on repeated hits", () => {
    const c = initCurriculum("test-app");
    const c1 = recordArchetypeHit(c, "invalid-input");
    const c2 = recordArchetypeHit(c1, "invalid-input");
    const entry = c2.archetypes.find((a) => a.archetype === "invalid-input")!;
    assert.equal(entry.firstCaughtAt, c1.archetypes.find((a) => a.archetype === "invalid-input")!.firstCaughtAt);
  });
});

describe("selectActiveArchetypes", () => {
  it("returns only proven archetypes, sorted by promotion count", () => {
    const c = initCurriculum("test-app");
    let updated = recordArchetypeHit(c, "happy-path");
    updated = recordArchetypeHit(updated, "happy-path");
    updated = recordArchetypeHit(updated, "invalid-input");

    const active = selectActiveArchetypes(updated);
    assert.equal(active.length, 2);
    assert.equal(active[0], "happy-path"); // promoted twice → first
    assert.equal(active[1], "invalid-input"); // promoted once → second
  });

  it("returns empty when no archetype has caught a bug", () => {
    const c = initCurriculum("test-app");
    assert.equal(selectActiveArchetypes(c).length, 0);
  });
});

describe("renderArchetypesForPrompt", () => {
  it("returns empty string for no archetypes", () => {
    assert.equal(renderArchetypesForPrompt([]), "");
  });

  it("renders archetype descriptions", () => {
    const text = renderArchetypesForPrompt(["invalid-input", "empty-state"]);
    assert.match(text, /invalid-input/);
    assert.match(text, /empty-state/);
    assert.match(text, /bad data submitted/);
    assert.match(text, /no data/);
  });
});
