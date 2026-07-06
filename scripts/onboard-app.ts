// scripts/onboard-app.ts
//   npm run onboard -- --app <app> --repo <primary> [--service <repo> ...]
//                       [--mirror-root <dir>] [--config <path>] [--dry-run]
//
// Onboarding CLI for the profile-generator tool: composes the LLM proposer
// (LlmProfileProposerAdapter, scripts/adapters/) with the REAL deterministic scorer
// (OnboardingService, qa-engine — imported, never reimplemented) to hypothesize and grade an
// app's cross-service `boundaries:` convention, then splices the winning profile into
// config/apps/<app>.yaml as a human-review-first block (scripts/yaml/write-boundaries.ts).
//
// runOnboarding(argv, deps) is the DI-testable core: every collaborator (mirror resolution, the
// onboarding loop, config read/write, logging) is injected, so tests drive it with fakes and
// never open a real LLM session or touch the filesystem. The argv entrypoint below is a thin
// shell that wires the REAL collaborators (mirrors src/cli.ts's established pattern).
//
// Exit codes (design §D):
//   0 = a profile resolved (resolvedScore > 0) and was written/printed
//   1 = nothing resolved within budget (nothing written)
//   2 = usage/arg error
//   3 = hard I/O error writing config (scoring OK, write failed — distinct from 1)
import { parseArgs } from "node:util";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { MirrorRegistryAdapter } from "../qa-engine/src/contexts/service-topology/infrastructure/mirror-registry.adapter.ts";
import { OnboardingService, type OnboardingResult } from "../qa-engine/src/contexts/service-topology/application/onboarding-service.ts";
import type { RepoRef } from "../qa-engine/src/contexts/service-topology/domain/index.ts";
import { LlmProfileProposerAdapter, PROPOSER_MODEL } from "../src/server/onboarding/llm-profile-proposer.adapter.ts";
import { defaultAgentDeps } from "../src/integrations/opencode-client";
import { serializeBoundary, spliceBoundariesBlock } from "../src/server/onboarding/write-boundaries.ts";

const EXIT = {
  RESOLVED: 0,
  UNRESOLVED: 1,
  USAGE_ERROR: 2,
  WRITE_ERROR: 3,
} as const;

/** Every collaborator runOnboarding needs, injected so tests never touch the filesystem or open
 *  a real LLM session. The argv shell below wires the real implementations. */
export interface OnboardingCliDeps {
  mirrorDir: (repo: string) => Promise<string>;
  runOnboardingLoop: (system: RepoRef[], front: RepoRef) => Promise<OnboardingResult>;
  readConfig: (path: string) => string;
  writeConfig: (path: string, content: string) => void;
  log: (msg: string) => void;
  error: (msg: string) => void;
}

interface ParsedCliArgs {
  app: string;
  repo: string;
  services: string[];
  mirrorRoot: string;
  configPath: string;
  dryRun: boolean;
}

/** Parses argv into a validated ParsedCliArgs, or returns null (after emitting a usage message
 *  via deps.error) when --app or --repo is missing. */
function parseCliArgs(argv: string[], deps: OnboardingCliDeps): ParsedCliArgs | null {
  let values: Record<string, string | boolean | string[] | undefined>;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        app: { type: "string" },
        repo: { type: "string" },
        service: { type: "string", multiple: true },
        "mirror-root": { type: "string" },
        config: { type: "string" },
        "dry-run": { type: "boolean" },
      },
      allowPositionals: false,
    }));
  } catch (err) {
    deps.error(`Usage: npm run onboard -- --app <app> --repo <primary-repo> [--service <repo> ...] [--mirror-root <dir>] [--config <path>] [--dry-run]`);
    deps.error(err instanceof Error ? err.message : String(err));
    return null;
  }

  const app = typeof values.app === "string" ? values.app : "";
  const repo = typeof values.repo === "string" ? values.repo : "";
  if (!app || !repo) {
    deps.error(`Usage: npm run onboard -- --app <app> --repo <primary-repo> [--service <repo> ...] [--mirror-root <dir>] [--config <path>] [--dry-run]`);
    return null;
  }

  const services = Array.isArray(values.service) ? values.service : [];
  const mirrorRoot = typeof values["mirror-root"] === "string" ? values["mirror-root"] : (process.env.MIRROR_DIR ?? "");
  const configPath = typeof values.config === "string" ? values.config : join("config", "apps", `${app}.yaml`);
  const dryRun = values["dry-run"] === true;

  return { app, repo, services, mirrorRoot, configPath, dryRun };
}

/** Renders the proposed boundaries: block as a standalone printable snippet, used for --dry-run
 *  and for a missing --config target (fail-open: never silently drop a resolved profile). */
function renderSnippet(lines: readonly string[]): string {
  return ["boundaries:", ...lines].join("\n");
}

/** Runs the onboarding loop end to end and returns the process exit code. Every dependency is
 *  injected via `deps` — this function itself never imports a concrete adapter, so tests can
 *  drive it entirely with fakes (spec C's exit-code contract, design §D composition). */
export async function runOnboarding(argv: string[], deps: OnboardingCliDeps): Promise<number> {
  const args = parseCliArgs(argv, deps);
  if (args === null) return EXIT.USAGE_ERROR;

  /** Resolves one repo's mirror, tagging any failure with the repo that actually failed — a
   *  Promise.all across front + every service repo would otherwise report the wrong name when a
   *  service (not the primary) is the one missing on disk (spec C3: name the SPECIFIC repo). */
  async function resolveRepoRef(repo: string): Promise<RepoRef> {
    try {
      return { repo, mirrorDir: await deps.mirrorDir(repo) };
    } catch (err) {
      throw new Error(`could not resolve a mirror for "${repo}": ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  let front: RepoRef;
  let system: RepoRef[];
  try {
    [front, system] = await Promise.all([
      resolveRepoRef(args.repo),
      Promise.all(args.services.map(resolveRepoRef)),
    ]);
  } catch (err) {
    deps.error(`[onboard-app] ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.UNRESOLVED;
  }

  const result = await deps.runOnboardingLoop(system, front);
  if (result.profile === null) {
    deps.error(`[onboard-app] no boundary profile resolved anything within ${result.rounds} round(s) — nothing written.`);
    return EXIT.UNRESOLVED;
  }

  const lines = serializeBoundary(result.profile);
  const winnerScore = result.candidates.find((c) => c.profile === result.profile)?.score;
  deps.log(`[onboard-app] resolved a boundary profile (resolvedScore=${winnerScore?.resolvedScore ?? "?"}).`);

  if (args.dryRun) {
    deps.log(renderSnippet(lines));
    return EXIT.RESOLVED;
  }

  let existing: string | null;
  try {
    existing = deps.readConfig(args.configPath);
  } catch {
    existing = null; // missing config file → fall back to printing the snippet (fail-open)
  }

  if (existing === null) {
    deps.log(`[onboard-app] config file "${args.configPath}" not found — printing the proposed snippet instead:`);
    deps.log(renderSnippet(lines));
    return EXIT.RESOLVED;
  }

  try {
    const spliced = spliceBoundariesBlock(existing, lines);
    deps.writeConfig(args.configPath, spliced);
  } catch (err) {
    deps.error(`[onboard-app] failed to write "${args.configPath}": ${err instanceof Error ? err.message : String(err)}`);
    return EXIT.WRITE_ERROR;
  }

  deps.log(`[onboard-app] wrote boundaries: block into "${args.configPath}".`);
  return EXIT.RESOLVED;
}

// ---- real collaborators (argv entrypoint only — never imported by tests) ----

function realDeps(app: string, mirrorRoot: string): OnboardingCliDeps {
  const registry = new MirrorRegistryAdapter(mirrorRoot);
  const proposer = new LlmProfileProposerAdapter(defaultAgentDeps, PROPOSER_MODEL, { app });
  const service = new OnboardingService(proposer, 3);
  return {
    mirrorDir: (repo) => registry.mirrorDir(repo),
    runOnboardingLoop: (system, front) => service.onboard(system, front),
    readConfig: (path) => readFileSync(path, "utf8"),
    writeConfig: (path, content) => writeFileSync(path, content, "utf8"),
    log: (msg) => console.log(msg),
    error: (msg) => console.error(msg),
  };
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  // mirrorRoot resolution happens twice on purpose: parseCliArgs (inside runOnboarding) validates
  // --app/--repo first; realDeps needs app + mirrorRoot up front to construct the proposer. A
  // lightweight pre-parse here mirrors src/cli.ts's own argv-then-loadConfig sequencing.
  // allowPositionals here (and ONLY here): under strict:false an unknown option's value falls
  // through as a positional — forbidding positionals in the pre-parse would throw on any option
  // the pre-parse doesn't know (e.g. --repo X). Real validation is parseCliArgs' job downstream.
  const preParsed = parseArgs({
    args: argv,
    options: { app: { type: "string" }, "mirror-root": { type: "string" } },
    allowPositionals: true,
    strict: false,
  });
  const app = typeof preParsed.values.app === "string" ? preParsed.values.app : "";
  const mirrorRoot = typeof preParsed.values["mirror-root"] === "string" ? preParsed.values["mirror-root"] : (process.env.MIRROR_DIR ?? "");
  const code = await runOnboarding(argv, realDeps(app, mirrorRoot));
  process.exit(code);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
