// src/server/onboarding/llm-profile-proposer.adapter.ts
// LLM-backed ProfileProposerPort adapter for the onboarding CLI + the server-side onboarding job.
// Lives under src/server/onboarding/ (re-homed from scripts/adapters/ in Slice 5a — see design
// delta §A) — this is the ONLY module that calls the agent runtime (src/) to hypothesize an app's
// cross-service boundary convention. The deterministic profile-scorer (qa-engine) is the objective
// oracle that grades each candidate this adapter proposes; the adapter itself never self-grades.
//
// Read-only end to end: the "qa-proposer" role has canWrite:false (agent-runtime/types.ts) and
// this adapter never calls any write-capable API. It only returns data to the caller (the CLI or
// the server job perform the only write, to config/apps/<app>.yaml — never a watched repo).
//
// Facade bypass (deliberate): SingleAgentFacade/DualAgentFacade always clobber opts.model with
// the role's assigned model (facades.ts `{...opts, model}` / `{...opts, model: assignment.model}`),
// and assignmentForRole has no branch for "proposer" (falls through to primary) — see design §A.4.
// So this adapter calls defaultAgentDeps() DIRECTLY, pinning its own model at the open() call-site,
// never routing through either facade.
//
// Import-specifier rule (TS5097, design delta §A): under the root tsconfig (no
// allowImportingTsExtensions), a VALUE import with a literal .ts suffix fails TS5097. VALUE
// imports below are therefore extensionless; type-only imports use the @contexts alias (already
// resolvable from src/, matching this file's src/server neighbors).
import { dirname, sep } from "node:path";
import type { AgentDeps } from "../../integrations/opencode-client";
import { defaultAgentDeps } from "../../integrations/opencode-client";
import { RedactionPortAdapter } from "../../orchestrator/sanitizer";
import { logJson } from "../../integrations/logger";
import type { BoundaryProfile, RepoRef } from "@contexts/service-topology/domain/index.ts";
import type {
  ProfileProposerPort,
  ProposerFeedback,
} from "@contexts/service-topology/application/ports/index.ts";
import { ProposerVerdictSchema, UNPARSEABLE_SENTINEL, type SchemaCandidate } from "./proposer-verdict.schema";

/** Model pinned for every proposer session, bypassing the facade/roster model entirely (see
 *  module doc above). Chip: keep in sync with agents/opencode.json's qa-proposer.model entry —
 *  that roster field is NOT authoritative for this CLI path, only for any future facade-routed
 *  caller + the modelsFromOpenCodeConfig catalog. */
export const PROPOSER_MODEL = "opencode-go/deepseek-v4-pro";

/** Default per-session timeout when the caller doesn't override it via ctx.timeoutMs. */
const DEFAULT_PROPOSER_TIMEOUT_MS = 5 * 60 * 1000;

// sdd/migration-wiring-phase-2 Slice 7b-2: the canonical redaction adapter (env+pattern) for this
// file's fail-open warn logging, replacing src/util/redact.ts's redactError.
const redactionPort = new RedactionPortAdapter();

/** A candidate degrades to this sentinel on a per-entry schema parse failure (see
 *  ProposerVerdictSchema); filter it before returning so a malformed sibling never poisons an
 *  otherwise-valid round. */
function isUnparseableSentinel(candidate: SchemaCandidate): boolean {
  return candidate.transport === "http" && candidate.frontFiles === UNPARSEABLE_SENTINEL.frontFiles;
}

/** Extracts a JSON payload from an LLM's free-form text reply: the last fenced ```json block if
 *  present, otherwise the trailing `{...}` object. Returns null when neither shape is found —
 *  the caller degrades that to a fail-open empty verdict. */
function extractJson(text: string): unknown {
  const fencedMatches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  const lastFenced = fencedMatches.at(-1)?.[1];
  const candidate = lastFenced ?? text.slice(text.lastIndexOf("{"));
  if (!candidate) return null;
  try {
    return JSON.parse(candidate);
  } catch {
    return null;
  }
}

/** Assembles the doc block spelling out both transport shapes with exact field names, so the
 *  proposer's output stays schema-accurate even without live access to this repo's source. */
function transportShapesDoc(): string {
  return [
    "Boundary profile shapes you may propose (emit ONLY fields listed here, using these exact names):",
    "",
    "http transport:",
    '  { "transport": "http", "frontFiles": string, "frontCallSite": { "kind": string, "receiver"?: string },',
    '    "servicePrefixTemplate": string, "serviceRepoTemplate": string, "openApiPath": string }',
    "",
    "event transport:",
    '  { "transport": "event", "files": string, "eventPattern": { "kind": string, "listenerBaseType": string,',
    '    "listenerEventCall": string, "subscriberBaseType": string, "publishCall": string } }',
    "",
    "Field dialect — a candidate violating these scores ZERO no matter how plausible it looks:",
    '- "frontFiles"/"files": FILENAME-SUFFIX globs only — "**/*.<suffix>" or "*.<suffix>" (e.g. "**/*.api.ts").',
    "  Path-anchored globs (any path segment before the *) are unsupported and match NO files;",
    "  encode the convention in the filename suffix, never in directories.",
    '- "frontCallSite.kind": must be "receiver-verb-call" (calls shaped this.<receiver>.<verb>(...);',
    '  put the injected client field name in "receiver").',
    '- "eventPattern.kind": must be "class-based-domain-events".',
    '- "openApiPath": a LITERAL repo-relative file path inside each service repo (never a glob),',
    '  e.g. "src/main/resources/openapi/api-definition.yaml".',
    '- Templates use {service}: e.g. "servicePrefixTemplate": "svc-{service}-api" -> "serviceRepoTemplate": "ms-{service}".',
  ].join("\n");
}

/** Compact "round N proposed X scored Y; refine" summary for the previous onboarding round(s),
 *  so the proposer can steer away from a low-scoring guess instead of repeating it blind. */
function feedbackSummary(feedback: ProposerFeedback): string {
  const lines = feedback.priorCandidates.map(({ profile, score }, index) => {
    const shape = profile.transport === "http" ? `servicePrefixTemplate="${profile.servicePrefixTemplate}"` : `eventPattern.kind="${profile.eventPattern.kind}"`;
    return `  round ${index + 1}: transport=${profile.transport} ${shape} -> resolvedScore=${score.resolvedScore} (links=${score.links}, resolutionRatio=${score.resolutionRatio})`;
  });
  return ["Prior round(s) scored too low by the deterministic scorer — refine your next guess:", ...lines].join("\n");
}

function assemblePrompt(system: RepoRef[], front: RepoRef, app: string, feedback?: ProposerFeedback): string {
  const sections = [
    `App: ${app}`,
    `Frontend repo: ${front.repo} (mirror: ${front.mirrorDir})`,
    "Backend service repos:",
    ...system.map((s) => `  - ${s.repo} (mirror: ${s.mirrorDir})`),
    "",
    transportShapesDoc(),
  ];
  if (feedback && feedback.priorCandidates.length > 0) {
    sections.push("", feedbackSummary(feedback));
  }
  return sections.join("\n");
}

/** True when `target` is `ancestor` itself, or is nested inside it (segment-aware — appends `sep`
 *  before the `startsWith` check so "/a/foo" is never mistaken for an ancestor of "/a/foobar"). */
function isAncestorOrSelf(ancestor: string, target: string): boolean {
  if (ancestor === target) return true;
  const prefix = ancestor.endsWith(sep) ? ancestor : ancestor + sep;
  return target.startsWith(prefix);
}

/** Walks `a` up its directory tree (via `dirname`) until it is an ancestor of (or equal to) `b`.
 *  Segment-aware by construction — never a naive string-prefix match. */
function pairwiseCommonAncestor(a: string, b: string): string {
  let candidate = a;
  while (!isAncestorOrSelf(candidate, b)) {
    const parent = dirname(candidate);
    if (parent === candidate) break; // reached filesystem root; nothing higher to climb to
    candidate = parent;
  }
  return candidate;
}

/** Computes the lowest common ancestor (LCA) directory of the front mirror and every service
 *  mirror, so the proposer's opencode session is rooted somewhere that contains ALL repos its
 *  prompt asks it to read.
 *
 *  Root cause (live-verified): the proposer's task spans the front repo AND every service repo —
 *  sibling directories under the same mirror root. Opening the session at `front.mirrorDir` alone
 *  means a service mirror is OUTSIDE the session root; opencode's external-read approval gate (in
 *  serve mode) then waits forever for an approval that never comes, the tool call sits
 *  `state=running` indefinitely, and the adapter's 5-min timeout eventually aborts it — a slow,
 *  silent fail-open to `[]` (three empty rounds -> `noProfile`), not a fast, diagnosable error.
 *  Rooting the session at the LCA of every mirror keeps all repos inside the workspace so
 *  cross-service reads never trip that gate.
 *
 *  Single-repo apps (`system.length === 0`) keep `front.mirrorDir` verbatim — there is no sibling
 *  repo to protect against, so behavior is unchanged.
 *
 *  POSIX-only: LCA is computed segment-by-segment via `node:path`'s `sep`/`dirname`, NOT a naive
 *  string prefix (which would wrongly treat "/a/foo" as an ancestor of "/a/foobar"). This repo's
 *  containers are POSIX-only; Windows path handling is out of scope. */
export function commonSessionRoot(front: RepoRef, system: RepoRef[]): string {
  if (system.length === 0) return front.mirrorDir;
  return system.reduce((lca, s) => pairwiseCommonAncestor(lca, s.mirrorDir), front.mirrorDir);
}

/** LLM-backed ProfileProposerPort implementation. Ctor DI keeps the agent-runtime dependency
 *  swappable (a fake depsFactory drives the unit tests) and the model pin overridable for tests
 *  without touching the production default. */
export class LlmProfileProposerAdapter implements ProfileProposerPort {
  constructor(
    private readonly depsFactory: () => Promise<AgentDeps> = defaultAgentDeps,
    private readonly model: string = PROPOSER_MODEL,
    // `signal` (Slice 5a, design delta §C): threaded straight through to deps.open's opts.signal so
    // the server-side onboarding job's round-budget AbortController can cancel an in-flight
    // proposer session on timeout, not merely resolve its own Promise.race (the session-leak fix).
    // AgentDeps.open's opts already accepts signal?: AbortSignal — no opencode-client.ts edit needed.
    private readonly ctx: { app: string; timeoutMs?: number; signal?: AbortSignal },
  ) {}

  async propose(system: RepoRef[], front: RepoRef, feedback?: ProposerFeedback): Promise<BoundaryProfile[]> {
    try {
      const deps = await this.depsFactory();
      const session = await deps.open("qa-proposer", commonSessionRoot(front, system), {
        model: this.model,
        timeoutMs: this.ctx.timeoutMs ?? DEFAULT_PROPOSER_TIMEOUT_MS,
        signal: this.ctx.signal,
      });
      try {
        const text = await session.prompt(assemblePrompt(system, front, this.ctx.app, feedback));
        const parsed = ProposerVerdictSchema.parse(extractJson(text));
        return parsed.candidates.filter((c) => !isUnparseableSentinel(c));
      } finally {
        await session.dispose().catch(() => {});
      }
    } catch (err) {
      // Fail-open by contract (ProfileProposerPort doc): any throw — open() failure, prompt()
      // rejection/timeout, unparseable text — degrades to an empty round, never propagates.
      // Instrumented (do NOT silently swallow): emit exactly one structured warn with the redacted
      // real error + the context needed to confirm-or-refute the AGENT_SINGLE_PROVIDER correlation
      // and identify the actual throw. redactionPort.redactError reads only err.message and scrubs
      // it via the canonical adapter (env+pattern) — it never serializes structured SDK bodies or
      // the stack (no new leak surface).
      logJson("warn", "onboarding proposer round failed (fail-open, returning no candidates)", {
        app: this.ctx.app,
        model: this.model,
        singleProvider: process.env.AGENT_SINGLE_PROVIDER,
        error: redactionPort.redactError(err),
      });
      return [];
    }
  }
}
