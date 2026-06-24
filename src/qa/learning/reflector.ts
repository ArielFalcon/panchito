import type { RunOutcome, StructuredReflection } from "../../types";
import type { ErrorClass } from "./taxonomy";
import { lastJsonMatching } from "../../integrations/verdict-parse";

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

// Shape guard for a complete StructuredReflection (every field the distiller needs).
function isStructuredReflection(o: Record<string, unknown>): boolean {
  const pr = o.preventiveRule as Record<string, unknown> | undefined;
  return (
    typeof o.goal === "string" &&
    typeof o.decision === "string" &&
    typeof o.assumption === "string" &&
    typeof o.errorClass === "string" &&
    typeof o.gateSignal === "string" &&
    typeof o.evidence === "string" &&
    typeof o.rootCause === "string" &&
    !!pr &&
    typeof pr === "object" &&
    typeof pr.trigger === "string" &&
    typeof pr.action === "string"
  );
}

// Parse the qa-reflector's StructuredReflection out of its raw output. The role is told to emit
// "ONLY the JSON object, no markdown", but models do not always comply — they may wrap the object
// in a ```json fence or surround it with prose, which makes a raw JSON.parse throw
// "Unexpected token '`'". Routing through the shared balanced-brace extractor (lastJsonMatching)
// makes reflection parsing robust to fences/prose, exactly like every other agent-JSON boundary in
// the codebase. Returns null when no complete reflection object is present (never throws).
export function parseStructuredReflection(raw: string): StructuredReflection | null {
  return lastJsonMatching<StructuredReflection>(raw, isStructuredReflection) ?? null;
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
    `   - trigger: a CONDITION phrased as an "Applies when …" sentence describing the change that should fire this rule (e.g. "Applies when the diff adds a form with onSubmit but no test for invalid input"). Start with "Applies when ".`,
    `   - action: a CONCRETE instruction the agent should follow (e.g. "generate a test that submits the form with invalid data and asserts the error message")`,
    `4. The rule must be RECUPERABLE — specific enough to match future changes, general enough to apply across apps.`,
    `5. Anchor every field to the gate signals above — evidence must reference actual numbers/output.`,
    ``,
    `## Output — ONLY this JSON:`,
    `{"goal":"why the run happened","decision":"what the agent chose","assumption":"what the agent assumed that was wrong","errorClass":"${input.errorClass}","gateSignal":"the specific signal that flagged this","evidence":"the actual assert/lines/output","rootCause":"why the gate caught this","preventiveRule":{"trigger":"Applies when <condition>","action":"instruction"}}`,
  ].join("\n");
}
