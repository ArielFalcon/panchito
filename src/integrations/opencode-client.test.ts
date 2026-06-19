import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildPrompt,
  buildContextTask,
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
  buildExplorerPrompt,
  renderArchitectureContext,
  shouldFanOut,
  parseModelRef,
  ManifestFs,
  ParallelWorkerInput,
  AgentDeps,
  OpencodeRunInput,
  askAssistant,
  reviewIndependently,
  startEventStreamWithReconnect,
  EventStreamManager,
  agentErrorToInfra,
} from "./opencode-client";
import { AgentUnavailableError, isInfraError } from "../errors";
import type { ArchitectureContext } from "../qa/context";
import type { ExplorationBrief } from "../qa/exploration-brief";

// context.json is read from the WATCHED repo and committed by this system's own PRs, so it
// is attacker-influenceable. It must be sanitized before reaching the test-writing agent.
test("renderArchitectureContext sanitizes injected fields (no prompt-injection / secret leak)", () => {
  const ctx: ArchitectureContext = {
    builtAtSha: "abc1234def",
    routes: [{ path: "/x", name: "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" }],
    api: [],
    feBe: [],
  };
  const out = renderArchitectureContext(ctx) ?? "";
  assert.doesNotMatch(out, /ghp_AAAA/, "a token in context.json must be redacted before the prompt");
});

test("renderArchitectureContext: a root route '/' does not scope-match every changed file (M9)", () => {
  const ctx: ArchitectureContext = {
    builtAtSha: "abc1234def",
    routes: [{ path: "/" }, { path: "/checkout" }],
    api: [{ operationId: "pay", method: "POST", path: "/pay" }],
    feBe: [
      { route: "/", operationId: "pay" }, // route "/" would match any file path via includes()
      { route: "/checkout", operationId: "pay" },
    ],
  };
  const out = renderArchitectureContext(ctx, ["src/unrelated.ts"]) ?? "";
  // The "/" link must NOT be pulled in as "relevant" just because every path contains "/".
  assert.doesNotMatch(out, /Route `\/` →/, "root-route link must not match every changed file");
});

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

function deps(finalText: string, captured?: { prompt?: string; agent?: string }): AgentDeps {
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
  assert.match(p, /independent reviewer/i);
  assert.match(p, /project="demo-app"/);
});

test("buildPrompt includes the commit intent and specMetas instruction for deterministic manifest", () => {
  const p = buildPrompt(input);
  assert.match(p, /Type: feat/);
  assert.match(p, /feat: new screen/);
  assert.match(p, /src\/x\.ts/); // changed files (scope)
  assert.match(p, /specMetas/); // instructs agent to include structured metadata in verdict
});

test("buildPrompt sanitizes the diff (defense in depth)", () => {
  const p = buildPrompt({ ...input, diff: "password=hunter2" });
  assert.doesNotMatch(p, /hunter2/);
  assert.match(p, /\[REDACTED_SECRET\]/);
});

test("buildPrompt without review omits the reviewer instruction", () => {
  const p = buildPrompt({ ...input, needsReview: false });
  assert.match(p, /Review disabled for this run/);
  assert.doesNotMatch(p, /independent reviewer/i);
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

test("parseVerdict reads the new generator contract (specs, no approved) — approval is the reviewer's job", () => {
  // The generator no longer self-reports `approved`: the independent reviewer is the gate.
  // The closing block is identified by its `specs` array, and a MISSING `approved` must not be
  // read as a rejection (that would fail-close every run under the new contract).
  const v = parseVerdict(
    'done.\n{ "specs": ["login.spec.ts"], "specMetas": [{"file":"login.spec.ts","flow":"login","objective":"valid creds reach the dashboard","targets":[]}], "note": "" }',
  );
  assert.equal(v.parsed, true);
  assert.deepEqual(v.specs, ["login.spec.ts"]);
  assert.equal(v.approved, true); // default for the specs-only contract; the reviewer decides for real
  assert.equal(v.specMetas?.length, 1);
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

test("parseVerdict extracts specMetas with flow, objective, and targets", () => {
  const v = parseVerdict(`{
    "approved": true,
    "specs": ["login.spec.ts", "checkout.spec.ts"],
    "specMetas": [
      {"file": "login.spec.ts", "flow": "login", "objective": "given valid credentials, when login, then redirect to dashboard", "targets": ["LoginComponent", "/api/auth"]},
      {"file": "checkout.spec.ts", "flow": "checkout", "objective": "given items in cart, when checkout, then order is created", "targets": ["CheckoutPage", "createOrder"]}
    ]
  }`);
  assert.equal(v.approved, true);
  assert.equal(v.specs.length, 2);
  assert.ok(v.specMetas);
  assert.equal(v.specMetas!.length, 2);
  assert.deepEqual(v.specMetas![0], {
    file: "login.spec.ts",
    flow: "login",
    objective: "given valid credentials, when login, then redirect to dashboard",
    targets: ["LoginComponent", "/api/auth"],
  });
});

test("parseVerdict drops specMetas entries missing required fields", () => {
  const v = parseVerdict(`{
    "approved": true,
    "specMetas": [
      {"file": "ok.spec.ts", "flow": "ok", "objective": "test something", "targets": ["X"]},
      {"file": "", "flow": "bad", "objective": "nope", "targets": []},
      {"flow": "no-file", "objective": "nothing"},
      "not-an-object"
    ]
  }`);
  assert.ok(v.specMetas);
  assert.equal(v.specMetas!.length, 1);
  assert.equal(v.specMetas![0]!.file, "ok.spec.ts");
});

test("startEventStreamWithReconnect retries after a stream error until aborted", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const delays: number[] = [];
  const logs: string[] = [];

  await startEventStreamWithReconnect(
    () => {},
    controller.signal,
    {
      initialDelayMs: 10,
      maxDelayMs: 20,
      log: (msg) => logs.push(msg),
      sleep: async (ms) => { delays.push(ms); },
      start: async () => {
        attempts++;
        if (attempts === 1) throw new Error("opencode down");
        controller.abort();
      },
    },
  );

  assert.equal(attempts, 2);
  assert.deepEqual(delays, [10]);
  assert.match(logs.join("\n"), /opencode down/);
});

test("startEventStreamWithReconnect reconnects after a clean stream close", async () => {
  const controller = new AbortController();
  let attempts = 0;
  const delays: number[] = [];

  await startEventStreamWithReconnect(
    () => {},
    controller.signal,
    {
      initialDelayMs: 5,
      sleep: async (ms) => { delays.push(ms); },
      start: async () => {
        attempts++;
        if (attempts === 2) controller.abort();
      },
    },
  );

  assert.equal(attempts, 2);
  assert.deepEqual(delays, [5]);
});

// v2 has no global firehose, so the orchestrator opens ONE scoped event.subscribe
// per run directory. The manager refcounts them (parallelDiff sessions share a dir)
// and closes a stream when its last session unregisters. openStream is injected so
// the demux/lifecycle is unit-tested without the SDK.
test("EventStreamManager opens one scoped stream per directory (refcounted) and closes on last detach", () => {
  const opened: Array<{ dir: string; signal: AbortSignal }> = [];
  const mgr = new EventStreamManager((dir, _onActivity, signal) => { opened.push({ dir, signal }); });
  mgr.setSink(() => {}, new AbortController().signal);

  mgr.attach("s1", "/m/a");
  mgr.attach("s2", "/m/a"); // same dir → shares the stream (refcount), no second open
  mgr.attach("s3", "/m/b");

  assert.deepEqual(opened.map((o) => o.dir).sort(), ["/m/a", "/m/b"]);
  assert.equal(opened.length, 2);

  const a = opened.find((o) => o.dir === "/m/a")!;
  mgr.detach("s1"); // /m/a refs 2→1, still open
  assert.equal(a.signal.aborted, false);
  mgr.detach("s2"); // /m/a refs 1→0, closed
  assert.equal(a.signal.aborted, true);
  assert.equal(opened.find((o) => o.dir === "/m/b")!.signal.aborted, false); // /m/b untouched
});

test("EventStreamManager defers opening a stream until the sink is set", () => {
  const opened: string[] = [];
  const mgr = new EventStreamManager((dir) => { opened.push(dir); });
  mgr.attach("s1", "/m/a"); // no sink yet → nothing opens
  assert.deepEqual(opened, []);
  mgr.setSink(() => {}, new AbortController().signal);
  assert.deepEqual(opened, ["/m/a"]); // opened once the sink arrives
});

test("EventStreamManager closes every directory stream on shutdown and ignores later attaches", () => {
  const opened: Array<{ dir: string; signal: AbortSignal }> = [];
  const shutdown = new AbortController();
  const mgr = new EventStreamManager((dir, _oa, signal) => { opened.push({ dir, signal }); });
  mgr.setSink(() => {}, shutdown.signal);
  mgr.attach("s1", "/m/a");
  mgr.attach("s2", "/m/b");

  shutdown.abort();
  assert.ok(opened.every((o) => o.signal.aborted), "all directory streams aborted on shutdown");
  mgr.attach("s3", "/m/c"); // after shutdown → no-op
  assert.equal(opened.length, 2);
});

test("parseVerdict returns undefined specMetas when absent or empty", () => {
  assert.equal(parseVerdict('{"approved": true, "specs": ["a.spec.ts"]}').specMetas, undefined);
  assert.equal(parseVerdict('{"approved": true, "specMetas": "not-array"}').specMetas, undefined);
  assert.equal(parseVerdict('{"approved": true, "specMetas": []}').specMetas, undefined);
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
    { flow: "checkout", objective: "pay with >10 items", symbols: ["pay"], needsUi: true },
    { flow: "login", objective: "valid", symbols: [], needsUi: true },
  ]);
});

test("parsePlan returns [] when there is no objectives object", () => {
  assert.deepEqual(parsePlan("no json here"), []);
  assert.deepEqual(parsePlan('{"approved":true}'), []);
});

test("parsePlan de-dups by resulting filename (distinct strings, same spec file)", () => {
  const out = parsePlan('{"objectives":[{"flow":"Check Out","objective":"a"},{"flow":"check-out","objective":"b"}]}');
  assert.equal(out.length, 1, "both normalize to flows/check-out.spec.ts → only one survives");
  assert.equal(out[0]!.flow, "Check Out");
});

// ── Fase 2: the planner emits a distilled brief per objective ────────────────

test("parsePlan attaches a per-objective brief and derives symbols from its blast radius", () => {
  const out = parsePlan(
    '{"objectives":[{"flow":"checkout","objective":"pay","needsUi":true,"brief":' +
      '{"builtForSha":"s","objective":"pay","blastRadius":[{"symbol":"CheckoutService.pay","file":"src/c.ts","role":"applies discount"}]}}]}',
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.brief?.blastRadius[0]!.symbol, "CheckoutService.pay");
  assert.deepEqual(out[0]!.symbols, ["CheckoutService.pay"], "symbols derived from the brief when not given explicitly");
});

test("parsePlan keeps explicit symbols even when a brief is present (no overwrite)", () => {
  const out = parsePlan(
    '{"objectives":[{"flow":"f","objective":"o","symbols":["Explicit.sym"],"brief":' +
      '{"builtForSha":"s","objective":"o","blastRadius":[{"symbol":"Other.sym","file":"x","role":"r"}]}}]}',
  );
  assert.deepEqual(out[0]!.symbols, ["Explicit.sym"]);
});

test("parsePlan without a brief stays back-compatible (no brief key)", () => {
  const out = parsePlan('{"objectives":[{"flow":"f","objective":"o","symbols":["s"]}]}');
  assert.equal(out[0]!.brief, undefined);
});

test("buildWorkerPrompt injects the exploration brief and forbids re-exploring the code", () => {
  const brief: ExplorationBrief = {
    builtForSha: "s",
    objective: "pay",
    blastRadius: [{ symbol: "CheckoutService.pay", file: "src/c.ts", role: "applies the bulk discount" }],
  };
  const w: ParallelWorkerInput = { objective: "pay", flow: "checkout", symbols: ["CheckoutService.pay"], needsUi: true, specFile: "flows/checkout.spec.ts", repo: "r", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns", baseUrl: "https://dev", appName: "a", mode: "diff", brief };
  const p = buildWorkerPrompt(w);
  assert.match(p, /Exploration brief/);
  assert.match(p, /applies the bulk discount/);
  assert.match(p, /do NOT re-(read|explore)/i);
  assert.match(p, /live DOM/i, "selectors must still be verified against the live DOM");
});

test("buildWorkerPrompt without a brief is unchanged (serena symbols line, back-compat)", () => {
  const w: ParallelWorkerInput = { objective: "pay", flow: "checkout", symbols: ["pay"], needsUi: true, specFile: "flows/checkout.spec.ts", repo: "r", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns", appName: "a", mode: "complete" };
  const p = buildWorkerPrompt(w);
  assert.match(p, /read them with serena/);
  assert.doesNotMatch(p, /Exploration brief/);
});

test("buildPlanPrompt asks each objective for a distilled brief (diff and complete)", () => {
  const diff = buildPlanPrompt(diffPlanInput);
  assert.match(diff, /brief/);
  assert.match(diff, /blastRadius/);
  const complete = buildPlanPrompt({ ...input, mode: "complete", intent: undefined });
  assert.match(complete, /brief/);
  assert.match(complete, /blastRadius/);
});

// ── Fase 3: explorer pass in the single-agent diff path ──────────────────────

test("buildExplorerPrompt asks a read-only explorer to map the diff into an ExplorationBrief", () => {
  const p = buildExplorerPrompt(input);
  assert.match(p, /abc123/); // the sha
  assert.match(p, /feat: new screen/); // intent message
  assert.match(p, /const x = 1/); // the diff
  assert.match(p, /read-only|do NOT write/i);
  assert.match(p, /ExplorationBrief|brief/i);
});

test("buildPrompt injects the exploration brief and tells the generator not to re-read that code", () => {
  const brief: ExplorationBrief = {
    builtForSha: "abc123",
    objective: "new screen",
    blastRadius: [{ symbol: "Screen.render", file: "src/x.ts", role: "renders the new screen" }],
  };
  const withBrief = buildPrompt({ ...input, contextBrief: brief });
  assert.match(withBrief, /Exploration brief/);
  assert.match(withBrief, /renders the new screen/);
  assert.match(withBrief, /do NOT re-read/i);
  assert.doesNotMatch(buildPrompt(input), /Exploration brief/, "no brief → no brief section (back-compat)");
});

test("runOpencode runs the explorer first when the flag is on, and feeds its brief to the generator", async () => {
  const opened: string[] = [];
  let generatorPrompt = "";
  const stub: AgentDeps = {
    open: async (agent) => {
      opened.push(agent);
      return {
        id: `s-${agent}`,
        prompt: async (text: string) => {
          if (agent === "qa-explorer") return '{"builtForSha":"abc123","objective":"new screen","blastRadius":[{"symbol":"Screen.render","file":"src/x.ts","role":"renders it"}]}';
          if (!generatorPrompt) generatorPrompt = text; // capture the FIRST generator prompt (pre any repair)
          return '{"approved":true,"specs":["x.spec.ts"]}';
        },
        dispose: async () => {},
      };
    },
  };
  const res = await runOpencode({ ...input, explorer: true, needsReview: false }, stub);
  assert.equal(opened[0], "qa-explorer", "explorer runs before the generator");
  assert.equal(opened[1], "qa-generator");
  assert.match(generatorPrompt, /Exploration brief/);
  assert.match(generatorPrompt, /renders it/);
  assert.deepEqual(res.specs, ["x.spec.ts"]);
});

test("runOpencode skips the explorer when the flag is off (only the generator runs)", async () => {
  const opened: string[] = [];
  const stub: AgentDeps = {
    open: async (agent) => {
      opened.push(agent);
      return { id: "s", prompt: async () => '{"approved":true,"specs":["x.spec.ts"]}', dispose: async () => {} };
    },
  };
  await runOpencode({ ...input, needsReview: false }, stub);
  assert.deepEqual(opened, ["qa-generator"]);
});

test("runOpencode degrades gracefully when the explorer yields no parseable brief", async () => {
  const opened: string[] = [];
  let generatorPrompt = "";
  const stub: AgentDeps = {
    open: async (agent) => {
      opened.push(agent);
      return {
        id: "s",
        prompt: async (text: string) => {
          if (agent === "qa-explorer") return "sorry, I could not map it";
          if (!generatorPrompt) generatorPrompt = text;
          return '{"approved":true,"specs":["x.spec.ts"]}';
        },
        dispose: async () => {},
      };
    },
  };
  const res = await runOpencode({ ...input, explorer: true, needsReview: false }, stub);
  assert.deepEqual(opened, ["qa-explorer", "qa-generator"]);
  assert.doesNotMatch(generatorPrompt, /Exploration brief/);
  assert.deepEqual(res.specs, ["x.spec.ts"]);
});

// ── Judgment-day fixes ───────────────────────────────────────────────────────

test("runOpencode gives the explorer a TIGHTER timeout than the generator (cannot starve the queue)", async () => {
  const timeouts: Record<string, number | undefined> = {};
  const stub: AgentDeps = {
    open: async (agent, _cwd, o) => {
      timeouts[agent] = o?.timeoutMs;
      return {
        id: agent,
        prompt: async () =>
          agent === "qa-explorer"
            ? '{"builtForSha":"abc123","objective":"o","blastRadius":[{"symbol":"S","file":"f","role":"r"}]}'
            : '{"approved":true,"specs":["x.spec.ts"]}',
        dispose: async () => {},
      };
    },
  };
  await runOpencode({ ...input, explorer: true, needsReview: false }, stub);
  assert.ok(
    timeouts["qa-explorer"]! < timeouts["qa-generator"]!,
    `explorer (${timeouts["qa-explorer"]}) must be shorter than generator (${timeouts["qa-generator"]})`,
  );
});

test("runOpencode treats an empty-blastRadius brief as no brief (degrades to inline exploration)", async () => {
  let generatorPrompt = "";
  const stub: AgentDeps = {
    open: async (agent) => ({
      id: agent,
      prompt: async (text: string) => {
        if (agent === "qa-explorer") return '{"builtForSha":"abc123","objective":"o","blastRadius":[]}';
        if (!generatorPrompt) generatorPrompt = text;
        return '{"approved":true,"specs":["x.spec.ts"]}';
      },
      dispose: async () => {},
    }),
  };
  await runOpencode({ ...input, explorer: true, needsReview: false }, stub);
  assert.doesNotMatch(generatorPrompt, /Exploration brief/, "an empty brief carries no signal and must not be injected");
});

test("parsePlan treats a brief with empty blastRadius as no brief", () => {
  const out = parsePlan('{"objectives":[{"flow":"f","objective":"o","brief":{"builtForSha":"s","objective":"o","blastRadius":[]}}]}');
  assert.equal(out[0]!.brief, undefined);
  assert.deepEqual(out[0]!.symbols, []);
});

test("buildExplorerPrompt sanitizes attacker-influenceable changed-file names", () => {
  const p = buildExplorerPrompt({
    ...input,
    intent: { type: "feat", breaking: false, message: "m", changedFiles: ["src/x.ts", "ghp_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA"] },
  });
  assert.doesNotMatch(p, /ghp_AAAA/, "a token in a changed-file name must be redacted");
});

test("runOpencodeParallel single-objective fallback reuses the planned brief and skips a redundant explorer", async () => {
  const opened: string[] = [];
  let generatorPrompt = "";
  const stub: AgentDeps = {
    open: async (agent) => {
      opened.push(agent);
      return {
        id: agent,
        prompt: async (text: string) => {
          if (text.includes("PLANNING ONLY")) {
            return '{"objectives":[{"flow":"f","objective":"o","needsUi":true,"brief":{"builtForSha":"abc123","objective":"o","blastRadius":[{"symbol":"Planned.sym","file":"src/p.ts","role":"the planned role"}]}}]}';
          }
          if (!generatorPrompt) generatorPrompt = text;
          return '{"approved":true,"specs":["x.spec.ts"]}';
        },
        dispose: async () => {},
      };
    },
  };
  await runOpencodeParallel({ ...input, mode: "diff", explorer: true, needsReview: false }, stub);
  assert.ok(!opened.includes("qa-explorer"), "the planner already explored — no redundant explorer session on the fallback");
  assert.match(generatorPrompt, /the planned role/, "the planner's brief is reused in the generator prompt");
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
function fanoutDeps(planText: string, workerText: (cwd: string, prompt: string) => string, opened: string[]): AgentDeps {
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
    { objective: "o1", flow: "checkout", symbols: [], needsUi: true, specFile: "flows/checkout.spec.ts", repo: "r", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns", appName: "a", mode: "complete" },
    { objective: "o2", flow: "login", symbols: [], needsUi: true, specFile: "flows/login.spec.ts", repo: "r", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns", appName: "a", mode: "complete" },
  ];
  const deps: AgentDeps = {
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
  assert.equal(opened[1], "qa-worker-code"); // serena pre-index (default-on, best-effort)
  assert.ok(opened.slice(2).every((a) => a === "qa-worker")); // then workers
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
  const w: ParallelWorkerInput = { objective: "pay", flow: "checkout", symbols: ["pay"], needsUi: true, specFile: "flows/checkout.spec.ts", repo: "r", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns", baseUrl: "https://dev", appName: "a", mode: "complete" };
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

test("buildWorkerPrompt injects learnedRules so fan-out workers don't repeat past mistakes", () => {
  const base: ParallelWorkerInput = { objective: "pay", flow: "checkout", symbols: ["pay"], needsUi: true, specFile: "flows/checkout.spec.ts", repo: "r", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns", baseUrl: "https://dev", appName: "a", mode: "complete" };
  // Without rules: no lessons block.
  assert.doesNotMatch(buildWorkerPrompt(base), /Lessons learned/);
  // With rules: the block appears, carrying the rule text, before the closing JSON contract.
  const withRules = buildWorkerPrompt({ ...base, learnedRules: "- avoid waitForTimeout; assert on the visible outcome" });
  assert.match(withRules, /Lessons learned from past runs/);
  assert.match(withRules, /avoid waitForTimeout/);
  assert.ok(withRules.indexOf("Lessons learned") < withRules.indexOf('{"spec"'), "lessons precede the JSON contract");
});

test("buildPlanPrompt injects learnedRules in both diff and complete variants", () => {
  const rule = "- prefer getByRole over nth-child selectors";
  const diffWithRules = buildPlanPrompt({ ...diffPlanInput, learnedRules: rule });
  assert.match(diffWithRules, /Lessons learned from past runs/);
  assert.match(diffWithRules, /prefer getByRole/);
  const completeWithRules = buildPlanPrompt({ ...input, mode: "complete", intent: undefined, learnedRules: rule });
  assert.match(completeWithRules, /Lessons learned from past runs/);
  // Absent rules → no lessons block (no wasted tokens).
  assert.doesNotMatch(buildPlanPrompt({ ...input, mode: "complete", intent: undefined }), /Lessons learned/);
});

test("parseModelRef splits provider/model and rejects malformed refs", () => {
  // The fallback model override must reach the SDK as {providerID, modelID}, not a raw string
  // (the bug that broke typecheck). A model id can itself contain slashes — only the FIRST splits.
  assert.deepEqual(parseModelRef("opencode-go/deepseek-v4-pro"), { providerID: "opencode-go", modelID: "deepseek-v4-pro" });
  assert.deepEqual(parseModelRef("a/b/c"), { providerID: "a", modelID: "b/c" });
  // Unparseable → undefined so the override is skipped, never sent malformed.
  assert.equal(parseModelRef("noslash"), undefined);
  assert.equal(parseModelRef("/leading"), undefined);
  assert.equal(parseModelRef("trailing/"), undefined);
});

test("withTimeout resolves if the promise arrives in time", async () => {
  const v = await withTimeout(Promise.resolve("ok"), 1000, "x");
  assert.equal(v, "ok");
});

test("withTimeout rejects when the deadline elapses", async () => {
  const slow = new Promise((r) => setTimeout(() => r("late"), 50));
  await assert.rejects(() => withTimeout(slow, 5, "agent"), /timed out after 5ms/);
});

test("withTimeout can throw a typed InfraError so a slow model is not a pipeline crash", async () => {
  const slow = new Promise((r) => setTimeout(() => r("late"), 50));
  await assert.rejects(
    () => withTimeout(slow, 5, "OpenCode prompt", AgentUnavailableError),
    (err: unknown) => {
      assert.ok(err instanceof AgentUnavailableError, "timeout must be an AgentUnavailableError");
      assert.ok(isInfraError(err), "timeout must classify as infrastructure");
      assert.match((err as Error).message, /OpenCode prompt: timed out after 5ms/);
      return true;
    },
  );
});

test("buildPrompt renders the cross-repo service section in diff mode", () => {
  const text = buildPrompt({
    repo: "org/shop-front",
    sha: "a1b2c3d",
    diff: "+ x",
    mirrorDir: "/m/front",
    e2eRelDir: "e2e",
    namespace: "qa-1",
    needsReview: false,
    target: "e2e",
    mode: "diff",
    appName: "shop",
    baseUrl: "https://dev.shop.io",
    service: { repo: "org/orders-svc", mirrorDir: "/m/svc", openapi: "api/*.yaml" },
  });
  assert.match(text, /Cross-repo change \(microservice\)/);
  assert.match(text, /org\/orders-svc/);
  assert.match(text, /\/m\/svc/);
  assert.match(text, /api\/\*\.yaml/);
  assert.match(text, /ONLY through the frontend UI/);
});

test("buildPrompt has no cross-repo section without a service", () => {
  const text = buildPrompt({
    repo: "org/shop-front", sha: "a1b2c3d", diff: "+ x", mirrorDir: "/m", e2eRelDir: "e2e",
    namespace: "qa-1", needsReview: false, target: "e2e", mode: "diff", appName: "shop",
  });
  assert.doesNotMatch(text, /Cross-repo change/);
});

test("buildContextTask renders one extraction section per service", () => {
  const text = buildContextTask({
    repo: "org/shop-front", sha: "a1b2c3d", diff: "", mirrorDir: "/m/front", e2eRelDir: "e2e",
    namespace: "qa-1", needsReview: false, target: "e2e", mode: "context", appName: "shop",
    services: [
      { repo: "org/orders-svc", mirrorDir: "/m/orders", openapi: "api/*.yaml" },
      { repo: "org/payments-svc", mirrorDir: "/m/payments" },
    ],
  });
  assert.match(text, /Microservice repos \(2\)/);
  assert.match(text, /org\/orders-svc/);
  assert.match(text, /\/m\/orders/);
  assert.match(text, /api\/\*\.yaml/);
  assert.match(text, /"service" field/);
  assert.match(text, /org\/payments-svc/);
  assert.match(text, /\/m\/payments/);
  // No-openapi entry should be present without the hint line
  assert.match(text, /No OpenAPI hint/);
});

test("buildContextTask without services is unchanged (no microservice section)", () => {
  const text = buildContextTask({
    repo: "org/shop-front", sha: "a1b2c3d", diff: "", mirrorDir: "/m/front", e2eRelDir: "e2e",
    namespace: "qa-1", needsReview: false, target: "e2e", mode: "context", appName: "shop",
  });
  assert.doesNotMatch(text, /Microservice repos/);
});

test("shouldFanOut: complete/exhaustive e2e fan out; diff only with parallelDiff", () => {
  assert.equal(shouldFanOut({ target: "e2e", mode: "complete" }), true);
  assert.equal(shouldFanOut({ target: "e2e", mode: "exhaustive" }), true);
  assert.equal(shouldFanOut({ target: "e2e", mode: "diff" }), false);
  assert.equal(shouldFanOut({ target: "e2e", mode: "diff", parallelDiff: true }), true);
});

test("shouldFanOut: never for code target, re-generation passes, or context mode", () => {
  assert.equal(shouldFanOut({ target: "code", mode: "complete" }), false);
  assert.equal(shouldFanOut({ target: "e2e", mode: "diff", parallelDiff: true, fixCases: [{ name: "t", status: "fail" }] }), false);
  assert.equal(shouldFanOut({ target: "e2e", mode: "diff", parallelDiff: true, reviewCorrections: ["fix x"] }), false);
  assert.equal(shouldFanOut({ target: "e2e", mode: "diff", parallelDiff: true, coverageGap: "lines 1-3" }), false);
  assert.equal(shouldFanOut({ target: "e2e", mode: "context" }), false);
});

const diffPlanInput = {
  repo: "org/shop-front", sha: "a1b2c3d", diff: "diff --git a/cart.ts b/cart.ts\n+ bulkDiscount()",
  mirrorDir: "/m/front", e2eRelDir: "e2e", namespace: "qa-1", needsReview: false,
  target: "e2e" as const, mode: "diff" as const, appName: "shop",
  intent: { type: "feat" as const, breaking: false, message: "feat: bulk discount", changedFiles: ["cart.ts"] },
};

test("buildPlanPrompt in diff mode plans ONLY the commit blast radius and includes the diff", () => {
  const text = buildPlanPrompt(diffPlanInput);
  assert.match(text, /blast radius of commit a1b2c3d/i);
  assert.match(text, /bulkDiscount/);
  assert.match(text, /feat: bulk discount/);
  assert.doesNotMatch(text, /WHOLE repository/);
  assert.match(text, /"objectives"/);
});

test("buildPlanPrompt complete/exhaustive variants are unchanged", () => {
  const completeInput = { ...diffPlanInput, mode: "complete" as const };
  const text = buildPlanPrompt(completeInput);
  assert.match(text, /WHOLE repository/);
  assert.doesNotMatch(text, /blast radius of commit/i);
});

test("diff fan-out falls back to the single agent when the plan has <2 objectives", async () => {
  const prompts: string[] = [];
  const stubDeps: AgentDeps = {
    open: async () => ({
      id: "s1",
      prompt: async (text: string) => {
        prompts.push(text);
        return prompts.length === 1
          ? `{"objectives":[{"flow":"checkout","objective":"o","symbols":[],"needsUi":true}]}`
          : `done {"approved":true,"specs":["flows/checkout.spec.ts"]}`;
      },
      dispose: async () => {},
    }),
  };
  const result = await runOpencodeParallel(
    {
      repo: "r", sha: "a1b2c3d", diff: "+x", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "n",
      needsReview: false, target: "e2e", mode: "diff", appName: "a",
    },
    stubDeps,
  );
  assert.equal(prompts.length, 2, `expected 2 prompts (planner + single-agent generation), got ${prompts.length}`);
  assert.match(prompts[1]!, /Generate\/update E2E tests/);
  assert.deepEqual(result.specs, ["flows/checkout.spec.ts"]);
});

test("diff fan-out with >=2 objectives dispatches workers (no fallback)", async () => {
  const agents: string[] = [];
  const stubDeps: AgentDeps = {
    open: async (agent: string) => {
      agents.push(agent);
      return {
        id: "s",
        prompt: async (text: string) =>
          agent === "qa-generator"
            ? `{"objectives":[{"flow":"a","objective":"oa","symbols":[],"needsUi":true},{"flow":"b","objective":"ob","symbols":[],"needsUi":true}]}`
            : `{"spec":"${text.includes("flows/a.spec.ts") ? "flows/a.spec.ts" : "flows/b.spec.ts"}"}`,
        dispose: async () => {},
      };
    },
  };
  const fakeFs = { read: () => null, write: () => {} };
  const result = await runOpencodeParallel(
    {
      repo: "r", sha: "a1b2c3d", diff: "+x", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "n",
      needsReview: false, target: "e2e", mode: "diff", appName: "a",
    },
    stubDeps, undefined, fakeFs,
  );
  assert.deepEqual(agents.filter((a) => a === "qa-worker"), ["qa-worker", "qa-worker"]);
  assert.equal(result.specs.length, 2);
});

test("runOpencodeParallel: PRE_INDEX_SERENA=0 opts out of the serena pre-index session", async () => {
  const prevEnv = process.env.PRE_INDEX_SERENA;
  process.env.PRE_INDEX_SERENA = "0";
  try {
    const opened: string[] = [];
    const deps = fanoutDeps(
      '{"objectives":[{"flow":"a","objective":"o1","symbols":[]},{"flow":"b","objective":"o2","symbols":[]}]}',
      (_cwd, prompt) => (prompt.includes("flows/a.spec.ts") ? '{"spec":"flows/a.spec.ts"}' : '{"spec":"flows/b.spec.ts"}'),
      opened,
    );
    const store = new Map<string, string>();
    const fs: ManifestFs = { read: (p) => store.get(p) ?? null, write: (p, c) => void store.set(p, c) };
    await runOpencodeParallel({ ...input, mode: "complete", intent: undefined }, deps, {}, fs);
    assert.ok(!opened.includes("qa-worker-code")); // no pre-index session when opted out
  } finally {
    process.env.PRE_INDEX_SERENA = prevEnv ?? "";
    if (!prevEnv) delete process.env.PRE_INDEX_SERENA;
  }
});

// ── Integration tests: OpenCode SDK boundary failure modes ──────────────────

test("runOpencode propagates error when deps.open throws (network timeout / auth failure)", async () => {
  const failingDeps: AgentDeps = {
    open: async () => { throw new Error("OpenCode connection timeout"); },
  };
  await assert.rejects(() => runOpencode(input, failingDeps), /OpenCode connection timeout/);
});

test("runOpencode propagates error when session.prompt throws", async () => {
  const failingDeps: AgentDeps = {
    open: async () => ({
      id: "s1",
      prompt: async () => { throw new Error("OpenCode prompt failed: 500"); },
      dispose: async () => {},
    }),
  };
  await assert.rejects(() => runOpencode(input, failingDeps), /OpenCode prompt failed: 500/);
});

test("runOpencode still returns result when session.dispose throws (does not crash)", async () => {
  const failingDeps: AgentDeps = {
    open: async () => ({
      id: "s1",
      prompt: async () => '{ "approved": true, "specs": ["a.spec.ts"] }',
      dispose: async () => { throw new Error("dispose failed"); },
    }),
  };
  const res = await runOpencode(input, failingDeps);
  assert.equal(res.approved, true);
  assert.deepEqual(res.specs, ["a.spec.ts"]);
});

test("askAssistant propagates error when deps.open throws", async () => {
  const failingDeps: AgentDeps = {
    open: async () => { throw new Error("OpenCode unavailable"); },
  };
  await assert.rejects(
    () => askAssistant({ context: "ctx", question: "q?" }, failingDeps, "/m"),
    /OpenCode unavailable/,
  );
});

test("askAssistant requests text-only output so the model's reasoning never leaks", async () => {
  let seenOpts: { textOnly?: boolean } | undefined;
  const deps: AgentDeps = {
    open: async () => ({
      id: "s1",
      prompt: async (_text: string, opts?: { textOnly?: boolean }) => {
        seenOpts = opts;
        return "**Resumen:** la corrida pasó.";
      },
      dispose: async () => {},
    }),
  };
  const answer = await askAssistant({ context: "ctx", question: "¿qué pasó?" }, deps, "/m");
  assert.equal(answer, "**Resumen:** la corrida pasó.");
  assert.equal(seenOpts?.textOnly, true);
});

test("askAssistant opens the requested agent (reflection runs tool-less as qa-reflector; chat is the default)", async () => {
  let openedAgent: string | undefined;
  const deps: AgentDeps = {
    open: async (agent: string) => {
      openedAgent = agent;
      return { id: "s", prompt: async () => "{}", dispose: async () => {} };
    },
  };
  await askAssistant({ context: "c", question: "q", agent: "qa-reflector" }, deps, "/m");
  assert.equal(openedAgent, "qa-reflector");
  await askAssistant({ context: "c", question: "q" }, deps, "/m");
  assert.equal(openedAgent, "qa-assistant"); // default unchanged for the TUI chat path
});

test("reviewIndependently propagates error when deps.open throws", async () => {
  const failingDeps: AgentDeps = {
    open: async () => { throw new Error("OpenCode auth failure"); },
  };
  await assert.rejects(
    () => reviewIndependently({ diff: "d", specs: ["a.spec.ts"], mirrorDir: "/m", e2eRelDir: "e2e", appName: "a", mode: "diff" }, failingDeps),
    /OpenCode auth failure/,
  );
});

test("reviewIndependently propagates error when session.prompt throws", async () => {
  const failingDeps: AgentDeps = {
    open: async () => ({
      id: "s1",
      prompt: async () => { throw new Error("prompt crashed"); },
      dispose: async () => {},
    }),
  };
  await assert.rejects(
    () => reviewIndependently(
      { diff: "d", specs: ["a.spec.ts"], mirrorDir: "/m", e2eRelDir: "e2e", appName: "a", mode: "diff" },
      failingDeps,
    ),
    /prompt crashed/,
  );
});

test("reviewIndependently judges ONLY the artifact in a separate qa-reviewer session (independence guard)", async () => {
  // Locks in the structural independence of the quality gate: the reviewer is a SEPARATE session
  // (not the generator's), it is fed only the diff + the spec contents on disk, and it is told it
  // has no access to the generator's reasoning. If a future change routes the reviewer through the
  // generator's session or forwards its thread/reasoning, these assertions break.
  const dir = mkdtempSync(join(tmpdir(), "qa-review-indep-"));
  const e2eDir = join(dir, "e2e");
  mkdirSync(e2eDir, { recursive: true });
  writeFileSync(join(e2eDir, "login.spec.ts"), "// SPEC_SENTINEL_CONTENT\ntest('x', async () => {});");
  const captured: { prompt?: string; agent?: string } = {};
  const stub: AgentDeps = {
    open: async (agent: string) => {
      captured.agent = agent;
      return {
        id: "rev",
        prompt: async (text: string) => {
          captured.prompt = text;
          return '{"approved":true,"corrections":[],"rationale":"defends the change"}';
        },
        dispose: async () => {},
      };
    },
  };
  try {
    await reviewIndependently(
      { diff: "DIFF_SENTINEL", specs: ["login.spec.ts"], mirrorDir: dir, e2eRelDir: "e2e", appName: "a", mode: "diff" },
      stub,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const p = captured.prompt ?? "";
  assert.equal(captured.agent, "qa-reviewer"); // a separate reviewer session, not the generator
  assert.match(p, /DIFF_SENTINEL/); // judges the real artifact: the diff
  assert.match(p, /SPEC_SENTINEL_CONTENT/); // ...and the spec contents read from disk
  assert.match(p, /WITHOUT the generator's reasoning/i); // explicit independence framing
  assert.match(p, /no access to the\s+generator's thought process/i);
});

test("reviewIndependently warns the operator when spec contents exceed the inline byte cap", async () => {
  // The review silently degrades from "judge inline content" to "go read the files yourself" when
  // the specs are too large to inline. That mode switch must be visible to the operator, not silent.
  const dir = mkdtempSync(join(tmpdir(), "qa-review-big-"));
  const e2eDir = join(dir, "e2e");
  mkdirSync(e2eDir, { recursive: true });
  writeFileSync(join(e2eDir, "big.spec.ts"), "// " + "x".repeat(45_000)); // > REVIEW_SPECS_MAX_BYTES
  const warnings: string[] = [];
  const origWarn = console.warn;
  console.warn = (...a: unknown[]) => { warnings.push(a.map(String).join(" ")); };
  const captured: { prompt?: string } = {};
  const stub: AgentDeps = {
    open: async () => ({
      id: "s1",
      prompt: async (text: string) => {
        captured.prompt = text;
        return '{"approved":true,"corrections":[],"rationale":"ok"}';
      },
      dispose: async () => {},
    }),
  };
  try {
    await reviewIndependently(
      { diff: "d", specs: ["big.spec.ts"], mirrorDir: dir, e2eRelDir: "e2e", appName: "a", mode: "diff" },
      stub,
    );
  } finally {
    console.warn = origWarn;
    rmSync(dir, { recursive: true, force: true });
  }
  assert.ok(warnings.some((w) => /exceed/i.test(w)), "a truncation warning must reach the operator");
  assert.match(captured.prompt ?? "", /read each file with the read tool/); // the fallback path is taken
});

test("reviewIndependently in MANUAL mode judges against the guidance, NOT the commit diff", async () => {
  // The [wrong-objective] bug: a manual (guidance-driven) run was reviewed against the commit diff,
  // so a good spec got rejected for "not testing the change" when the change was never the objective
  // (e.g. the run sat on an unrelated CI-only commit). Manual review must frame the objective as the
  // user's guidance and must NOT inject the commit diff.
  const dir = mkdtempSync(join(tmpdir(), "qa-review-manual-"));
  mkdirSync(join(dir, "e2e"), { recursive: true });
  writeFileSync(join(dir, "e2e", "owner.spec.ts"), "// spec\ntest('x', async () => {});");
  const captured: { prompt?: string } = {};
  const stub: AgentDeps = {
    open: async () => ({
      id: "rev",
      prompt: async (text: string) => { captured.prompt = text; return '{"approved":true,"corrections":[],"rationale":"ok"}'; },
      dispose: async () => {},
    }),
  };
  try {
    await reviewIndependently(
      { diff: "DIFF_SENTINEL_ABSENT", specs: ["owner.spec.ts"], mirrorDir: dir, e2eRelDir: "e2e", appName: "petclinic", mode: "manual", guidance: "GUIDANCE_SENTINEL register a new owner" },
      stub,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const p = captured.prompt ?? "";
  assert.match(p, /GUIDANCE_SENTINEL register a new owner/); // judged against the guidance...
  assert.match(p, /the requested behavior/); // ...named as the objective, not "the change"
  assert.doesNotMatch(p, /DIFF_SENTINEL_ABSENT/); // the unrelated commit diff is NOT injected
  assert.doesNotMatch(p, /## Commit diff/);
});

test("reviewIndependently in a whole-repo (complete) run judges each spec's own objective, not a diff", async () => {
  const dir = mkdtempSync(join(tmpdir(), "qa-review-complete-"));
  mkdirSync(join(dir, "e2e"), { recursive: true });
  writeFileSync(join(dir, "e2e", "flow.spec.ts"), "// spec\ntest('x', async () => {});");
  const captured: { prompt?: string } = {};
  const stub: AgentDeps = {
    open: async () => ({
      id: "rev",
      prompt: async (text: string) => { captured.prompt = text; return '{"approved":true,"corrections":[],"rationale":"ok"}'; },
      dispose: async () => {},
    }),
  };
  try {
    await reviewIndependently(
      { diff: "DIFF_SENTINEL_ABSENT", specs: ["flow.spec.ts"], mirrorDir: dir, e2eRelDir: "e2e", appName: "a", mode: "complete" },
      stub,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const p = captured.prompt ?? "";
  assert.match(p, /the targeted user flow/);
  assert.match(p, /its OWN stated objective/);
  assert.doesNotMatch(p, /DIFF_SENTINEL_ABSENT/);
});

test("agentErrorToInfra classifies an embedded provider fault as infrastructure with an actionable message", () => {
  // ROOT-CAUSE: a provider fault is embedded in res.data.info.error (NOT res.error). It must throw
  // a typed InfraError so the run is `infra-error`, never a code verdict that blames the tests.
  const auth = agentErrorToInfra({ name: "ProviderAuthError", data: { providerID: "opencode-go", message: "insufficient credits" } });
  assert.equal(isInfraError(auth), true);
  assert.match(auth.message, /out of credits|OPENCODE_API_KEY/i);
  assert.match(auth.message, /insufficient credits/);
  assert.match(auth.message, /not a test failure/i);

  const rate = agentErrorToInfra({ name: "APIError", data: { message: "Too Many Requests", statusCode: 429 } });
  assert.equal(isInfraError(rate), true);
  assert.match(rate.message, /429|rate-limited/i);

  // An unknown/future variant still classifies as infra, never a code verdict.
  const unknown = agentErrorToInfra({ name: "UnknownError", data: { message: "boom" } });
  assert.equal(isInfraError(unknown), true);
  assert.match(unknown.message, /not a test failure/i);
});

test("generateParallel collects all errors when every worker fails", async () => {
  const workers: ParallelWorkerInput[] = [
    { objective: "o1", flow: "a", symbols: [], needsUi: true, specFile: "flows/a.spec.ts", repo: "r", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns", appName: "a", mode: "complete" },
    { objective: "o2", flow: "b", symbols: [], needsUi: true, specFile: "flows/b.spec.ts", repo: "r", mirrorDir: "/m", e2eRelDir: "e2e", namespace: "ns", appName: "a", mode: "complete" },
  ];
  const failingDeps: AgentDeps = {
    open: async () => { throw new Error("OpenCode down"); },
  };
  const { results, errors } = await generateParallel(workers, failingDeps, { concurrency: 2 });
  assert.equal(results.length, 0);
  assert.equal(errors.length, 2);
  assert.ok(errors.every((e) => /OpenCode down/.test(e)));
});

test("runOpencodeParallel propagates planner failure", async () => {
  const failingDeps: AgentDeps = {
    open: async (agent) => {
      if (agent === "qa-generator") throw new Error("planner timeout");
      return { id: "w", prompt: async () => '{"spec":"x"}', dispose: async () => {} };
    },
  };
  await assert.rejects(
    () => runOpencodeParallel({ ...input, mode: "complete", intent: undefined }, failingDeps),
    /planner timeout/,
  );
});

test("runOpencodeParallel continues when pre-index serena fails (best-effort)", async () => {
  const prevEnv = process.env.PRE_INDEX_SERENA;
  process.env.PRE_INDEX_SERENA = "1";
  try {
    const failingDeps: AgentDeps = {
      open: async (agent) => {
        if (agent === "qa-worker-code") throw new Error("serena pre-index failed");
        return {
          id: "s",
          prompt: async () =>
            agent === "qa-generator"
              ? '{"objectives":[{"flow":"a","objective":"oa","symbols":[],"needsUi":true}]}'
              : '{"spec":"flows/a.spec.ts"}',
          dispose: async () => {},
        };
      },
    };
    const fakeFs = { read: () => null, write: () => {} };
    const result = await runOpencodeParallel(
      { ...input, mode: "complete", intent: undefined },
      failingDeps,
      {},
      fakeFs,
    );
    assert.equal(result.specs.length, 1);
  } finally {
    process.env.PRE_INDEX_SERENA = prevEnv ?? "";
    if (!prevEnv) delete process.env.PRE_INDEX_SERENA;
  }
});
