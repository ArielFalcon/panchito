// src/contexts/test-execution/infrastructure/static-gate.adapter.ts
// The static gate (tsc / eslint-playwright / playwright --list / manifest validity /
// zero-assertion guard). Each check is injected so the adapter test runs without spawning tsc,
// eslint, or playwright. Delegates — does not reimplement validation; the real body lives in this
// directory's own static-gate.checks.ts sibling (migration-tier-4b Slice 3 — body-moved from
// src/qa/validate.ts, which is now deleted; qa-engine owns the checks directly).
// Composition wiring passes the real validateSpecs as validateAll so the zero-assertion gate
// (checkZeroAssertionSpecs, internal to validateSpecs) is carried across the port boundary. A prior
// comment here ("inherited for free — no adapter changes needed") was wrong: without validateAll on
// the port, a consumer calling the 4 granular methods silently skipped the zero-assertion guard
// (WF-02 fix).
import type { StaticGatePort, CheckResult, ValidationResult } from "../application/ports/index.ts";

export interface StaticGateChecks {
  typecheck(specDir: string): Promise<CheckResult>;
  lint(specDir: string): Promise<CheckResult>;
  listTests(specDir: string): Promise<CheckResult>;
  checkManifest(specDir: string): Promise<CheckResult>;
  // validateAll runs the FULL gate including the zero-assertion guard. At wiring time this is
  // bound to the legacy validateSpecs(specDir, defaultValidateDeps). Never reimplement here —
  // always delegate to the injected fn so the guard stays in one canonical place.
  validateAll(specDir: string): Promise<ValidationResult>;
}

export class StaticGateAdapter implements StaticGatePort {
  constructor(private readonly checks: StaticGateChecks) {}
  typecheck(specDir: string): Promise<CheckResult> { return this.checks.typecheck(specDir); }
  lint(specDir: string): Promise<CheckResult> { return this.checks.lint(specDir); }
  listTests(specDir: string): Promise<CheckResult> { return this.checks.listTests(specDir); }
  checkManifest(specDir: string): Promise<CheckResult> { return this.checks.checkManifest(specDir); }
  validateAll(specDir: string): Promise<ValidationResult> { return this.checks.validateAll(specDir); }
}
