# OpenClaw Integration: Architecture and Product Plan

**Status**: ⚠️ NOT IMPLEMENTED — future product plan only.
**Author**: Sisyphus (AI Architect)
**Date**: 2026-06-05

> No `openclaw` service, plugins, or gateway exist in the codebase. The interactive
> surface that **was** built is the control API (`src/server/api.ts`) + the Ink TUI
> (`src/tui/`, launched via `bin/panchito`) + the read-only run assistant. This doc is
> an aspirational roadmap, not a description of the current system.

---

## 1. Vision

**ai-pipeline today** is a powerful engine that runs autonomously, but it only speaks two languages: webhooks and CLI flags. A developer who wants to trigger a QA run must know the exact app name, commit SHA, and mode syntax. A team lead who wants to understand why a test failed last Tuesday must grep through GitHub Issues. A new team member who wants to onboard their repo must read YAML documentation.

**ai-pipeline with OpenClaw** speaks human language. The same engine, but accessible through conversation: "check the last deploy of dashboard," "why did the checkout tests fail yesterday," "onboard the new payments service." The engine does not change. The interface does.

This is not a rewrite. It is a new access layer built on the existing system, respecting every invariant established in the project's architecture.

---

## 2. Current State vs. Desired State

### Today: three narrow interfaces

| Interface | Audience | Friction |
|---|---|---|
| Webhook | CI/CD post-deploy | Fully automated, no human interaction |
| CLI (`npm run qa`) | Developers at a terminal | Requires exact syntax, SHA knowledge, mode flags |
| TUI (`bin/qa`) | Operators in a shell | Requires memorizing subcommands, polling manually |

All three work. None of them invites exploration. A developer wondering "can this tool help me?" has no path to discover the answer without reading source code.

### Target: add a fourth interface that absorbs the other two for humans

| Interface | Audience | Experience |
|---|---|---|
| Webhook | CI/CD post-deploy | Unchanged |
| CLI (`npm run qa`) | Scripts, CI, power users | Unchanged |
| TUI (`bin/qa`) | Shell operators | Retained as fallback |
| **OpenClaw chat** | **Everyone else** | Natural language, guided discovery, multi-turn context |

The chat layer does not replace the CLI. It complements it. The CLI remains the tool for automation; the chat becomes the tool for humans.

---

## 3. Architecture Decisions

### Decision 1: OpenClaw as a third service, not embedded in the orchestrator

**Choice**: Add `openclaw` as a new Docker Compose service alongside `orchestrator` and `opencode`.

**Rationale**: The orchestrator is deterministic by design. Every side-effecting step is dependency-injected and unit-tested with stubs. Embedding an LLM-powered agent inside it would break this property and make the orchestration logic untestable. The project's own invariant states: "Never give the agent direct write to a watched repo." A separate service that communicates only through the existing REST API preserves this boundary naturally.

**What this enables**: The orchestrator does not know whether a run was triggered by a webhook, a CLI command, a TUI keystroke, or a chat message. It receives the same `{ app, sha, mode, guidance }` payload through the same queue. This is the definition of a clean abstraction.

### Decision 2: Three native plugins, not a monolithic agent

**Choice**: Build three focused OpenClaw plugins rather than one large agent.

**Rationale**: OpenClaw's plugin architecture encourages single-responsibility extensions. Each plugin registers its own tools, hooks, and routes. This gives us:

- **Independent development**: the pipeline tools plugin can ship before the security plugin is designed
- **Independent failure domains**: a bug in the copilot plugin does not block runs from being created
- **Composability**: teams can enable only the plugins they need. A small team might use only `qa-pipeline-tools`; an enterprise team enables all three

**What this looks like**:

```
openclaw gateway
  ├── qa-pipeline-tools   (required — the bridge to the REST API)
  ├── qa-guardian          (recommended — security and audit)
  └── qa-copilot           (advanced — predictive memory)
```

### Decision 3: REST API as the sole integration contract

**Choice**: OpenClaw calls `GET /api/apps`, `POST /api/runs`, `GET /api/runs/:id` — and nothing else.

**Rationale**: The REST API already handles validation, ref resolution, queue enqueuing, and status reporting. If OpenClaw imported the pipeline directly, it would need filesystem access to clone repos, read YAML configs, and resolve git refs — duplicating logic that already exists and is tested. The API is the published contract; every consumer (TUI, chat, future Slack bot, future IDE plugin) uses the same endpoints.

**What this enables**: We can evolve the pipeline internals without touching OpenClaw. The API is the stable interface. This is the same principle that lets `bin/qa` work without knowing how `pipeline.ts` is implemented.

### Decision 4: Shared engram, different namespaces

**Choice**: OpenClaw and the qa-generator agent share the same engram instance but use different project namespaces for their own operational data.

**Rationale**: The qa-generator writes memories about fragile flows and test patterns under `project=portfolio`. The qa-copilot plugin reads those same memories to inject context before runs. This is the virtuous cycle: the test generator learns from code, the chat layer learns from the test generator's learnings.

But the chat layer also produces its own memories (user preferences, conversation context, audit logs) that the test generator should never see. These go under a separate scope or topic key prefix, preventing context pollution.

**What this enables**: A developer can ask "what did we learn about the checkout flow last month?" and the chat layer retrieves memories written by both the qa-generator (test patterns) and previous chat sessions (user decisions). Two agents, one memory system, clean separation.

### Decision 5: Approval gating for destructive operations

**Choice**: The `qa-guardian` plugin intercepts every `qa_create_run` call and applies policy before the run reaches the queue.

**Rationale**: The existing system has no approval layer because webhooks and CLI commands are assumed to come from trusted sources (CI/CD, authenticated developers). A chat interface changes this: anyone with access to the chat channel can trigger runs. Without gating, a casual "test everything" could enqueue an exhaustive run that blocks the queue for an hour.

The guardian plugin enforces:
- **Mode gating**: `exhaustive` mode requires explicit confirmation
- **App scoping**: users can only trigger runs for apps they are authorized to access
- **Rate limiting**: maximum N runs per app per hour
- **Audit trail**: every run triggered through chat is logged with who, what, when, and why

### Decision 6: No real-time streaming, polling with progressive detail

**Choice**: The chat layer polls `GET /api/runs/:id` for status updates rather than implementing WebSocket push.

**Rationale**: The orchestrator already exposes step-level progress through the run record (`status`, `step`, `stepDetail`, `cases`, `logs`). Polling every 2 seconds gives the chat layer enough resolution to report "generating tests...", "running 8 specs against DEV...", "3 passed, 1 failed" as it happens, without requiring changes to the orchestrator's HTTP server.

WebSocket would be technically superior but architecturally invasive: it requires a persistent connection per run, state management on the server, and changes to the testable API surface. The cost outweighs the benefit for a chat interface where 2-second latency on status updates is imperceptible.

---

## 4. The Three Plugins: Product Definition

### Plugin 1: `qa-pipeline-tools` — The Bridge

**Purpose**: Make every capability of the ai-pipeline REST API available as typed, documented tools that an LLM can reason about and invoke.

**Capabilities exposed**:

| Tool | Maps to | What the user says to trigger it |
|---|---|---|
| `qa_create_run` | `POST /api/runs` | "test the last commit of dashboard" |
| `qa_get_run` | `GET /api/runs/:id` | "how is that QA going?" |
| `qa_list_runs` | `GET /api/runs?app=X` | "show me the last 5 runs of portfolio" |
| `qa_list_apps` | `GET /api/apps` | "what apps are configured?" |
| `qa_get_app` | `GET /api/apps/:name` | "tell me about the dashboard config" |
| `qa_get_queue` | `GET /api/queue` | "is there anything running right now?" |
| `qa_resolve_ref` | `POST /api/refs/resolve` | "what's the latest SHA on main?" |

**What makes this a product, not a wrapper**: Each tool is more than an HTTP call. It includes parameter validation with helpful error messages ("dashboard is not a configured app. Did you mean dashboard-api or dashboard-web?"), automatic retry on transient failures, and response formatting that turns raw JSON into readable summaries. The LLM receives tools it can reason about, not raw API documentation.

### Plugin 2: `qa-guardian` — The Safety Net

**Purpose**: Ensure that adding a conversational interface does not introduce new failure modes, security gaps, or audit blind spots.

**What it enforces**:

| Policy | Mechanism | Why |
|---|---|---|
| Destructive mode confirmation | `before_tool_call` hook intercepts `qa_create_run` with `mode=exhaustive` | Exhaustive regenerates the entire suite. A casual "test everything" should not trigger this without confirmation |
| App authorization | RBAC mapping: user identity to allowed apps | Different teams should not trigger runs on each other's apps |
| Rate limiting | Rolling window counter per app per user | Prevents queue saturation from rapid-fire commands |
| Audit logging | `after_tool_call` writes to engram with `type=audit` | Answers "who ran what and when" — critical for incident review |
| Failure notification | `agent_end` hook pushes to Slack/Discord on `fail` or `invalid` verdicts | Closes the feedback loop without requiring the user to poll |

**What makes this a product, not a checklist**: The guardian does not just block operations. It explains why. When it denies an exhaustive run, it tells the user: "Exhaustive mode regenerates the entire test suite for dashboard. This will take approximately 45 minutes and block other QA runs. Reply 'confirm' to proceed or try `diff` mode for just the last commit." This is education, not obstruction.

### Plugin 3: `qa-copilot` — The Memory

**Purpose**: Transform engram from passive storage into an active assistant that helps the agent make better decisions by learning from every run.

**What it does, phase by phase**:

**Before a run** — context injection via `before_prompt_build` hook:
- Retrieves the 3 most fragile flows for this app from engram
- Retrieves selector patterns that have proven reliable for this codebase
- Retrieves the last run result for the same or similar code paths
- Injects this as structured context before the agent prompt

**After a run** — pattern extraction:
- Analyzes the run result against historical patterns
- If the same test has failed 3 of the last 10 runs, flags it as a fragility hotspot
- If a selector pattern (e.g., `getByTestId`) consistently produces stable tests while another (`getByText`) produces flakes, records this as an app-specific pattern
- Updates the app's memory profile so the next run benefits

**Cross-run correlation**:
- When a new commit touches the same files as a commit from 2 weeks ago, retrieves the memory of that run: what was tested, what failed, what was learned
- This is the mechanism that breaks the circular quality loop: the system learns from real outcomes, not just LLM self-review

**What makes this a product, not a database query**: The copilot does not dump raw memory entries into the prompt. It synthesizes. Instead of "here are 47 engram observations about portfolio," it says: "The checkout flow has been fragile in 3 of the last 8 runs. The most common failure is a selector ambiguity on the payment button. Last fixed by commit abc123 which added `data-testid='pay-now'`. Consider verifying that selector is still present."

---

## 5. Integration Architecture

```
                          ┌─────────────────────────────────┐
  GitHub push to DEV      │         orchestrator             │
  ──────────────────────▶ │                                 │
                          │  POST /webhook  (unchanged)     │
                          │  POST /api/runs (unchanged)     │
                          │  GET  /api/runs/:id (unchanged) │
                          │  GET  /api/queue    (unchanged) │
                          │  GET  /api/apps     (unchanged) │
                          └───────────┬─────────────────────┘
                                      │
                                      │ HTTP session
                                      ▼
                          ┌─────────────────────────────────┐
                          │         opencode serve           │
                          │  qa-generator (unchanged)       │
                          │  qa-reviewer  (unchanged)       │
                          │  serena MCP   (unchanged)       │
                          │  engram MCP   (shared)          │
                          └─────────────────────────────────┘
                                      ▲
                                      │ reads memories
                                      │ written by qa-generator
                                      │
                          ┌───────────┴─────────────────────┐
                          │         openclaw gateway         │
                          │                                 │
                          │  ┌─────────────────────────┐    │
                          │  │ qa-pipeline-tools       │    │
                          │  │ 7 typed tools → REST API│    │
                          │  └─────────────────────────┘    │
                          │  ┌─────────────────────────┐    │
                          │  │ qa-guardian             │    │
                          │  │ hooks → approval + audit│    │
                          │  └─────────────────────────┘    │
                          │  ┌─────────────────────────┐    │
                          │  │ qa-copilot              │    │
                          │  │ hooks → context + learn │    │
                          │  └─────────────────────────┘    │
                          │                                 │
                          │  engram MCP (shared)            │
                          └─────────────────────────────────┘
```

**What changed**: One new service. Three new plugins. Zero changes to the orchestrator or opencode.

**What is shared**: engram. Both the qa-generator and the chat layer read and write to the same persistent memory, with namespace isolation preventing cross-contamination.

**What is separate**: Models. The qa-generator uses DeepSeek V4 Pro. The qa-reviewer uses Qwen 3.7 Max. OpenClaw uses whichever model the operator configures — ideally a fast, affordable model optimized for tool-calling rather than code generation. Different tasks, different models, no context pollution.

---

## 6. Non-Functional Requirements

### Security

- The chat layer never accesses git repositories directly. All runs flow through the existing queue, where the orchestrator controls git operations.
- The guardian plugin enforces that only authorized users can trigger runs on configured apps.
- All chat-triggered actions are logged to engram with immutable audit records.
- The API key for OpenClaw is separate from the OpenCode API key, limiting blast radius.

### Reliability

- If OpenClaw is down, webhooks and CLI continue to work. The pipeline has no dependency on the chat layer.
- If the REST API is down, the chat layer degrades gracefully: "The QA service is currently unavailable. I will notify you when it is back."
- All three plugins are independent. A failure in `qa-copilot` does not prevent `qa-pipeline-tools` from creating runs.

### Observability

- Every chat interaction that results in a pipeline run produces a run record with provenance: `triggered_by=chat`, `user=<identity>`.
- The guardian's audit trail answers operational questions: who ran what, when, and with what parameters.
- The copilot's memory profile for each app provides a dashboard of fragility hotspots and learned patterns.

### User Experience

- First interaction: "What can you do?" → agent lists configured apps and available actions
- Discovery: "Show me the dashboard app" → agent describes config, last runs, current coverage
- Action: "Test the last commit" → agent resolves ref, creates run, reports progress
- Follow-up: "Why did that fail?" → agent retrieves run details and relevant memory
- Learning: over time, the agent proactively suggests actions based on patterns

---

## 7. Risks and Mitigations

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| LLM hallucinates app names or SHAs | Medium | Low (API validates before enqueuing) | `qa_create_run` validates parameters server-side and returns clear errors |
| Chat layer becomes a bottleneck for the queue | Low | Medium (blocks automated runs) | Rate limiting in guardian; separate queue priority for webhook vs chat triggers |
| engram namespace collision between chat and generator | Low | Medium (context pollution) | Distinct scope/topic_key conventions; copilot reads but writes under separate prefix |
| OpenClaw version upgrades break plugins | Medium | Low (plugins are versioned) | Pin plugin versions; integration tests that exercise each tool against the API |
| Team over-relies on chat and stops writing CLI scripts | Low | Low (different use cases) | CLI remains documented and supported; chat is additive, not replacement |

---

## 8. Rollout Plan

### Phase 1: Foundation (week 1-2)
- Deploy OpenClaw as a third Docker service
- Ship `qa-pipeline-tools` plugin
- Add missing `POST /api/refs/resolve` endpoint to the REST API
- Internal testing: trigger runs through chat, verify against CLI results

### Phase 2: Safety (week 3)
- Ship `qa-guardian` plugin
- Define RBAC policies per app
- Enable audit logging
- Configure Slack/Discord failure notifications

### Phase 3: Intelligence (week 4-5)
- Ship `qa-copilot` plugin
- Seed initial memory profiles from existing engram data
- Validate that context injection improves agent decisions
- Tune the synthesis prompts for quality over quantity

### Phase 4: Adoption (week 6+)
- Expose chat interface to the development team
- Monitor: run frequency, success rate, user satisfaction
- Iterate on plugin behavior based on real usage patterns
- Consider additional channels (Slack bot, IDE plugin) using the same REST API

---

## 9. Success Criteria

The integration is successful when:

1. A developer who has never used ai-pipeline can trigger their first QA run within 60 seconds of opening the chat, without reading documentation.
2. The chat layer handles 90% of interactive triggers that today require `bin/qa` or `npm run qa`.
3. No pipeline invariant is violated: the queue remains sequential, the orchestrator remains the sole git writer, and the static and flakiness gates continue to operate unchanged.
4. The copilot plugin demonstrates measurable improvement: tests generated with copilot context have fewer selector ambiguities and fewer reviewer rejections than tests generated without.
5. The audit trail captures sufficient detail to answer any operational question about who triggered what run and why, without requiring access to chat logs.
