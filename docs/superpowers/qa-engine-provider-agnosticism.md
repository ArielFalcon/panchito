# Provider Agnosticism — status & backlog (opencode | codex | …)

From the provider-agnosticism audit (2026-06-26). The engine must be agnostic to the CLI/agent
provider it drives. Today: `AgentProvider = "opencode" | "codex"`, single mode (one provider for all
roles) or dual mode (different providers per role, for independent judgment). The hexagonal rewrite
makes a 3rd provider (claude-code, gemini-cli, …) a one-adapter change — once the cutover lands.

## Verdict on the three questions

1. **Both modes usable optimally today? PARTIAL.** OpenCode is production-grade. Codex runs but was
   second-class with one latent crash. Fixed CFG-04 + CP-01 (below); CP-02 + robustness items remain.
2. **Config solid? MOSTLY**, for the two-provider world — after CFG-04. One documentation hole remains
   (CFG-05) and one no-key fallback masks the configured provider (CFG-06).
3. **3rd provider easy? NOT in the live engine yet.** The qa-engine rewrite achieves the abstraction
   (array-shaped facade, kernel-owned session port, per-provider breaker) but `src/` is what runs, and
   `src/` has ~11 closed-union coupling sites. The rewrite is the right destination; the cutover (Plan 6)
   makes it real.

## Done

- **CFG-04** (`6770b70`) — dual-mode reviewer defaults to the primary's complement, not a hardcoded
  `codex` (which collapsed onto a codex primary, defeating independent judgment).
- **CP-01** (`b288457`) — the stall watchdog now skips self-timed Codex sessions (codex is exec-per-prompt
  with its own timeout and no SSE activity; the watchdog was false-positive-killing any codex turn >180s).
- **6 qa-engine fixes** (in progress, workflow `wa8rpgqff`): config.adapter real `toView` transform
  (QA-01 — a guaranteed cutover crash), widen `LegacyStrategy.provider` to the kernel `AgentProvider`
  (EXT-005/QA-03), 3 missing codex strategy tests (QA-02), move `codex-error-to-infra` to infrastructure/
  (QA-04), single-mode facade test (QA-05).

## COORDINATE-LEGACY backlog (live `src/` — the user's territory)

These live in `src/` (some in the user's active WIP `codex-strategy.ts`). Reported, not auto-applied.

### Codex robustness / parity (fix before heavy codex use)
- **CP-02 (HIGH) — deferred to the fixture.** No live tool-call events on codex → the TUI is a black box
  during a codex run. The wiring (thread `onRunEvent` through `start()` → `runExec`, split stdout per-line,
  call `mapCodexExecEvent`) depends on the real `codex exec --json` JSONL fixture (**T-P1-0, image-gated,
  not yet captured**). Parsing blind is fragile. **Capture the fixture once from the built agents image,
  then wire it** (and validate `extractCodexLastMessage`'s field probe — CP-06). The CP-01 fix already
  stops the watchdog from killing codex, so codex is usable meanwhile (no live event stream).
- **CP-06 (MEDIUM)** — `extractCodexLastMessage` probes `msg ?? message ?? text ?? content` against an
  UNVERIFIED schema; a field outside those four → every codex response becomes the raw JSONL blob. Pin
  with the T-P1-0 fixture.
- **CP-08 (LOW)** — `CodexExecTransport.health()` reports healthy whenever `CODEX_API_KEY` is set without
  checking the binary exists → missing binary surfaces as `fail` (spurious Issue). Add `ENOENT`/`not found`
  to `codexErrorToInfra` (and mirror in the qa-engine classifier).
- **CP-03 (MEDIUM)** — token usage always null for codex → blank cost dashboards. Intentional until T-P1-0.
- **CP-07 / CP-09 (LOW)** — `SupervisorExecTransport` lacks `restart` (module fn covers it); `OPENCODE_TIMEOUT_MS`
  caps codex too (add `AGENT_TIMEOUT_MS`/`CODEX_TIMEOUT_MS`).

### Config & usability
- **CP-06/CFG-06 (MEDIUM)** — no-key fallback returns `opencode`, masking a codex-first operator's intent.
- **CFG-05 (MEDIUM) — highest operator-facing value.** `help.ts`/README document only ~4 of ~12 agent env
  vars. The per-role vars (`AGENT_PRIMARY/REVIEWER/CHAT_PROVIDER` + models) and infra vars — critically
  `AGENT_SUPERVISOR_URL` (flips codex from local-exec to supervisor-HTTP) — live only in code/.env.example.

### Extensibility — the 11 closed-union sites (do as ONE coordinated `src/` change, not 11 patches)
A 3rd provider today forces edits at: the `AgentProvider` union (`types.ts:6` + kernel mirror);
`opposite()` binary (`server/agent-runtime.ts:274`); `PROVIDERS` literal array; `apiKeyForProvider`/`keyName`
ternaries; dual-mode key check + literal messages; `defaultAgentRuntimeConfig` detection chain;
`DualAgentFacade` named `.opencode`/`.codex` access; `apiKeys`/`KeyPresence`/`AgentHealthMap` wire schemas;
the OpenAPI inline enum; `usageComplete` provider-name check in `pipeline.ts`.

**The refactor that makes it a one-adapter change:** a single `KNOWN_PROVIDERS = [...] as const` feeding
both the TS union and every `z.enum`; derive `PROVIDERS` from the injected strategy registry
(`Object.keys(strategies)`); kill `opposite()` (require an explicit reviewer provider, or "first registered
≠ primary"); a `provider → ENV_VAR` map replacing the ternaries; open `Record<string,…>` wire types; a
`strategy.supportsUsage` capability flag replacing the `=== 'opencode'` check. The qa-engine rewrite already
encodes the array-shaped facade + kernel session port; the kernel union (`agent-role.ts:12`) and the
registry/env-map remain.

## NON-GOAL — cross-CLI same-task collaboration

A dual mode where both CLIs run at once and **interact within the same task** (opencode ↔ codex
collaborating/handing off mid-task) is explicitly OUT of scope. No code exists for it (verified). If any
appears, document it as a non-goal — do not build it. "Dual mode" in this codebase means *roles assigned to
different providers*, never same-task collaboration.
