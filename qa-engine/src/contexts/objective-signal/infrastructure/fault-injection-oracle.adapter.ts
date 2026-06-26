// src/contexts/objective-signal/infrastructure/fault-injection-oracle.adapter.ts
// ValueOraclePort for the E2E target — WRAP of src/qa/learning/fault-injection-e2e.ts
// runFaultInjectionOracle. The runner is injected so the adapter test needs no Playwright.
// Implements the 3-param measure(br, repoDir, namespace) signature (port-aligned in B.3 step 1).
// Signal-only by contract: a null valueScore never gates publish.
//
// Plan-6 wiring: inject (input) => runFaultInjectionOracle({ ...input, target: "e2e" }, defaultFaultInjectionDeps)
// and pass the live DEV URL from the App config as baseUrl to the constructor.
import type { ValueOraclePort, ValueOracleResult } from "../application/ports/index.ts";
import type { BlastRadius } from "@kernel/blast-radius.ts";

interface FaultInjectionInputLike {
  target: "e2e";
  e2eDir: string;         // maps to repoDir (the mirror working copy of the app)
  baseUrl: string;        // live DEV URL for the injected fault run
  namespace: string;      // per-run sha-scoped identifier
  baselineCases?: { name: string; status: string }[];
}
// The runner may return null when no JSON was intercepted (static site / no API surface).
// The port contract always returns ValueOracleResult (never null at the port boundary).
type RunFaultInjection = (input: FaultInjectionInputLike) => Promise<ValueOracleResult | null>;

export class FaultInjectionOracleAdapter implements ValueOraclePort {
  constructor(
    private readonly runFaultInjection: RunFaultInjection,
    private readonly baseUrl: string,         // live DEV URL (from the App config at wiring time)
  ) {}

  async measure(br: BlastRadius, repoDir: string, namespace: string): Promise<ValueOracleResult> {
    const result = await this.runFaultInjection({
      target: "e2e",
      e2eDir: repoDir,
      baseUrl: this.baseUrl,
      namespace,
    });
    // null means no JSON intercepted (inapplicable ecosystem / no fault fired). Return a
    // signal-only zero-score result so the caller sees a defined shape, not null — the
    // ValueOraclePort contract always returns ValueOracleResult (never null at the port).
    return result ?? { valueScore: null, mutantCount: 0, killedCount: 0, details: "no fault data intercepted" };
  }
}
