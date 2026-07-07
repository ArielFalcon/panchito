#!/usr/bin/env node
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { existsSync, readdirSync, rmSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const PROVIDERS = ["opencode", "codex"];
// OpenCode runs as a long-lived `opencode serve`. Codex is exec-per-prompt: the
// orchestrator reaches it over this supervisor's HTTP boundary (POST /codex/exec)
// instead of spawning the (nonexistent) `codex` binary in the orchestrator image.
const PROCESS_PROVIDERS = new Set(["opencode"]);
const PORT = Number(process.env.AGENT_SUPERVISOR_PORT || 4097);
const CODEX_BIN = process.env.CODEX_BIN || "codex";
const RUNTIME_ENV_KEYS = new Set([
  "AGENT_RUNTIME_MODE",
  "AGENT_SINGLE_PROVIDER",
  "AGENT_PRIMARY_PROVIDER",
  "AGENT_REVIEWER_PROVIDER",
  "AGENT_CHAT_PROVIDER",
  "AGENT_PRIMARY_MODEL",
  "AGENT_REVIEWER_MODEL",
  "AGENT_CHAT_MODEL",
]);

// Mirrors src/agent-runtime/codex-strategy.ts codexExecEnv: never hand the agent
// the orchestrator's secrets (GITHUB_TOKEN, WEBHOOK_SECRET, QA_API_TOKEN, …).
const CODEX_EXEC_ENV_EXACT = new Set([
  "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "TMPDIR", "TEMPDIR", "TMP", "TEMP",
  "CI", "NO_COLOR", "FORCE_COLOR", "DEBUG", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY",
  "https_proxy", "http_proxy", "no_proxy", "CODEX_API_KEY", "OPENAI_API_KEY", "CODEX_HOME", "CODEX_BIN",
]);
const CODEX_EXEC_ENV_PREFIX = /^(?:DEV_|AGENT_)/;
const MAX_PROMPT_BYTES = 2 * 1024 * 1024;

// When codex has a stored login (auth.json — e.g. a ChatGPT subscription created by `codex login`),
// do NOT forward the env API keys to the child: codex prefers an env API key over the stored login,
// which silently bypasses the subscription (and can hit a quota-exhausted key). Let the stored auth win.
function codexHasStoredAuth(env = process.env) {
  const home = env.CODEX_HOME || `${env.HOME || "/root"}/.codex`;
  return existsSync(`${home}/auth.json`);
}

function codexExecEnv(env = process.env) {
  const storedAuth = codexHasStoredAuth(env);
  const out = {};
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (storedAuth && (key === "CODEX_API_KEY" || key === "OPENAI_API_KEY")) continue;
    if (CODEX_EXEC_ENV_EXACT.has(key) || CODEX_EXEC_ENV_PREFIX.test(key)) out[key] = value;
  }
  return out;
}

// The codex/opencode CLIs can echo a key in an auth-failure message; never return
// it raw. Masks our configured key values verbatim plus common token shapes.
function redactForResponse(msg) {
  if (typeof msg !== "string") return msg;
  let out = msg;
  for (const name of ["CODEX_API_KEY", "OPENAI_API_KEY", "OPENCODE_API_KEY"]) {
    const value = process.env[name];
    if (value && value.length >= 6 && out.includes(value)) out = out.split(value).join("[REDACTED_CREDENTIAL]");
  }
  return out.replace(/\b(?:sk-[A-Za-z0-9_-]{10,}|gh[pousr]_[A-Za-z0-9_]{10,}|github_pat_[A-Za-z0-9_]{10,})\b/g, "[REDACTED_CREDENTIAL]");
}

const children = new Map();
const state = new Map(PROVIDERS.map((provider) => [provider, {
  provider,
  status: "stopped",
  configured: hasKey(provider),
}]));

function hasKey(provider) {
  return provider === "opencode" ? Boolean(process.env.OPENCODE_API_KEY) : Boolean(process.env.CODEX_API_KEY);
}

function selectedProviders() {
  const mode = process.env.AGENT_RUNTIME_MODE === "dual" ? "dual" : "single";
  if (mode === "dual") return PROVIDERS;
  const single = process.env.AGENT_SINGLE_PROVIDER === "codex"
    ? "codex"
    : process.env.AGENT_SINGLE_PROVIDER === "opencode"
      ? "opencode"
      : process.env.OPENCODE_API_KEY
        ? "opencode"
        : process.env.CODEX_API_KEY
          ? "codex"
          : "opencode";
  return [single];
}

function commandFor(provider) {
  // Only OpenCode is a managed long-lived process.
  if (provider === "opencode") {
    return {
      cmd: "opencode",
      args: ["serve", "--hostname", process.env.OPENCODE_SERVE_HOSTNAME || "0.0.0.0", "--port", "4096"],
      env: { ...process.env },
    };
  }
  return undefined;
}

function setState(provider, patch) {
  state.set(provider, { ...state.get(provider), provider, configured: hasKey(provider), ...patch });
}

function startProvider(provider) {
  if (!PROCESS_PROVIDERS.has(provider)) {
    probeExecProvider(provider);
    return;
  }
  if (children.has(provider)) return;
  if (!hasKey(provider)) {
    setState(provider, { status: "needs_config", error: undefined });
    return;
  }
  const spec = commandFor(provider);
  setState(provider, { status: "starting", error: undefined });
  const child = spawn(spec.cmd, spec.args, {
    stdio: ["ignore", "inherit", "inherit"],
    env: spec.env,
  });
  children.set(provider, child);
  const readyTimer = setTimeout(() => {
    if (children.get(provider) === child) setState(provider, { status: "healthy" });
  }, 2500);

  child.on("exit", (code, signal) => {
    clearTimeout(readyTimer);
    if (children.get(provider) === child) children.delete(provider);
    const desired = selectedProviders().includes(provider);
    setState(provider, {
      status: desired && hasKey(provider) ? "failed" : "stopped",
      error: desired && hasKey(provider) ? `${provider} exited ${signal ?? code ?? "unknown"}` : undefined,
    });
    if (desired && hasKey(provider) && !shuttingDown) {
      setTimeout(() => startProvider(provider), 2000);
    }
  });
}

// Codex has no long-lived process: health is "is the key present and the CLI
// resolvable", so a healthy report means a /codex/exec request can actually run.
function probeExecProvider(provider) {
  if (!hasKey(provider)) {
    setState(provider, { status: "needs_config", error: undefined });
    return;
  }
  setState(provider, { status: "starting", error: undefined });
  let settled = false;
  const finish = (patch) => { if (!settled) { settled = true; setState(provider, patch); } };
  try {
    const probe = spawn(CODEX_BIN, ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
    const timer = setTimeout(() => { probe.kill("SIGKILL"); finish({ status: "failed", error: "codex --version timed out" }); }, 4000);
    probe.on("error", (err) => { clearTimeout(timer); finish({ status: "failed", error: `codex CLI not available: ${err.message}` }); });
    probe.on("exit", (code) => {
      clearTimeout(timer);
      finish(code === 0 ? { status: "healthy", error: undefined } : { status: "failed", error: `codex --version exited ${code}` });
    });
  } catch (err) {
    finish({ status: "failed", error: err instanceof Error ? err.message : String(err) });
  }
}

function stopProvider(provider) {
  if (!PROCESS_PROVIDERS.has(provider)) {
    setState(provider, { status: hasKey(provider) ? "stopped" : "needs_config", error: undefined });
    return Promise.resolve();
  }
  const child = children.get(provider);
  if (!child) {
    setState(provider, { status: hasKey(provider) ? "stopped" : "needs_config", error: undefined });
    return Promise.resolve();
  }
  setState(provider, { status: "stopped", error: undefined });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolve();
    }, 5000);
    child.once("exit", () => {
      clearTimeout(timer);
      children.delete(provider);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

async function ensureDesired() {
  const desired = new Set(selectedProviders());
  for (const provider of PROVIDERS) {
    if (desired.has(provider)) startProvider(provider);
    else await stopProvider(provider);
  }
}

// One-shot at boot: wipe the OpenCode session DB so it never accumulates across the long-lived
// container (it grows run-after-run — ~49 MB observed — and a stale/locked row once produced a
// transient FK-constraint error). Auth is via OPENCODE_API_KEY (env), NOT the DB, so a wipe only
// drops resumable session history, which the orchestrator never relies on. MUST run BEFORE the first
// `opencode serve` spawn (an open DB cannot be cleanly replaced); it lives in the boot path only —
// never in startProvider (crash-restart, :128) or /restart, which would nuke a mid-life DB. The
// module-level flag makes it idempotent even if the boot path is ever reordered. Best-effort: a
// missing dir or a locked file degrades to a warning, never a crash.
let opencodeDbWiped = false;
function wipeOpencodeDbOnce() {
  if (opencodeDbWiped) return;
  opencodeDbWiped = true;
  const home = process.env.HOME || "/root";
  const dir = join(process.env.XDG_DATA_HOME || join(home, ".local", "share"), "opencode");
  try {
    if (!existsSync(dir)) return;
    let wiped = 0;
    for (const name of readdirSync(dir)) {
      // opencode.db plus its SQLite sidecars (-wal, -shm, -journal).
      if (name === "opencode.db" || name.startsWith("opencode.db-")) {
        try { rmSync(join(dir, name), { force: true }); wiped++; } catch { /* best-effort per file */ }
      }
    }
    if (wiped > 0) console.log(`[agent-supervisor] wiped ${wiped} OpenCode session DB file(s) in ${dir} (auth is via OPENCODE_API_KEY, not the DB)`);
  } catch (err) {
    console.warn(`[agent-supervisor] could not wipe OpenCode session DB: ${err instanceof Error ? err.message : String(err)}`);
  }
}

function applyRuntimeEnv(env) {
  if (!env || typeof env !== "object") return;
  for (const [key, value] of Object.entries(env)) {
    if (RUNTIME_ENV_KEYS.has(key) && typeof value === "string" && !/[\r\n]/.test(value)) {
      process.env[key] = value;
    }
  }
}

async function restartProvider(provider, apiKey, runtimeEnv) {
  if (!PROVIDERS.includes(provider)) throw new Error("provider must be opencode or codex");
  applyRuntimeEnv(runtimeEnv);
  if (apiKey) {
    if (provider === "opencode") process.env.OPENCODE_API_KEY = apiKey;
    else process.env.CODEX_API_KEY = apiKey;
  }
  await stopProvider(provider);
  await ensureDesired();
  return state.get(provider);
}

const ALLOWED_SANDBOXES = new Set(["read-only", "workspace-write"]);

// Validate the per-role sandbox the orchestrator sends: read-only roles (the reviewer judge, the
// reflector) must run read-only. Default to workspace-write when absent (an older orchestrator that
// omits it keeps today's behavior). Throw on an unknown value so it can never become a `--sandbox`
// flag-injection. Exported (with buildCodexExecArgs) so this security-relevant logic is unit-tested
// without booting the HTTP server.
export function resolveSandbox(sandbox) {
  if (sandbox === undefined) return "workspace-write";
  if (!ALLOWED_SANDBOXES.has(sandbox)) {
    throw new Error("sandbox must be 'read-only' or 'workspace-write'");
  }
  return sandbox;
}

// Build the `codex exec` argv for one turn. Throws (via resolveSandbox) on an invalid sandbox.
//
// SANDBOX POLICY inside the agents container. The container is the real security boundary:
// unprivileged (no added caps, not privileged, no host access) with a secret-scrubbed env
// (codexExecEnv). Codex's own OS-sandbox (landlock/seccomp via a user namespace) CANNOT initialise
// in this unprivileged container — every write/command fails with "the sandbox helper could not
// create a namespace". So for WRITE roles we bypass codex's redundant sandbox; codex documents this
// flag as "intended solely for running in environments that are externally sandboxed", which this
// container is. Defence-in-depth is preserved: only the orchestrator performs git writes, and it
// reverts any out-of-`e2e/` change. READ-ONLY roles keep `--sandbox read-only` — the judge never writes.
export function buildCodexExecArgs({ cwd, model, sandbox }) {
  const mode = resolveSandbox(sandbox);
  const sandboxArgs = mode === "workspace-write"
    ? ["--dangerously-bypass-approvals-and-sandbox"]
    : ["--sandbox", "read-only"];
  return [
    "exec", "--json", "--cd", cwd, "--skip-git-repo-check",
    ...sandboxArgs, "--color", "never",
    ...(model ? ["--model", model] : []),
    "-",
  ];
}

// Runs one `codex exec` turn in the agent container and resolves with Codex's
// final assistant message. This is the execution half of the orchestrator's
// CodexRuntimeStrategy → SupervisorExecTransport HTTP boundary.
function runCodexExec({ cwd, prompt, model, timeoutMs, sandbox }) {
  return new Promise((resolve, reject) => {
    if (!process.env.CODEX_API_KEY) return reject(new Error("CODEX_API_KEY is not configured"));
    if (typeof cwd !== "string" || !cwd.startsWith("/") || !existsSync(cwd)) return reject(new Error("cwd must be an existing absolute path"));
    if (typeof prompt !== "string" || !prompt.trim()) return reject(new Error("prompt is required"));
    if (Buffer.byteLength(prompt, "utf8") > MAX_PROMPT_BYTES) return reject(new Error("prompt too large"));
    if (model !== undefined && (typeof model !== "string" || model.startsWith("-"))) {
      return reject(new Error("model must be a string that does not start with '-'"));
    }
    // The per-role sandbox (read-only roles cannot write the workspace) is validated + defaulted in
    // buildCodexExecArgs; an invalid value throws, which we surface as a 400 rather than a spawn.
    let args;
    try {
      args = buildCodexExecArgs({ cwd, model, sandbox });
    } catch (err) {
      return reject(err);
    }
    const child = spawn(CODEX_BIN, args, {
      cwd,
      env: codexExecEnv(process.env),
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const limitMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined;
    const timer = limitMs ? setTimeout(() => {
      child.kill("SIGTERM");
      reject(new Error(`codex exec timed out after ${limitMs}ms`));
    }, limitMs) : undefined;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (err) => { if (timer) clearTimeout(timer); reject(err); });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (code === 0) resolve(extractCodexLastMessage(stdout) || stdout.trim());
      else reject(new Error(`codex exec exited ${code}: ${stderr.trim() || stdout.trim()}`));
    });
    child.stdin.end(prompt);
  });
}

function extractCodexLastMessage(jsonl) {
  let last = "";
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      // codex exec --json (0.139.0) emits the assistant turn as
      // {"type":"item.completed","item":{"type":"agent_message","text":"..."}}.
      // Keep the older flat shapes as fallbacks for forward/backward compatibility.
      const message =
        (event.type === "item.completed" && event.item?.type === "agent_message" ? event.item.text : undefined) ??
        event.msg ?? event.message ?? event.text ?? event.content;
      if (typeof message === "string" && message.trim()) last = message;
    } catch {
      // codex exec --json is JSONL; tolerate stray non-JSON lines without dropping a completed turn.
    }
  }
  return last;
}

function json(res, status, body) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) body += chunk;
  return body.trim() ? JSON.parse(body) : {};
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url || "/", "http://localhost");
  if (req.method === "GET" && url.pathname === "/health") {
    json(res, 200, { ok: true, providers: Object.fromEntries(state) });
    return;
  }
  if (req.method === "GET" && url.pathname === "/providers") {
    json(res, 200, { providers: Object.fromEntries(state), desired: selectedProviders() });
    return;
  }
  if (req.method === "POST" && url.pathname === "/restart") {
    try {
      const body = await readJson(req);
      const provider = String(body.provider || "");
      json(res, 200, { health: await restartProvider(provider, typeof body.apiKey === "string" ? body.apiKey : undefined, body.env) });
    } catch (err) {
      json(res, 400, { error: redactForResponse(err instanceof Error ? err.message : String(err)) });
    }
    return;
  }
  if (req.method === "POST" && url.pathname === "/codex/exec") {
    try {
      const body = await readJson(req);
      const message = await runCodexExec(body);
      json(res, 200, { message });
    } catch (err) {
      json(res, 400, { error: redactForResponse(err instanceof Error ? err.message : String(err)) });
    }
    return;
  }
  json(res, 404, { error: "not found" });
});

let shuttingDown = false;
async function shutdown() {
  shuttingDown = true;
  await Promise.all(PROVIDERS.map((provider) => stopProvider(provider)));
  server.close(() => process.exit(0));
}

// ──────────────────────────────────────────────────────────────────────────────────────
// ensureCodexConfig — supervisor writes $CODEX_HOME/config.toml at boot (T-P0-2 / C0.1)
// ──────────────────────────────────────────────────────────────────────────────────────
// Generates a Codex config.toml with [mcp_servers.*] blocks matching the top-level "mcp"
// server registry in opencode.json (referenced by key, not line — the file's agent section
// grew substantially in WS8 and line pointers went stale).
// Translation rules (design D2):
//   - opencode `command` array → TOML `command` = head, `args` = tail
//   - opencode `environment` object → TOML `env` table, with `{env:X}` placeholders
//     RESOLVED from process.env at config-gen time (supervisor side, NOT the agent)
//
// CRITICAL: ENGRAM_DATA_DIR is NOT in CODEX_EXEC_ENV_EXACT and does NOT match the
// /^(?:DEV_|AGENT_)/ prefix, so `codex exec` children do NOT inherit it from the
// supervisor env. Without an explicit `env` in config.toml, engram boots pointing at
// the wrong data dir (memory silently broken). This function fixes that gap.
//
// Idempotent: if config.toml already exists, existing content (e.g. [auth] from the
// codex-data volume) is preserved; only the [mcp_servers.*] sections are replaced/added.
//
// PATH A (design D2): supervisor generates config.toml; agent never writes it.
// FALLBACK (if T-P0-1 smoke proves config.toml MCPs are not loaded by codex 0.139):
//   wire MCP supervisor-side in runCodexExec (agent-supervisor.mjs ~268, already owns
//   the spawn) or add an explicit MCP flag in buildCodexExecArgs. Re-scope T-P0-2/3 to
//   the fallback shape and record the decision in apply-progress.
//
// @param {string} codexHome - path to $CODEX_HOME (e.g. /root/.codex)
// @param {Record<string,string|undefined>} [env] - environment to resolve {env:X} from
export function ensureCodexConfig(codexHome, env = process.env) {
  // Resolve an {env:X} placeholder from the supplied env map.
  function resolveEnvPlaceholder(value) {
    const match = /^\{env:([^}]+)\}$/.exec(value);
    if (!match) return value;
    return env[match[1]] ?? "";
  }

  // MCP server definitions (mirroring the top-level "mcp" server registry in opencode.json).
  // Each entry: { command: string[], environment?: Record<string,string> }
  const MCP_SERVERS = [
    {
      name: "serena",
      command: ["serena", "start-mcp-server", "--transport", "stdio", "--context", "ide-assistant"],
    },
    {
      name: "engram",
      command: ["engram", "mcp", "--tools=agent"],
      environment: { ENGRAM_DATA_DIR: "{env:ENGRAM_DATA_DIR}" },
    },
    {
      name: "playwright",
      command: ["npx", "@playwright/mcp", "--browser", "chromium", "--headless"],
    },
  ];

  // Build a TOML string for an array of strings (inline).
  function tomlStringArray(arr) {
    return "[" + arr.map((s) => JSON.stringify(s)).join(", ") + "]";
  }

  // Build the [mcp_servers.*] TOML sections.
  let mcpToml = "";
  for (const server of MCP_SERVERS) {
    const [cmd, ...args] = server.command;
    mcpToml += `[mcp_servers.${server.name}]\n`;
    mcpToml += `command = ${JSON.stringify(cmd)}\n`;
    mcpToml += `args = ${tomlStringArray(args)}\n`;
    if (server.environment) {
      // Inline TOML table for env: { KEY = "resolved_value", ... }
      const resolvedPairs = Object.entries(server.environment)
        .map(([k, v]) => `${k} = ${JSON.stringify(resolveEnvPlaceholder(v))}`)
        .join(", ");
      mcpToml += `env = { ${resolvedPairs} }\n`;
    }
    mcpToml += "\n";
  }

  const configPath = join(codexHome, "config.toml");

  // Ensure the directory exists (codex-data volume may not have pre-created it).
  mkdirSync(codexHome, { recursive: true });

  if (existsSync(configPath)) {
    // Preserve any non-mcp_servers content (e.g. [auth] from the codex-data volume).
    // Strip all existing [mcp_servers.*] sections from the file and append fresh ones.
    //
    // Strategy: split the file into "blocks" by top-level section headers (lines that
    // start with "[" but are NOT continuation lines of a value). Each block starts at a
    // section header line. Skip any block whose header starts with [mcp_servers.
    const existing = readFileSync(configPath, "utf8");
    const lines = existing.split(/\r?\n/);
    const blocks = []; // [{header: string|null, body: string[]}]
    let current = { header: null, body: [] };
    for (const line of lines) {
      // A top-level section header: starts with '[' at column 0, not '[[' (TOML array).
      if (/^\[[^\[]/.test(line)) {
        blocks.push(current);
        current = { header: line, body: [] };
      } else {
        current.body.push(line);
      }
    }
    blocks.push(current);

    // Keep only non-mcp_servers blocks (discard any [mcp_servers.*] block).
    const kept = blocks.filter(
      (b) => b.header === null || !b.header.startsWith("[mcp_servers.")
    );

    // Reconstruct retained content.
    const retained = kept.map((b) => {
      const parts = b.header !== null ? [b.header, ...b.body] : b.body;
      return parts.join("\n");
    }).join("\n").trimEnd();

    const mcpBlock = mcpToml.trimEnd() + "\n";
    const merged = (retained ? retained + "\n\n" : "") + mcpBlock;
    // Idempotent: only write if content differs.
    if (merged !== existing) {
      writeFileSync(configPath, merged, "utf8");
    }
  } else {
    writeFileSync(configPath, mcpToml.trimEnd() + "\n", "utf8");
  }
}

// Bootstrap only when run as the entrypoint (`node agent-supervisor.mjs`), NOT when imported by a
// test. Importing the module must be side-effect-free so the exported pure helpers can be unit-tested
// without binding the port or registering signal handlers.
const isMainModule = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  // Generate the Codex config.toml BEFORE ensureDesired so MCP servers are available
  // from the first codex exec turn. CODEX_HOME defaults to /root/.codex.
  const codexHome = process.env.CODEX_HOME || join(process.env.HOME || "/root", ".codex");
  ensureCodexConfig(codexHome, process.env);
  console.log(`[agent-supervisor] codex config.toml written to ${codexHome}/config.toml`);

  // Clean the session DB ONCE, synchronously, before any `opencode serve` spawns (ensureDesired).
  wipeOpencodeDbOnce();
  process.on("SIGTERM", () => void shutdown());
  process.on("SIGINT", () => void shutdown());

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`[agent-supervisor] listening on :${PORT}`);
    void ensureDesired();
  });
}
