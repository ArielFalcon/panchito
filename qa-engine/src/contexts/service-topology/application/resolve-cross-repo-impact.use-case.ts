// qa-engine/src/contexts/service-topology/application/resolve-cross-repo-impact.use-case.ts
//
// Slice C (structural-signals-expansion, design §3.3/§3.4): the pure algorithm behind
// CrossRepoImpactPort — domain-typed (ServiceLink/ContractDrift/CrossRepoImpact live in
// ../domain/index.ts and ./cross-repo-impact.ts), no barrel/qa-run-orchestration import. The
// infrastructure bridge (qa-run-orchestration/infrastructure/bridges/cross-repo-impact-port.adapter.ts)
// wraps THIS use-case and performs the structural cast to the barrel's port-local mirrors.
//
// Fresh per-service collaborators (NOT the pinned-to-primary-repoDir StructuralSignalPortAdapter
// pattern): a per-service VcsReadPort (via makeVcs factory) and a repo-agnostic CodeGraphPort,
// because the triggering service is a DIFFERENT repo per run, unlike StructuralSignalPort's
// static-repoDir posture.
//
// Algorithm (design C.4), fully fail-open — resolve() NEVER throws:
//   0.   cheap pre-filter: no resolvedLink targets triggerRepo -> null (skip every collaborator hop).
//   0.5. empty resolvedLinks -> null (subsumed by step 0's filter — an empty set has no match).
//   1.   mirror dir must exist on disk -> absent -> null (mirror not cloned).
//   1.5. best-effort `git fetch origin` (mirror-freshness) via the runner, BEFORE the diff read —
//        result deliberately unread (fail-open: a failed fetch falls through to step 2, which then
//        either throws on an unknown sha [caught -> null] or succeeds against whatever's on disk).
//   2.   blastRadius(triggerSha) — throws on bad/unknown sha -> caught -> null; empty diff -> null.
//   3.   TIER 1 — direct contract-file match: blast.changedFiles includes link.to.file.
//   4.   TIER 2 — graph-expanded symbol match: codeGraph.impactedSymbols(...), Result-narrowed
//        (`res.ok ? res.value : []`), joined on link.contractRef ?? link.to.symbol.
//   5.   zero matches -> null.
//   7.   return the PROPER SUBSET with tier tags.
import { existsSync } from "node:fs";
import type { BlastRadius } from "../../../shared-kernel/blast-radius.ts";
import { Sha } from "../../../shared-kernel/sha.ts";
import type { CodeGraphPort } from "../../../shared-kernel/ports/code-graph.port.ts";
import type { SandboxedBinaryRunner } from "../../../shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import { scrubEnv } from "../../../shared-infrastructure/process-sandbox/scrub-env.ts";
import type { ServiceLink } from "../domain/index.ts";
import { MATCH_TIER, type CrossRepoImpact, type ImpactedLink } from "../domain/cross-repo-impact.ts";

/** The minimal read-side VCS surface this use-case needs — matches VcsReadPort's own blastRadius
 *  signature (change-analysis/application/ports/index.ts) without importing that context; a
 *  structural (not nominal) match, satisfied by GitMirrorReadAdapter without a cast. */
export interface CrossRepoVcsRead {
  blastRadius(sha: Sha): Promise<BlastRadius>;
}

export interface MirrorRegistryLike {
  mirrorDir(repo: string): Promise<string>;
}

const FETCH_TIMEOUT_MS = 30_000;

export class ResolveCrossRepoImpactUseCase {
  constructor(
    private readonly mirrors: MirrorRegistryLike,
    private readonly makeVcs: (repoDir: string) => CrossRepoVcsRead,
    private readonly codeGraph: CodeGraphPort,
    private readonly runner: SandboxedBinaryRunner,
  ) {}

  async resolve(triggerRepo: string, triggerSha: string, resolvedLinks: readonly ServiceLink[]): Promise<CrossRepoImpact | null> {
    try {
      // Step 0: cheap pre-filter (design C.4/C.8 FIX-6) — skip every subsequent hop (mirror lookup,
      // fetch, diff read, graph query) when nothing in the resolved link set even targets this repo.
      // Subsumes design step 0.5's empty-links guard: an empty set has no matching link.
      const candidateLinks = resolvedLinks.filter((l) => l.to.repo === triggerRepo);
      if (candidateLinks.length === 0) return null;

      // Step 1: the mirror must exist ON DISK — cloning is the cross-repo-run's job, not this seam's.
      const mirrorDir = await this.mirrors.mirrorDir(triggerRepo);
      if (!existsSync(mirrorDir)) return null;

      // Step 1.5: best-effort mirror-freshness fetch, BEFORE the diff is read. Fail-open by
      // construction: exitCode/timedOut are deliberately UNREAD here — a failed/timed-out fetch
      // falls through to step 2 with whatever's already on disk (blastRadius's own throw-on-
      // unknown-sha is the real safety net one step later, caught by this method's own try/catch).
      await this.runner.run({
        command: "git",
        args: ["fetch", "origin"],
        cwd: mirrorDir,
        env: scrubEnv(),
        timeoutMs: FETCH_TIMEOUT_MS,
      });

      // Step 2: read the triggering service's OWN diff from ITS OWN mirror (never the run's own
      // diff — Slice C is self-sourced). blastRadius throws on an unknown/bad sha; that throw is
      // caught by this method's OWN try/catch below, degrading to null.
      const vcs = this.makeVcs(mirrorDir);
      const blast = await vcs.blastRadius(Sha.of(triggerSha));
      if (blast.isEmpty) return null;

      const impactedLinks: ImpactedLink[] = [];
      const matchedKeys = new Set<string>();

      // Step 3: TIER 1 — direct contract-file match (deterministic). The OpenAPI contract file
      // changing means EVERY operation it declares may have shifted.
      for (const link of candidateLinks) {
        if (blast.changedFiles.includes(link.to.file)) {
          impactedLinks.push({ link, tier: MATCH_TIER.CONTRACT_FILE });
          matchedKeys.add(this.linkKey(link));
        }
      }

      // Step 4: TIER 2 — graph-expanded symbol match (heuristic), Result-narrowed per the REAL idiom
      // (structural-signal-port.adapter.ts's own safeImpacted: `res.ok ? res.value : []`).
      const impactedRes = await this.codeGraph.impactedSymbols(mirrorDir, blast, { depth: 3 });
      const impactedSyms = impactedRes.ok ? impactedRes.value : [];
      const symNames = new Set(impactedSyms.map((s) => s.symbol));
      for (const link of candidateLinks) {
        if (matchedKeys.has(this.linkKey(link))) continue; // already tier-1, don't downgrade/duplicate
        const joinKey = link.contractRef ?? link.to.symbol;
        if (symNames.has(joinKey)) {
          impactedLinks.push({ link, tier: MATCH_TIER.IMPACTED_SYMBOL });
          matchedKeys.add(this.linkKey(link));
        }
      }

      // Step 5: zero matches -> null (not an error; a legitimate "nothing impacted" outcome).
      if (impactedLinks.length === 0) return null;

      // Step 7: return the PROPER SUBSET with tier tags. Tier-3 front expansion (serviceImpacted)
      // is deferred for v1 (design C.5) — never populated here.
      return { impactedLinks };
    } catch (err) {
      console.error("[qa] WARNING: cross-repo impact resolution failed (non-fatal, advisory-only):", err);
      return null;
    }
  }

  private linkKey(link: ServiceLink): string {
    return `${link.from.repo}/${link.from.file}#${link.from.symbol}->${link.to.repo}`;
  }
}
