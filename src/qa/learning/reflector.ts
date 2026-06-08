import type { RunOutcome, StructuredReflection } from "../../types";
import type { ErrorClass } from "./taxonomy";

export interface ReflectionInput {
  errorClass: ErrorClass;
  gateSignals: RunOutcome["gateSignals"];
  verdict: string;
  sha: string;
  mode: string;
}

export interface ReflectorDeps {
  reflect(input: ReflectionInput): Promise<StructuredReflection>;
}

export function buildReflectionPrompt(input: ReflectionInput): string {
  const signals = [
    `static gate: ${input.gateSignals.static ? "PASS" : "FAIL"}`,
    `coverage ratio: ${input.gateSignals.coverageRatio !== null ? (input.gateSignals.coverageRatio * 100).toFixed(0) + "%" : "unmeasured"}`,
    `value score: ${input.gateSignals.valueScore !== null ? (input.gateSignals.valueScore * 100).toFixed(0) + "%" : "unmeasured"}`,
    `flaky: ${input.gateSignals.flaky}`,
    `retries: ${input.gateSignals.retries}`,
  ];

  if (input.gateSignals.reviewerCorrections.length > 0) {
    signals.push(`reviewer corrections:\n${input.gateSignals.reviewerCorrections.map((c) => `  - ${c}`).join("\n")}`);
  }

  return [
    `Reflect on this QA run to produce a preventive rule.`,
    ``,
    `## Run context`,
    `- SHA: ${input.sha}`,
    `- Mode: ${input.mode}`,
    `- Verdict: ${input.verdict}`,
    `- Error class: ${input.errorClass}`,
    ``,
    `## Gate signals (the objective truth)`,
    ...signals,
    ``,
    `## Task`,
    `1. Identify the ROOT CAUSE of why this run failed or produced low-quality tests.`,
    `2. The errorClass "${input.errorClass}" is already determined by the gates — do NOT change it.`,
    `3. Write a preventiveRule that would have caught this BEFORE the run:`,
    `   - trigger: a CONDITION that, if present in the change, should trigger this rule (e.g. "the diff adds a form with onSubmit but no test for invalid input")`,
    `   - action: a CONCRETE instruction the agent should follow (e.g. "generate a test that submits the form with invalid data and asserts the error message")`,
    `4. The rule must be RECUPERABLE — specific enough to match future changes, general enough to apply across apps.`,
    `5. Anchor every field to the gate signals above — evidence must reference actual numbers/output.`,
    ``,
    `## Output — ONLY this JSON:`,
    `{"goal":"why the run happened","decision":"what the agent chose","assumption":"what the agent assumed that was wrong","errorClass":"${input.errorClass}","gateSignal":"the specific signal that flagged this","evidence":"the actual assert/lines/output","rootCause":"why the gate caught this","preventiveRule":{"trigger":"condition","action":"instruction"}}`,
  ].join("\n");
}
