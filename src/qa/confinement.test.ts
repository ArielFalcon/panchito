import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseStatusOutput,
  isE2eStray,
  isCodeDenied,
  isDangerousPath,
  classifyStrays,
  runConfinement,
  CONFINEMENT_DENYLIST,
  type ConfineDeps,
} from "./confinement";
import { join } from "node:path";

// ── parseStatusOutput ─────────────────────────────────────────────────────────

test("parseStatusOutput: modified file yields correct xy + path", () => {
  const result = parseStatusOutput("M  src/utils.ts\n");
  assert.deepEqual(result, [{ xy: "M ", path: "src/utils.ts" }]);
});

test("parseStatusOutput: untracked file yields xy=??", () => {
  const result = parseStatusOutput("?? foo.ts\n");
  assert.deepEqual(result, [{ xy: "??", path: "foo.ts" }]);
});

test("parseStatusOutput: rename line R old -> new yields new path only", () => {
  const result = parseStatusOutput("R  old-name.ts -> e2e/flows/new-name.spec.ts\n");
  assert.equal(result.length, 1);
  assert.equal(result[0]!.path, "e2e/flows/new-name.spec.ts");
  assert.equal(result[0]!.xy, "R ");
});

test("parseStatusOutput: copy line C old -> new yields new path only", () => {
  const result = parseStatusOutput("C  src/a.ts -> src/b.ts\n");
  assert.equal(result.length, 1);
  assert.equal(result[0]!.path, "src/b.ts");
  assert.equal(result[0]!.xy, "C ");
});

test("parseStatusOutput: untracked file whose NAME contains ' -> ' keeps its full path", () => {
  // The ` -> ` split is gated on the rename/copy status code. A non-rename file (here untracked)
  // whose name literally contains " -> " must NOT be truncated to a phantom suffix.
  const result = parseStatusOutput("?? a -> b.ts\n");
  assert.equal(result.length, 1);
  assert.equal(result[0]!.xy, "??");
  assert.equal(result[0]!.path, "a -> b.ts", "the full path is preserved, not split");
});

test("parseStatusOutput: modified file whose NAME contains ' -> ' keeps its full path", () => {
  const result = parseStatusOutput("M  weird -> name.ts\n");
  assert.equal(result.length, 1);
  assert.equal(result[0]!.path, "weird -> name.ts");
});

test("parseStatusOutput: git-quoted path with spaces has quotes stripped", () => {
  const result = parseStatusOutput('?? "path with spaces/file.ts"\n');
  assert.equal(result.length, 1);
  assert.equal(result[0]!.path, "path with spaces/file.ts");
});

test("parseStatusOutput: empty/short lines are skipped", () => {
  const result = parseStatusOutput("\n\n \n");
  assert.deepEqual(result, []);
});

test("parseStatusOutput: multiple lines all parsed", () => {
  const out = "M  src/a.ts\n?? src/b.ts\n";
  const result = parseStatusOutput(out);
  assert.equal(result.length, 2);
  assert.equal(result[0]!.path, "src/a.ts");
  assert.equal(result[1]!.path, "src/b.ts");
});

// ── isE2eStray ────────────────────────────────────────────────────────────────

test("isE2eStray: path inside e2e/ is NOT a stray", () => {
  assert.equal(isE2eStray("e2e/flows/foo.spec.ts"), false);
});

test("isE2eStray: path inside e2e/.qa/ is NOT a stray", () => {
  assert.equal(isE2eStray("e2e/.qa/manifest.json"), false);
});

test("isE2eStray: bare 'e2e' directory is NOT a stray", () => {
  assert.equal(isE2eStray("e2e"), false);
});

test("isE2eStray: src/ path IS a stray", () => {
  assert.equal(isE2eStray("src/utils.ts"), true);
});

test("isE2eStray: root file IS a stray", () => {
  assert.equal(isE2eStray("README.md"), true);
});

test("isE2eStray: lib/helper.ts IS a stray", () => {
  assert.equal(isE2eStray("lib/helper.ts"), true);
});

// ── isCodeDenied ──────────────────────────────────────────────────────────────

test("isCodeDenied: .git/ is NOT denied (dead — git status never reports paths inside .git/)", () => {
  // .git/ was removed from the denylist: git status --porcelain never surfaces a path inside
  // .git/, so the entry could never match. .git/ hook RCE is hardened separately via core.hooksPath.
  assert.equal(isCodeDenied(".git/hooks/pre-commit"), false);
});

test("isCodeDenied: .env exact match", () => {
  assert.equal(isCodeDenied(".env"), true);
});

test("isCodeDenied: .env.production matches .env.* prefix rule", () => {
  assert.equal(isCodeDenied(".env.production"), true);
});

test("isCodeDenied: .env.local matches .env.* prefix rule", () => {
  assert.equal(isCodeDenied(".env.local"), true);
});

test("isCodeDenied: secrets.env matches *.env suffix rule", () => {
  assert.equal(isCodeDenied("secrets.env"), true);
});

test("isCodeDenied: .github/CODEOWNERS matches .github/ directory glob", () => {
  assert.equal(isCodeDenied(".github/CODEOWNERS"), true);
});

test("isCodeDenied: Dockerfile exact match", () => {
  assert.equal(isCodeDenied("Dockerfile"), true);
});

test("isCodeDenied: docker-compose.override.yml matches docker-compose* trailing-star", () => {
  assert.equal(isCodeDenied("docker-compose.override.yml"), true);
});

test("isCodeDenied: docker-compose.yml matches docker-compose* trailing-star", () => {
  assert.equal(isCodeDenied("docker-compose.yml"), true);
});

test("isCodeDenied: tests/auth_test.go is NOT denied", () => {
  assert.equal(isCodeDenied("tests/auth_test.go"), false);
});

test("isCodeDenied: src/config.ts is NOT denied", () => {
  assert.equal(isCodeDenied("src/config.ts"), false);
});

// F7: VCS-metadata entries.
test("isCodeDenied: .gitattributes is denied (VCS metadata)", () => {
  assert.equal(isCodeDenied(".gitattributes"), true);
});

test("isCodeDenied: .gitmodules is denied (VCS metadata)", () => {
  assert.equal(isCodeDenied(".gitmodules"), true);
});

// F5: case-insensitive matching — on a case-insensitive host .ENV / DOCKERFILE / .GitHub/
// resolve to the same files the lowercase denylist targets, so they must be denied too.
test("isCodeDenied: .ENV (uppercase) is denied (case-insensitive)", () => {
  assert.equal(isCodeDenied(".ENV"), true);
});

test("isCodeDenied: DOCKERFILE (uppercase) is denied (case-insensitive)", () => {
  assert.equal(isCodeDenied("DOCKERFILE"), true);
});

test("isCodeDenied: .GitHub/workflows/ci.yml is denied (case-insensitive directory glob)", () => {
  assert.equal(isCodeDenied(".GitHub/workflows/ci.yml"), true);
});

test("isCodeDenied: .ENV.Production is denied (case-insensitive .env.* prefix)", () => {
  assert.equal(isCodeDenied(".ENV.Production"), true);
});

test("isCodeDenied: CONFINEMENT_DENYLIST contains expected entries (and NOT the dead .git/)", () => {
  // Ensure the denylist itself has the documented entries.
  assert.ok(CONFINEMENT_DENYLIST.includes(".env"));
  assert.ok(CONFINEMENT_DENYLIST.includes(".env.*"));
  assert.ok(CONFINEMENT_DENYLIST.includes("*.env"));
  assert.ok(CONFINEMENT_DENYLIST.includes(".github/"));
  assert.ok(CONFINEMENT_DENYLIST.includes("Dockerfile"));
  assert.ok(CONFINEMENT_DENYLIST.includes("docker-compose*"));
  // F7: VCS-metadata entries (publishCode stages `.`, so an agent-written one would be committed).
  assert.ok(CONFINEMENT_DENYLIST.includes(".gitattributes"));
  assert.ok(CONFINEMENT_DENYLIST.includes(".gitmodules"));
  // .git/ is intentionally absent — git status never reports paths inside it (dead entry removed).
  assert.ok(!CONFINEMENT_DENYLIST.includes(".git/"));
});

// ── isDangerousPath ───────────────────────────────────────────────────────────

test("isDangerousPath: .git/config is NOT dangerous (dead — git status never reports .git/ paths)", () => {
  // .git/ was removed from the dangerous tier: git status never surfaces a path inside .git/, so
  // this predicate could never see one. .git/ hook RCE is hardened separately via core.hooksPath.
  assert.equal(isDangerousPath(".git/config"), false);
});

test("isDangerousPath: .git/hooks/pre-commit is NOT dangerous (dead .git/ matching removed)", () => {
  assert.equal(isDangerousPath(".git/hooks/pre-commit"), false);
});

test("isDangerousPath: .env exact is dangerous", () => {
  assert.equal(isDangerousPath(".env"), true);
});

test("isDangerousPath: .env.local is dangerous", () => {
  assert.equal(isDangerousPath(".env.local"), true);
});

test("isDangerousPath: secrets.env is dangerous (suffix)", () => {
  assert.equal(isDangerousPath("secrets.env"), true);
});

test("isDangerousPath: lib/helper.ts is NOT dangerous", () => {
  assert.equal(isDangerousPath("lib/helper.ts"), false);
});

test("isDangerousPath: src/utils.ts is NOT dangerous", () => {
  assert.equal(isDangerousPath("src/utils.ts"), false);
});

// F5: case-insensitive — .ENV / secrets.ENV resolve to the same secret on a case-insensitive host.
test("isDangerousPath: .ENV (uppercase) is dangerous (case-insensitive)", () => {
  assert.equal(isDangerousPath(".ENV"), true);
});

test("isDangerousPath: secrets.ENV (uppercase suffix) is dangerous (case-insensitive)", () => {
  assert.equal(isDangerousPath("secrets.ENV"), true);
});

// ── classifyStrays ────────────────────────────────────────────────────────────

test("classifyStrays (e2e target): tracked modification outside e2e/ is a tracked stray", () => {
  const changes = [{ xy: "M ", path: "src/foo.ts" }];
  const { tracked, untracked, dangerousByPath } = classifyStrays(changes, false);
  assert.deepEqual(tracked, ["src/foo.ts"]);
  assert.deepEqual(untracked, []);
  assert.deepEqual(dangerousByPath, []);
});

test("classifyStrays (e2e target): file inside e2e/ is NOT a stray", () => {
  const changes = [{ xy: "M ", path: "e2e/flows/login.spec.ts" }];
  const { tracked, untracked } = classifyStrays(changes, false);
  assert.deepEqual(tracked, []);
  assert.deepEqual(untracked, []);
});

test("classifyStrays (e2e target): untracked .env.local is untracked + dangerous", () => {
  const changes = [{ xy: "??", path: ".env.local" }];
  const { tracked, untracked, dangerousByPath } = classifyStrays(changes, false);
  assert.deepEqual(tracked, []);
  assert.deepEqual(untracked, [".env.local"]);
  assert.deepEqual(dangerousByPath, [".env.local"]);
});

test("classifyStrays (code target): .github/ci.yml is a tracked stray (denylist)", () => {
  const changes = [{ xy: "M ", path: ".github/ci.yml" }];
  const { tracked, untracked } = classifyStrays(changes, true);
  assert.deepEqual(tracked, [".github/ci.yml"]);
  assert.deepEqual(untracked, []);
});

test("classifyStrays (code target): src/config.ts NOT denied → no stray", () => {
  const changes = [{ xy: "M ", path: "src/config.ts" }];
  const { tracked, untracked } = classifyStrays(changes, true);
  assert.deepEqual(tracked, []);
  assert.deepEqual(untracked, []);
});

test("classifyStrays (code target): untracked .env.local → untracked + dangerous", () => {
  const changes = [{ xy: "??", path: ".env.local" }];
  const { tracked, untracked, dangerousByPath } = classifyStrays(changes, true);
  assert.deepEqual(untracked, [".env.local"]);
  assert.deepEqual(dangerousByPath, [".env.local"]);
});

// ── runConfinement (stubbed git + realpath) ───────────────────────────────────

function makeDeps(statusOut: string, gitCalls: Array<string[]>): ConfineDeps {
  return {
    git: async (args, _cwd) => {
      gitCalls.push(args);
      // status call returns the stubbed output; other calls (restore, clean) return "".
      if (args[0] === "status") return statusOut;
      return "";
    },
    realpath: (p) => p, // identity: no symlink escapes unless we override
    isSymlink: () => false, // nothing is a symlink unless a test overrides this
  };
}

test("runConfinement: tracked stray → staged-aware git restore called, result correct", async () => {
  const gitCalls: Array<string[]> = [];
  const deps = makeDeps("M  src/config.ts\n", gitCalls);
  const result = await runConfinement("/mirror", false, deps);
  assert.equal(result.strays, 1);
  assert.equal(result.dangerous, 0);
  assert.deepEqual(result.reverted, ["src/config.ts"]);
  // Tracked strays are reverted with `git restore --staged --worktree --source=HEAD` (staged-aware),
  // NOT `git checkout --` (which restores from the index and leaves a staged-new file).
  const restoreCall = gitCalls.find((a) => a[0] === "restore");
  assert.ok(restoreCall, "git restore should be called");
  assert.deepEqual(
    restoreCall,
    ["restore", "--staged", "--worktree", "--source=HEAD", "--", "src/config.ts"],
    "restore must be staged-aware (unstage + restore worktree from HEAD)",
  );
  assert.equal(gitCalls.find((a) => a[0] === "checkout"), undefined, "git checkout must NOT be used");
  assert.equal(gitCalls.find((a) => a[0] === "clean"), undefined, "git clean should NOT be called for a tracked stray");
});

test("runConfinement: STAGED-new denylist stray (code target) → restore unstages + removes it", async () => {
  // publishCode runs `git add .`, so a denylist stray can be STAGED-new (status "A "). A plain
  // `git checkout -- ` would restore from the index and leave the staged file to be committed; the
  // staged-aware restore unstages AND removes it. The stub records the exact command sequence.
  const gitCalls: Array<string[]> = [];
  const deps = makeDeps("A  .env.local\n", gitCalls);
  const result = await runConfinement("/mirror", true, deps);
  assert.equal(result.strays, 1, "the staged-new .env.local is a stray");
  assert.equal(result.dangerous, 1, ".env.local is dangerous (secret)");
  assert.deepEqual(result.reverted, [".env.local"]);
  // A staged-new file has status "A " (not "??"), so it goes through the tracked → restore path,
  // not git clean. restore --source=HEAD removes a file that did not exist at HEAD.
  const restoreCall = gitCalls.find((a) => a[0] === "restore");
  assert.deepEqual(
    restoreCall,
    ["restore", "--staged", "--worktree", "--source=HEAD", "--", ".env.local"],
    "a staged-new stray must be reverted via staged-aware restore",
  );
  assert.equal(gitCalls.find((a) => a[0] === "clean"), undefined, "clean must NOT run for a staged (tracked-bucket) stray");
});

test("runConfinement: untracked secret file → git clean called, dangerous counted", async () => {
  const gitCalls: Array<string[]> = [];
  const deps = makeDeps("?? secret.env\n", gitCalls);
  const result = await runConfinement("/mirror", false, deps);
  assert.equal(result.strays, 1);
  assert.equal(result.dangerous, 1);
  assert.deepEqual(result.reverted, ["secret.env"]);
  const cleanCall = gitCalls.find((a) => a[0] === "clean");
  assert.ok(cleanCall, "git clean should be called for an untracked stray");
  assert.ok(cleanCall!.includes("secret.env"), "clean should include the stray path");
  const restoreCall = gitCalls.find((a) => a[0] === "restore");
  assert.equal(restoreCall, undefined, "git restore should NOT be called for an untracked stray");
});

test("runConfinement: clean working copy → no git restore or clean, zero strays", async () => {
  const gitCalls: Array<string[]> = [];
  const deps = makeDeps("", gitCalls);
  const result = await runConfinement("/mirror", false, deps);
  assert.equal(result.strays, 0);
  assert.equal(result.dangerous, 0);
  assert.deepEqual(result.reverted, []);
  const restore = gitCalls.find((a) => a[0] === "restore");
  const clean = gitCalls.find((a) => a[0] === "clean");
  assert.equal(restore, undefined, "git restore must not be called on a clean working copy");
  assert.equal(clean, undefined, "git clean must not be called on a clean working copy");
});

test("runConfinement: symlink escape within e2e/ counted as dangerous + reverted", async () => {
  const mirrorDir = "/mirror";
  const gitCalls: Array<string[]> = [];
  // "e2e/link-out" is in-area textually, but it is a SYMLINK whose realpath escapes mirrorDir.
  const statusOut = "M  e2e/link-out\n";
  const escapedReal = "/outside/the/mirror/target";
  const deps: ConfineDeps = {
    git: async (args, _cwd) => {
      gitCalls.push(args);
      if (args[0] === "status") return statusOut;
      return "";
    },
    realpath: (p) => {
      if (p === join(mirrorDir, "e2e/link-out")) return escapedReal;
      return p; // mirrorDir itself maps to itself
    },
    // Only the link is a symlink — the lstat pre-filter must let it through to realpath.
    isSymlink: (p) => p === join(mirrorDir, "e2e/link-out"),
  };
  const result = await runConfinement(mirrorDir, false, deps);
  assert.equal(result.dangerous, 1, "escape should be counted as dangerous");
  assert.ok(result.reverted.includes("e2e/link-out"), "escaped path must be in reverted list");
});

test("runConfinement: an ordinary (non-symlink) in-area file never pays realpath (lstat pre-filter)", async () => {
  // The escape check must skip realpath for ordinary files — only symlinks can escape via resolution.
  const mirrorDir = "/mirror";
  const gitCalls: Array<string[]> = [];
  let realpathCalls = 0;
  const deps: ConfineDeps = {
    git: async (args) => {
      gitCalls.push(args);
      if (args[0] === "status") return "M  e2e/flows/ok.spec.ts\n";
      return "";
    },
    realpath: (p) => {
      // mirrorDir is resolved once up front; an ordinary changed file must NOT be resolved.
      if (p !== mirrorDir) realpathCalls++;
      return p;
    },
    isSymlink: () => false, // ordinary file
  };
  const result = await runConfinement(mirrorDir, false, deps);
  assert.equal(result.strays, 0, "the in-area spec is not a stray");
  assert.equal(realpathCalls, 0, "realpath must NOT be called for an ordinary in-area file");
});

test("runConfinement (code target): symlink escape is detected + reverted (escape check runs for code too)", async () => {
  // publishCode stages `.`, so an escaping symlink would otherwise be committed. The escape check
  // must run for the code target, not only e2e. Here a tracked symlink outside any denied path
  // escapes the mirror via realpath.
  const mirrorDir = "/mirror";
  const gitCalls: Array<string[]> = [];
  const statusOut = "M  src/link-out\n"; // not denied by name; dangerous only by resolution
  const deps: ConfineDeps = {
    git: async (args) => {
      gitCalls.push(args);
      if (args[0] === "status") return statusOut;
      return "";
    },
    realpath: (p) => (p === join(mirrorDir, "src/link-out") ? "/etc/passwd" : p),
    isSymlink: (p) => p === join(mirrorDir, "src/link-out"),
  };
  const result = await runConfinement(mirrorDir, true, deps);
  assert.equal(result.dangerous, 1, "the escaping symlink must be dangerous on the code target too");
  assert.ok(result.reverted.includes("src/link-out"), "the escaped path must be reverted");
  const restoreCall = gitCalls.find((a) => a[0] === "restore");
  assert.ok(restoreCall?.includes("src/link-out"), "the tracked escape must be reverted via restore");
});

// F4: a path that is BOTH a denylist secret (dangerousByPath) AND an escaping symlink (escapes)
// must be counted as dangerous exactly ONCE — a plain sum would double-count it.
test("runConfinement (code target): a path that is both a denied secret AND an escaping symlink counts dangerous once", async () => {
  const mirrorDir = "/mirror";
  const gitCalls: Array<string[]> = [];
  // .env.local is denied by name (dangerousByPath) AND, here, a symlink that escapes (escapes).
  const statusOut = "M  .env.local\n";
  const deps: ConfineDeps = {
    git: async (args) => {
      gitCalls.push(args);
      if (args[0] === "status") return statusOut;
      return "";
    },
    realpath: (p) => (p === join(mirrorDir, ".env.local") ? "/etc/secrets" : p),
    isSymlink: (p) => p === join(mirrorDir, ".env.local"),
  };
  const result = await runConfinement(mirrorDir, true, deps);
  assert.equal(result.dangerous, 1, "must be deduped to 1 — not 2 (denylist + escape overlap)");
  assert.equal(result.strays, 1, "still a single stray");
  assert.deepEqual(result.reverted, [".env.local"], "reverted exactly once (no duplicate)");
});

test("runConfinement: empty tracked + untracked arrays → git is NOT called with empty args", async () => {
  // All changes are inside e2e/ (in-area), so classifyStrays produces empty arrays.
  const gitCalls: Array<string[]> = [];
  const deps = makeDeps("M  e2e/flows/login.spec.ts\n", gitCalls);
  const result = await runConfinement("/mirror", false, deps);
  assert.equal(result.strays, 0);
  // Only the status call should have been made.
  const nonStatusCalls = gitCalls.filter((a) => a[0] !== "status");
  assert.equal(nonStatusCalls.length, 0, "no restore or clean when there are no strays");
});

test("runConfinement (code target): allowed test file survives, denied .github/ is reverted", async () => {
  const gitCalls: Array<string[]> = [];
  const deps = makeDeps("M  .github/ci.yml\n?? tests/new_test.go\n", gitCalls);
  const result = await runConfinement("/mirror", true, deps);
  assert.equal(result.strays, 1, "only the .github/ path is a stray");
  assert.ok(result.reverted.includes(".github/ci.yml"), ".github/ must be reverted");
  assert.ok(!result.reverted.includes("tests/new_test.go"), "test file must NOT be reverted");
});
