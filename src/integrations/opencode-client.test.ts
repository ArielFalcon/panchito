import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPrompt,
  parseVerdict,
  runOpencode,
  withTimeout,
  OpencodeDeps,
  OpencodeRunInput,
} from "./opencode-client";

const input: OpencodeRunInput = {
  repo: "org/demo",
  sha: "abc123",
  diff: "diff --git a/x b/x\n+const x = 1;",
  mirrorDir: "/mirrors/org__demo",
  e2eRelDir: "e2e",
  namespace: "qa-bot-abc123",
  needsReview: true,
  intent: { type: "feat", breaking: false, message: "feat: nueva pantalla", changedFiles: ["src/x.ts"] },
};

function deps(finalText: string, captured?: { prompt?: string; agent?: string }): OpencodeDeps {
  return {
    open: async (agent, cwd) => {
      if (captured) captured.agent = agent;
      assert.equal(cwd, input.mirrorDir); // el agente arranca en el espejo
      return {
        prompt: async (text) => {
          if (captured) captured.prompt = text;
          return finalText;
        },
      };
    },
  };
}

test("buildPrompt incluye repo, sha, namespace, carpeta e2e y el diff", () => {
  const p = buildPrompt(input);
  assert.match(p, /abc123/);
  assert.match(p, /org\/demo/);
  assert.match(p, /qa-bot-abc123/);
  assert.match(p, /e2e\//);
  assert.match(p, /const x = 1;/);
  assert.match(p, /invoca al subagente qa-reviewer/);
});

test("buildPrompt incluye la intención del commit y pide actualizar el manifest", () => {
  const p = buildPrompt(input);
  assert.match(p, /Tipo: feat/);
  assert.match(p, /feat: nueva pantalla/);
  assert.match(p, /src\/x\.ts/); // ficheros cambiados (scope)
  assert.match(p, /manifest\.json/);
});

test("buildPrompt sanitiza el diff (defensa en profundidad)", () => {
  const p = buildPrompt({ ...input, diff: "password=hunter2" });
  assert.doesNotMatch(p, /hunter2/);
  assert.match(p, /\[REDACTED_SECRET\]/);
});

test("buildPrompt sin revisión instruye no invocar al revisor", () => {
  const p = buildPrompt({ ...input, needsReview: false });
  assert.match(p, /no invoques a qa-reviewer/);
});

test("parseVerdict lee el JSON de cierre (en bloque ```json)", () => {
  const v = parseVerdict('bla bla\n```json\n{ "approved": true, "specs": ["a.spec.ts"], "note": "" }\n```');
  assert.equal(v.approved, true);
  assert.deepEqual(v.specs, ["a.spec.ts"]);
});

test("parseVerdict toma el ÚLTIMO objeto válido", () => {
  const v = parseVerdict('{"approved": true}\nluego\n{ "approved": false, "note": "no convergió" }');
  assert.equal(v.approved, false);
  assert.equal(v.note, "no convergió");
});

test("parseVerdict sin veredicto falla cerrado (approved=false)", () => {
  const v = parseVerdict("el agente no dijo nada estructurado");
  assert.equal(v.approved, false);
});

test("runOpencode dispara el agente qa-generator y propaga el veredicto", async () => {
  const captured: { prompt?: string; agent?: string } = {};
  const res = await runOpencode(input, deps('{ "approved": true, "specs": ["login.spec.ts"] }', captured));
  assert.equal(captured.agent, "qa-generator");
  assert.deepEqual(res.specs, ["login.spec.ts"]);
  assert.equal(res.reviewed, true);
  assert.equal(res.approved, true);
});

test("runOpencode propaga el rechazo del revisor con nota", async () => {
  const res = await runOpencode(input, deps('{ "approved": false, "note": "asserts triviales" }'));
  assert.equal(res.approved, false);
  assert.equal(res.note, "asserts triviales");
});

test("runOpencode sin revisión aprueba aunque no haya veredicto", async () => {
  const res = await runOpencode({ ...input, needsReview: false }, deps("hecho, sin JSON"));
  assert.equal(res.reviewed, false);
  assert.equal(res.approved, true);
});

test("withTimeout resuelve si la promesa llega a tiempo", async () => {
  const v = await withTimeout(Promise.resolve("ok"), 1000, "x");
  assert.equal(v, "ok");
});

test("withTimeout rechaza si vence el plazo", async () => {
  const lenta = new Promise((r) => setTimeout(() => r("tarde"), 50));
  await assert.rejects(() => withTimeout(lenta, 5, "agente"), /timeout tras 5ms/);
});
