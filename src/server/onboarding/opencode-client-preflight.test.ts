// src/server/onboarding/opencode-client-preflight.test.ts
// Slice 5a pre-flight (task 5a.1): a concurrent session may be editing
// src/integrations/opencode-client.ts while this slice re-homes the LLM proposer adapter under
// src/server/onboarding/ and threads an AbortSignal through it. This test is a READ-ONLY re-diff
// guard: it asserts the two stable public surfaces this slice depends on are UNCHANGED —
// `defaultAgentDeps` (still exported, still async, still zero-arg) and `AgentDeps.open`'s opts
// shape (still carrying `signal?: AbortSignal`, source-verified below since opts is a structural
// type with no runtime tag to introspect). If either assumption breaks, this test goes red and
// flags the drift BEFORE the job's timeout/cancellation wiring (5a.6/5a.7) silently relies on a
// changed contract. Does NOT edit opencode-client.ts — read-only confirmation only.
//
// migration-tier-4c Slice 2: the AgentDeps interface itself (and its `signal?: AbortSignal;`
// declaration) MOVED to qa-engine's agent-transport-policy.ts — opencode-client.ts now only
// RE-EXPORTS the type. The re-diff below follows the type to its current, legitimate home rather
// than re-pinning a literal that no longer lives in opencode-client.ts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { defaultAgentDeps } from "../../integrations/opencode-client";

const HERE = dirname(fileURLToPath(import.meta.url));
const OPENCODE_CLIENT_PATH = join(HERE, "..", "..", "integrations", "opencode-client.ts");
const AGENT_TRANSPORT_POLICY_PATH = join(HERE, "..", "..", "..", "qa-engine", "src", "contexts", "generation", "infrastructure", "agent-transport-policy.ts");

test("pre-flight: defaultAgentDeps is still exported as a zero-arg async factory", () => {
  assert.equal(typeof defaultAgentDeps, "function");
  assert.equal(defaultAgentDeps.length, 0, "defaultAgentDeps must remain zero-arg");
});

test("pre-flight: AgentDeps.open's opts shape still declares signal?: AbortSignal (source re-diff)", () => {
  // A structural TS type carries no runtime tag, so the only way to re-confirm the opts shape at
  // apply-time (without editing the file) is a source-level re-diff — mirrors the same technique
  // Slice 3's own pre-flight used for defaultAgentDeps' signature.
  const source = readFileSync(OPENCODE_CLIENT_PATH, "utf8");
  assert.match(
    source,
    /export\s+async\s+function\s+defaultAgentDeps\s*\(\s*\)\s*:\s*Promise<AgentDeps>/,
    "defaultAgentDeps export signature changed — coordinate with the concurrent session before proceeding",
  );

  // AgentDeps itself now lives in qa-engine (migration-tier-4c Slice 2) — re-diff its declaration
  // there instead of re-pinning a literal opencode-client.ts no longer contains.
  const engineSource = readFileSync(AGENT_TRANSPORT_POLICY_PATH, "utf8");
  assert.match(
    engineSource,
    /signal\?:\s*AbortSignal;/,
    "AgentDeps.open's opts no longer declares signal?: AbortSignal — the job-timeout AbortController thread-through (5a.6/5a.7) depends on this",
  );
});
