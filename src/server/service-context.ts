// Stages a READ-ONLY, bounded snapshot of a related microservice's context (OpenAPI/contract
// files + the triggering commit's diff and post-change file content) INSIDE the front repo's
// own working copy, under e2e/.qa/service-context/<repo-slug>/.
//
// Why this exists (cross-repo generation stall, root cause): a cross-repo run used to embed an
// ABSOLUTE path to a SIBLING mirror (e.g. /app/.mirrors/org__ms-orders) directly into the
// generation prompt, but the agent session is rooted at the FRONT repo's working copy. A read
// outside that session root trips opencode serve's external_directory permission gate (no path
// scoping in SDK 1.17.7), which waits for an approval that never comes — the tool call hangs
// until the 180s watchdog fires and the run surfaces as infra-error. Staging the minimal context
// the agent actually needs (the service's contract + this commit's diff) IN-ROOT keeps every
// read inside the session root, so the gate never engages.
//
// The staged directory path is a PURE function of (workingCopyDir, repo) — deliberately NOT of
// the sha — so it can be computed synchronously at CompositionConfig build time (before the real
// checkout/staging side effect has run), the same "single deterministic formula, computed twice"
// precedent workdirRoot()/vcsDir already establish elsewhere in this codebase (see
// rewritten-engine-factory.ts). The actual staging (this module's real work) happens later, once
// the mirrors exist on disk, and writes INTO that same already-agreed-upon path.
//
// Every side effect (fs + git) is injected via StageDeps, so the staging/capping/omission logic
// is fully unit-tested without touching real disk or process — mirrors the module pattern of
// repo-mirror.ts / mirror-prune.ts / setup.ts (each integration exports its own `*Deps` +
// `default*Deps`).

import { dirname, join, relative, sep } from "node:path";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import type { Git } from "../integrations/repo-mirror";
import { realGit } from "../integrations/repo-mirror";

export interface StageServiceContextInput {
  workingCopyDir: string; // the FRONT repo's working copy (the agent session root)
  service: { repo: string; mirrorDir: string; openapi?: string | string[] };
  sha?: string; // the triggering commit — diff/changed-files staging only runs when present
}

export interface StagedServiceContext {
  dir: string;
  manifestPath: string;
}

export interface OmittedEntry {
  path: string;
  reason: string;
}

export interface ServiceContextManifest {
  repo: string;
  sha?: string;
  stagedAt: string; // ISO, derived from the injected clock — never a direct Date.now() read
  contracts: string[]; // repo-relative paths staged under contracts/
  changed: string[]; // repo-relative paths staged under changed/
  omitted: OmittedEntry[]; // anything considered but NOT staged, with why — no silent truncation
}

export interface StageDeps {
  git: Git;
  exists(path: string): boolean;
  mkdir(path: string): void; // recursive (mkdir -p semantics)
  rm(path: string): void; // recursive + force (rm -rf semantics)
  /** All FILES (not directories) under `dir`, recursively, as POSIX-style paths relative to `dir`. */
  listFiles(dir: string): string[];
  readFile(path: string): Buffer;
  writeFile(path: string, data: string | Buffer): void;
  now(): number; // epoch millis — matches the now()/deploy-gate.ts, mirror-prune.ts precedent
}

// Determinism + boundedness caps (task spec): omissions are always recorded in the manifest,
// never silently dropped.
const MAX_FILES = 200;
const MAX_TOTAL_BYTES = 2 * 1024 * 1024;
const MAX_FILE_BYTES = 512 * 1024;
const BINARY_SNIFF_BYTES = 8 * 1024;

function repoSlug(repo: string): string {
  return repo.replaceAll("/", "__");
}

// The ONE formula for the staged directory — shared by this module (where it writes) and
// rewritten-engine-factory.ts (which threads it, synchronously, into triggerService.mirrorDir /
// services[].mirrorDir at composition time). Never re-derive this elsewhere.
export function serviceContextDir(workingCopyDir: string, repo: string): string {
  return join(workingCopyDir, "e2e", ".qa", "service-context", repoSlug(repo));
}

// Case-insensitive basename match for the default contract sweep (no openapi hint declared):
// **/{openapi,swagger,api-definition}*.{yaml,yml,json}.
const DEFAULT_CONTRACT_RE = /^(openapi|swagger|api-definition).*\.(ya?ml|json)$/i;
function matchesDefaultContractSweep(relPath: string): boolean {
  const base = relPath.split("/").pop() ?? relPath;
  return DEFAULT_CONTRACT_RE.test(base);
}

// Minimal glob matcher for declared openapi hints (config/apps/*.yaml `openapi:` values): "**"
// (any depth), "*" (single path segment), "?" (single char), everything else literal. Not a
// general-purpose glob engine — deliberately narrow to the shapes this config surface uses.
function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!;
    if (c === "*" && glob[i + 1] === "*") {
      re += ".*";
      i++;
      if (glob[i + 1] === "/") i++;
    } else if (c === "*") {
      re += "[^/]*";
    } else if (c === "?") {
      re += "[^/]";
    } else if (".+^${}()|[]\\".includes(c)) {
      re += "\\" + c;
    } else {
      re += c;
    }
  }
  return new RegExp(`^${re}$`, "i");
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, BINARY_SNIFF_BYTES).includes(0);
}

export async function stageServiceContext(
  input: StageServiceContextInput,
  deps: StageDeps = defaultStageDeps,
): Promise<StagedServiceContext> {
  const { workingCopyDir, service, sha } = input;
  const dir = serviceContextDir(workingCopyDir, service.repo);

  // Idempotent re-stage: wipe any prior run's content first so a stale file from a previous sha
  // (or a hint that has since changed) never survives into this run's snapshot.
  if (deps.exists(dir)) deps.rm(dir);
  deps.mkdir(dir);

  const contracts: string[] = [];
  const changed: string[] = [];
  const omitted: OmittedEntry[] = [];
  let totalBytes = 0;
  let fileCount = 0;

  const tryStageBuffer = (destRelPath: string, buf: Buffer): true | string => {
    if (fileCount >= MAX_FILES) return "max-files cap (200) exceeded";
    if (buf.byteLength > MAX_FILE_BYTES) return "file too large (> 512KB)";
    if (totalBytes + buf.byteLength > MAX_TOTAL_BYTES) return "total size cap (2MB) exceeded";
    const destAbs = join(dir, destRelPath);
    deps.mkdir(dirname(destAbs));
    deps.writeFile(destAbs, buf);
    totalBytes += buf.byteLength;
    fileCount++;
    return true;
  };

  const tryStageFromMirror = (relSrcPath: string, destRelPath: string): true | string => {
    const srcAbs = join(service.mirrorDir, relSrcPath);
    if (!deps.exists(srcAbs)) return "not found in the service mirror (deleted/renamed)";
    let buf: Buffer;
    try {
      buf = deps.readFile(srcAbs);
    } catch (e) {
      return `unreadable: ${e instanceof Error ? e.message : String(e)}`;
    }
    if (isBinary(buf)) return "binary file (skipped)";
    return tryStageBuffer(destRelPath, buf);
  };

  // 1. OpenAPI/contract files — hinted glob(s) when declared, otherwise the default sweep.
  const hints = service.openapi ? (Array.isArray(service.openapi) ? service.openapi : [service.openapi]) : undefined;
  const allFiles = deps.listFiles(service.mirrorDir);
  const candidateContracts =
    hints && hints.length > 0
      ? (() => {
          const matchers = hints.map(globToRegExp);
          return allFiles.filter((f) => matchers.some((re) => re.test(f)));
        })()
      : allFiles.filter(matchesDefaultContractSweep);
  for (const relPath of candidateContracts) {
    const result = tryStageFromMirror(relPath, join("contracts", relPath));
    if (result === true) contracts.push(relPath);
    else omitted.push({ path: relPath, reason: result });
  }

  // 2 & 3. The commit diff + each changed file's post-change content — only when a sha is known
  // (context-mode services carry no per-run commit; contracts-only staging applies then).
  if (sha) {
    try {
      const patch = await deps.git(["show", "--stat", "--patch", sha], service.mirrorDir);
      const result = tryStageBuffer("CHANGE.patch", Buffer.from(patch, "utf8"));
      if (result !== true) omitted.push({ path: "CHANGE.patch", reason: result });
    } catch (e) {
      omitted.push({ path: "CHANGE.patch", reason: `git show --patch failed: ${e instanceof Error ? e.message : String(e)}` });
    }

    let changedPaths: string[] = [];
    try {
      const out = await deps.git(["show", "--name-only", "--pretty=format:", sha], service.mirrorDir);
      changedPaths = out
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean);
    } catch (e) {
      omitted.push({ path: "changed/*", reason: `git show --name-only failed: ${e instanceof Error ? e.message : String(e)}` });
    }
    for (const relPath of changedPaths) {
      const result = tryStageFromMirror(relPath, join("changed", relPath));
      if (result === true) changed.push(relPath);
      else omitted.push({ path: relPath, reason: result });
    }
  }

  const manifest: ServiceContextManifest = {
    repo: service.repo,
    ...(sha ? { sha } : {}),
    stagedAt: new Date(deps.now()).toISOString(),
    contracts,
    changed,
    omitted,
  };
  const manifestPath = join(dir, "manifest.json");
  deps.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  return { dir, manifestPath };
}

// Excludes VCS internals and installed deps from the default sweep's directory walk — mirrors
// getDirectorySize's own recursive-walk precedent (mirror-prune.ts), best-effort (an unreadable
// subtree is skipped, never thrown).
function listFilesRecursive(dir: string, base: string = dir): string[] {
  let out: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === "node_modules" || entry.name === ".git") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      out = out.concat(listFilesRecursive(full, base));
    } else if (entry.isFile()) {
      out.push(relative(base, full).split(sep).join("/"));
    }
  }
  return out;
}

export const defaultStageDeps: StageDeps = {
  git: realGit,
  exists: existsSync,
  mkdir: (path) => mkdirSync(path, { recursive: true }),
  rm: (path) => rmSync(path, { recursive: true, force: true }),
  listFiles: (dir) => listFilesRecursive(dir),
  readFile: (path) => readFileSync(path),
  writeFile: (path, data) => writeFileSync(path, data),
  now: () => Date.now(),
};
