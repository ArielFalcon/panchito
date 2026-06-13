# Code-mode sandbox — isolating untrusted code execution

In **code mode** (`target: code`) the orchestrator runs a watched repo's **own** install and test
commands (`npm ci`, `mvn -B test`, `go test`, `pytest`, …) plus the LLM-generated tests. That code is
**untrusted**, and it runs inside the orchestrator container — the same container that holds the API
token, the GitHub push credential (via env), the run history, the maintainer state, and the working
copies of **every** watched repo. Without isolation, a malicious or merely buggy test could read
secrets, tamper with the orchestrator, or poison a sibling repo's working copy.

## Threat model — what untrusted code-mode code could do unguarded

| Asset | Risk without isolation |
|---|---|
| `config/.api_token` (the QA API token) | read it (it is on the mounted config volume) |
| `/app/src`, `/app/node_modules` | overwrite orchestrator code → backdoor that runs as root on the next boot |
| `/app/.mirrors/<other-repo>` | tamper with a **sibling** repo's working copy that later gets published |
| `.git/hooks` of the run's own repo | plant a hook that runs **as root** on the orchestrator's publish `git commit` |
| process environment | already mitigated — `scrubEnv()` strips every secret before the spawn |

## What the sandbox does (privilege-drop)

The orchestrator runs as **root**; for each untrusted spawn it **drops to an unprivileged user**
(`sandbox`, uid 1001, baked into the image) and hands that user **only** the run's working copy:

- **Identity drop** — install/test/coverage spawn with `{ uid, gid }` of `sandbox` and `HOME`
  redirected to the sandbox's own home (so toolchain caches — `~/.m2`, `~/.gradle`, `~/.cache`,
  `~/.cargo` — never touch root's). `scrubEnv()` still removes secrets from the environment.
- **Filesystem hand-off** — the working copy is `chown`ed to `sandbox` before any spawn, so untrusted
  code can write **only its own tree**. The orchestrator's secrets, state, source, and sibling repos
  stay root-owned → unreadable/unwritable to the sandbox.
- **Git hooks are disabled for every orchestrator git op** — a sandbox owns its working copy, so it
  could replace `.git` wholesale and plant a `pre-commit` hook that would run **as root** on the
  publish `git commit` (a classic escape). The orchestrator's git runner (`realGit` in
  `repo-mirror.ts`) passes `-c core.hooksPath=/dev/null` on the **command line** (which the repo's own
  `.git/config` cannot override), so no watched-repo hook ever runs. The chown also re-roots `.git` as
  defense-in-depth.
- **No-new-privileges** (`docker-compose.yml`) blocks the dropped child from re-acquiring root via a
  setuid binary.

This closes secret theft, orchestrator backdooring, cross-repo tampering, and the git-hook escape —
with **no extra capabilities, no docker socket, and no daemon** (the reason privilege-drop was chosen
over `bubblewrap`, which needs `CAP_SYS_ADMIN`/userns inside Docker, or Docker-in-Docker, which
exposes a root-equivalent socket).

## What it does NOT do — network egress (a deploy-layer control)

The sandbox **leaves the network intact**. Maven and Gradle (the JVM/Spring target) resolve
dependencies **during the test phase**, so a network namespace (`--unshare-net`) would break them.
Network egress restriction therefore stays a **deployment-layer** control: run the orchestrator
behind an egress firewall / Kubernetes `NetworkPolicy` that allows only the package registries and the
DEV target. Because `scrubEnv()` already keeps secrets out of the process and the high-value secrets on
disk are now unreadable to the sandbox, there is little in-process material left to exfiltrate.

> Per-phase network isolation (block the network for the *test* phase of ecosystems that have a
> separate, network-using *install* phase — node/python/go/rust) is a possible future increment; it is
> intentionally left out of the first iteration to keep behavior uniform and not break the JVM target.

**Residual — cross-repo READ.** Sibling working copies under `/app/.mirrors` are root-owned, so the
sandbox cannot *write* them (no tampering), but with default `0755` dirs it can still *read* another
watched repo's source. Because the engine is centralized for one **team** (all watched repos belong to
it) this is low-risk; a future increment can `chmod 0700` the mirrors root + sibling trees to close
read-confidentiality too. The integrity property (no cross-repo tampering) is already enforced.

## Configuration

| env var | default | effect |
|---|---|---|
| `CODE_SANDBOX` | (on) | set to `off` to disable the privilege-drop (untrusted code runs as the orchestrator user) |
| `CODE_SANDBOX_UID` | `1001` | the unprivileged uid to drop to |
| `CODE_SANDBOX_GID` | = uid | the gid to drop to |
| `CODE_SANDBOX_HOME` | `/home/sandbox` | the sandbox user's writable home (toolchain caches) |

The sandbox **only applies when the orchestrator runs as root on Linux and the sandbox home exists**
(the production container). Anywhere else — local `npm run qa` on macOS, a non-root container, or an
image built without the `sandbox` user — it **degrades safely to "run as the current user"** (a one-line
warning is logged), so local development is unaffected.

## Code map

- `Dockerfile` — creates the `sandbox` user (uid 1001).
- `src/qa/code-runner.ts` — `resolveSandbox()` (applicability), `sandboxSpawnOptions()` (uid/gid + HOME),
  `prepareSandboxWorkdir()` (chown the working copy, keep `.git` root-owned); wired into the install,
  test, and coverage spawns.
- `src/integrations/repo-mirror.ts` — `realGit` disables hooks (`core.hooksPath=/dev/null`) for every
  orchestrator git operation, closing the planted-hook escape.
- `docker-compose.yml` — `no-new-privileges` + the note that network egress is a deploy-layer control.
