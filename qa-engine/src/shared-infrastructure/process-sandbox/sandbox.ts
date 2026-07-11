// qa-engine/src/shared-infrastructure/process-sandbox/sandbox.ts
// Privilege-drop sandbox for untrusted code execution (§21), moved from src/qa/code-runner.ts
// (migration-tier-4b, Slice 1 — code-execution migration). Body is byte-for-byte identical to the
// legacy implementation EXCEPT for one deliberate change: `resolveSandbox`'s `env` parameter no
// longer defaults to `process.env`. CLAUDE.md's "arch:check and env-read confinement" invariant
// forbids a NEW `process.env` read inside qa-engine/src (the one standing exception is
// scrub-env.ts's own body); a default parameter value of `process.env` would be exactly that, even
// though it is never evaluated once every caller passes `env` explicitly. The CODE_SANDBOX* env
// read now happens in src/server/rewritten-engine-factory.ts (the composition-root shell caller)
// exactly like PANCHITO_ROOT/GITHUB_TOKEN are read there — `resolveSandbox` was already
// parameterized to accept `env`; only the escape-hatch default is removed.
//
// scrubEnv() removes SECRETS FROM THE ENVIRONMENT, but the watched repo's install/test/coverage
// commands still run as the orchestrator's user (root, in the container) with its filesystem. That
// lets a malicious or buggy test READ the root-owned API token (config/.api_token, 0600), TAMPER
// with the orchestrator's own files (/app/src, node_modules), write SIBLING repos under
// /app/.mirrors, or plant a .git hook that later runs as root on the publish `git commit`. We close
// those by DROPPING PRIVILEGE: the untrusted spawns run as a dedicated unprivileged user (the
// `sandbox` user baked into the image), and the run's working copy is chowned to it so it can only
// write its OWN tree. NETWORK is intentionally left intact — Maven/Gradle resolve dependencies
// during the test phase, so a network namespace would break the JVM target; egress restriction is a
// deploy-layer control (see docker-compose.yml / docs/code-mode-sandbox.md).

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

export interface Sandbox {
  uid: number;
  gid: number;
  home: string;
}

// Resolves the sandbox identity, or null when privilege-drop does not apply (not root, not Linux,
// explicitly disabled, or the sandbox home is absent → the image wasn't built with the user). When
// null, spawns run as the current user exactly as before — so local `npm run qa` on macOS still works.
// `env` is REQUIRED (no default) — the caller (composition-root shell) must read process.env and
// pass it in; see this file's header for why. `platform`/`getuid`/`homeExists` keep their legacy
// defaults (none of them read `process.env`, so they are not subject to the same confinement rule).
export function resolveSandbox(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  getuid: () => number = () => process.getuid?.() ?? -1,
  homeExists: (p: string) => boolean = existsSync,
): Sandbox | null {
  if (env.CODE_SANDBOX === "off") return null; // operator escape hatch
  if (platform !== "linux") return null; // uid/gid spawn needs POSIX privilege semantics
  if (getuid() !== 0) return null; // only root can setuid to the sandbox user
  const uid = Number(env.CODE_SANDBOX_UID ?? 1001);
  const gid = Number(env.CODE_SANDBOX_GID ?? uid);
  const home = env.CODE_SANDBOX_HOME ?? "/home/sandbox";
  if (!Number.isInteger(uid) || uid <= 0 || !Number.isInteger(gid) || gid < 0) return null;
  if (!homeExists(home)) {
    console.warn(`[qa] code-mode sandbox DISABLED: home ${home} not found (image built without the sandbox user?). Untrusted code will run as the current user.`);
    return null;
  }
  return { uid, gid, home };
}

// Spawn options that drop to the sandbox: the uid/gid plus a HOME pointing at the sandbox's own
// writable home (so toolchain caches — ~/.m2, ~/.gradle, ~/.cache, ~/.cargo — never touch root's),
// merged onto the scrubbed env. When `sandbox` is null this is just the scrubbed env (unchanged),
// so the spawn runs exactly as before.
export function sandboxSpawnOptions(
  base: Record<string, string>,
  sandbox: Sandbox | null,
): { env: Record<string, string>; uid?: number; gid?: number } {
  if (!sandbox) return { env: base };
  return {
    env: { ...base, HOME: sandbox.home, USER: "sandbox", LOGNAME: "sandbox" },
    uid: sandbox.uid,
    gid: sandbox.gid,
  };
}

// Hand the run's working copy to the sandbox user so its install/test can write ONLY there. The
// chown runs on the SOURCE tree (before install/deps), so it is cheap. `.git` is kept ROOT-owned: a
// sandbox-writable `.git/hooks` would run as root on the orchestrator's next `git commit` (a classic
// sandbox escape). Root retains full access regardless of ownership, so publish/mirror git ops are
// unaffected. No-op when the sandbox does not apply. `sandbox` is REQUIRED (no default) — legacy's
// `= resolveSandbox()` default is dropped along with resolveSandbox's own `process.env` default (see
// this file's header); the ONE caller (code-setup.ts's default deps) now receives an already-resolved
// sandbox, injected from the composition-root shell.
export function prepareSandboxWorkdir(repoDir: string, sandbox: Sandbox | null): void {
  if (!sandbox) return;
  execFileSync("chown", ["-R", `${sandbox.uid}:${sandbox.gid}`, repoDir], { stdio: "ignore" });
  const gitDir = join(repoDir, ".git");
  if (existsSync(gitDir)) execFileSync("chown", ["-R", "0:0", gitDir], { stdio: "ignore" });
}
