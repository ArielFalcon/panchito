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
//
// options.baseDir (judgment-day round-1): pinned to the repo root, NOT left to default to
// process.cwd(). This fixes the `from`/`to` RULE-MATCHING regexes (anchored to
// "qa-engine/src/"/"^src/") so they resolve against repo-root-relative module ids no matter which
// directory the command is invoked from — see qa-engine/test/arch/no-src-import.test.ts's
// cwd=qa-engine/ variant.
//
// CONTRACT (judgment-day round-2 — the round-1 fix did NOT make every invocation form safe, only
// baseDir-relative ones): because baseDir is pinned to the repo root, dependency-cruiser ALSO
// resolves the CLI's own TARGET ARGUMENT against that same baseDir, not against the invoking cwd —
// so the target must itself be baseDir-relative ("qa-engine/src"), regardless of cwd. A bare
// relative target like `src`, run from inside qa-engine/ (e.g. `cd qa-engine && npx depcruise
// --config .dependency-cruiser.cjs src`), resolves as `<repo-root>/src` — the LEGACY root src/
// tree, a completely different, still-existing directory — not qa-engine/src. This does not error;
// it silently scans the wrong tree and reports a false "clean" even with a real qa-engine/src/
// violation present, because none of that tree's module ids match the `^qa-engine/src/` `from`
// pattern. Reproduced: 392 modules cruised (root src/) vs. 172 modules (qa-engine/src) on
// otherwise-identical HEAD. The canonical invocation is `npm run arch:check` FROM THE REPO ROOT
// (root package.json); from a subtree with its own package.json (qa-engine/, web/, packages/*)
// npm resolves the nearest manifest and fails LOUDLY with "Missing script" — an error, never a
// silent wrong-tree scan. The always-enforced gate is qa-engine/test/arch/ inside `npm test`,
// which pins its own cwd and is invocation-independent.
const path = require("node:path");

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
    {
      // migration-tier-1-2, Slice 5 (corrected judgment-day round-1: the prior comment's "ONLY
      // sanctioned src<->qa-engine bridge" framing was stale/inaccurate). The direction actually
      // enforced here is ONE-WAY: qa-engine/src/ may never import src/ (below). The OPPOSITE
      // direction — src/ importing qa-engine/src/ — is open by design (the shell consumes the
      // engine, not the reverse) and is NOT machine-enforced by this rule; src/server/
      // rewritten-engine-factory.ts (the composition factory) is one such importer, but not the
      // only one — src/integrations/repo-mirror.ts (MirrorProvisionAdapter, migration-tier-4a),
      // src/orchestrator/sanitizer.ts, src/server/webhook-routing.ts, and src/contract/{commands,
      // events}.ts all predate or postdate it and import qa-engine/src/ deliberately too. `*-parity.
      // test.ts` files under qa-engine/test/ (pre-deletion pins) are also outside this rule's
      // `from` scope (qa-engine/src/ only), so none of the above ever trips this gate.
      name: "no-src-import-in-qa-engine",
      severity: "error",
      comment: "No qa-engine production module may import src/ — qa-engine stays src-free by construction; the composition factory in src/server/ is the sole bridge.",
      from: { path: "^qa-engine/src/" },
      to: { path: "^src/" },
    },
  ],
  options: {
    // Repo root, regardless of the invoking cwd — see the header note above.
    baseDir: path.resolve(__dirname, ".."),
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
