// src/contexts/qa-run-orchestration/composition/pipeline-engine-flag.ts
// PIPELINE_ENGINE selects LegacyPipelineAdapter (default) vs RewrittenOrchestratorAdapter behind
// RunPipelinePort (design §7.3 Step 2). DEFAULT legacy — the shadow seam, NOT the cutover. Plan 6 never
// ships rewritten as the default; the cutover (flip default) is Plan 7, justified by the Slice F evidence.
export const PIPELINE_ENGINE = "PIPELINE_ENGINE" as const;
export type EngineChoice = "legacy" | "rewritten";

// Fail-safe: any value other than the EXACT string "rewritten" (absent, "legacy", casing, whitespace,
// garbage) selects the legacy engine. The rewritten engine is opt-in only, never a fallback.
export function selectEngine(env: Record<string, string | undefined>): EngineChoice {
  return env[PIPELINE_ENGINE] === "rewritten" ? "rewritten" : "legacy";
}
