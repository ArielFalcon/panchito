// Tripwire (post-ADR-001, Phase 3.2; re-grounded WS8.1): lock the agent's capability surface so
// that WIDENING it requires a conscious update here. The ADR-001 evaluation rejected exposing the
// orchestrator as an MCP server, but kept its best idea: "the agent only reads + proposes". The two
// dangerous ways that erodes silently are (a) adding an MCP server that can execute the
// authoritative test suite or reach the orchestrator's write path, and (b) flipping a read-only
// judge/assistant/reflector to writable or MCP-capable. Both should force a pause.
//
// WS8.1 correction: the PREVIOUS version of this test asserted against a per-agent `mcp: string[]`
// array and a `steps` field. Neither exists in the OpenCode 1.17.7 SDK's `AgentConfig` — verified
// against `node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`, which declares `tools?:
// {[key:string]: boolean}`, `maxSteps?: number`, `permission?`, `mode?`, and NO `mcp` key. The old
// test was certifying a security posture the runtime never enforced (the fictional fields were
// silently ignored by OpenCode). This version:
//   (a) pins the config against the SDK's real `AgentConfig` type at compile time (below);
//   (b) asserts the fiction is gone (no per-agent `mcp` arrays, no `steps` keys);
//   (c) asserts the REAL denial mechanism — `tools.<key>: false` — covers every MCP toolset for
//       read-only/tool-less roles.
//
// Empirical grounding (done in-slice, not assumed): started a real `opencode serve` (v1.17.13,
// closest available to the pinned 1.17.7) against an isolated probe config and used
// `opencode debug agent <name>` to inspect the RESOLVED agent. Confirmed a controlled A/B: an agent
// with `"engram*": false` in `tools` resolves to a `{ permission: "engram*", action: "deny",
// pattern: "*" }` rule; an otherwise-identical agent without that key has no such rule. So the
// `tools` map's keys are NOT restricted to the built-in tool names — arbitrary string keys
// (including glob-shaped ones like `engram*`) compile into real permission-deny rules. Separately,
// probing the real MCP servers directly (raw JSON-RPC `tools/list` against `engram mcp
// --tools=agent`, and against `npx @playwright/mcp`) showed NEITHER server's tools are prefixed
// with its own server name: engram exposes `mem_save`, `mem_search`, etc.; Playwright MCP exposes
// `browser_navigate`, `browser_click`, etc. Serena's tool names are documented in this repo's own
// prompts (`agents/AGENTS.md`, `agents/agent/*.md`) as `find_symbol`, `get_symbols_overview`,
// `find_referencing_symbols`, `activate_project`, etc. — same unprefixed convention. Whether
// OpenCode internally re-namespaces MCP tool IDs with the server name before matching against
// `tools`/`permission` could not be settled fully offline (no MCP-tool listing surfaced through the
// static `/experimental/tool` or `debug agent` resolution — only a live model turn would show it,
// which this probe deliberately avoided). Per the plan's explicit fallback instruction, this config
// uses BELT-AND-BRACES: both the wildcard key (`"engram*": false`, verified to compile) AND the
// enumerated real per-tool names (`mem_save: false`, `browser_navigate: false`, `find_symbol:
// false`, etc.) — harmless if one form turns out redundant, safe if only one form is honored.
//
// If you trip this test, you are changing the security posture — update the allowlist
// deliberately, and confirm the new capability cannot write a watched repo or trigger the
// authoritative Filter-C run (which is the orchestrator's job, never the agent's).

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentConfig } from "@opencode-ai/sdk";
import { ROLE_TO_OPENCODE_AGENT } from "../agent-runtime/opencode-strategy";
import { capabilitiesForRole } from "../agent-runtime/types";
import type { AgentRole } from "../agent-runtime/types";

// The ONLY MCP servers the agents may reach. None of these runs the orchestrator's
// authoritative test execution or carries a git-write capability:
//   serena     — read-only code navigation
//   playwright — LIVE DEV *exploration* while authoring (NOT the authoritative suite run)
//   engram     — persistent memory
const MCP_ALLOWLIST = new Set(["serena", "engram", "playwright"]);

// Real, unprefixed MCP tool names per server (empirically confirmed for engram/playwright via raw
// JSON-RPC `tools/list`; sourced from this repo's own Serena prompt references for serena — see the
// header comment). These are the enumeration half of the belt-and-braces denial.
const ENGRAM_TOOL_NAMES = [
  "mem_save",
  "mem_search",
  "mem_context",
  "mem_session_summary",
  "mem_get_observation",
  "mem_save_prompt",
  "mem_current_project",
  "mem_update",
  "mem_review",
  "mem_pin",
  "mem_unpin",
  "mem_suggest_topic_key",
  "mem_session_start",
  "mem_session_end",
  "mem_capture_passive",
  "mem_compare",
  "mem_judge",
  "mem_doctor",
];

const PLAYWRIGHT_TOOL_NAMES = [
  "browser_close",
  "browser_resize",
  "browser_console_messages",
  "browser_handle_dialog",
  "browser_evaluate",
  "browser_file_upload",
  "browser_drop",
  "browser_fill_form",
  "browser_press_key",
  "browser_type",
  "browser_navigate",
  "browser_navigate_back",
  "browser_network_requests",
  "browser_network_request",
  "browser_run_code_unsafe",
  "browser_take_screenshot",
  "browser_snapshot",
  "browser_click",
  "browser_drag",
  "browser_hover",
  "browser_select_option",
  "browser_tabs",
  "browser_wait_for",
];

// Grounding honesty for this list: Serena could NOT be probed offline (not installed on this host;
// it lives only in the agents Docker image). Only the first four names — activate_project,
// find_symbol, find_referencing_symbols, get_symbols_overview — are grounded in this repo's own
// prompt files (agents/AGENTS.md, agents/agent/qa-explorer.md, qa-proposer.md, qa-generator.md).
// The remaining names are best-effort from upstream Serena documentation and were NOT verified
// against the pinned server. The wildcard "serena*" key (empirically verified to compile into a
// permission-deny rule — see the header comment) is the actual load-bearing denial; this
// enumeration is the harmless redundant half of the belt-and-braces.
const SERENA_TOOL_NAMES = [
  "activate_project",
  "find_symbol",
  "find_referencing_symbols",
  "get_symbols_overview",
  "search_for_pattern",
  "list_dir",
  "find_file",
  "read_memory",
  "write_memory",
  "list_memories",
  "delete_memory",
  "insert_after_symbol",
  "insert_before_symbol",
  "replace_symbol_body",
  "execute_shell_command",
  "restart_language_server",
  "check_onboarding_performed",
  "onboarding",
  "think_about_collected_information",
  "think_about_task_adherence",
  "think_about_whether_you_are_done",
  "prepare_for_new_conversation",
  "switch_modes",
];

const MCP_TOOL_NAMES_BY_SERVER: Record<string, string[]> = {
  serena: SERENA_TOOL_NAMES,
  engram: ENGRAM_TOOL_NAMES,
  playwright: PLAYWRIGHT_TOOL_NAMES,
};

const BUILTIN_TOOL_KEYS = new Set([
  "write",
  "edit",
  "read",
  "bash",
  "webfetch",
  "glob",
  "grep",
  "task",
  "todowrite",
  "websearch",
  "skill",
  "question",
  "invalid",
  "apply_patch",
]);

function loadRawConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(process.cwd(), "agents", "opencode.json"), "utf8")) as Record<string, unknown>;
}

function loadAgentConfig(): { agents: Record<string, unknown>; mcpServers: string[] } {
  const raw = loadRawConfig();
  const agent = (raw.agent && typeof raw.agent === "object" ? raw.agent : {}) as Record<string, unknown>;
  const mcp = (raw.mcp && typeof raw.mcp === "object" ? raw.mcp : {}) as Record<string, unknown>;
  return { agents: agent, mcpServers: Object.keys(mcp) };
}

function agentTools(agent: unknown): Record<string, unknown> {
  if (!agent || typeof agent !== "object") return {};
  const tools = (agent as Record<string, unknown>).tools;
  return tools && typeof tools === "object" ? (tools as Record<string, unknown>) : {};
}

// Type-level tripwire (WS8.1c): every declared agent must structurally satisfy the SDK's REAL
// AgentConfig type. This forces a compile error the moment someone re-introduces a field the SDK
// does not recognize as a KNOWN key with the wrong shape (e.g. `mode: "invalid-value"`), or a wrong
// type for a known key (e.g. `maxSteps: "50"` as a string). Note `AgentConfig` carries a permissive
// index signature (`[key: string]: unknown | ...`), so this does NOT catch unknown extra keys by
// itself — that is what the runtime-shape assertions below are for.
function assertAgentConfigShape(agents: Record<string, unknown>): void {
  for (const [name, cfg] of Object.entries(agents)) {
    const typed: AgentConfig = cfg as AgentConfig;
    // Touch a couple of known fields so this is a real assignment-compatibility check, not a
    // no-op cast that the compiler could elide.
    void typed.model;
    void typed.mode;
    void typed.maxSteps;
    void typed.tools;
    if (!typed) throw new Error(`unreachable: ${name}`);
  }
}

test("every agent in opencode.json structurally satisfies the SDK's AgentConfig type", () => {
  const { agents } = loadAgentConfig();
  assert.ok(Object.keys(agents).length > 0, "expected opencode.json to declare agents");
  assertAgentConfigShape(agents);
});

test("the fiction is gone: no per-agent `mcp` array and no `steps` field remain", () => {
  const { agents } = loadAgentConfig();
  for (const [name, agent] of Object.entries(agents)) {
    const cfg = agent as Record<string, unknown>;
    assert.equal(
      "mcp" in cfg,
      false,
      `SECURITY: agent "${name}" still declares a per-agent "mcp" array. This key is not part of the ` +
        `OpenCode 1.17.7 AgentConfig and is silently ignored by the runtime — it is inert and must not ` +
        `be reintroduced as a stand-in for real tool denial.`,
    );
    assert.equal(
      "steps" in cfg,
      false,
      `agent "${name}" still declares a "steps" field. The SDK field is "maxSteps" — "steps" is not ` +
        `read by OpenCode 1.17.7 and is inert.`,
    );
  }
});

test("no dead top-level compaction/tool_output keys remain in opencode.json", () => {
  const raw = loadRawConfig();
  assert.equal("compaction" in raw, false, "top-level 'compaction' is not part of AgentConfig/opencode.json's real schema and was inert");
  assert.equal("tool_output" in raw, false, "top-level 'tool_output' is not part of AgentConfig/opencode.json's real schema and was inert");
});

test("every agent declares maxSteps (the real step-cap field)", () => {
  const { agents } = loadAgentConfig();
  for (const [name, agent] of Object.entries(agents)) {
    const cfg = agent as Record<string, unknown>;
    assert.equal(typeof cfg.maxSteps, "number", `agent "${name}" must declare a numeric "maxSteps"`);
  }
});

test("no agent's tools map denies with a bare global wildcard (would kill built-ins)", () => {
  const { agents } = loadAgentConfig();
  for (const [name, agent] of Object.entries(agents)) {
    const tools = agentTools(agent);
    assert.equal(
      Object.prototype.hasOwnProperty.call(tools, "*"),
      false,
      `SECURITY: agent "${name}" has a bare "*" key in tools{} — this would deny/allow every tool ` +
        `indiscriminately, including built-in read/write/edit, which is never the intent here.`,
    );
  }
});

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

// Belt-and-braces denial check (WS8.1): for a role that must NOT reach a given MCP server, both the
// wildcard key (`"<server>*": false`) AND every enumerated real tool name for that server must be
// explicitly denied (`false`) in the agent's `tools` map. This is deliberately redundant — whichever
// mechanism OpenCode actually honors at runtime, the deny is present.
function assertMcpServerDenied(agentName: string, tools: Record<string, unknown>, server: string): void {
  const wildcardKey = `${server}*`;
  assert.equal(
    tools[wildcardKey],
    false,
    `SECURITY: agent "${agentName}" must deny the "${wildcardKey}" wildcard tool key for the "${server}" MCP server.`,
  );
  const names = MCP_TOOL_NAMES_BY_SERVER[server] ?? [];
  assert.ok(names.length > 0, `no known real tool-name enumeration for MCP server "${server}" — test setup bug`);
  for (const toolName of names) {
    assert.equal(
      tools[toolName],
      false,
      `SECURITY: agent "${agentName}" must explicitly deny "${toolName}" (a real "${server}" MCP tool) — ` +
        `relying on the wildcard alone is not verifiable offline against the pinned OpenCode version.`,
    );
  }
}

function assertMcpServerAllowed(agentName: string, tools: Record<string, unknown>, server: string): void {
  const wildcardKey = `${server}*`;
  assert.notEqual(
    tools[wildcardKey],
    false,
    `agent "${agentName}" is designed to use the "${server}" MCP server but its tools{} denies "${wildcardKey}".`,
  );
  const names = MCP_TOOL_NAMES_BY_SERVER[server] ?? [];
  for (const toolName of names) {
    assert.notEqual(
      tools[toolName],
      false,
      `agent "${agentName}" is designed to use the "${server}" MCP server but denies its real tool "${toolName}".`,
    );
  }
}

test("the reviewer is a non-mutating judge with NO MCP access (independence + read-only, runtime-enforced)", () => {
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
  // WS8.1: independence must be runtime-enforced, not prompt etiquette — deny every MCP toolset.
  for (const server of MCP_ALLOWLIST) assertMcpServerDenied("qa-reviewer", tools, server);
});

test("the run-Q&A assistant is tool-less: no fs/shell tools and NO MCP at all", () => {
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
  // The assistant holds NO MCP — not even engram. Its own prompt (agents/agent/qa-assistant.md:
  // "You have no tools — do not read files, run commands, or call any MCP") and the orchestrator's
  // chat context builder (src/server/chat.ts buildRunChatContext: "You have NO tools") both declare
  // it tool-less; the run outcomes / learning rules / curriculum it answers about are injected
  // deterministically as TEXT by chat.ts, so it never needs mem_search. An engram grant would
  // contradict the prompt contract and widen the surface for no functional reason.
  for (const server of MCP_ALLOWLIST) assertMcpServerDenied("qa-assistant", tools, server);
});

test("the reflector is tool-less: no fs/shell tools and NO MCP at all (a pure failure->rule transform)", () => {
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
  for (const server of MCP_ALLOWLIST) assertMcpServerDenied("qa-reflector", tools, server);
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
  // Meaningfulness guard: the loop actually exercised the read-only roles (reviewer, chat, reflector,
  // explorer, proposer).
  assert.ok(checkedReadOnly >= 5, `expected >=5 read-only roles checked against opencode.json, got ${checkedReadOnly}`);
});

test("qa-explorer and qa-proposer keep serena (and engram for explorer) but deny playwright", () => {
  // These two are read-only (no write/edit/bash) but ARE designed to hold serena — and engram for
  // the explorer — per the design intent; only playwright (browser driving) is out of scope for
  // both, since neither navigates a live app.
  const { agents } = loadAgentConfig();
  const explorer = agents["qa-explorer"];
  const proposer = agents["qa-proposer"];
  assert.ok(explorer, "expected a qa-explorer agent");
  assert.ok(proposer, "expected a qa-proposer agent");

  const explorerTools = agentTools(explorer);
  assertMcpServerAllowed("qa-explorer", explorerTools, "serena");
  assertMcpServerAllowed("qa-explorer", explorerTools, "engram");
  assertMcpServerDenied("qa-explorer", explorerTools, "playwright");

  const proposerTools = agentTools(proposer);
  assertMcpServerAllowed("qa-proposer", proposerTools, "serena");
  assertMcpServerDenied("qa-proposer", proposerTools, "engram");
  assertMcpServerDenied("qa-proposer", proposerTools, "playwright");
});

test("qa-generator keeps full MCP access (serena+engram+playwright) as the test author", () => {
  const { agents } = loadAgentConfig();
  const generator = agents["qa-generator"];
  assert.ok(generator, "expected a qa-generator agent");
  const tools = agentTools(generator);
  assert.equal(tools.write, true, "qa-generator must have write");
  assert.equal(tools.edit, true, "qa-generator must have edit");
  assert.equal(tools.bash, true, "qa-generator must have bash");
  for (const server of MCP_ALLOWLIST) assertMcpServerAllowed("qa-generator", tools, server);
});

test("qa-maintainer keeps serena+engram but denies playwright (never drives a browser)", () => {
  const { agents } = loadAgentConfig();
  const maintainer = agents["qa-maintainer"];
  assert.ok(maintainer, "expected a qa-maintainer agent");
  const tools = agentTools(maintainer);
  assert.equal(tools.write, true, "qa-maintainer must have write");
  assertMcpServerAllowed("qa-maintainer", tools, "serena");
  assertMcpServerAllowed("qa-maintainer", tools, "engram");
  assertMcpServerDenied("qa-maintainer", tools, "playwright");
});

test("qa-worker and qa-worker-code keep serena only (engram and playwright denied)", () => {
  const { agents } = loadAgentConfig();
  for (const name of ["qa-worker", "qa-worker-code"]) {
    const worker = agents[name];
    assert.ok(worker, `expected a ${name} agent`);
    const tools = agentTools(worker);
    assertMcpServerAllowed(name, tools, "serena");
    assertMcpServerDenied(name, tools, "engram");
    assertMcpServerDenied(name, tools, "playwright");
  }
});

test("qa-reviewer's mode matches how it is actually invoked (direct prompt, not subagent delegation)", () => {
  // WS8.2: qa-reviewer is invoked directly by the orchestrator's ReviewPortAdapter (see the
  // qa-engine review-port bridge) — no other opencode agent delegates to it, so the old
  // "subagent" label mischaracterized the invocation path. The SDK's AgentConfig documents the
  // mode union ("subagent" | "primary" | "all") without describing any semantic difference
  // between "primary" and "all"; "all" was chosen as the least-restrictive option for a
  // directly-prompted agent. If OpenCode ever documents a real distinction, revisit this choice —
  // the load-bearing claim here is only "not subagent".
  const { agents } = loadAgentConfig();
  const reviewer = agents["qa-reviewer"] as Record<string, unknown>;
  assert.ok(reviewer, "expected a qa-reviewer agent");
  assert.equal(reviewer.mode, "all", 'qa-reviewer must declare mode "all" (direct invocation, not subagent delegation)');
});

test("known built-in tool keys are recognized (sanity check for the BUILTIN_TOOL_KEYS fixture)", () => {
  // Guards against silently drifting the fixture out of sync with reality: every built-in boolean
  // actually used across the agents in opencode.json must be one we know about.
  const { agents } = loadAgentConfig();
  const allMcpToolNames = new Set(Object.values(MCP_TOOL_NAMES_BY_SERVER).flat());
  for (const [name, agent] of Object.entries(agents)) {
    const tools = agentTools(agent);
    for (const key of Object.keys(tools)) {
      const isWildcard = key.endsWith("*");
      const isKnownMcpTool = allMcpToolNames.has(key);
      const isBuiltin = BUILTIN_TOOL_KEYS.has(key);
      assert.ok(
        isWildcard || isKnownMcpTool || isBuiltin,
        `agent "${name}" declares tools key "${key}" that is neither a known built-in, a known MCP ` +
          `tool name, nor a wildcard — likely a typo or an undocumented capability.`,
      );
    }
  }
});
