import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { OnboardWizard } from "./OnboardWizard";
import type { QaClient, CreateAppRequest, CreateAppResponse } from "../client";

function makeStubClient(opts: {
  onValidate?: (repo: string) => void;
  onCreate?: (input: CreateAppRequest) => void;
  onUpdate?: (name: string, input: CreateAppRequest) => void;
  onDelete?: () => void;
  listRepos?: () => Promise<{ repos: Array<{ fullName: string; private: boolean; description: string | null }>; hasMore: boolean }>;
  validateOk?: boolean;
  createOk?: boolean;
  updateOk?: boolean;
  appView?: { name: string; repo: string; baseUrl: string; versionUrl: string; code: boolean; shadow: boolean; needsReview: boolean; testDataPrefix: string; services: Array<{ repo: string; openapi?: string; versionUrl?: string }> };
} = {}): QaClient {
  const validateOk = opts.validateOk ?? true;
  const createOk = opts.createOk ?? true;
  const updateOk = opts.updateOk ?? true;
  const appView = opts.appView ?? {
    name: "shop", repo: "org/shop", baseUrl: "https://dev.shop.io", versionUrl: "", code: false, shadow: true, needsReview: true, testDataPrefix: "qa-bot", services: [],
  };
  return {
    listRepos: opts.listRepos ?? (async () => ({ repos: [], hasMore: false })),
    validateRepo: async (repo: string): Promise<CreateAppResponse> => {
      opts.onValidate?.(repo);
      return validateOk
        ? { ok: true, repoInfo: { name: "r", fullName: repo, private: false, defaultBranch: "main", description: null } }
        : { ok: false, errors: ["nope"] };
    },
    createApp: async (input: CreateAppRequest): Promise<CreateAppResponse> => {
      opts.onCreate?.(input);
      if (!createOk) return { ok: false, errors: ["bad"] };
      return input.dryRun
        ? { ok: true, yaml: `name: ${input.name ?? "r"}\nrepo: ${input.repo}` }
        : { ok: true, name: input.name ?? "r" };
    },
    getApp: async (): Promise<typeof appView> => appView,
    updateApp: async (name: string, input: CreateAppRequest): Promise<CreateAppResponse> => {
      opts.onUpdate?.(name, input);
      if (!updateOk) return { ok: false, errors: ["bad"] };
      return input.dryRun
        ? { ok: true, yaml: `name: ${name}\nrepo: ${input.repo ?? "org/shop"}` }
        : { ok: true, name };
    },
    deleteApp: async (): Promise<{ removed: string[] }> => {
      opts.onDelete?.();
      return { removed: [] };
    },
  } as unknown as QaClient;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function typeSlowly(stdin: { write: (s: string) => void }, s: string): Promise<void> {
  for (const ch of s) { stdin.write(ch); await sleep(5); }
}

// Helper: select "Enter repo manually" from the initial repo-source step.
async function goManual(stdin: { write: (s: string) => void }): Promise<void> {
  stdin.write("\x1b[B"); // down arrow → select "Enter repo manually"
  await sleep(10);
  stdin.write("\r");      // Enter → confirm
  await sleep(50);
}

test("renders the repo source selection initially", () => {
  const client = makeStubClient();
  const { lastFrame, unmount } = render(
    <OnboardWizard client={client} onDone={() => {}} onCancel={() => {}} />,
  );
  const f = lastFrame() ?? "";
  assert.match(f, /How would you like to select the repo/);
  assert.match(f, /Browse my repos/);
  assert.match(f, /Enter repo manually/);
  unmount();
});

test("renders without crashing", () => {
  const client = makeStubClient();
  const { unmount } = render(
    <OnboardWizard client={client} onDone={() => {}} onCancel={() => {}} />,
  );
  unmount();
});

test("selecting manual entry → typing a repo → Enter calls client.validateRepo", async () => {
  let validatedWith: string | null = null;
  const client = makeStubClient({ onValidate: (r) => { validatedWith = r; } });
  const { stdin, unmount } = render(
    <OnboardWizard client={client} onDone={() => {}} onCancel={() => {}} />,
  );
  await goManual(stdin);
  await typeSlowly(stdin, "org/repo");
  stdin.write("\r");
  await sleep(50);
  assert.equal(validatedWith, "org/repo");
  unmount();
});

test("invalid repo format goes to repo-error without calling validateRepo", async () => {
  let called = false;
  const client = makeStubClient({ onValidate: () => { called = true; } });
  const { stdin, lastFrame, unmount } = render(
    <OnboardWizard client={client} onDone={() => {}} onCancel={() => {}} />,
  );
  await goManual(stdin);
  await typeSlowly(stdin, "notarepo");
  stdin.write("\r");
  await sleep(50);
  assert.equal(called, false);
  assert.match(lastFrame() ?? "", /org\/name/);
  unmount();
});

test("edit mode loads config and shows edit menu", async () => {
  const client = makeStubClient();
  const { lastFrame, unmount } = render(
    <OnboardWizard client={client} onDone={() => {}} onCancel={() => {}} editMode initialAppName="shop" />,
  );
  await sleep(50);
  const f = lastFrame() ?? "";
  assert.match(f, /Edit config\/apps\/shop\.yaml/);
  assert.match(f, /Repo: org\/shop/);
  assert.match(f, /Base URL: https:\/\/dev\.shop\.io/);
  unmount();
});

test("edit mode selecting baseUrl → typing new value → Enter returns to menu", async () => {
  const client = makeStubClient();
  const { stdin, lastFrame, unmount } = render(
    <OnboardWizard client={client} onDone={() => {}} onCancel={() => {}} editMode initialAppName="shop" />,
  );
  await sleep(50);
  stdin.write("\x1b[B");
  await sleep(10);
  stdin.write("\r");
  await sleep(50);
  await typeSlowly(stdin, "https://new.dev.io");
  stdin.write("\r");
  await sleep(50);
  const f = lastFrame() ?? "";
  assert.match(f, /Base URL: https:\/\/new\.dev\.io/);
  unmount();
});

test("edit mode review & save calls client.updateApp", async () => {
  const updatedWith: { value: { name: string; input: CreateAppRequest } | null } = { value: null };
  const client = makeStubClient({
    onUpdate: (name, input) => { updatedWith.value = { name, input }; },
  });
  const { stdin, lastFrame, unmount } = render(
    <OnboardWizard client={client} onDone={() => {}} onCancel={() => {}} editMode initialAppName="shop" />,
  );
  await sleep(50);
  for (let i = 0; i < 9; i++) { stdin.write("\x1b[B"); await sleep(5); }
  stdin.write("\r");
  await sleep(50);
  assert.match(lastFrame() ?? "", /Review changes/);
  stdin.write("\r");
  await sleep(50);
  assert.ok(updatedWith.value);
  assert.equal(updatedWith.value.name, "shop");
  unmount();
});
