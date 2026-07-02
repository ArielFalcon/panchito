// qa-engine/test/characterization/parity-allowlist.ts
// Declared, intentional legacy-vs-rewritten divergences. Empty on day 1. The proof and (later) the
// 186-harness suppress a CI failure ONLY for a declared fingerprint; any UNDECLARED divergence fails
// the gate unconditionally. scenarioFingerprint is a stable hash of the scenario NAME (not fixture
// data), so fixture edits never silently break entries.
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";

export interface AllowlistEntry {
  scenarioFingerprint: string;
  divergenceDescription: string;
  approver: string;
}

export function fingerprint(scenarioName: string): string {
  return createHash("sha256").update(scenarioName).digest("hex").slice(0, 16);
}

export function loadAllowlist(): Set<string> {
  const raw = readFileSync(join(import.meta.dirname, "parity-allowlist.json"), "utf8");
  const entries = JSON.parse(raw) as AllowlistEntry[];
  return new Set(entries.map((e) => e.scenarioFingerprint));
}
