// src/contexts/qa-run-orchestration/composition/pipeline-engine-flag.ts
// Plan 7.6 (cutover finale): the legacy engine has been DELETED — there is no LegacyPipelineAdapter
// to select anymore. selectEngine now ALWAYS resolves to "rewritten"; the PIPELINE_ENGINE env var is
// accepted-but-ignored for backward compatibility with any operator tooling that still sets it. A
// deprecation warning is emitted once when PIPELINE_ENGINE=legacy is explicitly set, since that value
// can no longer be honored (there is nothing left to select).
export const PIPELINE_ENGINE = "PIPELINE_ENGINE" as const;
export type EngineChoice = "rewritten";

let warnedLegacyRequested = false;

// Always returns "rewritten" — the sole engine post-cutover. PIPELINE_ENGINE is read only to warn
// an operator who still explicitly requests "legacy" (a value that no longer has an implementation).
export function selectEngine(env: Record<string, string | undefined>): EngineChoice {
  if (env[PIPELINE_ENGINE] === "legacy" && !warnedLegacyRequested) {
    warnedLegacyRequested = true;
    console.warn(
      "[qa] PIPELINE_ENGINE=legacy was requested but the legacy engine was removed in Plan 7.6 — running the rewritten engine instead.",
    );
  }
  return "rewritten";
}
