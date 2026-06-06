# Self-Updating Pipeline: Graceful Hot-Reload Architecture

**Status**: ⚠️ NOT IMPLEMENTED — design proposal only.
**Author**: Sisyphus (AI Architect)
**Date**: 2026-06-05
**Review**: `docs/self-updating-pipeline-review.md`

> **What actually shipped is different.** None of this doc's primitives exist in
> `src/` (no `AI_PIPELINE_SHA` SHA-poll, no `queue.json` checkpoint, no drain state
> machine). Instead, an **incident-driven maintainer agent** was built: incidents →
> a `qa-maintainer` OpenCode session opens a fix PR → a human reviews/merges → on
> merge the orchestrator runs a typecheck+test **self-test gate** on the merged code
> and only then hot-swaps `src/` and restarts. See `src/index.ts` (`triggerMaintainer`)
> and `src/server/maintainer.ts`. This doc is kept for historical context.

---

## 1. The Problem

A bug is discovered in ai-pipeline itself while it is running QA on a watched repo. The maintainer fixes the bug, pushes to main. But the running instance still executes the old code. The pipeline cannot heal itself without human intervention: someone must SSH in, pull, and restart.

Meanwhile, the queue has pending runs. The current run is mid-execution. A naive restart loses both. The fix exists in git, but the running process is frozen in time.

This document defines how ai-pipeline detects its own updates, drains gracefully, persists in-flight state, and resumes without losing a single run or requiring a human to touch the server.

---

## 2. Core Insight: The Fix Lives in the Tool, Not in the Process

The tool is a Docker container running a specific git SHA of itself. The fix lives at a newer SHA. The gap between the running SHA and the fixed SHA is the problem.

There are two distinct update scenarios:

| Scenario | Trigger | What must survive |
|---|---|---|
| **Orchestrator code changes** | Bug in `pipeline.ts`, `validate.ts`, `queue.ts`, etc. | Current run state, queue |
| **Agent prompt/skill changes** | Bug in `qa-generator.md`, `playwright-authoring` skill, etc. | Nothing. Prompts are read at session start. Next session picks up new files. |
| **opencode.json or MCP config** | Serena config change, model switch | Nothing. Config is read at session start. |
| **Dockerfile or dependency changes** | New npm package, Node.js version bump | Full container rebuild required |

The first scenario is the hard one. The last three are already solved by the architecture: the agent reads from the mounted `./opencode/` volume, so file changes are live without restart. Only the orchestrator runs a single Node.js process that must be restarted to pick up code changes.

In practice, most bugs in ai-pipeline will be in agent prompts and skills, not in the orchestrator. The orchestrator is thin: 290 lines of pipeline logic, 80 lines of queue. It changes rarely. The mechanism described here is for the rare case where orchestrator code needs updating. Its design reflects that frequency: it prioritizes simplicity over speed, correctness over reactivity.

---

## 3. Architecture

The mechanism has three components: detection, drain, and resume. Two states. One file.

### 3.1 Detection: How the Tool Discovers It Is Outdated

The orchestrator runs a `setInterval` timer every 5 minutes. On each tick, it compares its own SHA (injected at build time via `AI_PIPELINE_SHA`) against the remote `main` branch:

```
Every 5 min:
  remoteSha = git ls-remote origin/main | cut -f1
  if remoteSha != process.env.AI_PIPELINE_SHA:
    shouldDrain = true
```

The timer also fires at the end of each run — between dequeueing the next job and starting it. This handles the case where a new commit arrives while the queue is actively processing: the update is detected between runs, not only on the 5-minute boundary.

**Why 5 minutes, not 60 seconds**: The orchestrator changes rarely. A fix will take effect within 5 minutes of push. Reducing the interval to 60 seconds saves at most 4 minutes of staleness while doubling GitHub API calls and adding no material benefit.

**Why `setInterval`, not a child process**: The orchestrator already has an event loop. Adding a timer is 10 lines. A separate watchdog process introduces IPC, crash isolation, and signal handling — three failure modes that do not exist today. The simplest mechanism that works is the best one.

**Why not webhook self-triggering**: The webhook receiver is part of the orchestrator. If the orchestrator has a bug that prevents it from receiving webhooks, it cannot receive its own update signal. The timer is independent of the HTTP server: it works even if the server is down, overloaded, or buggy.

### 3.2 Drain: How the Tool Stops Without Losing Work

When `shouldDrain` becomes true, the orchestrator stops accepting new work and finishes what it is currently doing. There are exactly two states:

| State | Behavior |
|---|---|
| **RUNNING** | Normal operation. Accepts webhooks and API requests. Processes the queue. |
| **DRAINING** | Stops accepting new runs. Webhook returns `503` with `{"status":"draining"}`. API returns `503`. Finishes the current run to completion — whatever step it is in. Does NOT process any more runs from the queue. |

When the current run finishes, the orchestrator serializes the remaining queue and prepares to exit.

**Why drain at run boundaries, never mid-step**: A run mid-execution has live side effects: Playwright is running against DEV, results are being collected, a PR or Issue will be opened. Aborting it would leave the system in an unknown state. Waiting for it to finish guarantees that every run has exactly one verdict from exactly one execution. The cost is patience: at most the duration of one Playwright run (2-5 minutes for a typical suite).

**Why the queue is NOT drained**: If the queue has 3 pending runs, the orchestrator does not process them. It saves them to disk. The alternative — processing all pending runs before restarting — could take hours for a large queue. Saving them and resuming after restart takes the same total time but allows the update to happen sooner. The user's runs are not delayed; they are just processed by the new code instead of the old.

### 3.3 Checkpoint: A Flat Array of Pending Runs

Before exiting, the orchestrator writes every pending run to a file on the `mirrors` volume:

```
/app/.mirrors/queue.json
```

The file is a flat JSON array:

```json
[
  {"app":"portfolio","sha":"abc123","mode":"diff","source":"webhook"},
  {"app":"dashboard","sha":"def456","mode":"complete","source":"manual"}
]
```

That is the entire checkpoint. Five fields per run. No nested objects, no version metadata, no current run state. The queue order is the array order.

**Why flat**: The current run has already finished (drain only at run boundaries). There is nothing to checkpoint about it. History records are regenerable from engram and GitHub Issues. The queue is the only state that must survive.

**Why the mirrors volume**: It is already shared between orchestrator and opencode. It survives container restarts. It is regenerable, so adding a small JSON file is harmless.

**Why not engram**: engram is for persistent knowledge, not ephemeral operational state. The checkpoint is read once on resume and deleted. Mixing queue state with test pattern memories violates the engram data model and creates a dependency on opencode being up during resume — which may not be true.

### 3.4 Pre-Update Validation: Verify Before You Trust

Before the orchestrator exits, it verifies that the target SHA is functional. It clones ai-pipeline's own repo at the target SHA into a temporary working copy and runs the test suite:

```
1. Clone ai-pipeline at remoteSha into /tmp/self-update-<sha>
2. npm install && npm test
3. If tests pass → update proceeds → process.exit(0)
4. If tests fail → log "update to <sha> rejected: tests failed" → shouldDrain = false → resume normal operation
```

**Why this gate exists**: Without it, the tool blindly updates to whatever is on `main`. If a developer pushes broken code, the tool auto-updates to it, crashes on startup, and enters a Docker restart loop. The update mechanism designed to increase reliability has decreased it. The pre-update validation gate prevents this: the tool only updates to a SHA that passes its own test suite.

**Why clone a temporary copy**: The orchestrator's own working copy has local modifications (queue state, run artifacts). Running tests in it would produce unreliable results. A clean clone at the target SHA guarantees a pristine test environment.

### 3.5 Resume: Pick Up Where You Left Off

Docker's `restart: always` policy starts the new container. On boot, before opening port 8080, the orchestrator checks for the checkpoint file:

```
1. Check for /app/.mirrors/queue.json
2. If absent → clean boot. Nothing to recover.
3. If present:
   a. Parse the array
   b. Enqueue each run in order (preserving the sequence they arrived in)
   c. Delete queue.json
   d. Log: "Resumed N pending runs from checkpoint"
4. Open port 8080. Begin processing the queue.
```

The new orchestrator code processes the saved runs. From the user's perspective, nothing was lost — the runs arrived via webhook, waited in the queue while the tool updated itself, and are now being processed by the fixed code.

---

## 4. The Complete Flow (Timeline)

```
09:00:00  Developer pushes fix to main (SHA def456).
          Orchestrator is mid-execution on a dashboard run.
          shouldDrain is false. No update detected yet.

09:05:00  Timer fires. remoteSha = def456. AI_PIPELINE_SHA = abc123.
          shouldDrain = true. Webhook receiver starts returning 503.
          Current run continues. Queue has 3 pending runs.

09:07:30  Current run finishes (fail verdict). Issue opened.
          Orchestrator does NOT dequeue next run.
          Serializes 3 pending runs → /app/.mirrors/queue.json

09:07:35  Pre-update validation: clones ai-pipeline at def456 → npm test.
          104 tests pass.

09:08:00  Validation passes. process.exit(0).

09:08:03  Docker starts new container with def456 code.
          New orchestrator boots. Detects queue.json.
          Restores 3 runs to queue. Deletes queue.json.
          Opens port 8080. Begins processing.

09:08:05  Tool updated, 3 runs preserved, 0 human intervention.
```

**Total downtime**: 5 seconds between process exit and port open. During this window, incoming webhooks receive a connection error. GitHub retries automatically. By the time GitHub retries, the new process is listening.

---

## 5. What Does NOT Need Restarting

Most changes to ai-pipeline do not require the orchestrator to restart. The mechanism described here is for the minority case.

| Change | Requires orchestrator restart? | Why |
|---|---|---|
| `opencode/agent/*.md` prompt changes | No | Agent reads prompts at session start. Next session picks up changes. |
| `opencode/opencode.json` config | No | Config is read at session start. |
| `opencode/skill/*` changes | No | Skills are loaded on demand. |
| `config/apps/*.yaml` changes | No | Config is hot-reloaded (mounted as volume). |
| `src/**/*.ts` code changes | **Yes** | Node.js process must restart to load new modules. |
| `package.json` dependency changes | **Yes** | New dependencies require `npm install` + restart. |
| `Dockerfile` changes | **Yes** | Full container rebuild. |

---

## 6. Failure Modes

| Failure | Behavior | Why it is safe |
|---|---|---|
| Checkpoint file corrupted | JSON parse fails on resume. File deleted. Clean boot. | Lost runs are acceptable: they would be lost anyway on an unplanned crash. This mechanism is an improvement over that baseline. |
| Pre-update validation fails | Update rejected. `shouldDrain` reset to false. Normal operation resumes. | The tool stays on the current working version. The broken SHA is never deployed. |
| Timer fails to fire (event loop blocked) | No update detected. Tool stays on current version. | The tool continues working normally. A human can restart manually. The mechanism fails safe: no update is better than a broken update. |
| Docker restart loop (new code crashes) | Docker `restart: always` with exponential backoff. After repeated crashes, backoff reaches minutes. | Human notices the outage. Fixes the code. Next restart picks it up. Docker's built-in backoff prevents resource exhaustion. |
| queue.json is from a different ai-pipeline version | Schema mismatch. JSON parse handles missing fields gracefully. | The schema is deliberately minimal: 5 required fields. Forward and backward compatibility is trivial. |
| Two updates in quick succession (drain interrupted by newer SHA) | The timer fires during drain. `shouldDrain` is already true. No action taken. | The drain already targets the latest detected SHA. If a newer SHA arrives during drain, it will be detected on the NEXT timer tick after the new process starts — at most 5 minutes later. |

---

## 7. Pragmatic Note: Start Simple

The orchestrator codebase is thin and stable. It changes rarely — most development happens in agent prompts, which update live without restart. The mechanism described here handles an infrequent event.

For the first iteration, the simplest thing that works is acceptable: a developer runs `docker compose up -d --build` after pushing a fix. This takes 30 seconds. If this becomes painful — frequent orchestrator changes, inconvenient timing — implement the automated mechanism. The design is ready; the need will tell you when to build it.
