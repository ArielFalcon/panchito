import { test } from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { render } from "ink-testing-library";
import { OnboardWizard } from "./OnboardWizard";
import type { QaClient, CreateAppRequest, CreateAppResponse } from "../client";

function makeStubClient(opts: {
  onValidate?: (repo: string) => void;
  onCreate?: (input: CreateAppRequest) => void;
  onDelete?: () => void;
  validateOk?: boolean;
  createOk?: boolean;
} = {}): QaClient {
  const validateOk = opts.validateOk ?? true;
  const createOk = opts.createOk ?? true;
  return {
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
    deleteApp: async (): Promise<{ removed: string[] }> => {
      opts.onDelete?.();
      return { removed: [] };
    },
  } as unknown as QaClient;
}

test("renders the repo input step initially", () => {
  const client = makeStubClient();
  const { lastFrame, unmount } = render(
    <OnboardWizard client={client} onDone={() => {}} onCancel={() => {}} />,
  );
  const f = lastFrame() ?? "";
  assert.match(f, /Enter the GitHub repo/);
  assert.match(f, /org\/repo/);
  unmount();
});

test("renders without crashing", () => {
  const client = makeStubClient();
  const { unmount } = render(
    <OnboardWizard client={client} onDone={() => {}} onCancel={() => {}} />,
  );
  unmount();
});

async function typeSlowly(stdin: { write: (s: string) => void }, s: string): Promise<void> {
  for (const ch of s) {
    stdin.write(ch);
    await new Promise((r) => setTimeout(r, 5));
  }
}

test("typing a repo and pressing Enter calls client.validateRepo (no in-process github.getRepo)", async () => {
  let validatedWith: string | null = null;
  const client = makeStubClient({ onValidate: (r) => { validatedWith = r; } });
  const { stdin, unmount } = render(
    <OnboardWizard client={client} onDone={() => {}} onCancel={() => {}} />,
  );
  await typeSlowly(stdin, "org/repo");
  stdin.write("\r");
  // Let the microtasks settle.
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(validatedWith, "org/repo");
  unmount();
});

test("invalid repo format goes to repo-error without calling validateRepo", async () => {
  let called = false;
  const client = makeStubClient({ onValidate: () => { called = true; } });
  const { stdin, lastFrame, unmount } = render(
    <OnboardWizard client={client} onDone={() => {}} onCancel={() => {}} />,
  );
  await typeSlowly(stdin, "notarepo");
  stdin.write("\r");
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(called, false);
  assert.match(lastFrame() ?? "", /org\/name/);
  unmount();
});
