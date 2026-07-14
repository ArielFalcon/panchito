// qa-engine/src/contexts/generation/infrastructure/agent-transport-policy.ts
// migration-tier-4c Slice 2 (D-4c-1, the two-tier transport split). opencode-client.ts's TRUE
// residue after this migration is ONLY the raw @opencode-ai/sdk I/O closure (client construction,
// session.create/prompt/abort/delete) — genuinely raw SDK primitives, injected here as
// `RawAgentTransport`. Everything with policy/lifecycle content — circuit-breaker gating,
// fallback-model retry-on-transient-fault, per-session bookkeeping, turn/usage telemetry assembly,
// and sanitize-before-emit — lives HERE, consuming the injected primitive. This mirrors tier-4a's
// github-pr.adapter.ts / github-http.ts split exactly (GitHubHttpDeps.fetch/authHeaders stay
// shell-injected; the auto-merge-fallback POLICY is GitHubPrAdapter's own body).
//
// DELIBERATE SCOPE EXCLUSION — env/fs-read confinement: this module does NOT read `process.env` or
// `process.cwd()`-relative config anywhere (CLAUDE.md's env-read confinement invariant forbids a NEW
// `process.env` read inside qa-engine/src — see qa-engine/src/shared-infrastructure/process-sandbox/
// sandbox.ts's own header for the standing precedent: the composition-root shell resolves
// env/fs-derived config ONCE and injects it). Concretely, this means REVIEWER_TIMEOUT_MS/
// EXPLORER_TIMEOUT_MS/PLANNER_TIMEOUT_MS/agentTimeout()/TIMEOUT_BY_MODE/MAX_AGENT_TIMEOUT_MS/
// stallMs() (all env-derived) and getFallbackModel's own agents/opencode.json fs read STAY in
// src/integrations/opencode-client.ts (the composition root for this seam) — this is a deliberate,
// documented DEVIATION from a literal "relocate getFallbackModel" reading of the tasks artifact; the
// resolved VALUES (a default prompt timeout, and a getFallbackModel callback) are injected into
// `createAgentDeps` below as `AgentDepsCollaborators`, exactly like GitHubHttpDeps.authHeaders() is
// injected instead of GitHubPrAdapter reading GITHUB_TOKEN itself.
import { checkCircuit, recordCircuitFailure, recordCircuitSuccess } from "./resilience/circuit-breaker.ts";
import { createStallWatchdog, type StallWatchdog } from "./resilience/stall-watchdog.ts";
import { AgentUnavailableError, StalledAgentError, isInfraError } from "@kernel/domain-error.ts";
import { sanitizeText } from "./sanitize-text.ts";

// ─── Legacy-mirrored types (declared locally — qa-engine never imports src/) ────────────────────

// The legacy TOKEN-ACCOUNTING usage shape (src/qa/usage.ts). Structurally mirrored, NOT the kernel
// AgentRuntimePort's OWN differently-shaped UsageSnapshot ({inputTokens,outputTokens,provider}) —
// the two are unrelated types that happen to share a name in different modules.
export interface UsageSnapshot {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
}

// A single agent prompt/response turn captured at the transport funnel. `outputText` is sanitized
// BEFORE emitting (this module's own sanitizeText, the qa-engine twin of src/orchestrator/
// sanitizer.ts — see that file's own header). `runId` is null when the session was opened without a
// descriptor (maintenance sessions, etc.). `sectionSizes` carries the per-section byte map from the
// ContextAssembler when the prompt was assembled via one of the buildXxxAssembled() functions (Slice
// 5); null for prompts not produced by the assembler.
export interface AgentTurnEvent {
  runId: string | null;
  sessionId: string;
  role: string;
  objective: string | undefined;
  round: number;
  isRepair: boolean;
  promptText: string;
  promptBytes: number;
  outputText: string;
  tokensInput: number | null;
  tokensOutput: number | null;
  tokensReasoning: number | null;
  tokensCacheRead: number | null;
  tokensCacheWrite: number | null;
  cost: number | null;
  ts: string;
  sectionSizes: Record<string, number> | null;
}

// A session opened against the transport. prompt() sends the message under `agent`'s role and
// returns its final text. dispose() releases the session.
export interface AgentSession {
  id: string;
  prompt(
    text: string,
    opts?: { textOnly?: boolean; round?: number; isRepair?: boolean; sectionSizes?: Record<string, number> | null },
  ): Promise<string>;
  dispose(): Promise<void>;
  // selfTimed marks a session whose transport manages its own per-prompt timeout (e.g. Codex
  // exec-per-prompt, which never emits SSE activity). The stall watchdog SKIPS such sessions.
  selfTimed?: boolean;
}

// Session-scoped descriptor forwarded by every open() call-site that has a run context.
export interface AgentOpenDescriptor {
  runId?: string;
  role?: string;
  objective?: string;
}

export interface AgentDeps {
  open(
    agent: string,
    cwd: string,
    opts?: {
      signal?: AbortSignal;
      timeoutMs?: number;
      model?: string;
      onUsage?: (u: UsageSnapshot) => void;
      onTurn?: (t: AgentTurnEvent) => void;
      descriptor?: AgentOpenDescriptor;
    },
  ): Promise<AgentSession>;
  cleanupOrphans?(maxAgeMs: number): Promise<number>;
}

// ─── Raw transport primitive (2.1 — the shared interface Slice 3 mirrors its own OpenStreamFn on) ──
// Genuinely raw @opencode-ai/sdk primitives: client construction (implicit — the shell builds/caches
// the client and closes over it), session.create/prompt/abort/delete. Injected from
// src/integrations/opencode-client.ts; qa-engine calls these methods but never imports the SDK or
// constructs the client itself.

export interface RawAgentErrorPayload {
  name: string;
  data?: { message?: string; statusCode?: number; providerID?: string };
}

export interface RawPromptResult {
  // A provider/agent fault embedded in the assistant message (info.error) — present when the
  // provider/agent rejected the request for a non-code reason (auth, credits, rate-limit,
  // output-length, abort). Absent on a normal successful turn.
  agentError?: RawAgentErrorPayload;
  parts: Array<{ type: string; text?: string }>;
  tokens?: { input: number; output: number; reasoning: number; cacheRead: number; cacheWrite: number };
  cost?: number;
}

export interface RawAgentTransport {
  createSession(cwd: string): Promise<{ id: string }>;
  promptSession(args: {
    id: string;
    cwd: string;
    agent: string;
    text: string;
    model?: { providerID: string; modelID: string };
  }): Promise<RawPromptResult>;
  abortSession(id: string): Promise<void>;
  deleteSession(id: string): Promise<void>;
}

// ─── Generic pure helpers ────────────────────────────────────────────────────────────────────────

// Timeout wrapper for a promise: rejects if it elapses. Prevents a hung agent run from blocking the
// (sequential) queue, which would block every repo.
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

// The session.prompt SDK takes a structured model override ({providerID, modelID}), not the
// "provider/model" string opencode.json uses. Parse it; an unparseable ref (no provider segment)
// yields undefined so the override is skipped rather than sent malformed.
export function parseModelRef(ref: string): { providerID: string; modelID: string } | undefined {
  const i = ref.indexOf("/");
  if (i <= 0 || i >= ref.length - 1) return undefined;
  return { providerID: ref.slice(0, i), modelID: ref.slice(i + 1) };
}

// textOf reads the string `text` field of a response part (empty when absent).
function textOf(p: { type: string; text?: string }): string {
  return typeof p.text === "string" ? p.text : "";
}

// Strips reasoning wrappers a model may inline in a text part (<think>…</think> etc.) — used only on
// the textOnly fallback path, so a leaked chain-of-thought is removed.
function stripReasoningWrappers(s: string): string {
  return s.replace(/<(think|thought|reasoning)>[\s\S]*?<\/\1>/gi, "").trim();
}

// Concatenates the text of the text parts in the agent's response.
function extractText(parts: Array<{ type: string; text?: string }> | undefined, opts?: { textOnly?: boolean }): string {
  const all = parts ?? [];
  if (!opts?.textOnly) {
    return all.map(textOf).join("");
  }
  const textOnly = all.filter((p) => p.type === "text").map(textOf).join("");
  if (textOnly.trim() !== "") return textOnly;
  return stripReasoningWrappers(all.map(textOf).join(""));
}

// ROOT-CAUSE classifier: map an embedded agent/provider fault to a typed, actionable
// AgentUnavailableError (an InfraError) so the run surfaces as `infra-error` with a clear operator
// message — never a code verdict (`invalid`/`fail`) that blames the user's tests.
export function agentErrorToInfra(error: RawAgentErrorPayload): AgentUnavailableError {
  const d = error.data ?? {};
  const detail = d.message ? `: ${d.message}` : "";
  const tail = "INCONCLUSIVE (infrastructure), not a test failure";
  switch (error.name) {
    case "ProviderAuthError":
      return new AgentUnavailableError(
        `OpenCode provider '${d.providerID ?? "?"}' rejected the request (auth / out of credits)${detail}. ` +
          `${tail} — check OPENCODE_API_KEY and your OpenCode credit balance.`,
      );
    case "APIError": {
      const code = d.statusCode ? ` ${d.statusCode}` : "";
      const hint =
        d.statusCode === 429 ? " — rate-limited, retry later" :
        d.statusCode === 402 ? " — out of credits / billing" :
        d.statusCode === 401 || d.statusCode === 403 ? " — auth (check OPENCODE_API_KEY)" :
        "";
      return new AgentUnavailableError(`OpenCode API error${code}${detail}${hint}. ${tail}.`);
    }
    case "MessageOutputLengthError":
      return new AgentUnavailableError(`the model hit its output-length limit before finishing the turn. ${tail}.`);
    case "MessageAbortedError":
      return new AgentUnavailableError(`the agent turn was aborted${detail}. ${tail}.`);
    default: // UnknownError, or any future variant
      return new AgentUnavailableError(`OpenCode agent error (${error.name})${detail}. ${tail}.`);
  }
}

// ─── Session registry (bookkeeping — zero SDK, moves with the open()/dispose() policy it backs) ───

interface SessionEntry {
  id: string;
  agent: string;
  cwd: string;
  openedAt: number;
}

const sessionRegistry = new Map<string, SessionEntry>();

export function getOpenSessions(): SessionEntry[] {
  return [...sessionRegistry.values()];
}

export function getOpenSessionCount(): number {
  return sessionRegistry.size;
}

// ─── createAgentDeps: the transport POLICY, consuming the injected RawAgentTransport ──────────────

export interface AgentDepsCollaborators {
  /** Env-derived default per-prompt timeout (ms), used when the caller passes no opts.timeoutMs.
   * Resolved shell-side (env-read confinement — see this module's header) from
   * Math.max(generatorMax, REVIEWER_TIMEOUT_MS, EXPLORER_TIMEOUT_MS, PLANNER_TIMEOUT_MS) + 30_000,
   * matching the legacy defaultAgentDeps' own dispatcherTimeoutMs derivation exactly. */
  defaultPromptTimeoutMs: number;
  /** Reads agents/opencode.json's model_fallback map for `agent`. Shell-injected (fs-read
   * confinement — see this module's header): absent (the default) means no fallback, so a primary
   * failure propagates unchanged. */
  getFallbackModel(agent: string): string | undefined;
  /** Best-effort turn persistence (writes to the local run history). Invoked only when the caller
   * supplied a run context (opts.descriptor.runId) and no caller-supplied onTurn overrides it. This
   * callback itself is wrapped in a try/catch here — a storage failure must never break the agent
   * session (mirrors the legacy defaultOnTurn's own contract). */
  persistTurn?(t: AgentTurnEvent): void;
}

export function createAgentDeps(raw: RawAgentTransport, collab: AgentDepsCollaborators): AgentDeps {
  return {
    open: async (agent, cwd, opts) => {
      const created = await raw.createSession(cwd);
      const id = created.id;
      const entry: SessionEntry = { id, agent, cwd, openedAt: Date.now() };
      sessionRegistry.set(id, entry);

      // Wire external abort signal (cancel endpoint) to run interruption + session deletion.
      // session.delete alone does NOT stop a running turn server-side; abort interrupts the
      // in-flight run so a cancel actually frees the model/session compute, then we dispose.
      const onAbort = () => {
        raw.abortSession(id).catch(() => {});
        raw.deleteSession(id).catch(() => {});
      };
      opts?.signal?.addEventListener("abort", onAbort, { once: true });

      const promptTimeoutMs = opts?.timeoutMs ?? collab.defaultPromptTimeoutMs;

      // Interrupt the in-flight run on the OpenCode server. withTimeout only rejects the
      // orchestrator's await; without this, a wedged agent turn keeps running (holding a session,
      // burning model tokens) until its natural end or the orphan sweep.
      const abortRun = () => raw.abortSession(id).catch(() => {});

      // Default turn sink: persist when a runId is available and no caller-supplied onTurn overrides
      // it. Best-effort: a storage failure must not break the agent session.
      const defaultOnTurn = opts?.descriptor?.runId
        ? (t: AgentTurnEvent) => {
            try {
              collab.persistTurn?.(t);
            } catch (err) {
              console.warn(`[qa] agent_turns persist failed: ${err instanceof Error ? err.message : String(err)}`);
            }
          }
        : undefined;
      // The effective onTurn: caller-supplied wins; default sink fires when runId is present.
      const effectiveOnTurn = opts?.onTurn ?? defaultOnTurn;

      // Track the per-call round counter so `onTurn` can report which round produced each output.
      // SEMANTICS: `round` is SESSION-LOCAL — a per-session prompt index, NOT a per-run regeneration
      // index (see the legacy header this module carries forward from opencode-client.ts).
      let _round = 0;

      return {
        id,
        prompt: (text, promptOpts) =>
          withTimeout(
            (() => {
              checkCircuit();
              const thisRound = _round++;
              const runPrompt = (modelOverride?: string) => {
                const overrideModel = modelOverride ? parseModelRef(modelOverride) : undefined;
                return raw
                  .promptSession({ id, cwd, agent, text, ...(overrideModel ? { model: overrideModel } : {}) })
                  .then((res) => {
                    // ROOT-CAUSE FIX: a provider/agent fault (out of credits, auth, rate-limit,
                    // output-length) is embedded in the assistant message, NOT in a transport-level
                    // error — without this it degrades into an EMPTY response that downstream
                    // misreads as a code verdict. Detect it at the source and throw it typed.
                    if (res.agentError) {
                      throw agentErrorToInfra(res.agentError);
                    }
                    recordCircuitSuccess();
                    // Emit a usage snapshot for the accumulator (observation-only). The ONLY sink is
                    // opts.onUsage — callers that want capture pre-wrap this AgentDeps to inject it
                    // into every open().
                    if (res.tokens) {
                      const snapshot: UsageSnapshot = {
                        input: res.tokens.input ?? 0,
                        output: res.tokens.output ?? 0,
                        reasoning: res.tokens.reasoning ?? 0,
                        cacheRead: res.tokens.cacheRead ?? 0,
                        cacheWrite: res.tokens.cacheWrite ?? 0,
                        cost: res.cost ?? 0,
                      };
                      opts?.onUsage?.(snapshot);
                    }
                    const outputRaw = extractText(res.parts, promptOpts);
                    // Emit a per-turn event alongside onUsage. Sanitize output_text before emitting
                    // so any DEV-environment data in the agent reply is redacted at the earliest
                    // point (before storage or logging by callers).
                    if (effectiveOnTurn) {
                      const sanitizedOutput = sanitizeText(outputRaw).text;
                      const turnEvent: AgentTurnEvent = {
                        runId: opts?.descriptor?.runId ?? null,
                        sessionId: id,
                        role: opts?.descriptor?.role ?? agent,
                        objective: opts?.descriptor?.objective,
                        round: promptOpts?.round ?? thisRound,
                        isRepair: promptOpts?.isRepair ?? false,
                        promptText: text,
                        promptBytes: Buffer.byteLength(text, "utf8"),
                        outputText: sanitizedOutput,
                        tokensInput: res.tokens?.input ?? null,
                        tokensOutput: res.tokens?.output ?? null,
                        tokensReasoning: res.tokens?.reasoning ?? null,
                        tokensCacheRead: res.tokens?.cacheRead ?? null,
                        tokensCacheWrite: res.tokens?.cacheWrite ?? null,
                        cost: res.cost ?? null,
                        ts: new Date().toISOString(),
                        sectionSizes: promptOpts?.sectionSizes ?? null,
                      };
                      effectiveOnTurn(turnEvent);
                    }
                    return outputRaw;
                  })
                  // Record the circuit failure in EXACTLY one place per attempt. The error branches
                  // above throw without counting; this single trailing catch counts the attempt
                  // once, then re-throws to the fallback retry.
                  .catch((err) => {
                    recordCircuitFailure();
                    throw err;
                  });
              };
              return runPrompt(opts?.model).catch((err) => {
                // Only retry a TRANSIENT primary-model fault on the fallback model. Skip the retry
                // (re-throw) on operator-abort (a cancel must not be defeated by a retry) and on
                // infra errors like AgentUnavailableError (out-of-credits/auth hits the SAME
                // OpenCode key — re-spending on the fallback is pointless and surfaces late).
                if (opts?.signal?.aborted || isInfraError(err)) throw err;
                const fallback = collab.getFallbackModel(agent);
                if (fallback) {
                  console.warn(`[qa] primary model failed for ${agent}, retrying with fallback ${fallback}: ${err instanceof Error ? err.message : String(err)}`);
                  return runPrompt(fallback);
                }
                throw err;
              });
            })(),
            promptTimeoutMs,
            "OpenCode prompt",
          ).catch((err: unknown) => {
            // On timeout (or any failure that left work in flight), interrupt the server run so it
            // stops consuming compute after the orchestrator has already given up.
            abortRun();
            throw err;
          }),
        dispose: async () => {
          try {
            await raw.deleteSession(id);
          } catch (err) {
            console.warn(`[qa] session ${id} dispose failed: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            opts?.signal?.removeEventListener("abort", onAbort);
            sessionRegistry.delete(id);
          }
        },
      };
    },
    cleanupOrphans: async (maxAgeMs: number) => {
      const now = Date.now();
      let cleaned = 0;
      for (const [id, entry] of sessionRegistry) {
        if (now - entry.openedAt > maxAgeMs) {
          try {
            await raw.deleteSession(id);
          } catch (err) {
            console.warn(`[qa] orphan cleanup failed for session ${id}: ${err instanceof Error ? err.message : String(err)}`);
          }
          sessionRegistry.delete(id);
          cleaned++;
        }
      }
      return cleaned;
    },
  };
}

// ─── Session-notify registry (watchdog liveness signal — pulled forward from Slice 3's own scope) ─
// Couples the stall watchdog (below) to the SSE event loop: registered on open(), read on every SSE
// event carrying a sessionID, cleared on stall/dispose. Pulled into THIS commit (rather than Slice
// 3's own EventStreamManager/activityRouter migration) because withStallWatchdog calls these
// directly and both are zero-SDK — see this batch's apply-progress for the documented boundary
// adjustment. Slice 3's startScopedEventStream (still shell-resident until that slice lands) imports
// notifySessionActivity from THIS module.

const sessionWatchdogNotifiers = new Map<string, () => void>();

/** Called by withStallWatchdog when a session opens. Not part of the public API surface. */
export function registerSessionWatchdogNotify(sessionId: string, notify: () => void): void {
  sessionWatchdogNotifiers.set(sessionId, notify);
}

/** Called by withStallWatchdog when a session is disposed or the watchdog stops. */
export function unregisterSessionWatchdogNotify(sessionId: string): void {
  sessionWatchdogNotifiers.delete(sessionId);
}

/** Notify the watchdog for a session (called from the SSE event loop on each activity). */
export function notifySessionActivity(sessionId: string): void {
  sessionWatchdogNotifiers.get(sessionId)?.();
}

// ─── AgentDeps decorators (pure — operate only on the AgentDeps/AgentSession shape above) ─────────

// Factory type for injecting a custom watchdog in tests. Receives onStall; must return a
// StallWatchdog. The real path uses createStallWatchdog with the real clock.
export type WatchdogFactory = (onStall: () => void) => StallWatchdog;

// Wrap an AgentDeps so EVERY session gets an inactivity watchdog. If notify() is not called within
// stallMs, the in-flight prompt() is rejected with StalledAgentError and the session is disposed.
// notify() must be called from the SSE event stream on each activity event received for this
// session (via notifySessionActivity above).
export function withStallWatchdog(
  baseDeps: AgentDeps,
  opts: {
    stallMs: number;
    watchdogFactory?: WatchdogFactory;
  },
): AgentDeps {
  const threshold = opts.stallMs;
  const factory: WatchdogFactory = opts.watchdogFactory ?? ((onStall) => createStallWatchdog({ stallMs: threshold, onStall }));

  return {
    ...baseDeps,
    open: async (agent, cwd, openOpts) => {
      const inner = await baseDeps.open(agent, cwd, openOpts);

      // Self-timed sessions (Codex exec-per-prompt) manage their own timeout in the transport and
      // never emit SSE activity, so the stall watchdog would false-positive-kill every prompt
      // slower than the threshold. Skip wrapping; the transport's own timeout is the real deadline.
      if (inner.selfTimed) return inner;

      // Track the in-flight prompt's reject handle so the stall callback can surface
      // StalledAgentError from inside the watchdog (which runs on the timer thread).
      let rejectInFlight: ((err: unknown) => void) | undefined;

      const watchdog = factory(() => {
        const err = new StalledAgentError(
          `Agent session stalled: no activity for ${threshold}ms. Aborting session to free resources.`,
        );
        rejectInFlight?.(err);
        // Clean up the session→notify registry on the stall path too. wrapped.dispose() also
        // unregisters, but a caller that swallows the rejection without reaching its finally would
        // otherwise leak the entry for the process lifetime. Idempotent.
        unregisterSessionWatchdogNotify(inner.id);
        // Best-effort dispose — do not await (we are inside a timer callback).
        inner.dispose().catch(() => {});
      });

      // Register this session's watchdog notify with the SSE event loop so that every incoming
      // activity event for this session resets the stall timer.
      registerSessionWatchdogNotify(inner.id, () => watchdog.notify());

      const wrapped: typeof inner = {
        id: inner.id,
        prompt: (text, promptOpts) =>
          new Promise<string>((resolve, reject) => {
            rejectInFlight = reject;
            // Arm the watchdog at prompt-start; subsequent SSE events reset it.
            watchdog.notify();
            inner.prompt(text, promptOpts).then(
              (v) => {
                rejectInFlight = undefined;
                watchdog.stop();
                resolve(v);
              },
              (e) => {
                rejectInFlight = undefined;
                watchdog.stop();
                reject(e);
              },
            );
          }),
        dispose: async () => {
          watchdog.stop();
          unregisterSessionWatchdogNotify(inner.id);
          await inner.dispose();
        },
      };

      return wrapped;
    },
  };
}

// Wrap an AgentDeps so EVERY open() injects the per-run usage sink, including internal callers
// (explorer, reviewer, parallel workers) that never set opts.onUsage themselves. A caller-supplied
// opts.onUsage still wins. No sink ⇒ baseDeps is returned untouched.
export function withUsageSink(
  baseDeps: AgentDeps,
  onUsage?: (u: UsageSnapshot) => void,
  onTurn?: (t: AgentTurnEvent) => void, // TEST-ONLY: production passes only onUsage.
): AgentDeps {
  if (!onUsage && !onTurn) return baseDeps;
  return {
    ...baseDeps,
    open: (agent, cwd, opts) =>
      baseDeps.open(agent, cwd, {
        ...opts,
        ...(onUsage ? { onUsage: opts?.onUsage ?? onUsage } : {}),
        ...(onTurn ? { onTurn: opts?.onTurn ?? onTurn } : {}),
      }),
  };
}

// Wrap an AgentDeps so a session opened with a descriptor.runId registers/unregisters with the SSE
// run→session mapping (activityRouter/EventStreamManager, still shell-resident until Slice 3 moves
// them). `collaborators` is REQUIRED here (unlike the legacy shell version's optional param
// defaulting to the real registerRunSession/unregisterRunSession): qa-engine cannot reach those shell
// functions on its own, so the composition root (src/server/rewritten-engine-factory.ts) must inject
// them explicitly. Absent runId (e.g. a unit test or an operator script with no run context) → no
// registration is attempted, matching every other "absent -> unchanged" optional-field contract.
export function withSessionRegistration(
  baseDeps: AgentDeps,
  collaborators: {
    register: (sessionId: string, runId: string, cwd: string) => void;
    unregister: (sessionId: string) => void;
  },
): AgentDeps {
  const { register, unregister } = collaborators;

  return {
    ...baseDeps,
    open: async (agent, cwd, opts) => {
      const inner = await baseDeps.open(agent, cwd, opts);
      const runId = opts?.descriptor?.runId;
      if (runId) register(inner.id, runId, cwd);

      return {
        ...inner,
        dispose: async () => {
          if (runId) unregister(inner.id);
          await inner.dispose();
        },
      };
    },
  };
}
