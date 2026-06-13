// Guard (post-ADR-001, Phase 2): the agent (`opencode`) container must NEVER receive
// git / control-plane write credentials. The core security invariant — "the LLM agent
// is read-only on watched repos; only the orchestrator does git writes" — rests on this
// credential isolation. That makes the invariant STRUCTURAL (the agent has no token to
// exfiltrate or misuse), not a convention in the agent's code. This test turns the
// comment in docker-compose.yml into an executable check: if a future edit leaks a write
// credential into the agent — directly via `environment` or wholesale via `env_file` —
// it fails here in CI, not silently in production.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";

// Credentials that grant WRITE power on the watched repos or the control plane. The
// orchestrator needs these; the agent must never see them.
const FORBIDDEN_IN_AGENT = ["GITHUB_TOKEN", "WEBHOOK_SECRET", "QA_API_TOKEN"];

function loadCompose(): unknown {
  return parse(readFileSync(join(process.cwd(), "docker-compose.yml"), "utf8"));
}

function getService(compose: unknown, name: string): Record<string, unknown> | undefined {
  if (!compose || typeof compose !== "object") return undefined;
  const services = (compose as Record<string, unknown>).services;
  if (!services || typeof services !== "object") return undefined;
  const svc = (services as Record<string, unknown>)[name];
  return svc && typeof svc === "object" ? (svc as Record<string, unknown>) : undefined;
}

// compose `environment` may be a map ({KEY: value}) OR a list (["KEY=value"]). Return the
// declared [key, value] pairs for either form. Values are kept as the raw YAML scalar:
// the `yaml` parser does NOT expand `${VAR}`, so an aliasing leak survives as a literal
// string we can scan (see the value check below).
function envEntries(environment: unknown): Array<[string, string]> {
  if (Array.isArray(environment)) {
    return environment.map((e) => {
      const s = String(e);
      const i = s.indexOf("=");
      return i >= 0 ? [s.slice(0, i).trim(), s.slice(i + 1)] : [s.trim(), ""];
    });
  }
  if (environment && typeof environment === "object") {
    return Object.entries(environment as Record<string, unknown>).map(([k, v]) => [k, String(v ?? "")]);
  }
  return [];
}

function envKeys(environment: unknown): string[] {
  return envEntries(environment).map(([k]) => k);
}

test("the opencode (agent) service is defined and we can read its real env block", () => {
  const opencode = getService(loadCompose(), "agents");
  assert.ok(opencode, "docker-compose.yml must define an `opencode` service");
  // Meaningfulness guard: prove we are inspecting the agent's actual environment and not
  // an empty/absent block (which would make the forbidden-key checks vacuously pass).
  const keys = envKeys(opencode.environment);
  assert.ok(
    keys.includes("OPENCODE_API_KEY"),
    "expected the agent service to declare OPENCODE_API_KEY — if this fails, the test is reading the wrong env block, so the isolation checks below are not trustworthy",
  );
});

test("the agent service receives NO git / control-plane write credentials", () => {
  const opencode = getService(loadCompose(), "agents");
  assert.ok(opencode, "missing `opencode` service");
  const keys = envKeys(opencode.environment);
  for (const secret of FORBIDDEN_IN_AGENT) {
    assert.ok(
      !keys.includes(secret),
      `SECURITY: the agent container must not receive ${secret} — only the orchestrator does git writes. ` +
        `Found it in services.opencode.environment. Remove it (the agent has no business holding a write credential).`,
    );
  }
  // Also catch a renaming/aliasing leak: `SOME_ALIAS: ${GITHUB_TOKEN}` would inject the
  // real credential under a benign key name. The yaml parser returns the literal
  // "${GITHUB_TOKEN}" (no shell expansion), so a value substring scan catches it before
  // Docker would expand it at runtime.
  for (const [key, value] of envEntries(opencode.environment)) {
    for (const secret of FORBIDDEN_IN_AGENT) {
      assert.ok(
        !value.includes(secret),
        `SECURITY: services.opencode.environment.${key} references ${secret} via value interpolation — ` +
          `the agent would receive the real credential at runtime.`,
      );
    }
  }
});

test("the agent service does not bulk-import .env (which would leak every secret)", () => {
  const opencode = getService(loadCompose(), "agents");
  assert.ok(opencode, "missing `opencode` service");
  // The orchestrator uses `env_file: .env` because it legitimately needs the tokens.
  // The agent MUST enumerate only the keys it needs; an `env_file` here would inherit
  // GITHUB_TOKEN / WEBHOOK_SECRET / QA_API_TOKEN wholesale and defeat the isolation.
  assert.equal(
    opencode.env_file,
    undefined,
    "SECURITY: the agent service must not use `env_file` — it would bulk-import the orchestrator's secrets. Enumerate only the keys the agent needs under `environment`.",
  );
});
