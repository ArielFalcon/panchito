import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveSandbox, buildCodexExecArgs, ensureCodexConfig } from "./agent-supervisor.mjs";

// Importing agent-supervisor.mjs must NOT start the HTTP server (it is main-guarded). If it did, the
// listening socket would keep this process alive and node:test would hang instead of exiting — so
// reaching these assertions and finishing cleanly is itself the proof that the import is side-effect-free.

test("resolveSandbox: read-only roles stay read-only; an absent sandbox defaults to workspace-write", () => {
  assert.equal(resolveSandbox("read-only"), "read-only");
  assert.equal(resolveSandbox("workspace-write"), "workspace-write");
  assert.equal(resolveSandbox(undefined), "workspace-write"); // older orchestrator that omits it
});

test("resolveSandbox rejects an unknown value (no `--sandbox` flag-injection)", () => {
  assert.throws(() => resolveSandbox("danger-full-access"), /sandbox must be/);
  assert.throws(() => resolveSandbox("--privileged"), /sandbox must be/);
});

test("buildCodexExecArgs applies the per-role sandbox so the reviewer cannot write the workspace", () => {
  const reviewer = buildCodexExecArgs({ cwd: "/repo", sandbox: "read-only" });
  const i = reviewer.indexOf("--sandbox");
  assert.ok(i >= 0 && reviewer[i + 1] === "read-only", "reviewer must run --sandbox read-only");

  const dflt = buildCodexExecArgs({ cwd: "/repo" });
  const j = dflt.indexOf("--sandbox");
  assert.equal(dflt[j + 1], "workspace-write", "an absent sandbox defaults to workspace-write");

  const withModel = buildCodexExecArgs({ cwd: "/repo", model: "gpt-5.4", sandbox: "workspace-write" });
  assert.ok(withModel.includes("--model") && withModel.includes("gpt-5.4"));
});

test("buildCodexExecArgs throws on an invalid sandbox (surfaced as a 400, never spawned)", () => {
  assert.throws(() => buildCodexExecArgs({ cwd: "/repo", sandbox: "nope" }), /sandbox must be/);
});

// ─── T-P0-2: ensureCodexConfig() — supervisor writes 3-field config.toml at boot ───
// AC0.1.1: produces TOML containing [mcp_servers.serena], [mcp_servers.engram],
//          [mcp_servers.playwright] with command/args/env matching opencode.json defs.
//          The engram block MUST contain env.ENGRAM_DATA_DIR = resolved value,
//          NOT the literal {env:ENGRAM_DATA_DIR} placeholder.
// AC0.1.2: second call is byte-identical (idempotent) and throws nothing.
test("ensureCodexConfig: produces TOML with the three expected MCP server blocks", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-test-"));
  const env = { ENGRAM_DATA_DIR: "/data" };
  ensureCodexConfig(codexHome, env);

  const content = readFileSync(join(codexHome, "config.toml"), "utf8");

  // serena block
  assert.ok(content.includes("[mcp_servers.serena]"), "must have [mcp_servers.serena]");
  assert.ok(content.includes('command = "serena"'), "serena command must be 'serena'");
  assert.ok(
    content.includes('"start-mcp-server"') && content.includes('"--transport"') &&
    content.includes('"stdio"') && content.includes('"--context"') && content.includes('"ide-assistant"'),
    "serena args must match opencode.json definition"
  );

  // engram block
  assert.ok(content.includes("[mcp_servers.engram]"), "must have [mcp_servers.engram]");
  assert.ok(content.includes('command = "engram"'), "engram command must be 'engram'");
  assert.ok(
    content.includes('"mcp"') && content.includes('"--tools=agent"'),
    "engram args must include mcp --tools=agent"
  );
  // CRITICAL: env must be RESOLVED value "/data", NOT the literal placeholder
  assert.ok(
    content.includes('ENGRAM_DATA_DIR = "/data"'),
    `engram env.ENGRAM_DATA_DIR must be the resolved value "/data", not the placeholder. Got:\n${content}`
  );
  assert.ok(
    !content.includes("{env:ENGRAM_DATA_DIR}"),
    "config.toml must NOT contain the literal {env:ENGRAM_DATA_DIR} placeholder"
  );

  // playwright block
  assert.ok(content.includes("[mcp_servers.playwright]"), "must have [mcp_servers.playwright]");
  assert.ok(content.includes('command = "npx"'), "playwright command must be 'npx'");
  assert.ok(
    content.includes('"@playwright/mcp"') && content.includes('"--browser"') &&
    content.includes('"chromium"') && content.includes('"--headless"'),
    "playwright args must match opencode.json definition"
  );
});

test("ensureCodexConfig: second call is byte-identical (idempotent) and throws nothing (AC0.1.2)", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-idempotent-"));
  const env = { ENGRAM_DATA_DIR: "/data" };

  ensureCodexConfig(codexHome, env);
  const first = readFileSync(join(codexHome, "config.toml"), "utf8");

  // second call must not throw
  assert.doesNotThrow(() => ensureCodexConfig(codexHome, env));
  const second = readFileSync(join(codexHome, "config.toml"), "utf8");

  assert.equal(first, second, "second call must produce byte-identical content (idempotent)");
});

test("ensureCodexConfig: preserves existing auth content in the file (AC0.1.2 — survives codex-data volume)", () => {
  const codexHome = mkdtempSync(join(tmpdir(), "codex-auth-"));
  const env = { ENGRAM_DATA_DIR: "/data" };

  // Pre-seed auth content that should survive a re-run
  const configPath = join(codexHome, "config.toml");
  writeFileSync(configPath, '[auth]\napi_key = "sk-test-value"\n\n', "utf8");

  // First call must not clobber auth
  ensureCodexConfig(codexHome, env);
  const after = readFileSync(configPath, "utf8");
  assert.ok(
    after.includes('[auth]') && after.includes('api_key = "sk-test-value"'),
    "ensureCodexConfig must preserve existing auth content"
  );
  assert.ok(after.includes("[mcp_servers.serena]"), "must still have mcp_servers after merge");
});

// T-P0-3: sandbox regression guard — read-only roles resolve to read-only, generator to workspace-write.
// AC0.1.3 RELAXED: the per-role MCP exclusion is satisfied by the per-role sandbox boundary,
// NOT by a per-role MCP config. This test pins the contract so it can never silently regress.
test("T-P0-3: reviewer/reflector roles resolve --sandbox read-only; generator gets workspace-write (AC0.1.3)", () => {
  // Read-only roles: reviewer, reflector
  const reviewer = buildCodexExecArgs({ cwd: "/repo", sandbox: "read-only" });
  const ri = reviewer.indexOf("--sandbox");
  assert.ok(ri >= 0, "--sandbox flag must be present for reviewer");
  assert.equal(reviewer[ri + 1], "read-only", "reviewer must run --sandbox read-only");

  // Generator role: workspace-write (write-capable sandbox)
  const generator = buildCodexExecArgs({ cwd: "/repo", sandbox: "workspace-write" });
  const gi = generator.indexOf("--sandbox");
  assert.ok(gi >= 0, "--sandbox flag must be present for generator");
  assert.equal(generator[gi + 1], "workspace-write", "generator must run --sandbox workspace-write (write-capable)");

  // Default (no sandbox specified) resolves to workspace-write — backward compat
  const defaultArgs = buildCodexExecArgs({ cwd: "/repo" });
  const di = defaultArgs.indexOf("--sandbox");
  assert.equal(defaultArgs[di + 1], "workspace-write", "default (no sandbox) must resolve to workspace-write");
});
