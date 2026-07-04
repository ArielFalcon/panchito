// qa-engine/test/contexts/qa-run-orchestration/infrastructure/bridges/structural-signal-port.adapter.test.ts
//
// RED for Slice 4b.3 (design §5.3, tasks 4b.3.1): StructuralSignalPortAdapter composes a
// CodeGraphPort (fake here, the real one is CodebaseMemoryCodeGraphAdapter from 4a) +
// blast-radius-signal.ts's pure renderer into ONE StructuralSignalPort.render() call. Owns
// depth=3/minConfidence=0.55 at this call boundary (design §5.3) — never throws (every method's
// err(CodeGraphUnavailable) degrades to an empty array for that field, matching the "" fail-open
// contract R10 requires).
import { test } from "node:test";
import assert from "node:assert/strict";
import { StructuralSignalPortAdapter } from "@contexts/qa-run-orchestration/infrastructure/bridges/structural-signal-port.adapter.ts";
import { renderBlastRadiusSignal } from "@contexts/qa-run-orchestration/infrastructure/bridges/blast-radius-signal.ts";
import { BlastRadius } from "@kernel/blast-radius.ts";
import { Sha } from "@kernel/sha.ts";
import { ok, err } from "@kernel/result.ts";
import type { CodeGraphPort } from "@kernel/ports/code-graph.port.ts";

function fakeCodeGraph(overrides: Partial<CodeGraphPort> = {}): CodeGraphPort {
  return {
    syncTo: overrides.syncTo ?? (async () => ok({ nodeCount: 0 })),
    impactedSymbols: overrides.impactedSymbols ?? (async () => ok([])),
    coChangeCoupling: overrides.coChangeCoupling ?? (async () => ok([])),
    callersOf: overrides.callersOf ?? (async () => ok([])),
    existingCoverage: overrides.existingCoverage ?? (async () => ok([])),
    structurallyRelated: overrides.structurallyRelated ?? (async () => ok([])),
  };
}

const changed = BlastRadius.of(Sha.of("abc1234"), ["src/Foo.java", "src/Bar.java"]);

test("composes a populated CodeGraphPort into the SAME block the pure renderer would produce", async () => {
  const impacted = [{ file: "src/Impacted.java", symbol: "run" }];
  const coupled = [{ file: "src/Coupled.java", couplingScore: 0.8, coChanges: 5 }];
  const callers = [{ file: "src/Caller.java", symbol: "call" }];

  const codeGraph = fakeCodeGraph({
    impactedSymbols: async () => ok(impacted),
    coChangeCoupling: async () => ok(coupled),
    callersOf: async () => ok(callers),
  });

  const adapter = new StructuralSignalPortAdapter(codeGraph, "/repo");
  const out = await adapter.render("/repo", changed);

  const expected = renderBlastRadiusSignal({ impacted, callers, coupled });
  assert.equal(out, expected, "adapter output must match the pure renderer given the same three result sets");
  assert.notEqual(out, "", "a populated composition must not degrade to an empty string");
});

test("calls impactedSymbols with depth=3 and coChangeCoupling with the changed file list", async () => {
  let capturedDepth: number | undefined;
  let capturedFiles: string[] | undefined;
  const codeGraph = fakeCodeGraph({
    impactedSymbols: async (_repoDir, _changed, opts) => {
      capturedDepth = opts.depth;
      return ok([]);
    },
    coChangeCoupling: async (_repoDir, files) => {
      capturedFiles = files;
      return ok([]);
    },
  });

  const adapter = new StructuralSignalPortAdapter(codeGraph, "/repo");
  await adapter.render("/repo", changed);

  assert.equal(capturedDepth, 3, "impactedSymbols must be called with the design's advisory depth=3");
  assert.deepEqual(capturedFiles, [...changed.changedFiles], "coChangeCoupling must be called with the changed file list");
});

test("calls callersOf per changed-file anchor symbol", async () => {
  const callersOfCalls: unknown[] = [];
  const codeGraph = fakeCodeGraph({
    impactedSymbols: async () => ok([{ file: "src/Foo.java", symbol: "handle" }]),
    callersOf: async (_repoDir, symbol) => {
      callersOfCalls.push(symbol);
      return ok([]);
    },
  });

  const adapter = new StructuralSignalPortAdapter(codeGraph, "/repo");
  await adapter.render("/repo", changed);

  assert.ok(callersOfCalls.length > 0, "callersOf must be invoked at least once when impactedSymbols returned an anchor");
});

test("callersOf fan-out is CAPPED: a large impacted set spawns at most MAX_CALLER_ANCHORS callersOf queries (each is a real process spawn in production — an unbounded Promise.all over hundreds of anchors is a spawn storm on the orchestrator host)", async () => {
  const bigImpacted = Array.from({ length: 80 }, (_, i) => ({ file: `src/F${i}.java`, symbol: `m${i}` }));
  let callersOfCalls = 0;
  const codeGraph = fakeCodeGraph({
    impactedSymbols: async () => ok(bigImpacted),
    callersOf: async () => {
      callersOfCalls += 1;
      return ok([]);
    },
  });

  const adapter = new StructuralSignalPortAdapter(codeGraph, "/repo");
  await adapter.render("/repo", changed);

  assert.ok(
    callersOfCalls <= 25,
    `callersOf must be capped at 25 anchors, got ${callersOfCalls} spawns for an 80-symbol impacted set`,
  );
  assert.ok(callersOfCalls > 0, "the cap must not silence callersOf entirely");
});

test("every method returning err(CodeGraphUnavailable) degrades to an empty string, never throws", async () => {
  const codeGraph = fakeCodeGraph({
    impactedSymbols: async () => err({ reason: "graph unavailable" }),
    coChangeCoupling: async () => err({ reason: "graph unavailable" }),
    callersOf: async () => err({ reason: "graph unavailable" }),
  });

  const adapter = new StructuralSignalPortAdapter(codeGraph, "/repo");
  const out = await adapter.render("/repo", changed);

  assert.equal(out, "", "a fully-unavailable graph must render an empty string — never a fabricated section");
});

test("an empty BlastRadius degrades to an empty string without ever calling the graph", async () => {
  let called = false;
  const codeGraph = fakeCodeGraph({
    impactedSymbols: async () => { called = true; return ok([]); },
    coChangeCoupling: async () => { called = true; return ok([]); },
  });

  const adapter = new StructuralSignalPortAdapter(codeGraph, "/repo");
  const out = await adapter.render("/repo", BlastRadius.of(Sha.of("abc1234"), []));

  assert.equal(out, "");
  assert.equal(called, false, "an empty BlastRadius must short-circuit before ever querying the graph");
});

test("a thrown error from the underlying CodeGraphPort degrades to an empty string, never propagates", async () => {
  const codeGraph = fakeCodeGraph({
    impactedSymbols: async () => { throw new Error("boom"); },
  });

  const adapter = new StructuralSignalPortAdapter(codeGraph, "/repo");
  const out = await adapter.render("/repo", changed);

  assert.equal(out, "", "an unexpected throw must degrade to an empty string, not propagate past render()");
});

test("the constructor's static repoDir (mirrorDir) wins over whatever repoDir the caller passes — the graph is indexed at the repo root, not workspace.specDir's e2e subfolder", async () => {
  const seenRepoDirs: string[] = [];
  const codeGraph = fakeCodeGraph({
    impactedSymbols: async (repoDir) => { seenRepoDirs.push(repoDir); return ok([]); },
    coChangeCoupling: async (repoDir) => { seenRepoDirs.push(repoDir); return ok([]); },
  });

  const adapter = new StructuralSignalPortAdapter(codeGraph, "/mirrors/org/app");
  // The caller (RunQaUseCase) actually passes workspace.specDir here — a DIFFERENT path.
  await adapter.render("/mirrors/org/app/e2e", changed);

  assert.ok(seenRepoDirs.length > 0, "the underlying CodeGraphPort must have been queried");
  for (const seen of seenRepoDirs) {
    assert.equal(seen, "/mirrors/org/app", "every CodeGraphPort call must use the adapter's own constructor-injected repoDir, never the call-site parameter");
  }
});
