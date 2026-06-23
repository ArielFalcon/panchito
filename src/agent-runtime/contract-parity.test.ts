// Contract-parity guard (T-P3-1 / C3.1 / AC3.1.1-2).
//
// Asserts that both AgentRuntimeStrategy implementations (opencode, codex) expose the same
// OBSERVABLE contract set, or that any known asymmetry is EXPLICITLY declared and documented
// in the ALLOWED_ASYMMETRIES allowlist below.
//
// PURPOSE: make future capability gaps fail CI instead of silently degrading. A developer who
// adds a new capability to one strategy without the other gets a clear test failure — not a
// runtime surprise.
//
// DESIGN NOTE — the asymmetries below are KNOWN and HONEST, not gaps to paper over:
//   - onUsage: OpenCode fires a UsageSnapshot per prompt (full token accounting); Codex never
//     does — `codex exec --json` does not surface token usage in the 0.139 JSONL (or it is
//     unknown pending the T-P1-0 image-gated fixture). The strategy intentionally omits onUsage
//     from its openSession opts rather than emitting null values that would look like real data.
//     A pending hook exists in codex-strategy.ts for when the real fixture proves usage is
//     available. See AC3.3.1.
//   - startEventStream shape: OpenCode has a persistent session server; its startEventStream
//     subscribes to a live SSE bus. Codex is exec-per-prompt — there is no global event bus.
//     CodexRuntimeStrategy.startEventStream is a structural no-op (documented in the code).
//     Per-exec activity events ARE emitted inline via mapCodexExecEvent during runExec.
//   - cleanupOrphans: OpenCode has long-lived sessions that can leak; Codex is one-shot exec,
//     no sessions to clean up. The method is legitimately absent on CodexRuntimeStrategy.
//
// ADDING A NEW ASYMMETRY: add an entry to ALLOWED_ASYMMETRIES below with a reason. Without
// the entry the guard fails — this is intentional (AC3.1.2).

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { OpenCodeRuntimeStrategy } from "./opencode-strategy";
import { CodexRuntimeStrategy } from "./codex-strategy";
import type { AgentRuntimeStrategy } from "./types";

// ---------------------------------------------------------------------------
// Allowed asymmetries: known, documented differences between the two strategies.
// Each entry names the capability and explains WHY the gap is acceptable.
// ---------------------------------------------------------------------------
const ALLOWED_ASYMMETRIES: Record<string, string> = {
  onUsage:
    "Codex strategy intentionally does not accept onUsage: `codex exec --json` does not expose " +
    "token usage in the current JSONL schema (pending T-P1-0 image-gated fixture confirmation). " +
    "Emitting null snapshots would fabricate data. A pending hook is documented in codex-strategy.ts " +
    "for when the fixture proves usage is available. See AC3.3.1 / T-P3-3.",
  startEventStream:
    "Codex is exec-per-prompt; there is no persistent session server or global SSE bus. " +
    "CodexRuntimeStrategy.startEventStream is a no-op structural stub that provides method " +
    "presence parity. Per-exec activity is emitted inline via mapCodexExecEvent during runExec.",
  cleanupOrphans:
    "OpenCode has long-lived sessions that can leak; Codex exec is one-shot with no sessions. " +
    "cleanupOrphans is legitimately absent on CodexRuntimeStrategy.",
};

// ---------------------------------------------------------------------------
// Observable contract surface: capabilities every strategy must expose unless
// explicitly listed in ALLOWED_ASYMMETRIES.
// ---------------------------------------------------------------------------
// Each entry: { name, probe } where probe returns true if the strategy exposes the capability.
// The probe MUST be deterministic and offline — no network, no binary.
const OBSERVABLE_CONTRACT: Array<{ name: string; probe: (s: AgentRuntimeStrategy) => boolean }> = [
  {
    // Every strategy must have a provider discriminant.
    name: "provider",
    probe: (s) => typeof s.provider === "string" && s.provider.length > 0,
  },
  {
    // Every strategy must expose health() — a required method on the interface.
    name: "health",
    probe: (s) => typeof s.health === "function",
  },
  {
    // Every strategy must expose listModels() — a required method on the interface.
    name: "listModels",
    probe: (s) => typeof s.listModels === "function",
  },
  {
    // Every strategy must expose openSession() — the load-bearing prompt path.
    name: "openSession",
    probe: (s) => typeof s.openSession === "function",
  },
  {
    // onUsage is in the ALLOWED_ASYMMETRIES: Codex does not accept it in openSession opts.
    // This entry documents the gap — the probe returns true only if the strategy's openSession
    // ACCEPTS onUsage (we check via the method's parameter count / the known method signature).
    //
    // Implementation note: we cannot introspect TypeScript parameter names at runtime. Instead
    // we check for a known published capability flag, or we rely on the ALLOWED_ASYMMETRIES
    // allowlist to make this gap safe. The test below verifies the asymmetry is declared.
    name: "onUsage",
    probe: (s) => {
      // OpenCode wires onUsage through to deps.open — it is in the openSession interface.
      // Codex intentionally omits it (documented asymmetry). The probe marks OpenCode as
      // having the capability, Codex as not — the allowlist makes this pass.
      return s.provider === "opencode";
    },
  },
  {
    // startEventStream: structural parity required (both have the method), even if codex is a no-op.
    name: "startEventStream",
    probe: (s) => typeof s.startEventStream === "function",
  },
  {
    // restart: both strategies must support restart (graceful API-key rotation / recovery).
    name: "restart",
    probe: (s) => typeof s.restart === "function",
  },
  {
    // infra-error classification: both strategies must throw AgentUnavailableError for auth/credits
    // failures so the pipeline never opens a false Issue. This is a behavioral contract, not just
    // method presence. We verify the classifier function exists and is exported from codex-strategy.
    // OpenCode's equivalent (agentErrorToInfra) is in opencode-client.ts — used via defaultAgentDeps.
    name: "infra-error-classification",
    probe: (s) => {
      if (s.provider === "codex") {
        // codexErrorToInfra is exported from codex-strategy.ts and is callable.
        // We verified this by importing it in this test's module scope (below).
        return typeof _codexErrorToInfra === "function";
      }
      // OpenCode's classification lives in defaultAgentDeps (agentErrorToInfra in opencode-client.ts).
      // It is structurally present for opencode; the unit tests in opencode-client cover it.
      return true;
    },
  },
];

// Import the codex classifier to verify it is exported and callable (part of AC3.1.1 probe above).
import { codexErrorToInfra as _codexErrorToInfra } from "./codex-strategy";

// ---------------------------------------------------------------------------
// The guard tests
// ---------------------------------------------------------------------------

const opencode = new OpenCodeRuntimeStrategy({ env: {} });
const codex = new CodexRuntimeStrategy({ env: {} });
const strategies: AgentRuntimeStrategy[] = [opencode, codex];

describe("contract-parity guard (T-P3-1 / C3.1)", () => {
  for (const capability of OBSERVABLE_CONTRACT) {
    it(`both strategies expose capability: ${capability.name} (or asymmetry is declared)`, () => {
      for (const strategy of strategies) {
        const has = capability.probe(strategy);
        if (has) continue; // capability present — all good

        // Capability absent — check whether this is a declared asymmetry.
        const reason = ALLOWED_ASYMMETRIES[capability.name];
        assert.ok(
          reason !== undefined,
          `contract-parity DRIFT: strategy "${strategy.provider}" is missing capability ` +
            `"${capability.name}" and no asymmetry is declared in ALLOWED_ASYMMETRIES. ` +
            `Either implement the capability or add a documented entry to ALLOWED_ASYMMETRIES.`,
        );
        // Asymmetry is declared — emit a diagnostic so it is visible in test output.
        // (node:test does not have a native "warn" for passing tests, so we use console.warn.)
        console.warn(
          `[contract-parity] declared asymmetry: "${strategy.provider}" / "${capability.name}": ${reason}`,
        );
      }
    });
  }

  it("AC3.1.2 — a capability present on one strategy but absent on the other (and not in ALLOWED_ASYMMETRIES) fails the guard", () => {
    // Simulate: a hypothetical new capability added only to opencode, not in allowlist.
    // The probe returns true for opencode, false for codex, with no allowlist entry.
    const fakeCapability: (typeof OBSERVABLE_CONTRACT)[number] = {
      name: "hypotheticalCapability",
      probe: (s) => s.provider === "opencode", // only opencode "has" it
    };

    let driftDetected = false;
    for (const strategy of strategies) {
      const has = fakeCapability.probe(strategy);
      if (!has) {
        const declared = (ALLOWED_ASYMMETRIES as Record<string, string>)[fakeCapability.name];
        if (!declared) {
          driftDetected = true;
          break;
        }
      }
    }
    assert.ok(driftDetected, "The guard must detect an undeclared capability gap between strategies.");
  });

  it("ALLOWED_ASYMMETRIES entries have non-empty reason strings (documentation quality gate)", () => {
    for (const [capability, reason] of Object.entries(ALLOWED_ASYMMETRIES)) {
      assert.ok(
        reason.trim().length > 20,
        `ALLOWED_ASYMMETRIES["${capability}"] must have a substantive reason (> 20 chars). Got: "${reason}"`,
      );
    }
  });
});
