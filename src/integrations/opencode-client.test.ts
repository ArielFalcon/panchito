import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPrompt,
  parseVerdict,
  extractJsonObjects,
  runOpencode,
  withTimeout,
  parsePlan,
  specFileForFlow,
  upsertManifest,
  generateParallel,
  runOpencodeParallel,
  buildWorkerPrompt,
  buildPlanPrompt,
  ManifestFs,
  ParallelWorkerInput,
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
  target: "e2e",
  mode: "diff",
  appName: "demo-app",
  intent: { type: "feat", breaking: false, message: "feat: new screen", changedFiles: ["src/x.ts"] },
};

function deps(finalText: string, captured?: { prompt?: string; agent?: string }): OpencodeDeps {
  return {
    open: async (agent, cwd, _opts) => {
      if (captured) captured.agent = agent;
      assert.equal(cwd, input.mirrorDir); // the agent starts in the working copy
      return {
        id: "test-session",
        prompt: async (text) => {
          if (captured) captured.prompt = text;
          return finalText;
        },
        dispose: async () => {},
      };
    },
  };
}

test("buildPrompt includes repo, sha, namespace, e2e folder and the diff", () => {
  const p = buildPrompt(input);
  assert.match(p, /abc123/);
  assert.match(p, /org\/demo/);
  assert.match(p, /qa-bot-abc123/);
  assert.match(p, /e2e\//);
  assert.match(p, /const x = 1;/);
  assert.match(p, /invoke the qa-reviewer subagent/);
  assert.match(p, /project="demo-app"/);
});

test("buildPrompt includes the commit intent and asks to update the manifest", () => {
  const p = buildPrompt(input);
  assert.match(p, /Type: feat/);
  assert.match(p, /feat: new screen/);
  assert.match(p, /src\/x\.ts/); // changed files (scope)
  assert.match(p, /manifest\.json/);
});

test("buildPrompt sanitizes the diff (defense in depth)", () => {
  const p = buildPrompt({ ...input, diff: "password=hunter2" });
  assert.doesNotMatch(p, /hunter2/);
  assert.match(p, /\[REDACTED_SECRET\]/);
});

test("buildPrompt without review instructs not to invoke the reviewer", () => {
  const p = buildPrompt({ ...input, needsReview: false });
  assert.match(p, /do not invoke qa-reviewer/);
});

test("buildPrompt includes the OpenAPI hint and the no-direct-call rule when configured", () => {
  const p = buildPrompt({ ...input, openapi: "**/src/main/resources/openapi/*.yaml" });
  assert.match(p, /OpenAPI contract/);
  assert.match(p, /src\/main\/resources\/openapi/);
  assert.match(p, /never call the API directly/);
});

test("buildPrompt joins multiple OpenAPI globs and omits the line when no hint is set", () => {
  const many = buildPrompt({ ...input, openapi: ["a/openapi.yaml", "b/api-definition.yaml"] });
  assert.match(many, /a\/openapi\.yaml, b\/api-definition\.yaml/);
  assert.doesNotMatch(buildPrompt(input), /OpenAPI contract/); // input has no openapi → no line
});

test("buildPrompt complete mode: whole-repo analysis + persisted coverage", () => {
  const p = buildPrompt({ ...input, mode: "complete", intent: undefined });
  assert.match(p, /WHOLE repository/);
  assert.match(p, /COVERAGE \+ IMPORTANCE map/);
  assert.match(p, /analysis\.json/);
  assert.match(p, /UNCOVERED flows/);
  assert.doesNotMatch(p, /## Commit diff/); // no diff for whole-repo mode
});

test("buildPrompt exhaustive mode: re-evaluates the whole suite", () => {
  const p = buildPrompt({ ...input, mode: "exhaustive", intent: undefined });
  assert.match(p, /REGENERATE the entire E2E suite/);
  assert.match(p, /Re-evaluate EVERY existing test/);
});

test("buildPrompt manual mode: includes the user guidance", () => {
  const p = buildPrompt({ ...input, mode: "manual", intent: undefined, guidance: "test the contact form validation" });
  assert.match(p, /FOCUSED on the following guidance/);
  assert.match(p, /contact form validation/);
});

test("parseVerdict reads the closing JSON (in a ```json block)", () => {
  const v = parseVerdict('blah blah\n```json\n{ "approved": true, "specs": ["a.spec.ts"], "note": "" }\n```');
  assert.equal(v.approved, true);
  assert.deepEqual(v.specs, ["a.spec.ts"]);
});

test("parseVerdict takes the LAST valid object", () => {
  const v = parseVerdict('{"approved": true}\nthen\n{ "approved": false, "note": "did not converge" }');
  assert.equal(v.approved, false);
  assert.equal(v.note, "did not converge");
});

test("parseVerdict with no verdict fails closed (approved=false) and flags the parse miss", () => {
  const v = parseVerdict("the agent said nothing structured");
  assert.equal(v.approved, false);
  assert.equal(v.parsed, false); // distinguishes a parse miss from an explicit rejection
});

test("parseVerdict flags a successfully parsed verdict", () => {
  assert.equal(parseVerdict('{ "approved": false, "specs": [] }').parsed, true);
});

test("parseVerdict handles a verdict with a NESTED object (regression: old regex truncated it)", () => {
  const v = parseVerdict('done.\n{"approved": true, "specs": ["a.spec.ts"], "meta": {"changeRef": {"sha": "x"}}}');
  assert.equal(v.parsed, true);
  assert.equal(v.approved, true);
  assert.deepEqual(v.specs, ["a.spec.ts"]);
});

test("parseVerdict ignores a brace inside a string and a non-verdict trailing object", () => {
  const v = parseVerdict('{"approved": true, "note": "use the } char"}\nlater: {"unrelated": 1}');
  assert.equal(v.approved, true);
  assert.equal(v.note, "use the } char");
});

test("extractJsonObjects returns balanced top-level objects in order, skipping invalid spans", () => {
  const objs = extractJsonObjects('noise {"a":1} mid {"b":{"c":2}} tail {not json}');
  assert.deepEqual(objs, [{ a: 1 }, { b: { c: 2 } }]);
});

test("buildPrompt surfaces reviewer corrections as the highest-priority block", () => {
  const p = buildPrompt({ ...input, reviewCorrections: ["a.spec.ts: scope the selector to the header"] });
  assert.match(p, /Apply reviewer corrections/);
  assert.match(p, /scope the selector to the header/);
  // it comes before the task body
  assert.ok(p.indexOf("Apply reviewer corrections") < p.indexOf("Generate/update E2E tests"));
});

test("runOpencode triggers the qa-generator agent and propagates the verdict", async () => {
  const captured: { prompt?: string; agent?: string } = {};
  const res = await runOpencode(input, deps('{ "approved": true, "specs": ["login.spec.ts"] }', captured));
  assert.equal(captured.agent, "qa-generator");
  assert.deepEqual(res.specs, ["login.spec.ts"]);
  assert.equal(res.reviewed, true);
  assert.equal(res.approved, true);
});

test("runOpencode propagates the reviewer rejection with a note", async () => {
  const res = await runOpencode(input, deps('{ "approved": false, "note": "trivial asserts" }'));
  assert.equal(res.approved, false);
  assert.equal(res.note, "trivial asserts");
});

test("runOpencode without review approves even without a verdict", async () => {
  const res = await runOpencode({ ...input, needsReview: false }, deps("done, no JSON"));
  assert.equal(res.reviewed, false);
  assert.equal(res.approved, true);
});

// ── complete/exhaustive fan-out ──────────────────────────────────────────────

test("parsePlan reads objectives, drops malformed entries, and de-dups by flow", () => {
  const out = parsePlan(
    'analysis done.\n{"objectives":[' +
      '{"flow":"checkout","objective":"pay with >10 items","symbols":["pay"]},' +
      '{"flow":"checkout","objective":"duplicate flow ignored"},' +
      '{"objective":"no flow → dropped"},' +
      '{"flow":"login","objective":"valid","symbols":[]}' +
      "]}",
  );
  assert.deepEqual(out, [
    { flow: "checkout", objective: "pay with >10 items", symbols: ["pay"] },
    { flow: "login", objective: "valid", symbols: [] },
  ]);
});

test("parsePlan returns [] when there is no objectives object", () => {
  assert.deepEqual(parsePlan("no json here"), []);
  assert.deepEqual(parsePlan('{"approved":true}'), []);
});

test("specFileForFlow produces a safe path under flows/", () => {
  assert.equal(specFileForFlow("Check Out / Pay!"), "flows/check-out-pay.spec.ts");
  assert.equal(specFileForFlow("   "), "flows/flow.spec.ts");
});

test("upsertManifest merges by id, preserves unrelated entries and measured fields", () => {
  const store = new Map<string, string>();
  const fs: ManifestFs = { read: (p) => store.get(p) ?? null, write: (p, c) => void store.set(p, c) };
  const path = "/m/.qa/manifest.json";
  store.set(path, JSON.stringify([{ id: "old", objective: "keep", flow: "old", targets: [], changeRef: { sha: "s0", type: "feat" }, merit: 7 }]));
  upsertManifest(fs, path, [
    { id: "old", objective: "updated", flow: "old", targets: ["X"], changeRef: { sha: "s1", type: "feat" } },
    { id: "new", objective: "added", flow: "new", targets: [], changeRef: { sha: "s1", type: "feat" } },
  ]);
  const arr = JSON.parse(store.get(path)!);
  assert.equal(arr.length, 2);
  const old = arr.find((e: { id: string }) => e.id === "old");
  assert.equal(old.objective, "updated");
  assert.equal(old.merit, 7, "preserves a measured field not in the upsert");
  assert.ok(arr.find((e: { id: string }) => e.id === "new"));
});

test("upsertManifest rebuilds from entries when the existing manifest is corrupt", () => {
  const store = new Map<string, string>([["/m.json", "not json"]]);
  const fs: ManifestFs = { read: (p) => store.get(p) ?? null, write: (p, c) => void store.set(p, c) };
  upsertManifest(fs, "/m.json", [{ id: "a", objective: "o", flow: "a", targets: [], changeRef: { sha: "s", type: "feat" } }]);
  assert.equal(JSON.parse(store.get("/m.json")!).length, 1);
});

// A deps stub that returns different text depending on the agent (planner vs worker).
function fanoutDeps(planText: string, workerText: (cwd: string, prompt: string) => string, opened: string[]): OpencodeDeps {
  return {
    open: async (agent) => {
      opened.push(agent);
      return {
        id: `s-${agent}-${opened.length}`,
        prompt: async (text) => (agent === "qa-generator" ? planText : workerText("", text)),
        dispose: async () => {},
      };
    },
  };
}

test("generateParallel isolates worker failures and maps flow→spec", async () => {
  const workers: ParallelWorkerInput[] = [
    { objective: "o1", flow: "checkout", symbols: [], specFile: "flows/checkout.spec.ts", repo: "r", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns", appName: "a", mode: "complete" },
    { objective: "o2", flow: "login", symbols: [], specFile: "flows/login.spec.ts", repo: "r", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns", appName: "a", mode: "complete" },
  ];
  const deps: OpencodeDeps = {
    open: async () => ({
      id: "w",
      // checkout returns a valid spec; login returns garbage (no JSON) → error
      prompt: async (text) => (text.includes("flows/checkout.spec.ts") ? '{"spec":"flows/checkout.spec.ts"}' : "i could not do it"),
      dispose: async () => {},
    }),
  };
  const { results, errors } = await generateParallel(workers, deps, { concurrency: 2 });
  assert.deepEqual(results, [{ flow: "checkout", spec: "flows/checkout.spec.ts" }]);
  assert.equal(errors.length, 1);
  assert.match(errors[0]!, /login/);
});

test("runOpencodeParallel: plan → workers → orchestrator writes the manifest (no worker race)", async () => {
  const opened: string[] = [];
  const deps = fanoutDeps(
    '{"objectives":[{"flow":"checkout","objective":"pay >10 items","symbols":["pay"]},{"flow":"login","objective":"log in","symbols":["auth"]}]}',
    (_cwd, prompt) => (prompt.includes("flows/checkout.spec.ts") ? '{"spec":"flows/checkout.spec.ts"}' : '{"spec":"flows/login.spec.ts"}'),
    opened,
  );
  const store = new Map<string, string>();
  const fs: ManifestFs = { read: (p) => store.get(p) ?? null, write: (p, c) => void store.set(p, c) };
  const res = await runOpencodeParallel({ ...input, mode: "complete", intent: undefined }, deps, {}, fs);
  assert.deepEqual(res.specs.sort(), ["flows/checkout.spec.ts", "flows/login.spec.ts"]);
  assert.equal(res.approved, true);
  assert.equal(opened[0], "qa-generator"); // planner first
  assert.ok(opened.slice(1).every((a) => a === "qa-worker")); // then workers
  // the orchestrator wrote ONE manifest with both entries
  const written = [...store.values()];
  assert.equal(written.length, 1);
  const manifest = JSON.parse(written[0]!);
  assert.equal(manifest.length, 2);
  assert.deepEqual(manifest.map((e: { id: string }) => e.id).sort(), ["checkout", "login"]);
  assert.equal(manifest[0].changeRef.sha, input.sha);
});

test("runOpencodeParallel: empty plan is a clean no-op (approved, no specs, no manifest write)", async () => {
  const opened: string[] = [];
  const deps = fanoutDeps('{"objectives":[]}', () => "{}", opened);
  const store = new Map<string, string>();
  const fs: ManifestFs = { read: (p) => store.get(p) ?? null, write: (p, c) => void store.set(p, c) };
  const res = await runOpencodeParallel({ ...input, mode: "complete", intent: undefined }, deps, {}, fs);
  assert.deepEqual(res.specs, []);
  assert.equal(res.approved, true);
  assert.equal(store.size, 0, "no workers, no manifest write");
  assert.deepEqual(opened, ["qa-generator"]); // only the planner ran
});

test("buildWorkerPrompt is surgical: exact file, explore-first, no manifest writes", () => {
  const w: ParallelWorkerInput = { objective: "pay", flow: "checkout", symbols: ["pay"], specFile: "flows/checkout.spec.ts", repo: "r", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns", baseUrl: "https://dev", appName: "a", mode: "complete" };
  const p = buildWorkerPrompt(w);
  assert.match(p, /Write EXACTLY this file: e2e\/flows\/checkout\.spec\.ts/);
  assert.match(p, /Explore YOUR flow FIRST with the Playwright MCP/);
  assert.match(p, /Do NOT write to the manifest/);
  assert.match(p, /\{"spec":"flows\/checkout\.spec\.ts"\}/);
});

test("buildPlanPrompt forbids writing specs and demands self-questioned objectives", () => {
  const p = buildPlanPrompt({ ...input, mode: "complete", intent: undefined });
  assert.match(p, /PLANNING ONLY/);
  assert.match(p, /QUESTION your own list/);
  assert.match(p, /edge cases/);
  assert.match(p, /"objectives"/);
});

test("withTimeout resolves if the promise arrives in time", async () => {
  const v = await withTimeout(Promise.resolve("ok"), 1000, "x");
  assert.equal(v, "ok");
});

test("withTimeout rejects when the deadline elapses", async () => {
  const slow = new Promise((r) => setTimeout(() => r("late"), 50));
  await assert.rejects(() => withTimeout(slow, 5, "agent"), /timed out after 5ms/);
});
