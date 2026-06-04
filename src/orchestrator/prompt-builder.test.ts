import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUserMessage } from "./prompt-builder";

test("ensambla las secciones presentes", () => {
  const msg = buildUserMessage(
    { source: "manual", task: "probar login", repo: "org/app", sha: "deadbeef" },
    null,
    null,
  );
  assert.match(msg, /## Tarea/);
  assert.match(msg, /probar login/);
  assert.match(msg, /## Repo/);
  assert.match(msg, /org\/app @ deadbeef/);
  assert.doesNotMatch(msg, /## Diff/); // no había diff
});

test("sanitiza CADA fracción que entra al mensaje (diff y codeContext)", () => {
  const msg = buildUserMessage(
    { source: "manual", task: "t", diff: "api_key=SECRETO123" },
    "const host = 10.0.0.5; // función impactada",
    "antes el usuario juan@correo.com falló",
  );
  assert.doesNotMatch(msg, /SECRETO123/); // secreto del diff
  assert.doesNotMatch(msg, /10\.0\.0\.5/); // host interno del codeContext
  assert.doesNotMatch(msg, /juan@correo\.com/); // PII de la memoria
});
