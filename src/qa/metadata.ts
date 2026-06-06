// Standard per-test metadata (lives in the repo's e2e/.qa/manifest.json). It is
// what dedup, pruning, impact-based selection and merit hang off. Here we define
// the schema and its VALIDATION (part of Filter B): a test without valid metadata
// makes the run invalid. The measured/derived fields (coverage, sensitivity,
// ledger, merit) are filled by the system; the day-one fields (objective, flow,
// targets, changeRef) are written by the agent.

import { ManifestSchema } from "../orchestrator/schemas";

export interface QaTestMeta {
  id: string; // stable and unique (e.g. "checkout/over-10-items")
  objective: string; // acceptance criterion: "given X, when Y, then Z"
  flow: string; // user flow (e.g. "checkout")
  useCase?: string;
  targets: string[]; // INTENT: symbols/routes it aims to exercise (blast radius)
  changeRef: { sha: string; type: string; pr?: number; ticket?: string };
  criticality?: "critical" | "normal";
  owner?: string; // "qa-bot" | "human"
  createdAt?: string;

  // Measured/derived fields, populated by the system (not the agent); optional.
  coverage?: { files?: string[]; functions?: string[] }; // measured on the last run
  sensitivity?: { status: "pass" | "fail" | "unknown"; method?: string; at?: string };
  stability?: { runs: number; flakyRuns: number };
  ledger?: { caughtRegressions: number; falsePositives: number };
  merit?: number; // derived from the above (not a source value)
}

export interface ManifestValidation {
  ok: boolean;
  errors: string[];
}

// Validates the manifest (array of QaTestMeta). Requires only the day-one fields;
// the measured ones are optional. An empty array is valid (repo with no tests yet).
export function validateManifest(raw: unknown): ManifestValidation {
  if (!Array.isArray(raw)) {
    return { ok: false, errors: ["the manifest (e2e/.qa/manifest.json) must be an array"] };
  }

  const result = ManifestSchema.safeParse(raw);
  const errors: string[] = [];

  if (!result.success) {
    errors.push(...result.error.issues.map(formatZodIssue));
  }

  // Zod cannot check for duplicate IDs across array entries — do it manually.
  const ids = new Set<string>();
  raw.forEach((entry) => {
    const m = (entry ?? {}) as Record<string, unknown>;
    const id = typeof m.id === "string" ? m.id.trim() : "";
    if (id.length > 0) {
      if (ids.has(id)) {
        errors.push(`'${id}': duplicate id`);
      } else {
        ids.add(id);
      }
    }
  });

  return { ok: errors.length === 0, errors };
}

function formatZodIssue(issue: { path: PropertyKey[]; message: string }): string {
  const tag = issue.path.length > 0 ? `entry ${issue.path.join(".")}` : "manifest";
  return `${tag}: ${issue.message}`;
}
