#!/usr/bin/env node
// T-P1-0 — [REAL-BOUNDARY] capture real `codex exec --json` JSONL → commit as fixture.
//
// PURPOSE: Run ONCE in the built `agents` image (which has @openai/codex@0.139.0).
// Captures the actual stdout JSONL from a minimal `codex exec --json` turn and saves
// it to src/agent-runtime/__fixtures__/codex-exec-json.jsonl for use in:
//   - T-P1-4: mapCodexExecEvent real-shape validation
//   - T-P2-1: extractCodexLastMessage real-shape tests
//   - T-P3-3: onUsage decision (are token fields present?)
//
// USAGE (inside the built agents container):
//   CODEX_API_KEY=<key> node agents/smoke/capture-codex-jsonl.smoke.mjs
//
// OUTPUT: writes src/agent-runtime/__fixtures__/codex-exec-json.jsonl
//         then prints a summary of what event types and fields it found.
//
// GUARD: exits 0 with SKIPPED if CODEX_API_KEY absent or codex binary not found.
//
// DO NOT add this to `npm test` — it requires the real binary and network.

import { execFileSync, spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(__dirname, "..", "..");
const FIXTURE_DIR = join(REPO_ROOT, "src", "agent-runtime", "__fixtures__");
const FIXTURE_PATH = join(FIXTURE_DIR, "codex-exec-json.jsonl");

const CODEX_BIN = process.env.CODEX_BIN ?? "codex";
const CODEX_API_KEY = process.env.CODEX_API_KEY;

// Guard: no key → skip
if (!CODEX_API_KEY) {
  console.log("[T-P1-0] SKIPPED: CODEX_API_KEY not set. Run in the built agents image.");
  process.exit(0);
}

// Guard: no binary → skip
const probe = spawnSync(CODEX_BIN, ["--version"], { encoding: "utf8" });
if (probe.error || probe.status !== 0) {
  console.log(`[T-P1-0] SKIPPED: codex binary not found (${CODEX_BIN}). Run in the built agents image.`);
  process.exit(0);
}

console.log(`[T-P1-0] codex binary: ${CODEX_BIN} ${probe.stdout?.trim()}`);
console.log("[T-P1-0] Capturing real codex exec --json JSONL...");

// Minimal prompt: asks for a simple response + one tool use (list directory).
const CAPTURE_PROMPT = `List the files in the current directory using the available tools, then respond with "CAPTURE_COMPLETE".`;

// Use a temp directory as cwd so the agent has a clean workspace.
const CWD = process.env.TMPDIR ?? "/tmp";

let rawJsonl = "";
try {
  // Run `codex exec --json --cd /tmp --skip-git-repo-check --sandbox read-only -` with prompt via stdin.
  const result = spawnSync(
    CODEX_BIN,
    ["exec", "--json", "--cd", CWD, "--skip-git-repo-check", "--sandbox", "read-only", "--color", "never", "-"],
    {
      input: CAPTURE_PROMPT,
      encoding: "utf8",
      env: { ...process.env, CODEX_API_KEY },
      timeout: 60_000,
    },
  );
  rawJsonl = result.stdout ?? "";
  if (result.status !== 0) {
    console.error(`[T-P1-0] codex exec exited ${result.status}: ${result.stderr?.trim()}`);
    process.exit(1);
  }
} catch (err) {
  console.error(`[T-P1-0] Failed to run codex exec: ${err}`);
  process.exit(1);
}

if (!rawJsonl.trim()) {
  console.error("[T-P1-0] No JSONL output captured. Check the codex binary and API key.");
  process.exit(1);
}

// Save fixture.
mkdirSync(FIXTURE_DIR, { recursive: true });
writeFileSync(FIXTURE_PATH, rawJsonl, "utf8");
console.log(`[T-P1-0] Fixture saved: ${FIXTURE_PATH}`);

// Analyze what event types and fields are present in the captured JSONL.
const lines = rawJsonl.split(/\r?\n/).filter(Boolean);
const types = new Map();
const fields = new Set();

for (const line of lines) {
  try {
    const event = JSON.parse(line);
    const type = String(event.type ?? "(no type)");
    types.set(type, (types.get(type) ?? 0) + 1);
    for (const key of Object.keys(event)) fields.add(key);
  } catch {
    // non-JSON line
    types.set("(non-json)", (types.get("(non-json)") ?? 0) + 1);
  }
}

console.log(`\n[T-P1-0] Captured ${lines.length} lines.`);
console.log("[T-P1-0] Event types:");
for (const [type, count] of types) {
  console.log(`  ${type}: ${count}`);
}
console.log("[T-P1-0] Top-level fields seen:", [...fields].sort().join(", "));

// Check for usage/token fields — informs T-P3-3 decision.
const usageFields = [...fields].filter((f) => /usage|token|cost|prompt|completion/.test(f.toLowerCase()));
if (usageFields.length > 0) {
  console.log("[T-P1-0] USAGE FIELDS FOUND:", usageFields.join(", "), "→ T-P3-3: wire real onUsage");
} else {
  console.log("[T-P1-0] No usage/token fields found → T-P3-3: document null / usageComplete honestly");
}

console.log("\n[T-P1-0] DONE. Commit the fixture and update mapCodexExecEvent + extractCodexLastMessage tests.");
