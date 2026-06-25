// qa-engine/.dependency-cruiser.cjs
// Structural security invariant (§8 R4): generation/* and agent-runtime/* are the agent-facing
// contexts; the agent is READ-ONLY on watched repos, so neither may reach the write seam. This rule
// forbids any module under those two contexts from importing ANYTHING from workspace-and-publication
// (barrel, port, or adapter) — catching VcsWritePort regardless of how it is re-exported.
// Known limitation: dependency-cruiser may miss dynamic import() — flagged for manual audit.
module.exports = {
  forbidden: [
    {
      name: "no-vcs-write-in-agent-contexts",
      severity: "error",
      comment: "generation/* and agent-runtime/* must never import from workspace-and-publication (agent-is-read-only). Matches barrel, ports, and any future adapter — not just the specific write adapter filename.",
      from: { path: "qa-engine/src/contexts/(generation|agent-runtime)/" },
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
