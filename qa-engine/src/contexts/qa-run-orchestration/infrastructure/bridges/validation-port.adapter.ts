// qa-engine/src/contexts/qa-run-orchestration/infrastructure/bridges/validation-port.adapter.ts
// Bridge: ValidationPort -> test-execution's REAL StaticGateAdapter. THIN — no new policy.
// Delegates to validateAll(specDir), the FULL gate (tsc/eslint-playwright/playwright --list/
// manifest/zero-assertion guard, WF-02) — never the 4 granular methods, which would silently skip
// the zero-assertion guard (StaticGateAdapter's own header warning).
import type { ValidationPort } from "../../application/ports/index.ts";
import type { StaticGateAdapter } from "@contexts/test-execution/infrastructure/static-gate.adapter.ts";

export class ValidationPortAdapter implements ValidationPort {
  constructor(private readonly gate: StaticGateAdapter) {}

  async validate(specDir: string): Promise<{ ok: boolean; errors: string[]; infra?: boolean }> {
    const result = await this.gate.validateAll(specDir);
    return { ok: result.ok, errors: result.errors, infra: result.infra };
  }
}
