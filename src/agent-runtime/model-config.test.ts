import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { singleProviderConfig } from "./config";

// Guard against the model "split-brain": config.ts's DEFAULT_MODELS (used by the runtime
// reconfig layer) and opencode/opencode.json (the file that actually runs the agents) must
// agree, and the reviewer must be a DIFFERENT model from the generator. When the default
// reviewer drifted out of the opencode.json catalog, validateAssignedModels threw on every
// applyConfig and the operator-facing docs advertised a model the system was not running.

function opencodeAgentModels(): Record<string, string> {
  const raw = JSON.parse(readFileSync(join(process.cwd(), "agents", "opencode.json"), "utf8")) as {
    agent?: Record<string, { model?: string }>;
  };
  const out: Record<string, string> = {};
  for (const [name, a] of Object.entries(raw.agent ?? {})) if (a.model) out[name] = a.model;
  return out;
}

test("every default opencode role model exists in opencode.json's agent catalog", () => {
  const catalog = new Set(Object.values(opencodeAgentModels()));
  const cfg = singleProviderConfig("opencode", {});
  for (const role of ["primary", "reviewer", "chat"] as const) {
    const model = cfg.assignments[role].model;
    assert.ok(
      catalog.has(model),
      `default opencode ${role} model '${model}' is not in opencode.json (catalog: ${[...catalog].join(", ")}). ` +
        `An assigned model outside the catalog makes validateAssignedModels throw on applyConfig.`,
    );
  }
});

test("the default reviewer model differs from the generator (independent judgment)", () => {
  const cfg = singleProviderConfig("opencode", {});
  assert.notEqual(
    cfg.assignments.reviewer.model,
    cfg.assignments.primary.model,
    "reviewer must be a DIFFERENT model from primary — otherwise the quality loop is the generator grading its own homework.",
  );
});

test("opencode.json's qa-reviewer runs a different model from qa-generator", () => {
  const models = opencodeAgentModels();
  assert.ok(models["qa-generator"], "qa-generator must declare a model");
  assert.ok(models["qa-reviewer"], "qa-reviewer must declare a model");
  assert.notEqual(
    models["qa-reviewer"],
    models["qa-generator"],
    "qa-reviewer and qa-generator must run different models for genuine two-model independence.",
  );
});

test("config.ts default reviewer matches opencode.json's qa-reviewer (single source of truth)", () => {
  const models = opencodeAgentModels();
  const cfg = singleProviderConfig("opencode", {});
  assert.equal(
    cfg.assignments.reviewer.model,
    models["qa-reviewer"],
    "config.ts DEFAULT_MODELS.opencode.reviewer must equal the model opencode.json actually runs for qa-reviewer.",
  );
});
