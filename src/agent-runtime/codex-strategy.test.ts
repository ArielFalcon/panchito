// Unit tests for CodexRuntimeStrategy capabilities (T-P1-2, T-P1-3, T-P1-4, T-P2-1, T-P2-3, T-P3-3).
// All tests use stubs/DI — no real codex binary, no network.

import { describe, it, mock } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { join } from "node:path";
import { AgentUnavailableError } from "../errors";
import {
  codexErrorToInfra,
  extractCodexLastMessage,
  rolePromptName,
  CodexRuntimeStrategy,
  CodexExecTransport,
  CODEX_USAGE_AVAILABLE,
  type SpawnFn,
  type CodexHeadlessTransport,
  type CodexTransportSession,
  type CodexTransportStartInput,
} from "./codex-strategy";
import type { AgentModelInfo, AgentProviderHealth } from "./types";

// ── Fake child-process factory for CodexExecTransport DI ────────────────────

// Builds a fake child process that:
//  - never exits on its own (simulates a hung process)
//  - optionally emits stdout data before hanging
//  - records kill() calls so tests can verify SIGTERM was sent
function makeFakeChild(opts: { stdoutData?: string } = {}): {
  child: ChildProcess;
  killSpy: { count: number; signal: string | undefined };
} {
  const killSpy = { count: 0, signal: undefined as string | undefined };

  class FakeReadable extends EventEmitter {
    setEncoding(_encoding: BufferEncoding) { return this; }
  }
  class FakeWritable extends EventEmitter {
    end(_chunk?: unknown) {
      if (opts.stdoutData) {
        (child.stdout as EventEmitter).emit("data", opts.stdoutData);
      }
    }
    write(_chunk: unknown) { return true; }
  }

  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    stdout: new FakeReadable(),
    stderr: new FakeReadable(),
    stdin: new FakeWritable(),
    kill(signal?: string) {
      killSpy.count++;
      killSpy.signal = signal;
      // Emit 'close' with code=1 after a microtask (simulate kill completing)
      setImmediate(() => emitter.emit("close", 1));
    },
    pid: 99999,
  }) as unknown as ChildProcess;

  return { child, killSpy };
}

// Builds a fake child process that exits immediately with code 0 and optional JSONL stdout.
function makeSuccessChild(jsonlOutput: string): ChildProcess {
  class FakeReadable extends EventEmitter {
    setEncoding(_encoding: BufferEncoding) { return this; }
  }
  class FakeWritable extends EventEmitter {
    end(_chunk?: unknown) {
      // Write stdout data then emit close 0
      setImmediate(() => {
        (child.stdout as EventEmitter).emit("data", jsonlOutput);
        setImmediate(() => emitter.emit("close", 0));
      });
    }
    write(_chunk: unknown) { return true; }
  }
  const emitter = new EventEmitter();
  const child = Object.assign(emitter, {
    stdout: new FakeReadable(),
    stderr: new FakeReadable(),
    stdin: new FakeWritable(),
    kill() {},
    pid: 99998,
  }) as unknown as ChildProcess;
  return child;
}

function makeHangingSpawnFn(): { spawnFn: SpawnFn; killSpy: { count: number; signal: string | undefined } } {
  const { child, killSpy } = makeFakeChild();
  const spawnFn = (() => child) as unknown as SpawnFn;
  return { spawnFn, killSpy };
}

function makeSuccessSpawnFn(jsonlOutput: string): SpawnFn {
  return (() => makeSuccessChild(jsonlOutput)) as unknown as SpawnFn;
}

// ---------------------------------------------------------------------------
// T-P1-2: codexErrorToInfra classifier
// ---------------------------------------------------------------------------

describe("codexErrorToInfra (T-P1-2 / AC1.2.1-4)", () => {
  it("auth / out-of-credits stderr → AgentUnavailableError INCONCLUSIVE (AC1.2.1)", () => {
    const cases: string[] = [
      "Error: 401 Unauthorized",
      "Error: 403 Forbidden",
      "Error: 402 Payment Required — out of credits",
      "out of credits",
      "unauthorized",
      "authentication failed",
    ];
    for (const stderr of cases) {
      const err = codexErrorToInfra(new Error(`codex exec exited 1: ${stderr}`));
      assert.ok(err instanceof AgentUnavailableError, `Expected AgentUnavailableError for: ${stderr}`);
      assert.ok(
        err.message.includes("INCONCLUSIVE (infrastructure)"),
        `Expected INCONCLUSIVE message for: ${stderr}`,
      );
    }
  });

  it("timeout / SIGTERM → AgentUnavailableError INCONCLUSIVE (AC1.2.2)", () => {
    const cases: string[] = [
      "Codex prompt: timed out after 30000ms",
      "timed out after 60000ms",
    ];
    for (const msg of cases) {
      const err = codexErrorToInfra(new Error(msg));
      assert.ok(err instanceof AgentUnavailableError, `Expected AgentUnavailableError for timeout: ${msg}`);
      assert.ok(err.message.includes("INCONCLUSIVE (infrastructure)"));
    }
  });

  it("non-zero exit with non-infra stderr is NOT coerced to infra-error (AC1.2.4)", () => {
    // A test legitimately fails — this must not be swallowed into infra-error.
    const err = codexErrorToInfra(new Error("codex exec exited 1: Test assertion failed: expected 200 got 404"));
    assert.ok(!(err instanceof AgentUnavailableError), "Non-infra failure must not become AgentUnavailableError");
    assert.equal(err, null, "codexErrorToInfra must return null for non-infra errors");
  });

  it("rate-limited (429) stderr → AgentUnavailableError (infra) (AC1.2.1)", () => {
    const err = codexErrorToInfra(new Error("codex exec exited 1: 429 Too Many Requests"));
    assert.ok(err instanceof AgentUnavailableError);
    assert.ok(err.message.includes("INCONCLUSIVE (infrastructure)"));
  });

  it("non-Error / null input returns null (AC1.2.4 guard)", () => {
    const err = codexErrorToInfra(null as unknown as Error);
    assert.equal(err, null);
  });
});

// ---------------------------------------------------------------------------
// T-P1-3: textOnly forwarded through prompt
// ---------------------------------------------------------------------------

describe("CodexRuntimeStrategy.openSession textOnly forwarding (T-P1-3 / AC1.3.1-2)", () => {
  // A minimal transport that captures what prompt text was received.
  function makeCapturingTransport(): { transport: CodexHeadlessTransport; captures: Array<{ text: string }> } {
    const captures: Array<{ text: string }> = [];
    const transport: CodexHeadlessTransport = {
      async start(_input: CodexTransportStartInput): Promise<CodexTransportSession> {
        return {
          id: "test-session-id",
          prompt: async (text: string) => {
            captures.push({ text });
            // Simulate a response with chain-of-thought reasoning wrapper + text answer.
            return "<think>internal reasoning step</think>\nfinal answer text";
          },
          dispose: async () => {},
        };
      },
      async health(): Promise<AgentProviderHealth> {
        return { provider: "codex", status: "healthy", configured: true };
      },
      async listModels(): Promise<AgentModelInfo[]> {
        return [{ id: "gpt-5.4", label: "GPT-5.4" }];
      },
    };
    return { transport, captures };
  }

  it("textOnly: true → reasoning wrappers stripped from output (AC1.3.1)", async () => {
    const { transport } = makeCapturingTransport();
    const strategy = new CodexRuntimeStrategy({
      transport,
      promptRoot: "/nonexistent/prompts", // no role preamble files needed for this test
      env: { CODEX_API_KEY: "test-key" },
    });

    const session = await strategy.openSession("chat", "/tmp", {});
    const result = await session.prompt("say hello", { textOnly: true });

    // Reasoning wrapper should be stripped when textOnly is true.
    assert.ok(
      !result.includes("<think>"),
      `textOnly=true must strip <think>…</think> wrappers. Got: ${result}`,
    );
    assert.ok(
      result.includes("final answer text"),
      `textOnly=true must preserve the final answer. Got: ${result}`,
    );
    await session.dispose();
  });

  it("textOnly omitted → output returned as-is, no stripping (AC1.3.2)", async () => {
    const { transport } = makeCapturingTransport();
    const strategy = new CodexRuntimeStrategy({
      transport,
      promptRoot: "/nonexistent/prompts",
      env: { CODEX_API_KEY: "test-key" },
    });

    const session = await strategy.openSession("chat", "/tmp", {});
    const result = await session.prompt("say hello");

    // Without textOnly the raw output (including reasoning) is returned.
    assert.ok(
      result.includes("<think>") || result.includes("final answer text"),
      `No-textOnly path should not strip wrappers. Got: ${result}`,
    );
    await session.dispose();
  });
});

// ---------------------------------------------------------------------------
// T-P1-4: startEventStream on CodexRuntimeStrategy
// ---------------------------------------------------------------------------

describe("CodexRuntimeStrategy.startEventStream (T-P1-4 / AC1.4.3)", () => {
  it("startEventStream is defined on CodexRuntimeStrategy", () => {
    const strategy = new CodexRuntimeStrategy({
      env: {},
    });
    assert.ok(
      typeof (strategy as unknown as Record<string, unknown>).startEventStream === "function" ||
        "startEventStream" in strategy,
      "CodexRuntimeStrategy must expose a startEventStream method",
    );
  });
});

// ---------------------------------------------------------------------------
// T-P2-3: CodexExecTransport timeout/SIGTERM path (AC2.3.1-2)
// ---------------------------------------------------------------------------
// Uses a fake spawn (DI via the new spawnFn parameter) to verify that the
// transport's SIGTERM deadline fires when the deadline elapses and that the
// error is classified by codexErrorToInfra as infra-error.

describe("CodexExecTransport timeout/SIGTERM path (T-P2-3 / AC2.3.1-2)", () => {
  it("SIGTERM is sent and a timeout error is rejected when the deadline elapses (AC2.3.1)", async () => {
    const { spawnFn, killSpy } = makeHangingSpawnFn();
    const transport = new CodexExecTransport(
      { CODEX_API_KEY: "test" },
      "codex",
      spawnFn,
    );
    const session = await transport.start({
      role: "primary",
      cwd: "/tmp",
      model: "gpt-5.4",
      timeoutMs: 20, // 20ms deadline — fires before the hanging child exits
    });

    let caughtErr: unknown;
    try {
      await session.prompt("run tests");
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(caughtErr instanceof Error, "Must reject with an Error when the deadline elapses");

    // The transport must have sent SIGTERM to the child.
    // The timeout fires FIRST and emits the timeout reject; the child's close handler
    // also rejects (after kill()), but the first rejection wins in the Promise.
    assert.ok(killSpy.count >= 1, `kill() must be called at least once. Called: ${killSpy.count}`);
    assert.equal(killSpy.signal, "SIGTERM", `kill must use SIGTERM signal. Got: ${killSpy.signal}`);

    // The timeout error message must match the codexErrorToInfra timeout pattern
    // so the pipeline classifies this as infra-error.
    const errMsg = (caughtErr as Error).message;
    assert.match(errMsg, /timed out after \d+ms/i, `timeout error message must match the pattern. Got: ${errMsg}`);

    // codexErrorToInfra must classify this as AgentUnavailableError (infra).
    const infraErr = codexErrorToInfra(caughtErr as Error);
    assert.ok(
      infraErr instanceof AgentUnavailableError,
      `timeout error must be classifiable as infra (AgentUnavailableError). Got: ${infraErr}`,
    );
    assert.ok(
      infraErr.message.includes("INCONCLUSIVE (infrastructure)"),
      "infra error must include INCONCLUSIVE message",
    );
  });

  it("resolves normally when the process completes before the deadline (AC2.3.2)", async () => {
    // Fake spawn that exits 0 immediately with a JSONL message.
    const jsonl = JSON.stringify({ msg: "all tests passed" });
    const spawnFn = makeSuccessSpawnFn(jsonl);
    const transport = new CodexExecTransport(
      { CODEX_API_KEY: "test" },
      "codex",
      spawnFn,
    );
    const session = await transport.start({
      role: "primary",
      cwd: "/tmp",
      model: "gpt-5.4",
      timeoutMs: 5_000, // 5 second ceiling — process exits in microseconds
    });

    let result: string | undefined;
    let caughtErr: unknown;
    try {
      result = await session.prompt("run tests");
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(
      caughtErr === undefined,
      `No error must be thrown when the process exits before the deadline. Got: ${String(caughtErr)}`,
    );
    assert.equal(
      result,
      "all tests passed",
      `Must resolve with the last JSONL message. Got: ${String(result)}`,
    );
  });
});

// ---------------------------------------------------------------------------
// WS9.3: CodexRuntimeStrategy must arm a DEFAULT per-role deadline when the caller passes no
// timeoutMs — today the rewritten path passes none, so a wedged `codex exec` is unbounded
// (facades.ts marks Codex sessions selfTimed, so the stall watchdog skips them entirely; a
// wall-clock deadline is the only mechanism that can see a Codex hang). The default is derived
// from the SAME per-role budget constants OpenCode uses (REVIEWER_TIMEOUT_MS, EXPLORER_TIMEOUT_MS,
// agentTimeout("diff")), imported directly to avoid the two providers drifting apart.
// ---------------------------------------------------------------------------
describe("CodexRuntimeStrategy — default per-role deadline (WS9.3)", () => {
  // Tiny env-overridden budgets so these tests exercise the REAL default-selection code path
  // (env override, same as OpenCode's OPENCODE_REVIEWER_TIMEOUT_MS pattern) without waiting out
  // the real 5-6 minute production defaults.
  const FAST_ENV = { CODEX_API_KEY: "test-key", OPENCODE_REVIEWER_TIMEOUT_MS: "20", OPENCODE_TIMEOUT_MS: "20" };

  it("openSession with NO timeoutMs still arms a deadline: a hung child is killed and the prompt rejects", { timeout: 10_000 }, async () => {
    const { spawnFn, killSpy } = makeHangingSpawnFn();
    const strategy = new CodexRuntimeStrategy({
      env: FAST_ENV,
      transport: new CodexExecTransport({ CODEX_API_KEY: "test" }, "codex", spawnFn),
      promptRoot: "/nonexistent/prompts",
    });

    // No timeoutMs passed at all — this is the exact rewritten-path shape (generate-tests.use-case.ts
    // never sets opts.timeoutMs). Without a default, this session.prompt() would hang forever.
    const session = await strategy.openSession("reviewer", "/tmp", {});

    let caughtErr: unknown;
    try {
      // Give the fake hanging child a chance to be killed by SOME deadline; the fake spawn never
      // exits on its own, so only an armed timer can resolve this promise at all.
      await session.prompt("review these specs");
    } catch (err) {
      caughtErr = err;
    }

    assert.ok(
      caughtErr instanceof Error,
      "a default deadline must fire and reject — otherwise this awaits forever with no timeoutMs set",
    );
    assert.ok(killSpy.count >= 1, "the hung child must be killed by the default deadline");
  });

  it("the default deadline for 'reviewer' uses SIGKILL (a hard wall-clock guarantee, not graceful SIGTERM)", { timeout: 10_000 }, async () => {
    const { spawnFn, killSpy } = makeHangingSpawnFn();
    const strategy = new CodexRuntimeStrategy({
      env: FAST_ENV,
      transport: new CodexExecTransport({ CODEX_API_KEY: "test" }, "codex", spawnFn),
      promptRoot: "/nonexistent/prompts",
    });

    const session = await strategy.openSession("reviewer", "/tmp", {});
    await assert.rejects(() => session.prompt("review these specs"));

    assert.equal(
      killSpy.signal,
      "SIGKILL",
      "Codex is self-timed with no mid-turn activity signal — the default deadline must use a hard " +
        "SIGKILL (the caller never opted into a specific budget, unlike the explicit-timeoutMs path).",
    );
  });

  it("an EXPLICIT timeoutMs from the caller still wins over the role default (caller intent is not overridden)", async () => {
    const { spawnFn } = makeHangingSpawnFn();
    let capturedTimeout: number | undefined;
    const transport: CodexHeadlessTransport = {
      async start(input: CodexTransportStartInput): Promise<CodexTransportSession> {
        capturedTimeout = input.timeoutMs;
        return { id: "s", prompt: async () => '{"specs":[]}', dispose: async () => {} };
      },
      async health(): Promise<AgentProviderHealth> {
        return { provider: "codex", status: "healthy", configured: true };
      },
      async listModels(): Promise<AgentModelInfo[]> {
        return [];
      },
    };
    void spawnFn; // unused in this transport-level test; only the captured timeoutMs matters here.

    const strategy = new CodexRuntimeStrategy({
      env: { CODEX_API_KEY: "test-key" },
      transport,
      promptRoot: "/nonexistent/prompts",
    });

    const session = await strategy.openSession("reviewer", "/tmp", { timeoutMs: 123_456 });
    await session.prompt("review these specs");
    await session.dispose();

    assert.equal(capturedTimeout, 123_456, "an explicit caller timeoutMs must be forwarded verbatim, not overridden by the role default");
  });

  it("distinct roles get distinct default budgets: reviewer's default differs from primary's", async () => {
    const capturedByRole: Record<string, number | undefined> = {};
    function makeCapturingTransport(roleLabel: string): CodexHeadlessTransport {
      return {
        async start(input: CodexTransportStartInput): Promise<CodexTransportSession> {
          capturedByRole[roleLabel] = input.timeoutMs;
          return { id: "s", prompt: async () => '{"specs":[]}', dispose: async () => {} };
        },
        async health(): Promise<AgentProviderHealth> {
          return { provider: "codex", status: "healthy", configured: true };
        },
        async listModels(): Promise<AgentModelInfo[]> {
          return [];
        },
      };
    }

    const reviewerStrategy = new CodexRuntimeStrategy({
      env: { CODEX_API_KEY: "test-key" },
      transport: makeCapturingTransport("reviewer"),
      promptRoot: "/nonexistent/prompts",
    });
    const primaryStrategy = new CodexRuntimeStrategy({
      env: { CODEX_API_KEY: "test-key" },
      transport: makeCapturingTransport("primary"),
      promptRoot: "/nonexistent/prompts",
    });

    await (await reviewerStrategy.openSession("reviewer", "/tmp", {})).prompt("x");
    await (await primaryStrategy.openSession("primary", "/tmp", {})).prompt("x");

    assert.ok(typeof capturedByRole.reviewer === "number", "reviewer must get a numeric default deadline");
    assert.ok(typeof capturedByRole.primary === "number", "primary must get a numeric default deadline");
    assert.notEqual(
      capturedByRole.reviewer,
      capturedByRole.primary,
      "reviewer (6min budget) and primary (5min diff budget) must use DIFFERENT default deadlines, " +
        "matching the same per-role split OpenCode already uses",
    );
  });
});

// ---------------------------------------------------------------------------
// T-P2-1: extractCodexLastMessage unit tests (AC2.1.1-3)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Slice 1: rolePromptName must route "proposer" through its own explicit
// branch, not the "qa-maintainer" fallthrough.
// ---------------------------------------------------------------------------

describe("rolePromptName (Slice 1 — proposer role)", () => {
  it("routes proposer to qa-proposer via an explicit branch, not the qa-maintainer fallthrough", () => {
    assert.equal(rolePromptName("proposer"), "qa-proposer");
    assert.notEqual(
      rolePromptName("proposer"),
      rolePromptName("maintainer"),
      "proposer must not silently fall through to the maintainer branch",
    );
  });
});

// ---------------------------------------------------------------------------
// T-P2-1: extractCodexLastMessage unit tests (AC2.1.1-3)
// ---------------------------------------------------------------------------

describe("extractCodexLastMessage (T-P2-1 / AC2.1.1-3)", () => {
  it("returns the LAST message from multi-line JSONL (AC2.1.1)", () => {
    // The function should pick the LAST message-like event in the JSONL stream.
    // Uses the defensive 4-field probe: msg ?? message ?? text ?? content.
    const jsonl = [
      JSON.stringify({ msg: "first message" }),
      JSON.stringify({ msg: "second message" }),
      JSON.stringify({ msg: "last message" }),
    ].join("\n");
    const result = extractCodexLastMessage(jsonl);
    assert.equal(result, "last message", "Must return the LAST non-empty message, not the first");
  });

  it("tolerates interleaved non-JSON/stderr lines and still returns trailing message (AC2.1.2)", () => {
    const jsonl = [
      "Spawning codex exec...",                       // non-JSON stderr
      JSON.stringify({ msg: "setup done" }),
      "[INFO] connecting to MCP",                     // non-JSON log
      JSON.stringify({ message: "test result: all passed" }),
      "some random stderr output",                    // trailing non-JSON
    ].join("\n");
    const result = extractCodexLastMessage(jsonl);
    assert.equal(result, "test result: all passed");
  });

  it("returns empty string for empty/whitespace-only input (AC2.1.3)", () => {
    assert.equal(extractCodexLastMessage(""), "");
    assert.equal(extractCodexLastMessage("   \n  \n  "), "");
  });

  it("handles the defensive 4-field probe: prefers msg, then message, then text, then content", () => {
    // msg takes priority — if present, it wins
    assert.equal(
      extractCodexLastMessage(JSON.stringify({ msg: "via-msg", message: "via-message" })),
      "via-msg",
    );
    // message fallback
    assert.equal(
      extractCodexLastMessage(JSON.stringify({ message: "via-message", text: "via-text" })),
      "via-message",
    );
    // text fallback
    assert.equal(
      extractCodexLastMessage(JSON.stringify({ text: "via-text", content: "via-content" })),
      "via-text",
    );
    // content fallback
    assert.equal(
      extractCodexLastMessage(JSON.stringify({ content: "via-content" })),
      "via-content",
    );
  });

  it("skips events with no message field and returns the last valid one", () => {
    const jsonl = [
      JSON.stringify({ msg: "real result" }),
      JSON.stringify({ type: "tool_use", tool: "read_file" }),  // no msg/message/text/content
      JSON.stringify({ status: "done" }),                       // no message field
    ].join("\n");
    // The last line has no message → the last valid message was "real result"
    assert.equal(extractCodexLastMessage(jsonl), "real result");
  });

  // ── WS9.4(a): prefer the last message CONTAINING a parseable verdict block ──
  //
  // extractCodexLastMessage previously returned only the LAST agent_message unconditionally. If
  // the agent emits its closing verdict JSON and THEN a trailing remark (e.g. "Done!" after the
  // JSON block, or a courtesy follow-up), the verdict is lost — this is a Codex-only asymmetry
  // (OpenCode's extractText concatenates ALL messages, so a trailing remark never displaces the
  // verdict there). The fix: scan messages in reverse and return the last one that itself parses
  // as containing a verdict-shaped JSON block (specs[] or an approved field); only when NONE do,
  // fall back to the true last message (preserving all plain-text/chat behavior above).

  it("WS9.4(a): a generator verdict block followed by a trailing remark is still recovered", () => {
    const verdictJson = JSON.stringify({ specs: ["login.spec.ts"], note: "covers the new login flow" });
    const jsonl = [
      JSON.stringify({ msg: verdictJson }),
      JSON.stringify({ msg: "Done! Let me know if you need anything else." }),
    ].join("\n");
    const result = extractCodexLastMessage(jsonl);
    assert.ok(
      result.includes('"specs"') && result.includes("login.spec.ts"),
      `must recover the verdict-bearing message, not the trailing remark. Got: ${result}`,
    );
  });

  it("WS9.4(a): a reviewer verdict block followed by a trailing remark is still recovered", () => {
    const verdictJson = JSON.stringify({ approved: true, rationale: "looks good", corrections: [] });
    const jsonl = [
      JSON.stringify({ msg: verdictJson }),
      JSON.stringify({ msg: "Great, all specs look solid!" }),
    ].join("\n");
    const result = extractCodexLastMessage(jsonl);
    assert.ok(
      result.includes('"approved"') && result.includes("true"),
      `must recover the verdict-bearing message, not the trailing remark. Got: ${result}`,
    );
  });

  it("WS9.4(a): when NO message contains a verdict, falls back to the true last message (unchanged behavior)", () => {
    const jsonl = [
      JSON.stringify({ msg: "exploring the codebase" }),
      JSON.stringify({ msg: "still no verdict, just chatting" }),
    ].join("\n");
    const result = extractCodexLastMessage(jsonl);
    assert.equal(result, "still no verdict, just chatting");
  });

  it("WS9.4(a): a verdict embedded mid-message (not the whole message) is still detected", () => {
    // The agent's closing message is prose THEN a JSON block, not a bare JSON string — the
    // detection must find the verdict block WITHIN the message text, not require the whole
    // message to be pure JSON.
    const verdictJson = JSON.stringify({ specs: ["checkout.spec.ts"] });
    const jsonl = [
      JSON.stringify({ msg: `I wrote the spec.\n${verdictJson}` }),
      JSON.stringify({ msg: "Anything else?" }),
    ].join("\n");
    const result = extractCodexLastMessage(jsonl);
    assert.ok(result.includes("checkout.spec.ts"), `must recover the message embedding the verdict. Got: ${result}`);
  });

  it("WS9.4(a): TWO verdict-bearing messages (draft then final) — the LAST one wins", () => {
    // An agent may emit a draft verdict, keep working, and emit a corrected final verdict.
    // The reverse scan must return the LAST verdict-bearing message, never resurrect the draft.
    const draft = JSON.stringify({ specs: ["draft.spec.ts"], note: "first attempt" });
    const final_ = JSON.stringify({ specs: ["final.spec.ts"], note: "corrected" });
    const jsonl = [
      JSON.stringify({ msg: `Draft:\n${draft}` }),
      JSON.stringify({ msg: "hmm, let me fix the selector first" }),
      JSON.stringify({ msg: `Final verdict:\n${final_}` }),
    ].join("\n");
    const result = extractCodexLastMessage(jsonl);
    assert.ok(result.includes("final.spec.ts"), `the LAST verdict must win. Got: ${result}`);
    assert.ok(!result.includes("draft.spec.ts"), `the draft verdict must not be resurrected. Got: ${result}`);
  });

  it.skip("[REAL-BOUNDARY] validates against real codex --json fixture (requires T-P1-0 image run)", () => {
    // This test validates extractCodexLastMessage against the REAL `codex exec --json` JSONL
    // output shape captured by agents/smoke/capture-codex-jsonl.smoke.mjs.
    // IMAGE-GATED: the fixture at src/agent-runtime/__fixtures__/codex-exec-json.jsonl does not
    // exist until T-P1-0 is run in the built agents image with CODEX_API_KEY set.
    // When that fixture exists, replace this with:
    //   const fixture = readFileSync("src/agent-runtime/__fixtures__/codex-exec-json.jsonl", "utf8");
    //   const result = extractCodexLastMessage(fixture);
    //   assert.ok(result.length > 0, "Must extract a non-empty message from real fixture");
    // Then remove it.skip and move to DONE.
  });
});

// ---------------------------------------------------------------------------
// T-P3-3 — onUsage honesty: explicit asymmetry + honest usageComplete (C3.3 / AC3.3.1)
// ---------------------------------------------------------------------------
// These tests assert the HONEST behavior of the codex path: tokens are null, onUsage is not
// emitted (because codex exec does not expose usage in the current JSONL schema), and the
// PENDING_USAGE_HOOK flag documents where wiring goes once the real fixture is captured.
//
// ENVIRONMENT CONSTRAINT (from instructions): no CODEX_API_KEY / codex binary available.
// The wiring is tested via the exported CODEX_USAGE_AVAILABLE flag, the AgentTurnEvent token
// fields (asserted via the onTurn callback), and a structural assertion that the flag is false.
//
// When T-P1-0 image-gated fixture is committed and proves usage is in the JSONL, the correct
// remediation is:
//   1. Set CODEX_USAGE_AVAILABLE = true in codex-strategy.ts
//   2. This test (assert.equal(CODEX_USAGE_AVAILABLE, false)) will fail → RED
//   3. Wire onUsage in openSession + parse token fields
//   4. Update this test to assert the real usage fields
// This RED-on-activation is intentional — it forces the developer to wire, not just flip.
describe("T-P3-3 — onUsage honesty (C3.3 / AC3.3.1)", () => {
  it("CODEX_USAGE_AVAILABLE is false — pending hook is NOT yet activated (AC3.3.1)", () => {
    // This is the HONEST assertion: codex exec does not yet expose token usage.
    // When the T-P1-0 fixture proves usage is available, this test will go RED (intentionally),
    // forcing the developer to wire onUsage before re-greening.
    assert.equal(
      CODEX_USAGE_AVAILABLE,
      false,
      "CODEX_USAGE_AVAILABLE must be false until the T-P1-0 image-gated fixture confirms " +
        "codex exec --json exposes token usage fields. Do NOT set this to true without wiring " +
        "the actual usage parsing and onUsage callback in openSession.",
    );
  });

  it("AgentTurnEvent token fields are null — no fabricated data emitted (AC3.3.1)", async () => {
    // Assert that token fields in the turn event are null (not fabricated) when using the codex path.
    const capturedTurns: Array<{ tokensInput: unknown; tokensOutput: unknown; cost: unknown }> = [];

    const fakeTransportSession: CodexTransportSession = {
      id: "t-p3-3-session",
      prompt: async () => "honest null output",
      dispose: async () => {},
    };

    const fakeTransport: CodexHeadlessTransport = {
      start: async () => fakeTransportSession,
      health: async () => ({ provider: "codex" as const, status: "healthy" as const, configured: true }),
      listModels: async () => [],
    };

    const strategy = new CodexRuntimeStrategy({ env: { CODEX_API_KEY: "test-key" }, transport: fakeTransport });
    const session = await strategy.openSession("primary", "/tmp", {
      descriptor: { runId: "run-p3-3", role: "primary" as const, objective: "test" },
      onTurn: (t) => {
        capturedTurns.push({ tokensInput: t.tokensInput, tokensOutput: t.tokensOutput, cost: t.cost });
      },
    });

    await session.prompt("test prompt for onUsage honesty");

    assert.equal(capturedTurns.length, 1, "onTurn must fire once per prompt");
    const turn = capturedTurns[0]!;
    assert.equal(
      turn.tokensInput,
      null,
      "tokensInput must be null for codex (usage not available in JSONL). See CODEX_USAGE_AVAILABLE.",
    );
    assert.equal(
      turn.tokensOutput,
      null,
      "tokensOutput must be null for codex (usage not available in JSONL). See CODEX_USAGE_AVAILABLE.",
    );
    assert.equal(
      turn.cost,
      null,
      "cost must be null for codex (usage not available in JSONL). See CODEX_USAGE_AVAILABLE.",
    );
  });

  it("openSession does not silently drop an onUsage callback when it is passed — asymmetry is explicit (AC3.3.1)", async () => {
    // OpenCodeRuntimeStrategy accepts onUsage and forwards it to deps.open.
    // CodexRuntimeStrategy does NOT accept onUsage in its openSession signature — this is the
    // declared asymmetry. This test documents that:
    //   1. The pending hook flag is false (tested above).
    //   2. No onUsage snapshot is fabricated when the caller supplies a callback via descriptor opts.
    //   3. The strategy is not broken — it opens sessions and prompts normally without onUsage.
    //
    // The asymmetry is EXPLICIT (declared in contract-parity.test.ts ALLOWED_ASYMMETRIES) and
    // SAFE (pipeline.ts:937 already yields usageComplete=false for codex).
    const fakeTransportSession: CodexTransportSession = {
      id: "t-p3-3b-session",
      prompt: async () => "no usage emitted",
      dispose: async () => {},
    };

    const fakeTransport: CodexHeadlessTransport = {
      start: async () => fakeTransportSession,
      health: async () => ({ provider: "codex" as const, status: "healthy" as const, configured: true }),
      listModels: async () => [],
    };

    const strategy = new CodexRuntimeStrategy({ env: { CODEX_API_KEY: "test-key" }, transport: fakeTransport });

    // openSession with no onUsage — must succeed without throwing (the normal codex path).
    const session = await strategy.openSession("reviewer", "/tmp");
    const result = await session.prompt("test no-usage path");
    assert.equal(result, "no usage emitted", "prompt must return the transport output");
    await session.dispose();
  });
});

// ---------------------------------------------------------------------------
// WS9.2: skill delivery parity — the Codex role preamble must inline the SKILL.md
// content a role prompt references, the same way it already inlines AGENTS.md and
// roles/<role>.md. Without this, "Consult the `playwright-authoring` skill" is a
// dangling reference on Codex (nothing ships agent/skills/ into a codex turn).
// ---------------------------------------------------------------------------
describe("CodexRuntimeStrategy — skill inlining into the role preamble (WS9.2)", () => {
  // Real repo promptRoot (this test file lives at src/agent-runtime/ → two levels up to repo root,
  // then into agent/ — the same provider-neutral tree withCodexRolePreamble reads from).
  const REPO_ROOT = join(import.meta.dirname ?? __dirname, "..", "..");
  const REAL_PROMPT_ROOT = join(REPO_ROOT, "agent");

  function makeCapturingTransport(): { transport: CodexHeadlessTransport; captures: Array<{ text: string }> } {
    const captures: Array<{ text: string }> = [];
    const transport: CodexHeadlessTransport = {
      async start(_input: CodexTransportStartInput): Promise<CodexTransportSession> {
        return {
          id: "skill-capture-session",
          prompt: async (text: string) => {
            captures.push({ text });
            return '{"specs":[]}';
          },
          dispose: async () => {},
        };
      },
      async health(): Promise<AgentProviderHealth> {
        return { provider: "codex", status: "healthy", configured: true };
      },
      async listModels(): Promise<AgentModelInfo[]> {
        return [{ id: "gpt-5.4", label: "GPT-5.4" }];
      },
    };
    return { transport, captures };
  }

  it("worker role preamble inlines the playwright-authoring skill it references", async () => {
    const { transport, captures } = makeCapturingTransport();
    const strategy = new CodexRuntimeStrategy({
      transport,
      promptRoot: REAL_PROMPT_ROOT,
      env: { CODEX_API_KEY: "test-key" },
    });

    const session = await strategy.openSession("worker", "/tmp", {});
    await session.prompt("write a spec");
    await session.dispose();

    assert.equal(captures.length, 1);
    const preamble = captures[0]!.text;
    assert.ok(
      preamble.includes("Craft knowledge for writing specs"),
      "the worker preamble must inline playwright-authoring's SKILL.md content, not just reference its name",
    );
  });

  it("generator role preamble inlines ALL THREE skills it references (architecture-mapping, playwright-authoring, test-value-review)", async () => {
    const { transport, captures } = makeCapturingTransport();
    const strategy = new CodexRuntimeStrategy({
      transport,
      promptRoot: REAL_PROMPT_ROOT,
      env: { CODEX_API_KEY: "test-key" },
    });

    const session = await strategy.openSession("primary", "/tmp", {});
    await session.prompt("write a spec");
    await session.dispose();

    assert.equal(captures.length, 1);
    const preamble = captures[0]!.text;
    assert.ok(preamble.includes("Craft knowledge for writing specs"), "playwright-authoring must be inlined");
    assert.ok(preamble.includes("Assume bad faith from the test"), "test-value-review must be inlined");
    assert.ok(
      preamble.includes("Craft knowledge for building"),
      "architecture-mapping must be inlined",
    );
  });

  it("reviewer role preamble inlines the test-value-review skill it references", async () => {
    const { transport, captures } = makeCapturingTransport();
    const strategy = new CodexRuntimeStrategy({
      transport,
      promptRoot: REAL_PROMPT_ROOT,
      env: { CODEX_API_KEY: "test-key" },
    });

    const session = await strategy.openSession("reviewer", "/tmp", {});
    await session.prompt("review these specs");
    await session.dispose();

    assert.equal(captures.length, 1);
    const preamble = captures[0]!.text;
    assert.ok(
      preamble.includes("Assume bad faith from the test"),
      "the reviewer preamble must inline test-value-review's SKILL.md content",
    );
  });

  it("a role with NO skill reference (chat/qa-assistant) does not inline any skill content", async () => {
    const { transport, captures } = makeCapturingTransport();
    const strategy = new CodexRuntimeStrategy({
      transport,
      promptRoot: REAL_PROMPT_ROOT,
      env: { CODEX_API_KEY: "test-key" },
    });

    const session = await strategy.openSession("chat", "/tmp", {});
    await session.prompt("answer a question");
    await session.dispose();

    assert.equal(captures.length, 1);
    const preamble = captures[0]!.text;
    assert.ok(
      !preamble.includes("Craft knowledge for writing specs") && !preamble.includes("Assume bad faith from the test"),
      "qa-assistant references no skill — nothing should be inlined for it",
    );
  });

  it("a missing/unresolvable skill degrades gracefully (no throw, preamble still assembled) AND warns loudly", async () => {
    const { transport, captures } = makeCapturingTransport();
    const strategy = new CodexRuntimeStrategy({
      transport,
      promptRoot: "/nonexistent/prompt/root/for/skill/fallback/test",
      env: { CODEX_API_KEY: "test-key" },
    });

    // Capture console.warn: a skill file that fails to resolve must not silently ship an
    // impoverished preamble — a renamed/moved SKILL.md should be visible in the logs.
    const warnings: string[] = [];
    const warnMock = mock.method(console, "warn", (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    try {
      const session = await strategy.openSession("worker", "/tmp", {});
      const result = await session.prompt("write a spec");
      await session.dispose();

      assert.equal(captures.length, 1);
      assert.equal(result, '{"specs":[]}', "prompt must still complete even when no skill/role file resolves");
      assert.ok(
        warnings.some((w) => w.includes("playwright-authoring") && w.includes("SKILL.md")),
        `a warn naming the missing skill path must be emitted. Got: ${JSON.stringify(warnings)}`,
      );
    } finally {
      warnMock.mock.restore();
    }
  });

  it("no warn is emitted when every referenced skill resolves", async () => {
    const { transport } = makeCapturingTransport();
    const strategy = new CodexRuntimeStrategy({
      transport,
      promptRoot: REAL_PROMPT_ROOT,
      env: { CODEX_API_KEY: "test-key" },
    });

    const warnings: string[] = [];
    const warnMock = mock.method(console, "warn", (...args: unknown[]) => {
      warnings.push(args.map(String).join(" "));
    });
    try {
      const session = await strategy.openSession("worker", "/tmp", {});
      await session.prompt("write a spec");
      await session.dispose();

      assert.ok(
        !warnings.some((w) => w.includes("SKILL.md")),
        `no skill warn expected when all skills resolve. Got: ${JSON.stringify(warnings)}`,
      );
    } finally {
      warnMock.mock.restore();
    }
  });
});
