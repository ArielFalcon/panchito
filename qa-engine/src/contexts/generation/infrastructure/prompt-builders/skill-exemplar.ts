// migration-tier-4c Slice 5a: this file relocated from src/qa/learning/skill-exemplar.ts (prompts.ts's
// own rider — prompts.ts is its ONLY production value-consumer, confirmed via a fresh grep before this
// move). `ScenarioArchetype` structurally mirrors src/qa/learning/curriculum.ts's own type (a plain
// string-literal union) — NOT imported: curriculum.ts stays in src/ (it has other, unrelated shell
// consumers: src/server/intelligence-view.ts, src/server/history.ts), so qa-engine may not import it
// (arch:check's one-way rule). Same "structurally mirror, never import" discipline this migration
// program already uses for OcServiceLink/OcContractDrift/ParallelWorkerInput.
export type ScenarioArchetype =
  | "happy-path"
  | "empty-state"
  | "boundary-value"
  | "invalid-input"
  | "re-query-after-mutation"
  | "concurrent-update"
  | "permission-denied"
  | "network-error"
  | "loading-state"
  | "stale-data";

export type StructuralPattern =
  | { kind: "form"; hasOnSubmit: boolean; hasValidation: boolean }
  | { kind: "api-call"; method: string; hasRequestBody: boolean; hasErrorHandling: boolean }
  | { kind: "stateful-cache"; sourceType: string; hasIndependentWritePath: boolean }
  | { kind: "auth-flow"; hasLogin: boolean; hasSessionToken: boolean }
  | { kind: "data-list"; hasFilter: boolean; hasPagination: boolean; hasEmptyState: boolean }
  | { kind: "generic" };

// A static catalog of authoring templates keyed by structural pattern. This is NOT a learned
// store: it was previously dressed with status/valueScore/usageCount lifecycle fields that were
// never persisted, mutated, or read (selection is purely pattern-shape based), which falsely
// implied an evolving "skill" that promotes/deprecates exemplars. Honest shape: pattern → template.
export interface SkillExemplar {
  id: string;
  name: string;
  description: string;
  pattern: StructuralPattern;
  template: string;
  archetype: ScenarioArchetype;
}

const BUILT_IN_EXEMPLARS: SkillExemplar[] = [
  {
    id: "ex-form-invalid-input",
    name: "Form invalid input",
    description: "Tests that submitting a form with invalid data shows error messages and does NOT succeed",
    pattern: { kind: "form", hasOnSubmit: true, hasValidation: true },
    template: "Generate a test that submits the form with invalid data (empty required field, wrong format, too long) and asserts that the error message is visible and the form was NOT submitted successfully.",
    archetype: "invalid-input",
  },
  {
    id: "ex-form-happy-path",
    name: "Form happy path",
    description: "Tests the primary success flow of a form submission",
    pattern: { kind: "form", hasOnSubmit: true, hasValidation: false },
    template: "Generate a test that fills the form with valid data, submits it, and asserts the success outcome (redirect, confirmation message, or data appearing in the UI).",
    archetype: "happy-path",
  },
  {
    id: "ex-api-error-handling",
    name: "API error handling",
    description: "Tests that API call failures surface correctly in the UI",
    pattern: { kind: "api-call", method: "POST", hasRequestBody: true, hasErrorHandling: true },
    template: "Generate a test that triggers the API call and asserts that: (1) on success the UI reflects the result, (2) on error the UI shows an error message (not a blank page or console error). For the error case, verify the network response shape if the OpenAPI contract defines error responses.",
    archetype: "network-error",
  },
  {
    id: "ex-stateful-re-query",
    name: "Re-query after mutation",
    description: "Tests that after a write operation, re-reading the data shows the updated state",
    pattern: { kind: "stateful-cache", sourceType: "any", hasIndependentWritePath: true },
    template: "Generate a test that: (1) reads the current state, (2) performs a mutation through a DIFFERENT write path, (3) re-reads and asserts the state reflects the mutation. This catches stale caches, missing invalidations, and derived data that was not recomputed.",
    archetype: "re-query-after-mutation",
  },
  {
    id: "ex-data-list-empty",
    name: "Data list empty state",
    description: "Tests that a list/datatable shows appropriate empty state when there is no data",
    pattern: { kind: "data-list", hasFilter: false, hasPagination: false, hasEmptyState: true },
    template: "Generate a test that navigates to the list view when there is no data and asserts that the empty state message is shown (not a blank page, not a loading spinner forever, not a crash).",
    archetype: "empty-state",
  },
  {
    id: "ex-data-list-boundary",
    name: "Data list boundary values",
    description: "Tests pagination, filtering, and boundary edge cases of a data list",
    pattern: { kind: "data-list", hasFilter: true, hasPagination: true, hasEmptyState: false },
    template: "Generate a test that: (1) tests the list with exactly one item (boundary), (2) tests pagination (navigate to page 2, verify different data), (3) applies a filter and asserts the results match the filter criteria.",
    archetype: "boundary-value",
  },
];

export function matchExemplars(pattern: StructuralPattern): SkillExemplar[] {
  return BUILT_IN_EXEMPLARS.filter((e) => {
    if (e.pattern.kind !== pattern.kind) return false;

    switch (pattern.kind) {
      case "form": {
        const ep = e.pattern as { kind: "form"; hasOnSubmit: boolean; hasValidation: boolean };
        const pp = pattern as { kind: "form"; hasOnSubmit: boolean; hasValidation: boolean };
        return ep.hasOnSubmit === pp.hasOnSubmit && ep.hasValidation === pp.hasValidation;
      }
      case "api-call": {
        const pp = pattern as { kind: "api-call"; hasRequestBody: boolean; hasErrorHandling: boolean };
        return pp.hasRequestBody && pp.hasErrorHandling;
      }
      case "stateful-cache": {
        const pp = pattern as { kind: "stateful-cache"; hasIndependentWritePath: boolean };
        return pp.hasIndependentWritePath;
      }
      case "data-list":
        return true;
      default:
        return false;
    }
  });
}

export function renderExemplarsForPrompt(exemplars: SkillExemplar[]): string {
  if (exemplars.length === 0) return "";

  const lines = [
    "## Skill exemplars for the detected structural patterns",
    "Apply these test templates to the current change. Each is a proven pattern for this kind of code.",
    "",
  ];

  for (const e of exemplars) {
    lines.push(`### ${e.name} (${e.archetype})`);
    lines.push(e.template);
    lines.push("");
  }

  return lines.join("\n");
}
