import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCommit, parseChangedFiles } from "./commit-classify";

const logicDiff = [
  "diff --git a/src/checkout.ts b/src/checkout.ts",
  "+++ b/src/checkout.ts",
  "+if (cart.items > 10) {",
  "+  return applyDiscount(cart);",
  "+}",
].join("\n");

const commentDiff = [
  "diff --git a/src/checkout.ts b/src/checkout.ts",
  "+++ b/src/checkout.ts",
  "+// corrige un typo en el comentario",
].join("\n");

const movedLineDiff = [
  "diff --git a/src/checkout.ts b/src/checkout.ts",
  "+++ b/src/checkout.ts",
  "-  doThing(x);",
  "+  doThing(x);",
].join("\n");

test("feat → generar", () => {
  assert.equal(classifyCommit("feat: nueva pantalla de pago", logicDiff).action, "generate");
});

test("fix → generar (regresión del bug)", () => {
  assert.equal(classifyCommit("fix(checkout): falla con >10 ítems", logicDiff).action, "generate");
});

test("refactor sin lógica nueva → solo regresión", () => {
  const c = classifyCommit("refactor: unifica auth", movedLineDiff);
  assert.equal(c.action, "regression");
  assert.equal(c.contradiction, false);
});

test("style con solo comentarios → skip", () => {
  assert.equal(classifyCommit("style: corrige comentarios", commentDiff).action, "skip");
});

test("CONTRADICCIÓN: refactor pero el diff añade lógica → escala a generar", () => {
  const c = classifyCommit("refactor: limpieza", logicDiff);
  assert.equal(c.action, "generate");
  assert.equal(c.contradiction, true);
  assert.match(c.reason, /añade lógica/);
});

test("breaking change siempre genera", () => {
  assert.equal(classifyCommit("refactor!: cambia el contrato de auth", commentDiff).action, "generate");
  assert.equal(classifyCommit("feat: x\n\nBREAKING CHANGE: api", commentDiff).breaking, true);
});

test("una línea movida NO se confunde con lógica añadida (neto 0)", () => {
  assert.equal(classifyCommit("style: reordena", movedLineDiff).hasLogicChange, false);
});

test("tipo desconocido → genera (ante la duda)", () => {
  assert.equal(classifyCommit("actualiza cosas", logicDiff).type, "unknown");
  assert.equal(classifyCommit("actualiza cosas", logicDiff).action, "generate");
});

test("deduce los ficheros cambiados del diff (scope se infiere de aquí)", () => {
  const files = parseChangedFiles(logicDiff);
  assert.deepEqual(files, ["src/checkout.ts"]);
});

test("lógica solo en ficheros de código (un .md con if no cuenta)", () => {
  const mdDiff = ["diff --git a/README.md b/README.md", "+++ b/README.md", "+if you want to..."].join("\n");
  assert.equal(classifyCommit("docs: actualiza readme", mdDiff).hasLogicChange, false);
});
