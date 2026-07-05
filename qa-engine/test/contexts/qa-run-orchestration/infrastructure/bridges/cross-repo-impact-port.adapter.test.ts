// qa-engine/test/contexts/qa-run-orchestration/infrastructure/bridges/cross-repo-impact-port.adapter.test.ts
//
// Slice C (structural-signals-expansion, design §3.3/§3.4): CrossRepoImpactPortAdapter — the
// advisory cross-repo impact composition. Fake mirror registry + fake SandboxedBinaryRunner + fake
// VCS/CodeGraph collaborators, proving the design §3.4 algorithm end to end: the cheap pre-filter
// (step 0), the empty-links guard (step 0.5), the mirror-freshness fetch (step 1.5, MUST fire before
// the diff is read), tier-1 contract-file matching (step 3), tier-2 graph-expanded symbol matching
// with Result narrowing (step 4), and every fail-open branch (step 5 + thrown-exception guards).
//
// C-R1: fetch-before-diff-read ordering.
// C-R2: tier-1 + tier-2 matching, proper-subset output, correct tier tags.
// C-R3: every fail-open branch (absent mirror, unindexed mirror, empty diff, no matches, thrown
//       exceptions at any collaborator boundary).
// C-R4: the cheap pre-filter (FIX-6) — zero mirror/VCS/code-graph calls when no link matches.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CrossRepoImpactPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/cross-repo-impact-port.adapter.ts";
import type { ServiceLink } from "@contexts/qa-run-orchestration/application/ports/index.ts";
import type { MirrorRegistryPort } from "@kernel/ports/mirror-registry.port.ts";
import type { SandboxedBinaryRunner, SandboxedRunRequest, SandboxedRunResult } from "../../../../../src/shared-infrastructure/process-sandbox/sandboxed-binary-runner.ts";
import type { VcsReadPort } from "@contexts/change-analysis/application/ports/index.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";
import { ok } from "@kernel/result.ts";

// ── shared fixtures ─────────────────────────────────────────────────────────────────────────────
// A REAL on-disk temp directory, not a mock path — the mirror-existence check is real (existsSync),
// matching service-links-port.adapter.test.ts's own "stay honest about what existsSync actually
// sees" precedent.
const TRIGGER_REPO = "ArielFalcon/ms-name-restaurants";
const TRIGGER_SHA = "abc1234abc1234abc1234abc1234abc1234abcd";
let tmpRoot: string;
let MIRROR_DIR: string;

before(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "cross-repo-impact-"));
  MIRROR_DIR = join(tmpRoot, "ArielFalcon__ms-name-restaurants");
  mkdirSync(MIRROR_DIR, { recursive: true });
});

after(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

const matchingLink: ServiceLink = {
  from: { repo: "ArielFalcon/name-webapp", file: "src/restaurants.api.ts", symbol: "getRestaurants" },
  to: { repo: TRIGGER_REPO, file: "src/main/resources/api-definition.yaml", symbol: "getRestaurants" },
  transport: "http",
  contractRef: "getRestaurants",
  confidence: 1,
  source: "openapi",
};

const nonMatchingLink: ServiceLink = {
  from: { repo: "ArielFalcon/name-webapp", file: "src/orders.api.ts", symbol: "getOrders" },
  to: { repo: "ArielFalcon/ms-name-orders", file: "src/main/resources/api-definition.yaml", symbol: "getOrders" },
  transport: "http",
  contractRef: "getOrders",
  confidence: 1,
  source: "openapi",
};

class FakeMirrorRegistry implements MirrorRegistryPort {
  constructor(private readonly dirs: Record<string, string | undefined>) {}
  async mirrorDir(repo: string): Promise<string> {
    const dir = this.dirs[repo];
    if (dir === undefined) throw new Error(`FakeMirrorRegistry: no mirror configured for ${repo}`);
    return dir;
  }
}

class RecordingRunner implements SandboxedBinaryRunner {
  calls: SandboxedRunRequest[] = [];
  constructor(private readonly result: SandboxedRunResult = { exitCode: 0, stdout: "", stderr: "", timedOut: false }) {}
  async run(req: SandboxedRunRequest): Promise<SandboxedRunResult> {
    this.calls.push(req);
    return this.result;
  }
}

class FakeVcs implements VcsReadPort {
  diffCalls: Sha[] = [];
  constructor(
    private readonly blast: BlastRadius | null,
    private readonly onBlastRadius?: () => void,
  ) {}
  async diff(): Promise<string> { return ""; }
  async message(): Promise<string> { return ""; }
  async blastRadius(sha: Sha): Promise<BlastRadius> {
    this.diffCalls.push(sha);
    this.onBlastRadius?.();
    if (this.blast === null) throw new Error(`unknown revision or path not in the working tree: ${sha.toString()}`);
    return this.blast;
  }
}

class FakeCodeGraph implements CodeGraphPort {
  calls = 0;
  constructor(private readonly impacted: Awaited<ReturnType<CodeGraphPort["impactedSymbols"]>> = ok([])) {}
  async syncTo(): ReturnType<CodeGraphPort["syncTo"]> { return ok({ nodeCount: 0 }); }
  async impactedSymbols(): ReturnType<CodeGraphPort["impactedSymbols"]> { this.calls++; return this.impacted; }
  async coChangeCoupling(): ReturnType<CodeGraphPort["coChangeCoupling"]> { return ok([]); }
  async callersOf(): ReturnType<CodeGraphPort["callersOf"]> { return ok([]); }
  async existingCoverage(): ReturnType<CodeGraphPort["existingCoverage"]> { return ok([]); }
  async structurallyRelated(): ReturnType<CodeGraphPort["structurallyRelated"]> { return ok([]); }
}

function makeAdapter(opts: {
  mirrors: MirrorRegistryPort;
  vcs: VcsReadPort;
  codeGraph: CodeGraphPort;
  runner: SandboxedBinaryRunner;
}): CrossRepoImpactPortAdapter {
  return new CrossRepoImpactPortAdapter({
    mirrors: opts.mirrors,
    makeVcs: () => opts.vcs,
    codeGraph: opts.codeGraph,
    runner: opts.runner,
  });
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// C-R1: mirror-freshness fetch fires BEFORE the diff/blastRadius read (design C.4 step 1.5).
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("CrossRepoImpactPortAdapter — C-R1: fetch-before-diff ordering", () => {
  test("git fetch origin is invoked (via the shared runner + scrubEnv) BEFORE blastRadius reads the diff", async () => {
    const order: string[] = [];
    const runner = new RecordingRunner();
    const originalRun = runner.run.bind(runner);
    runner.run = async (req) => { order.push("fetch"); return originalRun(req); };

    const blast = BlastRadius.of(Sha.of(TRIGGER_SHA), ["src/main/resources/api-definition.yaml"]);
    const vcs = new FakeVcs(blast, () => order.push("blastRadius"));

    const adapter = makeAdapter({
      mirrors: new FakeMirrorRegistry({ [TRIGGER_REPO]: MIRROR_DIR }),
      vcs,
      codeGraph: new FakeCodeGraph(),
      runner,
    });

    await adapter.resolve(TRIGGER_REPO, TRIGGER_SHA, [matchingLink]);

    assert.deepEqual(order, ["fetch", "blastRadius"], "the fetch must fire before the diff is read — otherwise a freshly-pushed trigger sha may not exist in a stale mirror");
    assert.equal(runner.calls.length, 1, "exactly one fetch call expected");
    assert.equal(runner.calls[0]?.command, "git");
    assert.deepEqual(runner.calls[0]?.args, ["fetch", "origin"]);
    assert.equal(runner.calls[0]?.cwd, MIRROR_DIR);
    assert.equal(runner.calls[0]?.timeoutMs, 30_000);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// C-R2: tier-1 (contract-file) + tier-2 (impacted-symbol) matching with Result narrowing.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("CrossRepoImpactPortAdapter — C-R2: tiered matching", () => {
  test("a diff touching the OpenAPI contract file produces a tier-1 (contract-file) match", async () => {
    const blast = BlastRadius.of(Sha.of(TRIGGER_SHA), ["src/main/resources/api-definition.yaml"]);
    const vcs = new FakeVcs(blast);
    const adapter = makeAdapter({
      mirrors: new FakeMirrorRegistry({ [TRIGGER_REPO]: MIRROR_DIR }),
      vcs,
      codeGraph: new FakeCodeGraph(),
      runner: new RecordingRunner(),
    });

    const result = await adapter.resolve(TRIGGER_REPO, TRIGGER_SHA, [matchingLink, nonMatchingLink]);

    assert.ok(result, "a contract-file match must produce a non-null result");
    assert.equal(result!.impactedLinks.length, 1, "must be a PROPER SUBSET — the non-matching-repo link must be excluded");
    assert.equal(result!.impactedLinks[0]?.tier, "contract-file");
    assert.deepEqual(result!.impactedLinks[0]?.link, matchingLink);
  });

  test("an impacted symbol matching link.contractRef produces a tier-2 (impacted-symbol) match, via Result narrowing", async () => {
    const blast = BlastRadius.of(Sha.of(TRIGGER_SHA), ["src/main/java/RestaurantsController.java"]);
    const vcs = new FakeVcs(blast);
    const codeGraph = new FakeCodeGraph(ok([{ file: "src/main/java/RestaurantsController.java", symbol: "getRestaurants" }]));
    const adapter = makeAdapter({
      mirrors: new FakeMirrorRegistry({ [TRIGGER_REPO]: MIRROR_DIR }),
      vcs,
      codeGraph,
      runner: new RecordingRunner(),
    });

    const result = await adapter.resolve(TRIGGER_REPO, TRIGGER_SHA, [matchingLink, nonMatchingLink]);

    assert.ok(result, "an impacted-symbol match must produce a non-null result");
    assert.equal(result!.impactedLinks.length, 1);
    assert.equal(result!.impactedLinks[0]?.tier, "impacted-symbol");
    assert.deepEqual(result!.impactedLinks[0]?.link, matchingLink);
    assert.equal(codeGraph.calls, 1, "impactedSymbols must have been called exactly once");
  });

  test("output is a PROPER SUBSET (never a superset) of the input links, even when every link matches", async () => {
    const secondMatchingLink: ServiceLink = {
      ...matchingLink,
      from: { repo: "ArielFalcon/name-webapp", file: "src/restaurants.api.ts", symbol: "listRestaurants" },
      contractRef: "listRestaurants",
    };
    const blast = BlastRadius.of(Sha.of(TRIGGER_SHA), ["src/main/resources/api-definition.yaml"]);
    const vcs = new FakeVcs(blast);
    const adapter = makeAdapter({
      mirrors: new FakeMirrorRegistry({ [TRIGGER_REPO]: MIRROR_DIR }),
      vcs,
      codeGraph: new FakeCodeGraph(),
      runner: new RecordingRunner(),
    });

    const result = await adapter.resolve(TRIGGER_REPO, TRIGGER_SHA, [matchingLink, secondMatchingLink]);

    assert.ok(result);
    assert.equal(result!.impactedLinks.length, 2, "both matching links must be included, but never more than the input set");
    assert.ok(result!.impactedLinks.every((il) => [matchingLink, secondMatchingLink].includes(il.link)), "every output link must be one of the input links — never a fabricated one");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// C-R3: every fail-open branch.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("CrossRepoImpactPortAdapter — C-R3: fail-open branches", () => {
  test("an absent mirror dir (existsSync false) degrades to null", async () => {
    const adapter = makeAdapter({
      mirrors: new FakeMirrorRegistry({ [TRIGGER_REPO]: "/mirrors/does-not-exist-on-disk" }),
      vcs: new FakeVcs(null),
      codeGraph: new FakeCodeGraph(),
      runner: new RecordingRunner(),
    });

    const result = await adapter.resolve(TRIGGER_REPO, TRIGGER_SHA, [matchingLink]);

    assert.equal(result, null, "an absent mirror directory must degrade to null, never throw");
  });

  test("an unindexed mirror (impactedSymbols returns ok([])) with a non-contract diff degrades to null (tier-1-only outcome, not an error)", async () => {
    const blast = BlastRadius.of(Sha.of(TRIGGER_SHA), ["src/main/java/UnrelatedController.java"]);
    const vcs = new FakeVcs(blast);
    const adapter = makeAdapter({
      mirrors: new FakeMirrorRegistry({ [TRIGGER_REPO]: MIRROR_DIR }),
      vcs,
      codeGraph: new FakeCodeGraph(ok([])),
      runner: new RecordingRunner(),
    });

    const result = await adapter.resolve(TRIGGER_REPO, TRIGGER_SHA, [matchingLink]);

    assert.equal(result, null, "no contract-file hit and an empty impacted-symbol set must degrade to null, not throw");
  });

  test("an empty diff (blastRadius resolves to an empty BlastRadius) degrades to null", async () => {
    const emptyBlast = BlastRadius.of(Sha.of(TRIGGER_SHA), []);
    const vcs = new FakeVcs(emptyBlast);
    const adapter = makeAdapter({
      mirrors: new FakeMirrorRegistry({ [TRIGGER_REPO]: MIRROR_DIR }),
      vcs,
      codeGraph: new FakeCodeGraph(),
      runner: new RecordingRunner(),
    });

    const result = await adapter.resolve(TRIGGER_REPO, TRIGGER_SHA, [matchingLink]);

    assert.equal(result, null, "an empty BlastRadius must degrade to null before any matching is attempted");
  });

  test("no matches at all (diff touches neither the contract file nor an impacted symbol) degrades to null", async () => {
    const blast = BlastRadius.of(Sha.of(TRIGGER_SHA), ["src/main/java/UnrelatedController.java"]);
    const vcs = new FakeVcs(blast);
    const adapter = makeAdapter({
      mirrors: new FakeMirrorRegistry({ [TRIGGER_REPO]: MIRROR_DIR }),
      vcs,
      codeGraph: new FakeCodeGraph(ok([{ file: "x", symbol: "unrelatedMethod" }])),
      runner: new RecordingRunner(),
    });

    const result = await adapter.resolve(TRIGGER_REPO, TRIGGER_SHA, [matchingLink]);

    assert.equal(result, null, "zero matches must degrade to null");
  });

  test("blastRadius throwing (bad/unknown sha) is caught and degrades to null, never propagates", async () => {
    const vcs = new FakeVcs(null); // null blast => FakeVcs.blastRadius throws "unknown revision"
    const adapter = makeAdapter({
      mirrors: new FakeMirrorRegistry({ [TRIGGER_REPO]: MIRROR_DIR }),
      vcs,
      codeGraph: new FakeCodeGraph(),
      runner: new RecordingRunner(),
    });

    const result = await adapter.resolve(TRIGGER_REPO, TRIGGER_SHA, [matchingLink]);

    assert.equal(result, null, "a thrown blastRadius error must be caught at the composition boundary and degrade to null");
  });

  test("a thrown exception inside graph expansion (impactedSymbols itself throws, not a Result err) is caught and degrades to null", async () => {
    const blast = BlastRadius.of(Sha.of(TRIGGER_SHA), ["src/main/java/RestaurantsController.java"]);
    const vcs = new FakeVcs(blast);
    class ThrowingCodeGraph extends FakeCodeGraph {
      override async impactedSymbols(): ReturnType<CodeGraphPort["impactedSymbols"]> {
        throw new Error("codebase-memory-mcp CLI crashed");
      }
    }
    const throwingCodeGraph: CodeGraphPort = new ThrowingCodeGraph();
    const adapter = makeAdapter({
      mirrors: new FakeMirrorRegistry({ [TRIGGER_REPO]: MIRROR_DIR }),
      vcs,
      codeGraph: throwingCodeGraph,
      runner: new RecordingRunner(),
    });

    const result = await adapter.resolve(TRIGGER_REPO, TRIGGER_SHA, [matchingLink]);

    assert.equal(result, null, "a thrown graph-expansion error must never propagate past resolve()");
  });

  test("mirrors.mirrorDir() itself rejecting is caught at the whole-resolve() level and degrades to null", async () => {
    const rejectingMirrors: MirrorRegistryPort = {
      mirrorDir: async () => { throw new Error("mirror registry unreachable"); },
    };
    const adapter = makeAdapter({
      mirrors: rejectingMirrors,
      vcs: new FakeVcs(null),
      codeGraph: new FakeCodeGraph(),
      runner: new RecordingRunner(),
    });

    const result = await adapter.resolve(TRIGGER_REPO, TRIGGER_SHA, [matchingLink]);

    assert.equal(result, null, "resolve() must never throw past its own boundary, regardless of which collaborator failed");
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// C-R4: the cheap pre-filter (FIX-6) — zero collaborator calls when no link matches the trigger repo.
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("CrossRepoImpactPortAdapter — C-R4: cheap pre-filter", () => {
  test("when no resolvedLinks entry has to.repo === triggerRepo, resolve() returns null WITHOUT calling mirrors/VCS/code-graph at all", async () => {
    let mirrorDirCalls = 0;
    const countingMirrors: MirrorRegistryPort = {
      mirrorDir: async (repo: string) => { mirrorDirCalls++; return `/mirrors/${repo}`; },
    };
    let vcsCalls = 0;
    const countingVcs: VcsReadPort = {
      diff: async () => { vcsCalls++; return ""; },
      message: async () => { vcsCalls++; return ""; },
      blastRadius: async () => { vcsCalls++; throw new Error("must never be called"); },
    };
    const codeGraph = new FakeCodeGraph();
    const runner = new RecordingRunner();

    const adapter = new CrossRepoImpactPortAdapter({
      mirrors: countingMirrors,
      makeVcs: () => countingVcs,
      codeGraph,
      runner,
    });

    // TRIGGER_REPO does not match either link's `to.repo` (both target OTHER services).
    const result = await adapter.resolve(TRIGGER_REPO, TRIGGER_SHA, [nonMatchingLink]);

    assert.equal(result, null, "no-match must degrade to null");
    assert.equal(mirrorDirCalls, 0, "mirrors.mirrorDir() must never be called on the cheap pre-filter path");
    assert.equal(vcsCalls, 0, "no VCS method must ever be called on the cheap pre-filter path");
    assert.equal(codeGraph.calls, 0, "codeGraph.impactedSymbols() must never be called on the cheap pre-filter path");
    assert.equal(runner.calls.length, 0, "the fetch step must never fire on the cheap pre-filter path");
  });

  test("an empty resolvedLinks array also short-circuits to null without any collaborator call (step 0.5)", async () => {
    let mirrorDirCalls = 0;
    const countingMirrors: MirrorRegistryPort = {
      mirrorDir: async () => { mirrorDirCalls++; return MIRROR_DIR; },
    };
    const adapter = new CrossRepoImpactPortAdapter({
      mirrors: countingMirrors,
      makeVcs: () => new FakeVcs(null),
      codeGraph: new FakeCodeGraph(),
      runner: new RecordingRunner(),
    });

    const result = await adapter.resolve(TRIGGER_REPO, TRIGGER_SHA, []);

    assert.equal(result, null);
    assert.equal(mirrorDirCalls, 0, "an empty links array must short-circuit before any mirror lookup");
  });
});
