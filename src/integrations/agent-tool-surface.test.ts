// Tripwire (post-ADR-001, Phase 3.2): lock the agent's capability surface so that
// WIDENING it requires a conscious update here. The ADR-001 evaluation rejected exposing
// the orchestrator as an MCP server, but kept its best idea: "the agent only reads +
// proposes". The two dangerous ways that erodes silently are (a) adding an MCP server
// that can execute the authoritative test suite or reach the orchestrator's write path,
// and (b) flipping a read-only judge/assistant to writable. Both should force a pause.
// If you trip this test, you are changing the security posture — update the allowlist
// deliberately, and confirm the new capability cannot write a watched repo or trigger
// the authoritative Filter-C run (which is the orchestrator's job, never the agent's).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROLE_TO_OPENCODE_AGENT } from "../agent-runtime/opencode-strategy";
import { capabilitiesForRole } from "../agent-runtime/types";
import type { AgentRole } from "../agent-runtime/types";

// The ONLY MCP servers the agents may reach. None of these runs the orchestrator's
// authoritative test execution or carries a git-write capability:
//   serena     — read-only code navigation
//   playwright — LIVE DEV *exploration* while authoring (NOT the authoritative suite run)
//   engram     — persistent memory
const MCP_ALLOWLIST = new Set(["serena", "engram", "playwright"]);

function loadAgentConfig(): { agents: Record<string, unknown>; mcpServers: string[] } {
  const raw = JSON.parse(readFileSync(join(process.cwd(), "agents", "opencode.json"), "utf8")) as Record<string, unknown>;
  const agent = (raw.agent && typeof raw.agent === "object" ? raw.agent : {}) as Record<string, unknown>;
  const mcp = (raw.mcp && typeof raw.mcp === "object" ? raw.mcp : {}) as Record<string, unknown>;
  return { agents: agent, mcpServers: Object.keys(mcp) };
}

function agentMcp(agent: unknown): string[] {
  if (!agent || typeof agent !== "object") return [];
  const mcp = (agent as Record<string, unknown>).mcp;
  return Array.isArray(mcp) ? mcp.filter((m): m is string => typeof m === "string") : [];
}

function agentTools(agent: unknown): Record<string, unknown> {
  if (!agent || typeof agent !== "object") return {};
  const tools = (agent as Record<string, unknown>).tools;
  return tools && typeof tools === "object" ? (tools as Record<string, unknown>) : {};
}

test("every declared MCP server is on the agent allowlist (catches a new tool surface)", () => {
  const { mcpServers } = loadAgentConfig();
  // Meaningfulness guard: there is a real, non-empty MCP block to check.
  assert.ok(mcpServers.length > 0, "expected opencode.json to declare MCP servers");
  for (const server of mcpServers) {
    assert.ok(
      MCP_ALLOWLIST.has(server),
      `SECURITY: opencode.json declares an MCP server "${server}" not on the agent allowlist {${[...MCP_ALLOWLIST].join(", ")}}. ` +
        `Adding an MCP server widens the agent's capability surface — confirm it cannot write a watched repo or run the authoritative suite, then add it here on purpose.`,
    );
  }
});

test("no agent is granted an MCP server outside the allowlist", () => {
  const { agents } = loadAgentConfig();
  const names = Object.keys(agents);
  assert.ok(names.length > 0, "expected opencode.json to declare agents");
  for (const name of names) {
    for (const server of agentMcp(agents[name])) {
      assert.ok(
        MCP_ALLOWLIST.has(server),
        `SECURITY: agent "${name}" is granted MCP server "${server}" outside the allowlist {${[...MCP_ALLOWLIST].join(", ")}}.`,
      );
    }
  }
});

test("the reviewer is a non-mutating judge (independence + read-only)", () => {
  const { agents } = loadAgentConfig();
  const reviewer = agents["qa-reviewer"];
  assert.ok(reviewer, "expected a qa-reviewer agent");
  const tools = agentTools(reviewer);
  // Meaningfulness guard: an absent `tools` block would make every read-only check below
  // pass vacuously (and may inherit permissive defaults). Require it to be explicit.
  assert.ok(Object.keys(tools).length > 0, "qa-reviewer must declare an explicit tools block");
  // The reviewer must never write/edit/bash: it judges the artifact and emits a verdict.
  // A writable reviewer could "fix" what it is judging, destroying the independence that
  // makes its verdict trustworthy.
  assert.notEqual(tools.write, true, "qa-reviewer must not have write");
  assert.notEqual(tools.edit, true, "qa-reviewer must not have edit");
  assert.notEqual(tools.bash, true, "qa-reviewer must not have bash");
});

test("the run-Q&A assistant has no fs/shell tools and only memory (engram) MCP", () => {
  const { agents } = loadAgentConfig();
  const assistant = agents["qa-assistant"];
  assert.ok(assistant, "expected a qa-assistant agent");
  const tools = agentTools(assistant);
  // Meaningfulness guard: an absent `tools` block would make the checks below vacuous.
  assert.ok(Object.keys(tools).length > 0, "qa-assistant must declare an explicit tools block");
  // The TUI chat assistant answers from provided run context only — it must not touch
  // the filesystem, shell, or the watched repo in any way.
  for (const cap of ["write", "edit", "bash", "read"]) {
    assert.notEqual(tools[cap], true, `qa-assistant must not have ${cap}`);
  }
  // engram (memory) is the ONLY MCP the assistant may hold; granting it a filesystem or
  // browser MCP would reintroduce exactly the access the tool flags above deny.
  const extraneous = agentMcp(assistant).filter((m) => m !== "engram");
  assert.deepEqual(extraneous, [], `qa-assistant may only use the engram MCP; found also: ${extraneous.join(", ")}`);
});

test("the reflector is tool-less: no fs/shell tools and NO MCP (a pure failure→rule transform)", () => {
  const { agents } = loadAgentConfig();
  const reflector = agents["qa-reflector"];
  assert.ok(reflector, "expected a qa-reflector agent");
  const tools = agentTools(reflector);
  assert.ok(Object.keys(tools).length > 0, "qa-reflector must declare an explicit tools block");
  for (const cap of ["write", "edit", "bash", "read"]) {
    assert.notEqual(tools[cap], true, `qa-reflector must not have ${cap}`);
  }
  // Unlike the chat assistant, the reflector holds NO MCP at all — not even engram. Reflection is a
  // pure transform of the provided failure context into a rule; any recall/memory access would make
  // it non-deterministic and let it touch state beyond the prompt.
  assert.deepEqual(agentMcp(reflector), [], "qa-reflector must hold no MCP servers");
});

test("read-only roles in the capability policy map to non-writable OpenCode agents (no drift)", () => {
  // Ties the provider-agnostic policy (capabilitiesForRole) to its OpenCode enforcement
  // (opencode.json tools{}). Without this they could silently diverge: a role declared read-only in
  // the policy could still map to a write-capable agent, re-opening exactly the gap this work closed.
  // The mutating caps (write/edit/bash) are the security-relevant ones for a read-only judge/reflector.
  const { agents } = loadAgentConfig();
  let checkedReadOnly = 0;
  for (const [role, agentName] of Object.entries(ROLE_TO_OPENCODE_AGENT)) {
    if (capabilitiesForRole(role as AgentRole).canWrite) continue;
    checkedReadOnly++;
    const agent = agents[agentName];
    assert.ok(agent, `read-only role "${role}" maps to OpenCode agent "${agentName}" not declared in opencode.json`);
    const tools = agentTools(agent);
    for (const cap of ["write", "edit", "bash"]) {
      assert.notEqual(
        tools[cap],
        true,
        `SECURITY: role "${role}" is read-only in capabilitiesForRole, but its OpenCode agent "${agentName}" grants ${cap}.`,
      );
    }
  }
  // Meaningfulness guard: the loop actually exercised the read-only roles (reviewer, chat, reflector).
  assert.ok(checkedReadOnly >= 3, `expected ≥3 read-only roles checked against opencode.json, got ${checkedReadOnly}`);
});
