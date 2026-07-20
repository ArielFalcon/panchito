// Behavioral tests for CodebaseMemoryClient — the shared spawn+parse primitive for the
// codebase-memory-mcp CLI, layered over SandboxedBinaryRunner exactly like runbinary.ts
// (see runbinary.test.ts for the sibling pattern), but reimplemented independently at the
// shared-infrastructure layer per design ADR-3 (a shared-infrastructure file cannot import
// from a context, so this client does NOT reuse runbinary.ts — it reproduces the same
// scrubEnv + {code:null} degrade contract on its own).
//
// The runner is constructor-injected (default = the real SandboxedBinaryRunnerAdapter), so
// every test here passes a FAKE runner and never spawns a real process — these are pure
// unit tests of the client's parse/degrade mapping, not integration tests of the binary.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { SandboxedBinaryRunner, SandboxedRunRequest, SandboxedRunResult } from "../../../../../src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import { CodebaseMemoryClient } from "../../../../../src/shared-infrastructure/code-graph/codebase-memory-client.ts";

// A minimal fake implementing SandboxedBinaryRunner's run() — the client is constructor-injected
// with this instead of the real SandboxedBinaryRunnerAdapter, so no process is ever spawned here.
class FakeRunner implements SandboxedBinaryRunner {
  public lastRequest: SandboxedRunRequest | null = null;
  constructor(private readonly result: () => Promise<SandboxedRunResult>) {}
  async run(req: SandboxedRunRequest): Promise<SandboxedRunResult> {
    this.lastRequest = req;
    return this.result();
  }
}

const fixturePath = fileURLToPath(new URL("./__fixtures__/codebase-memory-complexity.json", import.meta.url));

test("cli() resolves parsed-shaped stdout on a successful spawn", async () => {
  const runner = new FakeRunner(async () => ({
    exitCode: 0,
    stdout: '{"nodes":[]}',
    stderr: "",
    timedOut: false,
  }));
  const client = new CodebaseMemoryClient(runner);
  const result = await client.cli("query_graph", '{"query":"MATCH (n) RETURN n"}', "/repo");
  assert.deepEqual(result, { code: 0, stdout: '{"nodes":[]}', stderr: "" });
});

test("cli() degrades to {code:null} (never rejects) when the runner rejects with a spawn error", async () => {
  const runner = new FakeRunner(async () => {
    throw new Error("spawn codebase-memory-mcp ENOENT");
  });
  const client = new CodebaseMemoryClient(runner);
  const result = await client.cli("query_graph", "{}", "/repo");
  assert.equal(result.code, null);
  assert.equal(result.stdout, "");
  assert.ok(result.stderr.length > 0, "stderr must carry the spawn-error message, never empty");
  assert.match(result.stderr, /ENOENT/);
});

test("cli() degrades to {code:null} (never rejects) on a timeout", async () => {
  const runner = new FakeRunner(async () => ({
    exitCode: null,
    stdout: "",
    stderr: "",
    timedOut: true,
  }));
  const client = new CodebaseMemoryClient(runner);
  const result = await client.cli("query_graph", "{}", "/repo", 5_000);
  assert.equal(result.code, null);
  assert.ok(result.stderr.length > 0, "stderr must be non-empty on timeout, never a silent blank degrade");
});

test("cli() applies scrubEnv to the spawn env — an unscrubbed secret never reaches the runner request", async () => {
  const runner = new FakeRunner(async () => ({
    exitCode: 0,
    stdout: "{}",
    stderr: "",
    timedOut: false,
  }));
  const previous = process.env.GITHUB_TOKEN;
  process.env.GITHUB_TOKEN = "super-secret-should-be-dropped";
  try {
    const client = new CodebaseMemoryClient(runner);
    await client.cli("query_graph", "{}", "/repo");
    assert.ok(runner.lastRequest, "the fake runner must have been invoked");
    assert.equal(runner.lastRequest?.env.GITHUB_TOKEN, undefined, "scrubEnv must drop GITHUB_TOKEN before it reaches the runner");
  } finally {
    if (previous === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = previous;
  }
});

// migration-tier-4b Slice 1 (gate DEFECT-2 fix, tier-4a regression check): scrubEnv's base allowlist
// narrowed to the legacy set (no CBM_CACHE_DIR). This client must keep injecting it via extraExact
// for its OWN spawn — a tier-4a consumer regression here would silently break codebase-memory's
// docker-volume-mounted graph-store persistence.
test("cli() still forwards CBM_CACHE_DIR to the spawn env after the scrubEnv narrow-base change (tier-4a regression check)", async () => {
  const runner = new FakeRunner(async () => ({
    exitCode: 0,
    stdout: "{}",
    stderr: "",
    timedOut: false,
  }));
  const previous = process.env.CBM_CACHE_DIR;
  process.env.CBM_CACHE_DIR = "/app/.codebase-memory";
  try {
    const client = new CodebaseMemoryClient(runner);
    await client.cli("query_graph", "{}", "/repo");
    assert.equal(runner.lastRequest?.env.CBM_CACHE_DIR, "/app/.codebase-memory", "CBM_CACHE_DIR must still reach the spawn env");
  } finally {
    if (previous === undefined) delete process.env.CBM_CACHE_DIR;
    else process.env.CBM_CACHE_DIR = previous;
  }
});

test("cli() passes command=codebase-memory-mcp, args=[cli, tool, jsonArg], and the given cwd/timeout through to the runner", async () => {
  const runner = new FakeRunner(async () => ({
    exitCode: 0,
    stdout: "{}",
    stderr: "",
    timedOut: false,
  }));
  const client = new CodebaseMemoryClient(runner);
  await client.cli("search_graph", '{"query":"x"}', "/some/repo", 12_345);
  assert.equal(runner.lastRequest?.command, "codebase-memory-mcp");
  assert.deepEqual(runner.lastRequest?.args, ["cli", "search_graph", '{"query":"x"}']);
  assert.equal(runner.lastRequest?.cwd, "/some/repo");
  assert.equal(runner.lastRequest?.timeoutMs, 12_345);
});

test("the captured codebase-memory-complexity.json fixture parses and matches the client's expected raw-stdout shape", () => {
  const raw = readFileSync(fixturePath, "utf8");
  const parsed = JSON.parse(raw) as { columns: string[]; rows: string[][]; total: number };
  assert.ok(Array.isArray(parsed.columns) && parsed.columns.length > 0, "fixture must carry a columns array");
  assert.ok(Array.isArray(parsed.rows) && parsed.rows.length > 0, "fixture must carry at least one row");
  assert.ok(parsed.total >= parsed.rows.length);
  // The client is tool-agnostic: it hands back raw stdout for the caller (2b's adapter) to parse.
  // Re-stringifying the fixture and feeding it through the client's success path must round-trip
  // exactly, proving the client does not mutate or reinterpret the JSON body.
  const runner = new FakeRunner(async () => ({ exitCode: 0, stdout: raw, stderr: "", timedOut: false }));
  return new CodebaseMemoryClient(runner).cli("query_graph", "{}", "/repo").then((result) => {
    assert.equal(result.code, 0);
    assert.deepEqual(JSON.parse(result.stdout), parsed);
  });
});
