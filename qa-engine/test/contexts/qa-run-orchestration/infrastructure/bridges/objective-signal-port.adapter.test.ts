// test/contexts/qa-run-orchestration/infrastructure/bridges/objective-signal-port.adapter.test.ts
// ObjectiveSignalPortAdapter composes the REAL keystone collaborators — CoverageCollectorPort.collect
// (raw covered lines), the assembler (diff + raw CoverageReport -> ChangeCoverage read-model),
// DecideCoverageService.decide (the keystone: unknown NEVER blocks — consumed VERBATIM, never
// reimplemented) and ValueOraclePort.measure (the mutation-testing / fault-injection valueScore).
// THIN — no new coverage-ratio logic added here.
//
// The assembler is wired via qa-engine/src/contexts/objective-signal/domain/assemble-change-coverage.ts
// (a pure port of legacy parseDiffHunks + computeChangeCoverage — see that module's own tests for the
// port's own correctness). This suite exercises the BRIDGE: diff present + assembler -> real
// status/ratio; diff absent -> unknown; assembler absent -> unknown; the namespace fix; and the
// changedFiles threading into collect()'s optional trailing arg.
import { test } from "node:test";
import assert from "node:assert/strict";
import { ObjectiveSignalPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/objective-signal-port.adapter.ts";
import { DecideCoverageService, type ChangeCoverage } from "@contexts/objective-signal/domain/decide-coverage.service.ts";
import { assembleChangeCoverage } from "@contexts/objective-signal/domain/assemble-change-coverage.ts";
import type { CoverageCollectorPort, ValueOraclePort, CoverageReport, ValueOracleResult } from "@contexts/objective-signal/application/ports/index.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";

function fakeCollector(report: CoverageReport, onCollect?: (specDir: string, namespace: string, changedFiles?: string[]) => void): CoverageCollectorPort {
  return {
    collect: async (specDir, namespace, changedFiles) => {
      onCollect?.(specDir, namespace, changedFiles);
      return report;
    },
  };
}
function fakeOracle(result: ValueOracleResult): ValueOraclePort {
  return { measure: async () => result };
}

const SAMPLE_DIFF = [
  "diff --git a/src/checkout.ts b/src/checkout.ts",
  "+++ b/src/checkout.ts",
  "@@ -1,0 +1,2 @@",
  "+a",
  "+b",
].join("\n");

test("measure() returns unknown+null when no ChangeCoverage assembler is injected (keystone-safe default)", async () => {
  const collector = fakeCollector({ covered: [{ file: "src/checkout.ts", lines: [1, 2, 3] }] });
  const decide = new DecideCoverageService();
  const oracle = fakeOracle({ valueScore: null, mutantCount: 0, killedCount: 0, details: "" });
  const adapter = new ObjectiveSignalPortAdapter({ collector, decide, oracle }, { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app" });

  const br = BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]);
  const result = await adapter.measure(br, "/mirrors/org/app/e2e", SAMPLE_DIFF);

  assert.equal(result.status, "unknown");
  assert.equal(result.ratio, null);
});

test("measure() returns unknown+null when an assembler IS injected but diff is absent (non-diff modes)", async () => {
  const collector = fakeCollector({ covered: [{ file: "src/checkout.ts", lines: [1, 2] }] });
  const decide = new DecideCoverageService();
  const oracle = fakeOracle({ valueScore: null, mutantCount: 0, killedCount: 0, details: "" });
  const adapter = new ObjectiveSignalPortAdapter(
    { collector, decide, oracle },
    { policy: { mode: "enforce", minRatio: 0.7 }, repoDir: "/mirrors/org/app", assembleChangeCoverage },
  );

  const br = BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]);
  const result = await adapter.measure(br, "/mirrors/org/app/e2e"); // no diff argument

  assert.equal(result.status, "unknown", "an assembler with no diff must never fabricate a status");
  assert.equal(result.ratio, null);
});

test("measure() short-circuits the collector's IO entirely when no assembly will happen (judgment-day: legacy keeps collection INSIDE the gated block, src/pipeline.ts:2912)", async () => {
  let collectCalls = 0;
  const collector = fakeCollector({ covered: [{ file: "src/checkout.ts", lines: [1, 2] }] }, () => { collectCalls++; });
  const decide = new DecideCoverageService();
  const oracle = fakeOracle({ valueScore: 0.5, mutantCount: 2, killedCount: 1, details: "" });
  const br = BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]);

  // Case 1: assembler wired, diff absent (non-diff modes / cross-repo starved diff) -> no collection.
  const withAssembler = new ObjectiveSignalPortAdapter(
    { collector, decide, oracle },
    { policy: { mode: "enforce", minRatio: 0.7 }, repoDir: "/mirrors/org/app", assembleChangeCoverage },
  );
  const starved = await withAssembler.measure(br, "/mirrors/org/app/e2e");
  assert.equal(collectCalls, 0, "no diff -> the collector's real IO must be skipped, not run-and-discarded");
  assert.equal(starved.status, "unknown");
  assert.equal(starved.valueScore, 0.5, "the value-oracle still runs — only coverage collection is skipped (legacy parity)");

  // Case 2: no assembler wired -> no collection either.
  const withoutAssembler = new ObjectiveSignalPortAdapter(
    { collector, decide, oracle },
    { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app" },
  );
  await withoutAssembler.measure(br, "/mirrors/org/app/e2e", SAMPLE_DIFF);
  assert.equal(collectCalls, 0, "no assembler -> the collector's real IO must be skipped");

  // Control: assembler + diff -> collection happens exactly once.
  await withAssembler.measure(br, "/mirrors/org/app/e2e", SAMPLE_DIFF);
  assert.equal(collectCalls, 1, "assembler + diff -> collection runs (the only consumer of the report)");
});

test("measure() delegates to the injected ChangeCoverageAssembler + DecideCoverageService.decide verbatim", async () => {
  const collector = fakeCollector({ covered: [{ file: "src/checkout.ts", lines: [1, 2] }] });
  const decide = new DecideCoverageService();
  const oracle = fakeOracle({ valueScore: null, mutantCount: 0, killedCount: 0, details: "" });
  const spy = (diff: string, report: CoverageReport): ChangeCoverage => assembleChangeCoverage(diff, report);
  const adapter = new ObjectiveSignalPortAdapter(
    { collector, decide, oracle },
    { policy: { mode: "enforce", minRatio: 0.7 }, repoDir: "/mirrors/org/app", assembleChangeCoverage: spy },
  );

  const br = BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]);
  const result = await adapter.measure(br, "/mirrors/org/app/e2e", SAMPLE_DIFF);

  assert.equal(result.status, "pass");
  assert.equal(result.ratio, 1);
});

test("measure() surfaces valueScore from the injected ValueOraclePort (the mutation-testing keystone companion)", async () => {
  const collector = fakeCollector({ covered: [] });
  const decide = new DecideCoverageService();
  const oracle = fakeOracle({ valueScore: 0.85, mutantCount: 20, killedCount: 17, details: "17/20 mutants killed" });
  const adapter = new ObjectiveSignalPortAdapter({ collector, decide, oracle }, { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app" });

  const br = BlastRadius.of(Sha.of("abc1234"), ["src/checkout.ts"]);
  const result = await adapter.measure(br, "/mirrors/org/app/e2e");

  assert.equal(result.valueScore, 0.85);
});

// ── NAMESPACE FIX ──────────────────────────────────────────────────────────────────────────────

// Collection is observable ONLY on the assemble path (assembler wired + diff supplied): the
// judgment-day short-circuit skips collect() entirely otherwise (see the short-circuit test above),
// exactly like the legacy keeps collection INSIDE the `!triggerService`-gated block. These
// threading tests therefore always wire the real assembler and pass a diff.

test("measure() uses ctx.namespace (the SAME per-run namespace ExecutionPortAdapter uses), not br.sha.toString()", async () => {
  const seenNamespaces: string[] = [];
  const collector = fakeCollector({ covered: [] }, (_specDir, namespace) => seenNamespaces.push(namespace));
  const decide = new DecideCoverageService();
  const oracle = fakeOracle({ valueScore: null, mutantCount: 0, killedCount: 0, details: "" });
  const adapter = new ObjectiveSignalPortAdapter(
    { collector, decide, oracle },
    { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app", namespace: "qa-bot-abc1234", assembleChangeCoverage },
  );

  const br = BlastRadius.of(Sha.of("abc1234"), []);
  await adapter.measure(br, "/mirrors/org/app/e2e", SAMPLE_DIFF);

  assert.deepEqual(seenNamespaces, ["qa-bot-abc1234"], "the collector must be queried under the SAME namespace execution wrote dumps to");
});

test("measure() falls back to br.sha.toString() when ctx.namespace is absent (backward compatible)", async () => {
  const seenNamespaces: string[] = [];
  const collector = fakeCollector({ covered: [] }, (_specDir, namespace) => seenNamespaces.push(namespace));
  const decide = new DecideCoverageService();
  const oracle = fakeOracle({ valueScore: null, mutantCount: 0, killedCount: 0, details: "" });
  const adapter = new ObjectiveSignalPortAdapter(
    { collector, decide, oracle },
    { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app", assembleChangeCoverage },
  );

  const br = BlastRadius.of(Sha.of("abc1234"), []);
  await adapter.measure(br, "/mirrors/org/app/e2e", SAMPLE_DIFF);

  assert.deepEqual(seenNamespaces, ["abc1234"]);
});

// ── CHANGED-FILES THREADING ───────────────────────────────────────────────────────────────────

test("measure() derives changedFiles from the diff and threads them into collect()'s optional trailing arg", async () => {
  const seenChangedFiles: (string[] | undefined)[] = [];
  const collector = fakeCollector({ covered: [] }, (_specDir, _namespace, changedFiles) => seenChangedFiles.push(changedFiles));
  const decide = new DecideCoverageService();
  const oracle = fakeOracle({ valueScore: null, mutantCount: 0, killedCount: 0, details: "" });
  const adapter = new ObjectiveSignalPortAdapter(
    { collector, decide, oracle },
    { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app", assembleChangeCoverage },
  );

  const br = BlastRadius.of(Sha.of("abc1234"), []);
  await adapter.measure(br, "/mirrors/org/app/e2e", SAMPLE_DIFF);

  assert.deepEqual(seenChangedFiles, [["src/checkout.ts"]]);
});

// ── W4 fix (F2) — per-call baselineCases (the dead value oracle). The e2e fault-injection oracle
// returns valueScore:null forever unless it knows the green run's passing spec names; the
// composition root's static ctx.baselineCases is a permanent [] placeholder (no per-run case list
// exists at composition time) — the PER-CALL arg is what finally supplies a real value. ──────────

test("measure() forwards a PER-CALL baselineCases arg into ValueOraclePort.measure, taking precedence over ctx.baselineCases", async () => {
  const seenBaselineCases: (string[] | undefined)[] = [];
  const collector = fakeCollector({ covered: [] });
  const decide = new DecideCoverageService();
  const oracle: ValueOraclePort = {
    measure: async (_br, _repoDir, _namespace, baselineCases) => {
      seenBaselineCases.push(baselineCases);
      return { valueScore: 0.9, mutantCount: 10, killedCount: 9, details: "9/10" };
    },
  };
  const adapter = new ObjectiveSignalPortAdapter(
    { collector, decide, oracle },
    { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app", baselineCases: ["stale-static-case"] },
  );

  const br = BlastRadius.of(Sha.of("abc1234"), []);
  const result = await adapter.measure(br, "/mirrors/org/app/e2e", undefined, ["login", "checkout"]);

  assert.deepEqual(seenBaselineCases, [["login", "checkout"]], "the per-call baselineCases must win over the static ctx.baselineCases placeholder");
  assert.equal(result.valueScore, 0.9);
});

test("measure() falls back to ctx.baselineCases when the per-call arg is absent (backward compatible)", async () => {
  const seenBaselineCases: (string[] | undefined)[] = [];
  const collector = fakeCollector({ covered: [] });
  const decide = new DecideCoverageService();
  const oracle: ValueOraclePort = {
    measure: async (_br, _repoDir, _namespace, baselineCases) => {
      seenBaselineCases.push(baselineCases);
      return { valueScore: null, mutantCount: 0, killedCount: 0, details: "" };
    },
  };
  const adapter = new ObjectiveSignalPortAdapter(
    { collector, decide, oracle },
    { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app", baselineCases: ["ctx-fallback-case"] },
  );

  const br = BlastRadius.of(Sha.of("abc1234"), []);
  await adapter.measure(br, "/mirrors/org/app/e2e"); // no baselineCases arg at all

  assert.deepEqual(seenBaselineCases, [["ctx-fallback-case"]]);
});

test("measure() passes undefined to the oracle when NEITHER a per-call arg NOR ctx.baselineCases is supplied", async () => {
  const seenBaselineCases: (string[] | undefined)[] = [];
  const collector = fakeCollector({ covered: [] });
  const decide = new DecideCoverageService();
  const oracle: ValueOraclePort = {
    measure: async (_br, _repoDir, _namespace, baselineCases) => {
      seenBaselineCases.push(baselineCases);
      return { valueScore: null, mutantCount: 0, killedCount: 0, details: "" };
    },
  };
  const adapter = new ObjectiveSignalPortAdapter({ collector, decide, oracle }, { policy: { mode: "signal", minRatio: 0.7 }, repoDir: "/mirrors/org/app" });

  const br = BlastRadius.of(Sha.of("abc1234"), []);
  await adapter.measure(br, "/mirrors/org/app/e2e");

  assert.deepEqual(seenBaselineCases, [undefined]);
});
