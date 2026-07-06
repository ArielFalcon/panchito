import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentDeps, AgentSession } from "../../src/integrations/opencode-client";
import type { RepoRef } from "../../qa-engine/src/contexts/service-topology/domain/index.ts";
import type { ProposerFeedback } from "../../qa-engine/src/contexts/service-topology/application/ports/index.ts";
import { LlmProfileProposerAdapter, PROPOSER_MODEL } from "./llm-profile-proposer.adapter.ts";

// ── Fixtures ────────────────────────────────────────────────────────────────

const FRONT: RepoRef = { repo: "ArielFalcon/nname-gateway", mirrorDir: "/mirrors/nname-gateway" };
const SYSTEM: RepoRef[] = [{ repo: "ArielFalcon/ms-name-orders", mirrorDir: "/mirrors/ms-name-orders" }];

const VALID_VERDICT_JSON = JSON.stringify({
  candidates: [
    {
      transport: "http",
      frontFiles: "**/*.api.ts",
      frontCallSite: { kind: "receiver-verb-call", receiver: "this.rest" },
      servicePrefixTemplate: "name-{service}-api",
      serviceRepoTemplate: "ms-name-{service}",
      openApiPath: "openapi.yaml",
    },
    {
      transport: "event",
      files: "**/*.java",
      eventPattern: {
        kind: "class-based-domain-events",
        listenerBaseType: "ListenerMessageDelegate",
        listenerEventCall: "convertMsgToSpecificType",
        subscriberBaseType: "DomainEventSubscriber",
        publishCall: "publishGenericMessage",
      },
    },
  ],
});

const MIXED_VERDICT_JSON = JSON.stringify({
  candidates: [
    {
      transport: "http",
      frontFiles: "**/*.api.ts",
      frontCallSite: { kind: "receiver-verb-call", receiver: "this.rest" },
      servicePrefixTemplate: "name-{service}-api",
      serviceRepoTemplate: "ms-name-{service}",
      openApiPath: "openapi.yaml",
    },
    {
      // malformed: missing eventPattern.publishCall
      transport: "event",
      files: "**/*.java",
      eventPattern: {
        kind: "class-based-domain-events",
        listenerBaseType: "ListenerMessageDelegate",
        listenerEventCall: "convertMsgToSpecificType",
        subscriberBaseType: "DomainEventSubscriber",
      },
    },
    {
      transport: "http",
      frontFiles: "**/*.gateway.ts",
      frontCallSite: { kind: "receiver-verb-call", receiver: "this.http" },
      servicePrefixTemplate: "other-{service}-api",
      serviceRepoTemplate: "ms-other-{service}",
      openApiPath: "openapi.json",
    },
  ],
});

function fencedJson(payload: string): string {
  return `Some reasoning text before the answer.\n\n\`\`\`json\n${payload}\n\`\`\`\n`;
}

interface FakeDepsOpts {
  promptResult?: string | Error;
  onOpen?: (agent: string, cwd: string, opts?: { model?: string; timeoutMs?: number }) => void;
  openThrows?: boolean;
  disposed?: { count: number };
}

function fakeDepsFactory(opts: FakeDepsOpts): () => Promise<AgentDeps> {
  return async () => ({
    open: async (agent: string, cwd: string, openOpts?: { model?: string; timeoutMs?: number }) => {
      opts.onOpen?.(agent, cwd, openOpts);
      if (opts.openThrows) throw new Error("boom: open failed");
      const session: AgentSession = {
        id: "fake-session",
        prompt: async () => {
          if (opts.promptResult instanceof Error) throw opts.promptResult;
          return opts.promptResult ?? "";
        },
        dispose: async () => {
          if (opts.disposed) opts.disposed.count += 1;
        },
      };
      return session;
    },
  });
}

// ── Tests ───────────────────────────────────────────────────────────────────

test("propose(): a well-formed verdict (1 http + 1 event) returns the correctly discriminated BoundaryProfile[]", async () => {
  const disposed = { count: 0 };
  const depsFactory = fakeDepsFactory({ promptResult: fencedJson(VALID_VERDICT_JSON), disposed });
  const adapter = new LlmProfileProposerAdapter(depsFactory, PROPOSER_MODEL, { app: "nname" });

  const result = await adapter.propose(SYSTEM, FRONT);

  assert.equal(result.length, 2);
  assert.equal(result[0]?.transport, "http");
  assert.equal(result[1]?.transport, "event");
  if (result[0]?.transport === "http") {
    assert.equal(result[0].frontFiles, "**/*.api.ts");
  }
  assert.equal(disposed.count, 1, "session must be disposed exactly once");
});

test("propose(): fail-open — deps.open() throwing returns [] without propagating", async () => {
  const depsFactory = fakeDepsFactory({ openThrows: true });
  const adapter = new LlmProfileProposerAdapter(depsFactory, PROPOSER_MODEL, { app: "nname" });

  const result = await adapter.propose(SYSTEM, FRONT);

  assert.deepEqual(result, []);
});

test("propose(): fail-open — session.prompt() rejecting (timeout/transport error) returns []", async () => {
  const depsFactory = fakeDepsFactory({ promptResult: new Error("timed out") });
  const adapter = new LlmProfileProposerAdapter(depsFactory, PROPOSER_MODEL, { app: "nname" });

  const result = await adapter.propose(SYSTEM, FRONT);

  assert.deepEqual(result, []);
});

test("propose(): fail-open — garbage/unparseable text from prompt() returns []", async () => {
  const depsFactory = fakeDepsFactory({ promptResult: "this is not json at all, sorry." });
  const adapter = new LlmProfileProposerAdapter(depsFactory, PROPOSER_MODEL, { app: "nname" });

  const result = await adapter.propose(SYSTEM, FRONT);

  assert.deepEqual(result, []);
});

test("propose(): mixed valid/malformed candidates returns only the valid ones (sentinel filtered out)", async () => {
  const depsFactory = fakeDepsFactory({ promptResult: fencedJson(MIXED_VERDICT_JSON) });
  const adapter = new LlmProfileProposerAdapter(depsFactory, PROPOSER_MODEL, { app: "nname" });

  const result = await adapter.propose(SYSTEM, FRONT);

  assert.equal(result.length, 2);
  assert.ok(result.every((c) => c.transport === "http"), "only the two valid http candidates should survive");
  if (result[0]?.transport === "http") assert.equal(result[0].servicePrefixTemplate, "name-{service}-api");
  if (result[1]?.transport === "http") assert.equal(result[1].servicePrefixTemplate, "other-{service}-api");
});

test("propose(): calls depsFactory() DIRECTLY and pins the adapter's model on open() opts (facade-bypass proof)", async () => {
  const opens: Array<{ agent: string; cwd: string; model?: string; timeoutMs?: number }> = [];
  const depsFactory = fakeDepsFactory({
    promptResult: fencedJson(VALID_VERDICT_JSON),
    onOpen: (agent, cwd, opts) => opens.push({ agent, cwd, model: opts?.model, timeoutMs: opts?.timeoutMs }),
  });
  const adapter = new LlmProfileProposerAdapter(depsFactory, PROPOSER_MODEL, { app: "nname", timeoutMs: 12345 });

  await adapter.propose(SYSTEM, FRONT);

  assert.equal(opens.length, 1);
  assert.equal(opens[0]?.agent, "qa-proposer");
  assert.equal(opens[0]?.cwd, FRONT.mirrorDir);
  assert.equal(opens[0]?.model, PROPOSER_MODEL, "adapter must pin its own model, not fall through a facade");
  assert.equal(opens[0]?.timeoutMs, 12345);
});

test("propose(): when feedback.priorCandidates is non-empty, the prompt text references the prior round", async () => {
  let capturedPrompt = "";
  const depsFactory: () => Promise<AgentDeps> = async () => ({
    open: async () => ({
      id: "fake-session",
      prompt: async (text: string) => {
        capturedPrompt = text;
        return fencedJson(VALID_VERDICT_JSON);
      },
      dispose: async () => {},
    }),
  });
  const adapter = new LlmProfileProposerAdapter(depsFactory, PROPOSER_MODEL, { app: "nname" });

  const feedback: ProposerFeedback = {
    priorCandidates: [
      {
        profile: {
          transport: "http",
          frontFiles: "**/*.api.ts",
          frontCallSite: { kind: "receiver-verb-call", receiver: "this.rest" },
          servicePrefixTemplate: "wrong-{service}-api",
          serviceRepoTemplate: "ms-wrong-{service}",
          openApiPath: "openapi.yaml",
        },
        score: { links: 0, drift: 0, external: 3, unresolved: 0, coverage: 3, resolutionRatio: 0, resolvedScore: 0 },
      },
    ],
  };

  await adapter.propose(SYSTEM, FRONT, feedback);

  assert.ok(capturedPrompt.includes("round"), "prompt must reference the prior round when feedback is supplied");
  assert.ok(
    capturedPrompt.includes("wrong-{service}-api") || capturedPrompt.includes("resolvedScore"),
    "prompt must include a compact summary of the prior candidate/score",
  );
});

test("propose(): fail-open holds even when feedback is supplied and the session throws", async () => {
  const depsFactory = fakeDepsFactory({ openThrows: true });
  const adapter = new LlmProfileProposerAdapter(depsFactory, PROPOSER_MODEL, { app: "nname" });

  const feedback: ProposerFeedback = {
    priorCandidates: [
      {
        profile: {
          transport: "event",
          files: "**/*.java",
          eventPattern: {
            kind: "class-based-domain-events",
            listenerBaseType: "ListenerMessageDelegate",
            listenerEventCall: "convertMsgToSpecificType",
            subscriberBaseType: "DomainEventSubscriber",
            publishCall: "publishGenericMessage",
          },
        },
        score: { links: 1, drift: 0, external: 0, unresolved: 0, coverage: 1, resolutionRatio: 1, resolvedScore: 1 },
      },
    ],
  };

  const result = await adapter.propose(SYSTEM, FRONT, feedback);

  assert.deepEqual(result, []);
});
