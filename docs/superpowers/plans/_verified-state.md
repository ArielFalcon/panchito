# Verified current-state (HEAD as of implementation)

- runPipeline: src/pipeline.ts:828 ; file 3179 lines
- characterization scenarios: pipeline.test.ts 184 + pipeline-codex.test.ts 4 = 188
- decideCoverage: src/qa/change-coverage.ts:173 ; blocksPublish: :179
- RunOutcome: src/types.ts:216
- node: v24.11.0

These numbers supersede the spec's stale snapshot. Re-run Task 1's commands if more than a few days elapse.

## Frozen boundaries (Plans 1–6)
- DO NOT edit `PipelineDeps` interface or `runPipeline` signature in src/pipeline.ts.
- DO NOT run `npm run contract:gen` unless making a deliberate, versioned API change.
