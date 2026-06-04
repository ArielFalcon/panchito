import { test } from "node:test";
import assert from "node:assert/strict";
import { runLoop, LoopDeps, LoopInput, Verdict, MAX_ITERATIONS } from "./loop";

function input(overrides: Partial<LoopInput> = {}): LoopInput {
  return {
    systemPrimary: "P",
    systemReviewer: "R",
    userMessage: "haz E2E",
    needsReview: true,
    ...overrides,
  };
}

// Stub que cuenta llamadas y devuelve guiones predefinidos.
function deps(opts: {
  proposals: string[];
  verdicts: Verdict[];
}): LoopDeps & { primaryCalls: number; reviewerCalls: number } {
  const state = { primaryCalls: 0, reviewerCalls: 0 };
  return {
    get primaryCalls() {
      return state.primaryCalls;
    },
    get reviewerCalls() {
      return state.reviewerCalls;
    },
    primary: async () => {
      const p = opts.proposals[Math.min(state.primaryCalls, opts.proposals.length - 1)];
      state.primaryCalls++;
      return p ?? "";
    },
    reviewer: async () => {
      const v = opts.verdicts[Math.min(state.reviewerCalls, opts.verdicts.length - 1)];
      state.reviewerCalls++;
      return v ?? { approved: false, corrections: [] };
    },
  };
}

test("aprueba en la primera vuelta", async () => {
  const d = deps({ proposals: ["test v1"], verdicts: [{ approved: true, corrections: [] }] });
  const r = await runLoop(input(), d);
  assert.equal(r.approved, true);
  assert.equal(r.reviewed, true);
  assert.equal(d.primaryCalls, 1);
  assert.equal(d.reviewerCalls, 1);
  assert.equal(r.artifacts.length, 1);
});

test("itera una vez y luego aprueba", async () => {
  const d = deps({
    proposals: ["v1", "v2"],
    verdicts: [
      { approved: false, corrections: ["falta caso de error"] },
      { approved: true, corrections: [] },
    ],
  });
  const r = await runLoop(input(), d);
  assert.equal(r.approved, true);
  assert.equal(d.primaryCalls, 2);
  assert.equal(r.output, "v2");
});

test("corta en maxIterations si nunca aprueba (sin bucle infinito)", async () => {
  const d = deps({
    proposals: ["v1", "v2", "v3"],
    verdicts: [
      { approved: false, corrections: ["a"] },
      { approved: false, corrections: ["b"] },
      { approved: false, corrections: ["c"] },
    ],
  });
  const r = await runLoop(input(), d); // default MAX_ITERATIONS = 2
  assert.equal(r.approved, false);
  assert.equal(d.primaryCalls, MAX_ITERATIONS);
  assert.match(r.note ?? "", /maxIterations/);
});

test("corta por estancamiento si las correcciones se repiten", async () => {
  // maxIterations alto para que el guard que dispare sea el anti-estancamiento,
  // no el tope de iteraciones.
  const d = deps({
    proposals: ["v1", "v2", "v3", "v4"],
    verdicts: [
      { approved: false, corrections: ["mismo"] },
      { approved: false, corrections: ["mismo"] },
    ],
  });
  const r = await runLoop(input({ maxIterations: 5 }), d);
  assert.equal(r.approved, false);
  assert.equal(d.primaryCalls, 2); // se detuvo al detectar correcciones idénticas
  assert.match(r.note ?? "", /progreso/);
});

test("sin needsReview no llama al revisor", async () => {
  const d = deps({ proposals: ["v1"], verdicts: [] });
  const r = await runLoop(input({ needsReview: false }), d);
  assert.equal(r.reviewed, false);
  assert.equal(r.approved, true);
  assert.equal(d.reviewerCalls, 0);
});
