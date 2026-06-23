// Model-window catalog for per-role byte budget enforcement (Phase 2 / Slice F).
//
// This module resolves the per-role byte budget the ContextAssembler enforces on
// every boundary prompt. The budget is expressed in BYTES using the documented
// approximation: 1 token ≈ 4 bytes (≈ 4 chars in typical English/code content).
// No real tokenizer is used — the `opencode-go/*` models are opaque and no
// per-model tokenizer is available at this layer.
//
// The catalog maps ROLE names to model context windows (in tokens). The role →
// model mapping is read at runtime from `agents/opencode.json` so `src/` does
// not hard-code model identities (those live in `agents/`). When the JSON is
// unavailable or the role is absent, the DEFAULT_WINDOW_TOKENS fallback is used —
// a conservative value that is safe for any current model in the roster.
//
// ⚠ PROVISIONAL VALUES — must be confirmed against `opencode models` once
// Phase-0 telemetry is available. The numbers below are conservative: they are
// well below advertised context windows so a mis-identification can never cause a
// hard context-overflow inside the agent's own tool calls.
//
// Compaction coordination note (Phase 2 / Slice F):
//   The budget here bounds only the ORCHESTRATOR-ASSEMBLED INPUT PROMPT. It cannot
//   bound the agent's accumulated tool-call outputs mid-turn; that is the runtime
//   domain. `agents/opencode.json` keeps `compaction.auto: true` so the OpenCode
//   runtime compacts accumulated tool outputs before they hit the model's hard
//   context limit. The `preserve_recent_tokens` / `tail_turns` values in that file
//   are tuned conservatively so the ground-truth content pushed in the VOLATILE band
//   (positioned near the task, per Phase-1 canonical order) remains within the
//   preserved-recent window at write time. These values are provisional pending
//   Phase-0 window-pressure telemetry; raise them only after confirming observed
//   turn sizes via `agent_turns`.
//
// Session policy note (Phase 2 / Slice F):
//   The REVIEWER always runs in its own independent session (independence invariant
//   — it must judge the generator's output without access to the generator's
//   reasoning). Generator session-reuse across its own regeneration passes is a
//   MEASURED option: validate via `cacheRead` trends in `agent_turns` before
//   enabling it as a default. It is NOT a default change in this slice.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// The bytes-per-token approximation applied uniformly across all models.
// Rationale: opencode-go/* model tokenizers are opaque; 4 bytes/token is a
// reasonable approximation for mixed English/code content (roughly 3-5 bytes per
// token in practice). Using 4 is conservative enough to stay under real limits
// while still providing meaningful budget guidance.
export const BYTES_PER_TOKEN = 4;

// Safety margin: the orchestrator-assembled input prompt is budgeted to this
// fraction of the model's full context window. The remainder is reserved for:
//   - The agent's own system prompt (injected by OpenCode from agents/opencode.json)
//   - Tool definitions and tool call overhead
//   - The agent's output tokens (model response)
//   - Headroom for mis-estimated byte→token conversion
// 0.75 is conservative: it leaves 25% of the window for the above overhead,
// which is ample for typical tool/system-prompt sizes while keeping the input
// prompt in a safe range.
export const INPUT_PROMPT_SAFETY_MARGIN = 0.75;

// Per-model context-window catalog in TOKENS.
// ⚠ PROVISIONAL — confirm with `opencode models` once Phase-0 telemetry lands.
//
// Conservative methodology: all values are set significantly below the advertised
// maximums to account for uncertainty in model identification and tokenizer
// differences. Current roster (from agents/opencode.json):
//   kimi-k2.7-code    → ga-generator, qa-maintainer (primary writer)
//   minimax-m3        → qa-reviewer (independent judge)
//   deepseek-v4-flash → qa-assistant, qa-reflector, qa-worker, qa-worker-code, qa-explorer
//
// These opencode-go/* prefixed names are gateway-specific. Advertised context
// windows for the underlying models vary widely (32K–128K+), but we use 64K
// as a safe conservative starting point for all, to be refined per-model as
// Phase-0 data accumulates. kimi-k2.7-code is a large-context coder model;
// deepseek-v4-flash and minimax-m3 are smaller/faster. All can safely handle
// 64K input tokens with the 0.75 margin.
const MODEL_WINDOW_TOKENS: Record<string, number> = {
  // Generator / maintainer model: kimi-k2.7-code.
  // Likely supports 128K+ but we use 64K conservatively until telemetry confirms.
  "kimi-k2.7-code": 64_000,
  // Reviewer model: minimax-m3.
  // Reviewer prompts are typically smaller (spec contents + DOM slice), so 32K
  // is used as a conservative starting value. Raise after Phase-0 data.
  "minimax-m3": 32_000,
  // Worker / flash tier models: deepseek-v4-flash.
  // Workers receive per-objective prompts (smaller scope), 32K is safe.
  "deepseek-v4-flash": 32_000,
  // Codex models (T-P2-4): gpt-5.4 and gpt-5.4-mini.
  // GPT-5 series supports 128K+ context (conservative entry; raise after telemetry confirms).
  // Without entries these fall to the 32K default, silently truncating context on large runs.
  // ⚠ PROVISIONAL — confirm the exact window via `openai models` or OpenAI docs once available.
  "gpt-5.4": 128_000,
  "gpt-5.4-mini": 128_000,
};

// Fallback window in tokens when the role or model is not in the catalog.
// 32K is conservative enough for any model in the current roster.
// ⚠ PROVISIONAL — should not be lower than the smallest known model window.
export const DEFAULT_WINDOW_TOKENS = 32_000;

// Compute the effective budget in BYTES for an assembled input prompt destined
// for the given model (identified by the short model name from agents/opencode.json,
// without the "opencode-go/" prefix). Returns:
//   floor(windowTokens × SAFETY_MARGIN × BYTES_PER_TOKEN)
// If the model is not in the catalog, uses DEFAULT_WINDOW_TOKENS.
export function modelWindowBytes(modelName: string): number {
  const tokens = MODEL_WINDOW_TOKENS[modelName] ?? DEFAULT_WINDOW_TOKENS;
  return Math.floor(tokens * INPUT_PROMPT_SAFETY_MARGIN * BYTES_PER_TOKEN);
}

// Normalize an `opencode-go/model-name` reference to the bare model name used
// as catalog key. Strips the "opencode-go/" prefix if present.
export function normalizeModelName(raw: string): string {
  const prefix = "opencode-go/";
  return raw.startsWith(prefix) ? raw.slice(prefix.length) : raw;
}

// FIX 8c: a fall-through to the default window is silent today, so a model-name/catalog mismatch
// (e.g. the roster in agents/opencode.json renamed a model the catalog still keys by the old name)
// is invisible — every prompt would quietly use the conservative DEFAULT_WINDOW_TOKENS instead of the
// model's real, larger window. Warn ONCE per (role, reason) so the mismatch is observable without
// spamming the log on every assemble() call. Module-level set survives for the process lifetime.
const warnedFallbacks = new Set<string>();
function warnFallbackOnce(role: string, reason: string): void {
  const key = `${role}:${reason}`;
  if (warnedFallbacks.has(key)) return;
  warnedFallbacks.add(key);
  console.warn(
    `[model-window-catalog] role '${role}' fell through to the DEFAULT window (${DEFAULT_WINDOW_TOKENS} tokens): ${reason}. ` +
      `The assembled-prompt budget for this role is the conservative default, not its real model window. ` +
      `Confirm the role→model mapping in agents/opencode.json and the catalog in this file (see \`opencode models\`).`,
  );
}

// Resolve the byte budget for a ROLE. Reads the role's model from
// `agents/opencode.json` at `agentsConfigPath` (defaults to the process-cwd
// relative path used by the rest of `src/`). Falls back gracefully at every step
// (logging ONCE per role/reason so a mismatch is observable, FIX 8c):
//   1. Config file missing or unparseable → DEFAULT_WINDOW_TOKENS
//   2. Role absent from agents.agent map → DEFAULT_WINDOW_TOKENS
//   3. Model not in catalog → DEFAULT_WINDOW_TOKENS
// Never throws; always returns a positive byte count.
export function roleWindowBytes(
  role: string,
  agentsConfigPath?: string,
): number {
  const configPath = agentsConfigPath ?? join(process.cwd(), "agents", "opencode.json");
  try {
    if (!existsSync(configPath)) {
      warnFallbackOnce(role, `config not found at ${configPath}`);
      return modelWindowBytes("__fallback__");
    }
    const raw = JSON.parse(readFileSync(configPath, "utf8")) as {
      agent?: Record<string, { model?: string }>;
    };
    const modelRef = raw.agent?.[role]?.model;
    if (!modelRef) {
      warnFallbackOnce(role, "role absent from agents.agent map (no model assigned)");
      return modelWindowBytes("__fallback__");
    }
    const modelName = normalizeModelName(modelRef);
    if (!(modelName in MODEL_WINDOW_TOKENS)) {
      warnFallbackOnce(role, `model '${modelName}' not in the catalog`);
    }
    return modelWindowBytes(modelName);
  } catch {
    // Config unreadable or unparseable; return the safe fallback.
    warnFallbackOnce(role, "config unreadable or unparseable JSON");
    return modelWindowBytes("__fallback__");
  }
}
