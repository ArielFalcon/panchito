# Critical Review: Self-Updating Pipeline Architecture

**Reviewer**: Sisyphus (Senior Architect)
**Target**: `docs/self-updating-pipeline.md`
**Date**: 2026-06-05

---

## Executive Summary

The plan identifies the right problem but over-engineers the solution. A drain protocol with 6 states, file-based IPC between a watchdog and main process, step-level checkpointing with re-execution semantics, and a custom restart loop detector — this is the kind of complexity that causes more incidents than it prevents. The most robust self-updating system is the one with the fewest moving parts. This review identifies 7 real flaws and proposes a simplified architecture that eliminates 4 of the 6 proposed components while preserving the core guarantee: zero lost runs on restart.

---

## Flaw 1: The Watchdog as a Separate Process

**What the plan says**: Spawn a child process that polls `git ls-remote` every 60 seconds and writes to a `.drain-signal` file.

**Why it is wrong**: This introduces three failure modes that do not exist today. The watchdog can crash independently of the main process, leaving the system without update detection and no one to notice. The file-based IPC between watchdog and orchestrator creates a race condition: the orchestrator reads `.drain-signal` between steps, but what if the watchdog writes it while the orchestrator is mid-read? What if the file is left behind after a crash and triggers a spurious drain on next boot? What if the filesystem is full and the write silently fails?

And for what? A `setInterval` in the main process achieves the same result with zero additional failure modes. The orchestrator already has an event loop. Adding a 60-second timer that calls `git ls-remote` and sets an in-memory boolean `shouldDrain = true` is 10 lines of code with no IPC, no child process management, and no filesystem dependency.

**Verdict**: Eliminate the watchdog. Use `setInterval` in the main process.

---

## Flaw 2: Step-Level Checkpointing with Re-Execution Semantics

**What the plan says**: On drain, checkpoint the current run's step, partial results, and cases. On resume, re-execute from that step. Claims "Playwright runs are deterministic given the same specs."

**Why it is wrong**: The determinism claim is false. Playwright tests run against a live DEV environment. Between the checkpoint at 9:08 AM and the resume at 9:09 AM, the DEV database state may have changed, a third-party API may have returned different data, a cookie may have expired, a race condition in the app may have resolved differently. Re-running `execute` can produce a different verdict than the original run. This means a run that was `pass` before the restart could become `fail` after — or vice versa. The system would publish a result that does not correspond to what actually happened.

The plan attempts to mitigate this by merging results: "new results merge with existing." But merging verdicts from two different executions of the same specs creates an incoherent result. Which verdict is correct: the one from 9:08 or the one from 9:09? The system cannot know.

**The correct approach**: Never checkpoint mid-step. Only checkpoint between runs. If the orchestrator is in the middle of `execute`, it finishes the run to completion before draining. This guarantees that every run has exactly one verdict from exactly one execution. The cost is waiting — at most the duration of one Playwright run (typically 2-5 minutes). This is predictable, bounded, and produces correct results.

**Verdict**: Eliminate step-level checkpointing. Drain only at run boundaries.

---

## Flaw 3: The Drain State Machine

**What the plan says**: Six states: NORMAL → DRAINING → DRAINED → RESTARTING → RESUMING → NORMAL. With rules about which steps can be aborted and which cannot.

**Why it is wrong**: This state machine encodes knowledge about the pipeline's internal step structure into the drain mechanism. If a new step is added to the pipeline (e.g., a "notify" step after publish), the drain protocol must be updated. If a step changes its side-effect characteristics (e.g., `generate` starts writing to git), the abort rules become incorrect. The drain mechanism is coupled to the pipeline implementation — the exact kind of coupling that makes systems fragile.

The state machine also introduces the concept of "aborting early steps." This creates a new code path — "what happens when a run is aborted mid-classify?" — that must be tested, maintained, and reasoned about. Every new code path is a new source of bugs.

**The correct approach**: There are two states: RUNNING and DRAINING. In DRAINING, the orchestrator stops accepting new runs. It finishes the current run to completion — whatever step it is on. It does not abort anything. It does not care what step the run is in. When the run finishes, it saves the queue and exits. Two states, one rule: finish what you started.

**Verdict**: Collapse 6 states into 2. Eliminate abort logic entirely.

---

## Flaw 4: Checkpoint Schema Complexity

**What the plan says**: A nested JSON object with `version`, `drainingSha`, `targetSha`, `queue[]`, `currentRun{}` containing `cases[]`, `logs[]`, `step`, `stepDetail`, `verdict`, `retrying`.

**Why it is wrong**: The checkpoint's job is to preserve the queue so it can be restored after restart. It does not need to preserve the current run's state because — per Flaw 2 — we only drain at run boundaries. The current run has already completed. There is nothing to checkpoint about it.

The `version`, `drainingSha`, and `targetSha` fields are metadata useful for debugging but unnecessary for correctness. The queue is just an ordered list of `{app, sha, mode, guidance, source}` — exactly the payload that arrived via webhook or API.

**The correct structure**: A flat JSON array of pending runs. Optionally, a `drainedAt` timestamp for observability.

```json
[
  {"app":"portfolio","sha":"abc123","mode":"diff","source":"webhook"},
  {"app":"dashboard","sha":"def456","mode":"complete","source":"manual"}
]
```

That is the entire checkpoint. The order of the array is the queue order. On resume, pop each item and enqueue it.

**Verdict**: Flatten the checkpoint to a simple array. Drop currentRun, drop metadata, drop version.

---

## Flaw 5: No Pre-Update Validation

**What the plan says**: Detect new SHA, drain, restart with new SHA. No verification that the new SHA is functional.

**Why it is wrong**: The tool updates itself blindly to whatever is on `main`. If a developer pushes broken code at 11 PM, the tool updates itself at 11:01 PM, crashes on startup, and enters a Docker restart loop. The `restart: always` policy with backoff mitigates the infinite loop but does not solve the root cause: the tool is now running broken code and cannot process any runs until a human fixes `main` again.

This is a self-inflicted outage. The update mechanism that was designed to increase reliability has decreased it.

**The correct approach**: Before updating, verify that the target SHA passes the tool's own test suite. The orchestrator runs `npm test` against the new SHA in a temporary working copy. If tests pass, the update proceeds. If tests fail, the update is rejected and the orchestrator logs: "Update to def456 rejected: tests failed. Staying on abc123."

This requires the orchestrator to clone its own repo at the target SHA and run tests — but it already has the infrastructure for this (mirror, working copy, npm test). It is a `verify` run against itself, triggered automatically before the update.

**Verdict**: Add a pre-update validation gate: run ai-pipeline's own test suite against the target SHA before draining.

---

## Flaw 6: Network Dependency for Update Detection

**What the plan says**: `git ls-remote` polls GitHub every 60 seconds.

**Why it is wrong**: The orchestrator's ability to detect updates depends on GitHub being reachable. If GitHub is down (which happens), the orchestrator cannot detect updates — acceptable, it just stays on the current version. But there is a more subtle failure mode: if GitHub returns a stale or incorrect SHA (cache inconsistency, CDN issue), the orchestrator could detect a "new" SHA that does not exist or is not the intended one. It would then try to update to a SHA that — per Flaw 5 — fails pre-update validation and is rejected. This is a self-correcting failure, but it wastes a clone and test run.

More importantly: the poll interval creates a window where the orchestrator is running outdated code despite the fix being available. For critical fixes, waiting up to 60 seconds is fine. But the mechanism could be made event-driven instead of poll-driven.

**A valid enhancement (not a flaw)**: If ai-pipeline is configured to watch itself, its own webhook receiver can detect pushes to its own repo. This is not circular — the webhook receiver is thin, stable code that rarely changes. A push to main triggers the same webhook flow, but instead of enqueuing a QA run, it triggers the update protocol. This reduces the detection window from 60 seconds to near-instant.

**Verdict**: Polling is acceptable as the baseline. Webhook self-detection is a future optimization, not a requirement. The pre-update validation gate (Flaw 5) protects against bad SHAs regardless of detection method.

---

## Flaw 7: Over-Engineering Relative to Problem Frequency

**What the plan says**: An elaborate drain-checkpoint-resume mechanism with watchdog, state machine, step-level recovery, and restart loop detection.

**Why it is wrong**: The orchestrator's codebase is thin and stable. The pipeline logic (`pipeline.ts`) is 290 lines. The queue is 80 lines. The validators are each under 100 lines. This code changes rarely — most development happens in agent prompts, skills, and config, which do not require restart.

The elaborate mechanism is designed for a problem that will occur — at most — once every few weeks. The cost of the mechanism (maintenance burden, testing surface, failure modes) outweighs the cost of the problem (a few lost runs on the rare occasion a restart is needed without the mechanism).

**The pragmatic alternative**: For the first iteration, do nothing. When a developer pushes a fix to ai-pipeline, they manually run `docker compose up -d --build` after the current run finishes. This takes 30 seconds. If this becomes painful (frequent updates, inconvenient timing), implement the minimal version: drain at run boundary + queue serialization + restart. Three components, not six.

**Verdict**: Start with the simplest thing that could possibly work. The elaborate mechanism is premature optimization for a low-frequency event.

---

## Summary: What to Keep, What to Cut

| Component | Verdict | Reason |
|---|---|---|
| Watchdog (child process) | **Cut** | Use `setInterval` in main process. Zero additional failure modes. |
| File-based IPC (`.drain-signal`) | **Cut** | Use in-memory flag. No filesystem dependency. |
| 6-state drain machine | **Cut** | Use 2 states (RUNNING, DRAINING). No abort logic. |
| Step-level checkpointing | **Cut** | Drain only at run boundaries. Every run gets exactly one verdict. |
| Complex checkpoint schema | **Cut** | Flat array of pending runs. 5 fields per run. |
| Drain timeout with force-checkpoint | **Cut** | Never force-checkpoint. If a run is stuck, it is stuck regardless of update. |
| Pre-update validation gate | **Keep** | Run own test suite against target SHA before updating. This is the single most important safety mechanism. |
| Queue serialization on drain | **Keep** | Serialize pending runs to JSON. Restore on startup. Core guarantee. |
| Resume from checkpoint on boot | **Keep** | Check for saved queue on startup. Restore if present. |
| `restart: always` in Docker | **Keep** | Docker manages the restart. No custom restart loop detection needed — Docker has backoff built in. |

---

## The Simplified Architecture (Version 2)

```
1. Every 5 minutes (setInterval), the orchestrator runs:
   git ls-remote origin/main → remoteSha
   if remoteSha != AI_PIPELINE_SHA:
     shouldDrain = true

2. At the end of each run (after publish/report):
   if shouldDrain:
     stop accepting new runs (webhook → 503, API → 503)
     if queue has pending runs:
       serialize queue to /app/.mirrors/queue.json
     run pre-update validation:
       clone own repo at remoteSha → npm test
       if tests fail: log "update rejected", shouldDrain = false, resume normal operation
       if tests pass: proceed
     process.exit(0)

3. Docker restarts container with new image.
   New process starts.
   if /app/.mirrors/queue.json exists:
     restore queue in order
     delete queue.json
   begin processing

That is the entire mechanism. 3 steps. 2 states. 1 file.
```

---

## What This Fix Preserves from the Original Plan

- Zero lost runs: the queue is serialized before exit, restored on startup
- Zero human intervention: detection, validation, drain, restart, resume — all automatic
- Zero side-effect duplication: drain only at run boundaries, never mid-run
- The core guarantee: the tool updates itself without data loss

## What This Fix Eliminates

- The watchdog process and its failure modes
- File-based IPC and its race conditions
- The 6-state drain machine and its coupling to pipeline internals
- Step-level checkpointing and its non-determinism problem
- The drain timeout and force-checkpoint logic
- The custom restart loop detector (Docker handles this)

## What This Fix Adds

- Pre-update validation: the tool verifies the update is functional before applying it
- A single, flat checkpoint file that is trivially inspectable and debuggable
- Dramatically reduced testing surface: 2 states instead of 6, 0 abort paths
