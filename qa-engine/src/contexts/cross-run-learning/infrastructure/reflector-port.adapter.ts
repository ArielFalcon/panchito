// qa-engine/src/contexts/cross-run-learning/infrastructure/reflector-port.adapter.ts
// ReflectorPort adapter (reflector-rewire design, Phase 2). Runs a ONE-SHOT, read-only "reflector"
// session over AgentRuntimePort, parses the closing StructuredReflection JSON, and — on a valid
// parse only — writes a candidate/low LearningRule via LearningRepositoryPort.save (ADR-3: this
// call site NEVER threads an initialStatus-shaped field, which is the whole anti-Goodhart
// guarantee) and back-fills the persisted RunOutcome.reflection via the injected `backfill` dep
// (ADR-2: host-side updateRunOutcomeReflection, not a widened RunHistoryPort).
//
// Fault isolation (ADR-1's stricter gate lives at the CALL SITE, not here — this adapter's own
// contract is: whatever reaches reflect(), a crash, a rejected prompt, a hung session past its own
// timeout, or a malformed/incomplete JSON response is caught INLINE and never re-thrown, mirroring
// LearningPortAdapter.fold()'s documented off-path convention on the sibling LearningRepositoryPort.
// The run's verdict and already-made ledger writes (runHistory.save, learning.fold) are made BEFORE
// this call and are structurally unaffected by anything that happens inside reflect().
//
// isStructuredReflection / parseStructuredReflection / buildReflectionPrompt are ported VERBATIM
// from src/qa/learning/reflector.ts (task 2.3) — qa-engine/ never imports from src/, so the shared
// balanced-brace JSON extractor (lastJsonMatching/extractJsonObjects, originally
// src/integrations/verdict-parse.ts) is ported alongside them rather than imported across the
// hexagonal boundary.
import type { LearningRepositoryPort, LearningRule, ReflectionInput, StructuredReflection } from "../application/ports/index.ts";
import type { AgentRuntimePort } from "@kernel/ports/agent-runtime.port.ts";

// ── Ported verbatim from src/integrations/verdict-parse.ts ──────────────────────────────────────
// Extracts every BALANCED top-level JSON object from free-form agent text, respecting string
// literals and escapes (so a `}` inside a string, or nested objects, never mis-split the span).
function extractJsonObjects(text: string): unknown[] {
  const objs: unknown[] = [];
  let depth = 0;
  let start = -1;
  let inStr = false;
  let esc = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') inStr = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          try {
            objs.push(JSON.parse(text.slice(start, i + 1)));
          } catch {
            /* not valid JSON; ignore this span */
          }
          start = -1;
        }
      }
    }
  }
  return objs;
}

// Returns the LAST extracted JSON object for which `pred` holds, or undefined.
function lastJsonMatching<T = Record<string, unknown>>(text: string, pred: (o: Record<string, unknown>) => boolean): T | undefined {
  const objs = extractJsonObjects(text);
  for (let i = objs.length - 1; i >= 0; i--) {
    const o = objs[i];
    if (o && typeof o === "object" && pred(o as Record<string, unknown>)) return o as T;
  }
  return undefined;
}

// ── Ported verbatim from src/qa/learning/reflector.ts ────────────────────────────────────────────
// Shape guard for a complete StructuredReflection (every field the distiller needs).
function isStructuredReflection(o: Record<string, unknown>): boolean {
  const pr = o.preventiveRule as Record<string, unknown> | undefined;
  return (
    typeof o.goal === "string" &&
    typeof o.decision === "string" &&
    typeof o.assumption === "string" &&
    typeof o.errorClass === "string" &&
    typeof o.gateSignal === "string" &&
    typeof o.evidence === "string" &&
    typeof o.rootCause === "string" &&
    !!pr &&
    typeof pr === "object" &&
    typeof pr.trigger === "string" &&
    typeof pr.action === "string"
  );
}

// Parse the qa-reflector's StructuredReflection out of its raw output. The role is told to emit
// "ONLY the JSON object, no markdown", but models do not always comply — they may wrap the object
// in a ```json fence or surround it with prose, which makes a raw JSON.parse throw. Routing through
// the shared balanced-brace extractor makes reflection parsing robust to fences/prose. Returns null
// when no complete reflection object is present (never throws).
function parseStructuredReflection(raw: string): StructuredReflection | null {
  return lastJsonMatching<StructuredReflection>(raw, isStructuredReflection) ?? null;
}

function buildReflectionPrompt(input: ReflectionInput): string {
  const signals = [
    `static gate: ${input.gateSignals.static ? "PASS" : "FAIL"}`,
    `coverage ratio: ${input.gateSignals.coverageRatio !== null ? (input.gateSignals.coverageRatio * 100).toFixed(0) + "%" : "unmeasured"}`,
    `value score: ${input.gateSignals.valueScore !== null ? (input.gateSignals.valueScore * 100).toFixed(0) + "%" : "unmeasured"}`,
    `flaky: ${input.gateSignals.flaky}`,
    `retries: ${input.gateSignals.retries}`,
  ];

  if (input.gateSignals.reviewerCorrections.length > 0) {
    signals.push(`reviewer corrections:\n${input.gateSignals.reviewerCorrections.map((c) => `  - ${c}`).join("\n")}`);
  }

  return [
    `Reflect on this QA run to produce a preventive rule.`,
    ``,
    `## Run context`,
    `- SHA: ${input.sha}`,
    `- Mode: ${input.mode}`,
    `- Verdict: ${input.verdict}`,
    `- Error class: ${input.errorClass}`,
    ``,
    `## Gate signals (the objective truth)`,
    ...signals,
    ``,
    `## Task`,
    `1. Identify the ROOT CAUSE of why this run failed or produced low-quality tests.`,
    `2. The errorClass "${input.errorClass}" is already determined by the gates — do NOT change it.`,
    `3. Write a preventiveRule that would have caught this BEFORE the run:`,
    `   - trigger: a CONDITION phrased as an "Applies when …" sentence describing the change that should fire this rule (e.g. "Applies when the diff adds a form with onSubmit but no test for invalid input"). Start with "Applies when ".`,
    `   - action: a CONCRETE instruction the agent should follow (e.g. "generate a test that submits the form with invalid data and asserts the error message")`,
    `4. The rule must be RECUPERABLE — specific enough to match future changes, general enough to apply across apps.`,
    `5. Anchor every field to the gate signals above — evidence must reference actual numbers/output.`,
    ``,
    `## Output — ONLY this JSON:`,
    `{"goal":"why the run happened","decision":"what the agent chose","assumption":"what the agent assumed that was wrong","errorClass":"${input.errorClass}","gateSignal":"the specific signal that flagged this","evidence":"the actual assert/lines/output","rootCause":"why the gate caught this","preventiveRule":{"trigger":"Applies when <condition>","action":"instruction"}}`,
  ].join("\n");
}

// Default reflect timeout: 60s, overridable via env at construction (rewritten-engine-factory.ts
// reads REFLECTOR_TIMEOUT_MS and passes it as `timeoutMs`; this constant is the adapter's own
// fallback default when no override is supplied). Independent of any other port's timeout.
export const REFLECT_TIMEOUT_MS = 60_000;

export interface ReflectorPortDeps {
  runtime: AgentRuntimePort;
  repo: LearningRepositoryPort;
  // ADR-2: host-side back-fill (updateRunOutcomeReflection, src/server/history.ts:750), injected so
  // this context never depends on the SQLite-backed RunHistoryPort implementer directly.
  backfill: (runId: string, refl: StructuredReflection) => void;
  cwd: string;
  app: string;
  timeoutMs?: number;
  // Injectable so a test can assert the swallow without polluting stderr; defaults to console.error,
  // mirroring LearningPortAdapter's onFoldError convention on the sibling port.
  onReflectError?: (e: unknown) => void;
}

export class ReflectorPortAdapter {
  constructor(private readonly deps: ReflectorPortDeps) {}

  async reflect(input: ReflectionInput): Promise<void> {
    // `app` is carried on ReflectorPortDeps for ctor parity with the design's documented DI seam
    // (a future per-app-scoped save projection may need it) but LearningRepositoryPort.save(rule)
    // takes no `app` argument today — the port type has no such field — so it is not read here.
    const { runtime, repo, backfill, cwd, timeoutMs, onReflectError } = this.deps;
    const reportError = onReflectError ?? ((e: unknown) => console.error("[ReflectorPortAdapter] reflect failed (off-path, swallowed):", e));

    let session: Awaited<ReturnType<AgentRuntimePort["openSession"]>> | undefined;
    try {
      session = await runtime.openSession("reflector", cwd, {
        timeoutMs: timeoutMs ?? REFLECT_TIMEOUT_MS,
        descriptor: { runId: input.runId, role: "reflector" },
      });

      const { output } = await session.prompt(buildReflectionPrompt(input), { textOnly: true });
      const reflection = parseStructuredReflection(output);
      if (!reflection) return; // malformed/incomplete JSON: logged no-op, never a throw

      // ADR-3: status/confidence are hardcoded here — candidate/low — NEVER threaded from an
      // "initialStatus"-shaped field. This is the anti-Goodhart guarantee: reflection can only ever
      // author a candidate, never an active rule.
      const rule: LearningRule = {
        id: `rule-${input.runId.slice(-8)}-${Math.random().toString(16).slice(2, 8)}`,
        trigger: reflection.preventiveRule.trigger,
        action: reflection.preventiveRule.action,
        errorClass: reflection.errorClass,
        archetype: null,
        status: "candidate",
        confidence: "low",
        usageCount: 0,
        outcomeCount: 0,
        successRate: null,
        lastVerified: null,
        source: input.runId,
        at: new Date().toISOString(),
      };

      await repo.save(rule);
      backfill(input.runId, reflection);
    } catch (e) {
      // Off-path by contract: never gates publish, never affects the already-made verdict/ledger
      // writes. Logged, not re-thrown — mirrors LearningPortAdapter.fold()'s documented convention
      // on the sibling LearningRepositoryPort.
      reportError(e);
    } finally {
      // Guard with `?.` since openSession() itself can throw before `session` is ever assigned.
      await session?.dispose();
    }
  }
}
