// src/contexts/test-execution/infrastructure/static-gate.adapter.ts
// WRAP of src/qa/validate.ts — the static gate (tsc / eslint-playwright / playwright --list /
// manifest validity). Each check is injected so the adapter test runs without spawning tsc,
// eslint, or playwright. Delegates — does not reimplement validation.
// Plan-6 wiring passes the real defaultValidateDeps so the zero-assertion gate (checkZeroAssertionSpecs,
// hardcoded inside validateSpecs) is inherited for free — no adapter changes needed.
import type { StaticGatePort, CheckResult } from "../application/ports/index.ts";

export interface StaticGateChecks {
  typecheck(specDir: string): Promise<CheckResult>;
  lint(specDir: string): Promise<CheckResult>;
  listTests(specDir: string): Promise<CheckResult>;
  checkManifest(specDir: string): Promise<CheckResult>;
}

export class StaticGateAdapter implements StaticGatePort {
  constructor(private readonly checks: StaticGateChecks) {}
  typecheck(specDir: string): Promise<CheckResult> { return this.checks.typecheck(specDir); }
  lint(specDir: string): Promise<CheckResult> { return this.checks.lint(specDir); }
  listTests(specDir: string): Promise<CheckResult> { return this.checks.listTests(specDir); }
  checkManifest(specDir: string): Promise<CheckResult> { return this.checks.checkManifest(specDir); }
}
