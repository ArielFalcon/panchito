import { z } from "zod";
import type { BoundaryProfile } from "@contexts/service-topology/domain/index.ts";

// ── ProposerVerdictSchema — scripts/-resident LLM-text parser ──────────────────
// Lives in src/server/onboarding/, NOT qa-engine/, NOT src/orchestrator/ (qa-engine-first directive: qa-engine
// must never import scripts/; this module carries the only LLM-text Zod parsing for the proposer
// flow). Structurally mirrors the domain BoundaryProfile union WITHOUT a runtime cross-tree
// import — parity is enforced by the type-level gates below, not by importing
// src/orchestrator/schemas.ts's BoundarySchema. Field names are copied VERBATIM from
// qa-engine's service-topology domain/index.ts (HttpBoundaryProfile/EventBoundaryProfile).
//
// Deliberately stricter than the domain: every string field below uses `.min(1)`, while the
// domain BoundaryProfile types them as plain `string` (allowing ""). This is intentional — an
// empty frontFiles glob, openApiPath, or eventPattern field is never a usable candidate (a ""
// glob matches nothing, a "" path resolves to no file), so rejecting it here, at the untrusted
// LLM-text parse boundary, fails a bad candidate fast instead of passing an unscoreable empty
// through to the deterministic scorer. Do NOT relax `.min(1)` to match the domain's looser
// typing — the stricter parse is deliberate input-hardening at this seam, not an oversight.
const HttpProfileSchema = z.object({
  transport: z.literal("http"),
  frontFiles: z.string().min(1),
  frontCallSite: z.object({ kind: z.string().min(1), receiver: z.string().optional() }),
  servicePrefixTemplate: z.string().min(1),
  serviceRepoTemplate: z.string().min(1),
  openApiPath: z.string().min(1),
});

const EventProfileSchema = z.object({
  transport: z.literal("event"),
  files: z.string().min(1),
  eventPattern: z.object({
    kind: z.string().min(1),
    listenerBaseType: z.string().min(1),
    listenerEventCall: z.string().min(1),
    subscriberBaseType: z.string().min(1),
    publishCall: z.string().min(1),
  }),
});

const CandidateSchema = z.discriminatedUnion("transport", [HttpProfileSchema, EventProfileSchema]);

// Recognizable sentinel a malformed candidate degrades to (per-entry .catch), so the adapter can
// filter it out while preserving valid siblings — the INVERSE intent of ReviewerVerdictSchema's
// fail-closed placeholder (src/orchestrator/schemas.ts): the proposer must fail OPEN, a bad
// candidate must never poison the round nor collapse the whole array.
export const UNPARSEABLE_SENTINEL = {
  transport: "http",
  frontFiles: "__UNPARSEABLE__",
  frontCallSite: { kind: "__UNPARSEABLE__" },
  servicePrefixTemplate: "__UNPARSEABLE__",
  serviceRepoTemplate: "__UNPARSEABLE__",
  openApiPath: "__UNPARSEABLE__",
} as const satisfies z.infer<typeof HttpProfileSchema>;

// The inner `.catch([])` guards the `candidates` FIELD (present but non-array/missing). The outer
// `.catch({candidates: []})` guards the case where the top-level input isn't even an object (e.g.
// a bare string, null, or garbage JSON) — `.parse()` must never throw for any input shape; every
// failure mode degrades to a well-formed empty verdict, per the adapter's fail-open contract.
export const ProposerVerdictSchema = z
  .object({
    candidates: z.array(CandidateSchema.catch(UNPARSEABLE_SENTINEL)).catch([]),
  })
  .catch({ candidates: [] });

export type ProposerVerdict = z.infer<typeof ProposerVerdictSchema>;
export type SchemaCandidate = z.infer<typeof CandidateSchema>;

// ── Structural parity gates (type-level, zero runtime cost) ────────────────────
// Three gates guard against the schema silently drifting from the domain BoundaryProfile union:
//
// 1-2. Per-variant KeyDiff gates (_HttpParity, _EventParity): catch KEY drift WITHIN a known
//      variant (e.g. a field renamed/added/removed on the http or event shape). These only run
//      Extract over transports BOTH sides already enumerate — a brand-new domain variant (e.g. a
//      future "rpc" transport) is INVISIBLE to them, because Extract<Union, {transport: "rpc"}>
//      on a union with no "rpc" member yields `never`, and diffing `never` against `never` is
//      silently clean. Empirically verified during task 2.1: a scratch phantom "rpc" variant left
//      these two gates green/silent.
// 3.   Whole-union discriminant-coverage gate (_AllTransportsCovered): closes exactly that gap.
//      It diffs the SET of transport literals on both sides, not per-variant keys. Adding a new
//      domain transport without a matching schema variant makes `Exclude<BoundaryProfile["transport"],
//      SchemaCandidate["transport"]>` resolve to that literal type (e.g. "rpc") instead of `never`,
//      so `AssertNever<...>` fails to compile, naming the missing transport in the error. Verified
//      during task 2.1: the same scratch probe made ONLY this gate go red (TS2344 naming "rpc"),
//      while the per-variant gates above stayed silent. Zod's runtime rejection of an unknown
//      transport value is real but orthogonal — a fail-safe at parse time, not static coverage.
type KeyDiff<A, B> = Exclude<keyof A, keyof B> | Exclude<keyof B, keyof A>;
type AssertNever<T extends never> = T;

type _HttpParity = AssertNever<
  KeyDiff<Extract<SchemaCandidate, { transport: "http" }>, Extract<BoundaryProfile, { transport: "http" }>>
>;
type _EventParity = AssertNever<
  KeyDiff<Extract<SchemaCandidate, { transport: "event" }>, Extract<BoundaryProfile, { transport: "event" }>>
>;
type _AllTransportsCovered = AssertNever<Exclude<BoundaryProfile["transport"], SchemaCandidate["transport"]>>;
