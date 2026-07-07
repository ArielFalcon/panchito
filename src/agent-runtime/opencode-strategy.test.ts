// Unit tests for OpenCodeRuntimeStrategy's model-listing fallback (WS9.4(b)).
//
// modelsFromOpenCodeConfig only falls back to FALLBACK_MODELS when agents/opencode.json is
// missing or unreadable. That is rare in production (the file ships with the image), but when it
// DOES fire, the fallback roster must not reject the actual default primary model — a stale
// roster naming models the live config no longer has is worse than an empty list, because it
// looks authoritative while being wrong.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OpenCodeRuntimeStrategy } from "./opencode-strategy";

// Repo root relative to this test file (src/agent-runtime/ → two levels up), for reading the
// REAL agents/opencode.json in the structural anti-drift test below.
const REPO_ROOT = join(import.meta.dirname ?? __dirname, "..", "..");

describe("OpenCodeRuntimeStrategy.listModels fallback roster (WS9.4(b))", () => {
  it("the fallback roster includes the LIVE default primary model (deepseek-v4-pro), not a stale one", async () => {
    // Point at a config path that does not exist, forcing the FALLBACK_MODELS path.
    const strategy = new OpenCodeRuntimeStrategy({
      env: { OPENCODE_API_KEY: "test-key" },
      configPath: "/nonexistent/opencode/config/path.json",
    });

    const models = await strategy.listModels();
    const ids = models.map((m) => m.id);

    assert.ok(
      ids.includes("opencode-go/deepseek-v4-pro"),
      `the fallback roster must include the live qa-generator/qa-proposer default (opencode-go/deepseek-v4-pro). Got: ${ids.join(", ")}`,
    );
  });

  it("structural anti-drift: EVERY fallback roster entry appears in the REAL agents/opencode.json roster", async () => {
    // Read the actual shipped config — not a hand-transcribed copy — and assert the fallback list
    // is a subset of the models genuinely assigned there. If someone retires a model from
    // opencode.json without updating FALLBACK_MODELS, this fails; no manual transcription to rot.
    const livePath = join(REPO_ROOT, "agents", "opencode.json");
    const liveConfig = JSON.parse(readFileSync(livePath, "utf8")) as {
      agent?: Record<string, { model?: string }>;
    };
    const liveModels = new Set(
      Object.values(liveConfig.agent ?? {})
        .map((a) => a.model)
        .filter((m): m is string => typeof m === "string"),
    );
    assert.ok(liveModels.size > 0, `agents/opencode.json must assign at least one model (read from ${livePath})`);

    // Force the fallback path with a nonexistent configPath.
    const strategy = new OpenCodeRuntimeStrategy({
      env: { OPENCODE_API_KEY: "test-key" },
      configPath: "/nonexistent/opencode/config/path.json",
    });
    const fallbackIds = (await strategy.listModels()).map((m) => m.id);

    for (const id of fallbackIds) {
      assert.ok(
        liveModels.has(id),
        `FALLBACK_MODELS entry "${id}" is not assigned to any agent in the live agents/opencode.json — ` +
          `the fallback roster has drifted from the live config. Live roster: ${[...liveModels].sort().join(", ")}`,
      );
    }
  });

  it("parsing logic: distinct agent models in a config are surfaced exactly (temp-config shape test)", async () => {
    // Build a tiny temp config mirroring the SHAPE this parser reads (agent -> model) and confirm
    // the LIVE-config parse path (not the fallback) surfaces exactly the distinct assigned ids.
    const dir = mkdtempSync(join(tmpdir(), "opencode-config-test-"));
    const configPath = join(dir, "opencode.json");
    try {
      writeFileSync(
        configPath,
        JSON.stringify({
          agent: {
            "qa-generator": { model: "opencode-go/deepseek-v4-pro" },
            "qa-reviewer": { model: "opencode-go/minimax-m3" },
            "qa-maintainer": { model: "opencode-go/kimi-k2.7-code" },
            "qa-assistant": { model: "opencode-go/deepseek-v4-flash" },
          },
        }),
      );
      const strategy = new OpenCodeRuntimeStrategy({
        env: { OPENCODE_API_KEY: "test-key" },
        configPath,
      });
      const liveIds = (await strategy.listModels()).map((m) => m.id).sort();
      assert.deepEqual(
        liveIds,
        [
          "opencode-go/deepseek-v4-flash",
          "opencode-go/deepseek-v4-pro",
          "opencode-go/kimi-k2.7-code",
          "opencode-go/minimax-m3",
        ],
        "the live-config parse path must surface exactly the distinct models assigned",
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a malformed/unreadable config also falls back to the roster that includes the live default primary", async () => {
    const dir = mkdtempSync(join(tmpdir(), "opencode-config-test-"));
    const configPath = join(dir, "opencode.json");
    try {
      writeFileSync(configPath, "{ not valid json");
      const strategy = new OpenCodeRuntimeStrategy({
        env: { OPENCODE_API_KEY: "test-key" },
        configPath,
      });
      const ids = (await strategy.listModels()).map((m) => m.id);
      assert.ok(
        ids.includes("opencode-go/deepseek-v4-pro"),
        `malformed-config fallback must still include the live default primary. Got: ${ids.join(", ")}`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
