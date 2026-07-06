// scripts/onboard-app.test.ts
// TDD (strict): write failing tests first, then implement.
// runOnboarding(deps) is the DI-testable core (argv parsing + composition wiring stay in the
// thin argv shell in onboard-app.ts's `if (process.argv[1] === ...)` guard, per src/cli.ts's
// established pattern) — every test here drives a FAKE OnboardingService / MirrorRegistryPort /
// filesystem, never opens a real LLM session (spec C, design §D exit-code contract).
import { test } from "node:test";
import assert from "node:assert/strict";
import type { BoundaryProfile, RepoRef } from "../qa-engine/src/contexts/service-topology/domain/index.ts";
import type { OnboardingResult } from "../qa-engine/src/contexts/service-topology/application/onboarding-service.ts";
import { runOnboarding, type OnboardingCliDeps } from "./onboard-app.ts";

const HTTP_PROFILE: BoundaryProfile = {
  transport: "http",
  frontFiles: "**/*.api.ts",
  frontCallSite: { kind: "receiver-verb-call", receiver: "this.rest" },
  servicePrefixTemplate: "name-{service}-api",
  serviceRepoTemplate: "ms-name-{service}",
  openApiPath: "openapi.yaml",
};

function fakeDeps(overrides: Partial<OnboardingCliDeps> = {}): OnboardingCliDeps {
  const files = new Map<string, string>();
  return {
    mirrorDir: async (repo: string) => `/mirrors/${repo.replaceAll("/", "__")}`,
    runOnboardingLoop: async (_system: RepoRef[], _front: RepoRef): Promise<OnboardingResult> => ({
      profile: null,
      candidates: [],
      rounds: 3,
    }),
    readConfig: (path: string) => {
      if (files.has(path)) return files.get(path) as string;
      throw Object.assign(new Error(`ENOENT: no such file, open '${path}'`), { code: "ENOENT" });
    },
    writeConfig: (path: string, content: string) => {
      files.set(path, content);
    },
    log: () => {},
    error: () => {},
    ...overrides,
  };
}

// ── exit code 0: profile resolves and is written/printed ───────────────────────

test("runOnboarding: exit 0 when a profile resolves and --config exists (splices + writes)", async () => {
  let written: { path: string; content: string } | undefined;
  const deps = fakeDeps({
    runOnboardingLoop: async () => ({
      profile: HTTP_PROFILE,
      candidates: [{ profile: HTTP_PROFILE, score: { links: 1, drift: 0, external: 0, unresolved: 0, coverage: 1, resolutionRatio: 1, resolvedScore: 1 } }],
      rounds: 1,
    }),
    readConfig: () => 'name: "nname"\nrepo: "org/nname"\n',
    writeConfig: (path, content) => {
      written = { path, content };
    },
  });

  const code = await runOnboarding(["--app", "nname", "--repo", "org/nname", "--config", "config/apps/nname.yaml"], deps);

  assert.equal(code, 0);
  assert.ok(written);
  assert.ok(written?.content.includes("boundaries:"));
  assert.ok(written?.content.includes("**/*.api.ts"));
});

test("runOnboarding: exit 0 with --dry-run prints the snippet and never writes", async () => {
  let wroteAnything = false;
  const logged: string[] = [];
  const deps = fakeDeps({
    runOnboardingLoop: async () => ({
      profile: HTTP_PROFILE,
      candidates: [{ profile: HTTP_PROFILE, score: { links: 1, drift: 0, external: 0, unresolved: 0, coverage: 1, resolutionRatio: 1, resolvedScore: 1 } }],
      rounds: 1,
    }),
    readConfig: () => 'name: "nname"\nrepo: "org/nname"\n',
    writeConfig: () => {
      wroteAnything = true;
    },
    log: (msg: string) => logged.push(msg),
  });

  const code = await runOnboarding(["--app", "nname", "--repo", "org/nname", "--dry-run"], deps);

  assert.equal(code, 0);
  assert.equal(wroteAnything, false);
  assert.ok(logged.some((l) => l.includes("boundaries:")));
});

test("runOnboarding: exit 0 and prints the snippet when --config path does not exist", async () => {
  let wroteAnything = false;
  const logged: string[] = [];
  const deps = fakeDeps({
    runOnboardingLoop: async () => ({
      profile: HTTP_PROFILE,
      candidates: [{ profile: HTTP_PROFILE, score: { links: 1, drift: 0, external: 0, unresolved: 0, coverage: 1, resolutionRatio: 1, resolvedScore: 1 } }],
      rounds: 1,
    }),
    // readConfig throws ENOENT for any path (default fakeDeps behavior with no seeded files)
    writeConfig: () => {
      wroteAnything = true;
    },
    log: (msg: string) => logged.push(msg),
  });

  const code = await runOnboarding(["--app", "nname", "--repo", "org/nname", "--config", "config/apps/missing.yaml"], deps);

  assert.equal(code, 0);
  assert.equal(wroteAnything, false);
  assert.ok(logged.some((l) => l.includes("boundaries:")));
});

// ── exit code 1: nothing resolved within budget ─────────────────────────────────

test("runOnboarding: exit 1 when nothing resolves within budget (nothing written)", async () => {
  let wroteAnything = false;
  const deps = fakeDeps({
    runOnboardingLoop: async () => ({ profile: null, candidates: [], rounds: 3 }),
    readConfig: () => 'name: "nname"\nrepo: "org/nname"\n',
    writeConfig: () => {
      wroteAnything = true;
    },
  });

  const code = await runOnboarding(["--app", "nname", "--repo", "org/nname"], deps);

  assert.equal(code, 1);
  assert.equal(wroteAnything, false);
});

// ── exit code 2: usage / arg errors ─────────────────────────────────────────────

test("runOnboarding: exit 2 when --app is missing", async () => {
  const errors: string[] = [];
  const deps = fakeDeps({ error: (msg: string) => errors.push(msg) });

  const code = await runOnboarding(["--repo", "org/nname"], deps);

  assert.equal(code, 2);
  assert.ok(errors.length > 0);
});

test("runOnboarding: exit 2 when --repo is missing", async () => {
  const deps = fakeDeps();
  const code = await runOnboarding(["--app", "nname"], deps);
  assert.equal(code, 2);
});

// ── exit code 3: hard I/O error writing config (distinct from exit 1) ──────────

test("runOnboarding: exit 3 when scoring resolves but the config write fails (I/O error)", async () => {
  const deps = fakeDeps({
    runOnboardingLoop: async () => ({
      profile: HTTP_PROFILE,
      candidates: [{ profile: HTTP_PROFILE, score: { links: 1, drift: 0, external: 0, unresolved: 0, coverage: 1, resolutionRatio: 1, resolvedScore: 1 } }],
      rounds: 1,
    }),
    readConfig: () => 'name: "nname"\nrepo: "org/nname"\n',
    writeConfig: () => {
      throw new Error("EACCES: permission denied");
    },
  });

  const code = await runOnboarding(["--app", "nname", "--repo", "org/nname", "--config", "config/apps/nname.yaml"], deps);

  assert.equal(code, 3);
});

// ── no-mirror-on-disk fail-open message (spec C3) ───────────────────────────────

test("runOnboarding: a missing mirror produces an actionable error naming the repo/path, not a stack trace", async () => {
  const errors: string[] = [];
  const deps = fakeDeps({
    mirrorDir: async () => {
      throw Object.assign(new Error("ENOENT: no such directory"), { code: "ENOENT" });
    },
    error: (msg: string) => errors.push(msg),
  });

  const code = await runOnboarding(["--app", "nname", "--repo", "org/nname"], deps);

  assert.notEqual(code, 0);
  assert.ok(errors.some((m) => m.includes("org/nname")), "error must name the missing repo");
  assert.ok(
    errors.every((m) => !m.includes("at ") && !m.includes(".ts:")),
    "error must be a clean message, not a raw stack trace",
  );
});

test("runOnboarding: a missing SERVICE repo (not the primary) names the service repo, not the primary", async () => {
  const errors: string[] = [];
  const deps = fakeDeps({
    mirrorDir: async (repo: string) => {
      if (repo === "org/ms-name-missing") {
        throw Object.assign(new Error("ENOENT: no such directory"), { code: "ENOENT" });
      }
      return `/mirrors/${repo.replaceAll("/", "__")}`;
    },
    error: (msg: string) => errors.push(msg),
  });

  const code = await runOnboarding(
    ["--app", "nname", "--repo", "org/nname-gateway", "--service", "org/ms-name-missing"],
    deps,
  );

  assert.notEqual(code, 0);
  assert.ok(errors.some((m) => m.includes("org/ms-name-missing")), "error must name the missing SERVICE repo");
  assert.ok(errors.every((m) => !m.includes("org/nname-gateway")), "error must not blame the primary repo instead");
});

// ── composition wiring smoke: --service is repeatable ──────────────────────────

test("runOnboarding: passes every --service repo into the onboarding loop's system[] argument", async () => {
  let capturedSystem: RepoRef[] = [];
  const deps = fakeDeps({
    runOnboardingLoop: async (system: RepoRef[]) => {
      capturedSystem = system;
      return { profile: null, candidates: [], rounds: 1 };
    },
  });

  await runOnboarding(
    ["--app", "nname", "--repo", "org/nname-gateway", "--service", "org/ms-name-orders", "--service", "org/ms-name-billing"],
    deps,
  );

  assert.equal(capturedSystem.length, 2);
  assert.ok(capturedSystem.some((r) => r.repo === "org/ms-name-orders"));
  assert.ok(capturedSystem.some((r) => r.repo === "org/ms-name-billing"));
});
