// src/contexts/objective-signal/infrastructure/stryker-mutation-oracle.adapter.ts
// ValueOraclePort for the CODE target — WRAP of src/qa/learning/mutation-code.ts runMutationOracle.
// The runner is injected so the adapter test needs no Stryker binary.
// IMPORTANT: `namespace` is per-run (sha-scoped like "qa-bot-<sha>") — it comes from the
// `measure` call args, NOT from the constructor. `repoDir` maps to OracleInput.repoDir (not specDir).
// Signal-only by contract: a null valueScore never gates publish.
//
// Plan-6 wiring: inject (input) => runMutationOracle({ ...input, target: "code" }, realMutationDeps)
// (the full OracleInput binding from pipeline.ts context).
import type { ValueOraclePort, ValueOracleResult } from "../application/ports/index.ts";
import type { BlastRadius } from "@kernel/blast-radius.ts";

// OracleInput fields this adapter uses (local structural type — no src/ import at runtime).
interface OracleInputLike {
  target: "code";
  repoDir: string;
  namespace: string;
  changedFiles?: string[];
}
type RunMutation = (input: OracleInputLike) => Promise<ValueOracleResult>;

export class StrykerMutationOracleAdapter implements ValueOraclePort {
  constructor(private readonly runMutation: RunMutation) {}

  async measure(br: BlastRadius, repoDir: string, namespace: string): Promise<ValueOracleResult> {
    return this.runMutation({
      target: "code",
      repoDir,
      namespace,
      changedFiles: [...br.changedFiles],
    });
  }
}
