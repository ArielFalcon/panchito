// qa-engine/.dependency-cruiser.cjs
// Structural security invariant (§8 R4): the agent is READ-ONLY on watched repos; only the
// workspace-and-publication context may import the VCS write seam. The rule is inverted: deny the
// VcsWritePort import from EVERY context path that is NOT workspace-and-publication. This is broader
// than the prior generation|agent-runtime allowlist — it covers any new context added in future plans
// without requiring a whitelist update.
//
// ONE deliberate, narrow exemption (Task E.2): the qa-run-orchestration COMPOSITION ROOT
// (composition-root.ts) is, per the plan's own design (§5.2), "the ONLY module that imports
// concrete adapters" — it is where the REAL PublishDecisionService/GitHubPrAdapter/
// GitHubIssueAdapter/ShadowLogAdapter instances are constructed and passed into the
// PublicationPortAdapter bridge (which itself stays exempt-free — see its own header note on
// depending only on LOCAL structural interfaces). Every OTHER path under qa-run-orchestration/
// (the bridges, the domain, the application layer) remains DENIED — only the single composition
// file is excepted, so a future bridge/domain/use-case addition is still secure by default.
// Known limitation: dependency-cruiser may miss dynamic import() — flagged for manual audit.
module.exports = {
  forbidden: [
    {
      name: "no-vcs-write-in-agent-contexts",
      severity: "error",
      comment: "Only workspace-and-publication (and the qa-run-orchestration composition root, its one declared exception) may import the VCS write seam. All other contexts/* paths are denied — this rule is inverted so new contexts are secure by default without a whitelist update.",
      from: {
        path: "qa-engine/src/contexts/(?!workspace-and-publication)",
        pathNot: "qa-engine/src/contexts/qa-run-orchestration/composition/composition-root\\.ts$",
      },
      to: { path: "contexts/workspace-and-publication" },
    },
  ],
  options: {
    // Use the root tsconfig (no composite flag) so the run works from the repo root.
    // The root tsconfig carries the same @kernel/@contexts/@interface path aliases as
    // qa-engine/tsconfig.json, so alias-based imports are resolved correctly.
    tsConfig: { fileName: "tsconfig.json" },
    // Include pre-compilation (type-only) imports so `import type { VcsWritePort } from ...`
    // is treated as a dependency and the gate catches structural type leaks, not just runtime ones.
    tsPreCompilationDeps: true,
    doNotFollow: { path: "node_modules" },
    enhancedResolveOptions: { extensions: [".ts"] },
  },
};
