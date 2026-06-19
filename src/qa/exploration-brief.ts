// The distilled output of the read-heavy exploration step (tema #4). An isolated, read-only
// explorer maps a change's blast radius ONCE and returns this compact brief; the test-writer
// (generator/worker) consumes the distillate instead of re-exploring, keeping its context window
// clean for the actual job of writing the spec. This module is the PURE CORE (Fase 0): the schema,
// its deterministic VALIDATION (form gate, mirroring context.ts/metadata.ts), a tolerant PARSER of
// the agent's JSON output (mirroring parsePlan), and the RENDERER that turns a brief into the prompt
// section the writer sees. The orchestration that runs the explorer and injects the brief lives
// elsewhere (Fase 2/3); this module is generic, app-agnostic and side-effect-free.
//
// CRITICAL invariant (decision D — solo-código in v1): the brief distills CODE authoritatively
// (symbols, FE↔BE joins, contracts) but DOM `domLandmarks` are HINTS only. The writer must still
// verify selectors against the live DOM — never trust a distilled selector. The renderer states
// this explicitly so the distillation can never silently override the browser as ground truth.

import { lastJsonMatching } from "../integrations/verdict-parse";
import { sanitizeText } from "../orchestrator/sanitizer";

export interface BlastNode {
  symbol: string; // e.g. "CheckoutService.pay"
  file: string; // repo-relative file the symbol lives in
  role: string; // ONE line: what this symbol does for the flow (the distillate, not the body)
}

export interface FeBeFact {
  route: string; // a frontend entry route the flow uses
  operationId: string; // the backend operation it exercises
  via?: string; // the client/method symbol that makes the call
}

export interface ContractFact {
  operationId: string; // join key with FeBeFact
  method: string; // GET | POST | ...
  path: string; // "/orders/{id}"
  fields?: string[]; // required fields / enums worth asserting
  errors?: string[]; // error responses worth a negative case
}

export interface RouteRecon {
  path: string; // entry route, e.g. "/checkout"
  component?: string; // the component/page it renders
  domLandmarks?: string[]; // HINTS only — NOT verified selectors (see module header)
  // DEPRECATED (vestigial after F3): nothing PRODUCES `true` anymore — the explorer never navigates and
  // the planner's Lever-3 route-verification step was removed — and grounding no longer reads it
  // (captureDomByRoute renders all candidate routes, soft-404-guarded). Retained only so the schema /
  // parser / older briefs stay backward-compatible; do not add new logic that branches on it.
  verified: boolean;
}

export interface ExplorationBrief {
  builtForSha: string; // provenance + staleness signal (the SHA the brief was derived from)
  objective: string; // the flow/objective this brief serves
  blastRadius: BlastNode[]; // the code touched, distilled to symbol + file + 1-line role
  feBe?: FeBeFact[]; // resolved FE→BE joins relevant to the objective
  contracts?: ContractFact[]; // contract facts relevant to assertions
  routes?: RouteRecon[]; // candidate entry routes + DOM landmark hints
  risks?: string[]; // fragilities / what to assert to catch the regression
  notes?: string;
}

export interface BriefValidation {
  ok: boolean;
  errors: string[];
}

// Validates the FORM of a brief (internal consistency), exactly as context.ts gates the
// architecture map. It does NOT cross-check the brief against the code — that is the explorer's
// job and the writer's re-verification; a form gate only keeps the artifact well-shaped. Empty
// sections are valid (a pure-logic objective may have no routes/feBe/contracts).
export function validateExplorationBrief(raw: unknown): BriefValidation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["exploration brief must be an object"] };
  }
  const b = raw as Partial<ExplorationBrief>;
  const errors: string[] = [];

  if (!nonEmpty(b.builtForSha)) errors.push("missing 'builtForSha' (the SHA the brief was built from)");
  if (!nonEmpty(b.objective)) errors.push("missing 'objective'");

  if (!Array.isArray(b.blastRadius)) {
    errors.push("'blastRadius' must be an array");
  } else {
    b.blastRadius.forEach((entry, i) => {
      const n = (entry ?? {}) as Partial<BlastNode>;
      if (!nonEmpty(n.symbol)) errors.push(`blastRadius[${i}]: missing 'symbol'`);
      if (!nonEmpty(n.file)) errors.push(`blastRadius[${i}]: missing 'file'`);
      if (!nonEmpty(n.role)) errors.push(`blastRadius[${i}]: missing 'role' (the 1-line distillate)`);
    });
  }

  if (b.feBe !== undefined) {
    if (!Array.isArray(b.feBe)) errors.push("'feBe' must be an array when present");
    else
      b.feBe.forEach((entry, i) => {
        const l = (entry ?? {}) as Partial<FeBeFact>;
        if (!nonEmpty(l.route)) errors.push(`feBe[${i}]: missing 'route'`);
        if (!nonEmpty(l.operationId)) errors.push(`feBe[${i}]: missing 'operationId'`);
      });
  }

  if (b.contracts !== undefined) {
    if (!Array.isArray(b.contracts)) errors.push("'contracts' must be an array when present");
    else
      b.contracts.forEach((entry, i) => {
        const c = (entry ?? {}) as Partial<ContractFact>;
        const tag = nonEmpty(c.operationId) ? c.operationId! : `#${i}`;
        if (!nonEmpty(c.operationId)) errors.push(`contracts[${i}]: missing 'operationId'`);
        if (!nonEmpty(c.method)) errors.push(`contracts '${tag}': missing 'method'`);
        if (!nonEmpty(c.path)) errors.push(`contracts '${tag}': missing 'path'`);
      });
  }

  if (b.routes !== undefined) {
    if (!Array.isArray(b.routes)) errors.push("'routes' must be an array when present");
    else
      b.routes.forEach((entry, i) => {
        const r = (entry ?? {}) as Partial<RouteRecon>;
        if (!nonEmpty(r.path)) errors.push(`routes[${i}]: missing 'path'`);
        if (typeof r.verified !== "boolean") errors.push(`routes[${i}]: 'verified' must be a boolean`);
      });
  }

  if (b.risks !== undefined && !Array.isArray(b.risks)) errors.push("'risks' must be an array when present");
  if (b.notes !== undefined && typeof b.notes !== "string") errors.push("'notes' must be a string when present");

  return { ok: errors.length === 0, errors };
}

// Tolerant parser of the explorer's REPLY TEXT, mirroring parsePlan: pick the LAST balanced JSON
// object carrying a `blastRadius` array (the brief's signature, distinct from a plan's `objectives`)
// and coerce it. Returns null when no brief-shaped JSON is present.
export function parseExplorationBrief(text: string): ExplorationBrief | null {
  return coerceExplorationBrief(lastJsonMatching(text, (x) => Array.isArray((x as Record<string, unknown>).blastRadius)) ?? null);
}

// Coerces an ALREADY-PARSED value into a brief: used when the brief arrives as a nested object — e.g.
// each planner objective carries one (see parsePlan) — not as text. DROPS malformed array entries
// rather than failing, and returns null unless the value is an object with a `blastRadius` array (the
// brief's signature). Validation of form is a SEPARATE gate (validateExplorationBrief).
export function coerceExplorationBrief(raw: unknown): ExplorationBrief | null {
  const r = asObj(raw);
  if (!r || !Array.isArray(r.blastRadius)) return null;

  const brief: ExplorationBrief = {
    builtForSha: str(r.builtForSha),
    objective: str(r.objective),
    blastRadius: arr(r.blastRadius)
      .map((e) => asObj(e))
      .filter((e): e is Record<string, unknown> => e !== null && nonEmpty(e.symbol) && nonEmpty(e.file))
      .map((e) => ({ symbol: str(e.symbol), file: str(e.file), role: str(e.role) })),
  };

  if (Array.isArray(r.feBe)) {
    brief.feBe = arr(r.feBe)
      .map(asObj)
      .filter((e): e is Record<string, unknown> => e !== null && nonEmpty(e.route) && nonEmpty(e.operationId))
      .map((e) => ({ route: str(e.route), operationId: str(e.operationId), ...(nonEmpty(e.via) ? { via: str(e.via) } : {}) }));
  }
  if (Array.isArray(r.contracts)) {
    brief.contracts = arr(r.contracts)
      .map(asObj)
      .filter((e): e is Record<string, unknown> => e !== null && nonEmpty(e.operationId) && nonEmpty(e.method) && nonEmpty(e.path))
      .map((e) => ({
        operationId: str(e.operationId),
        method: str(e.method),
        path: str(e.path),
        ...(Array.isArray(e.fields) ? { fields: strList(e.fields) } : {}),
        ...(Array.isArray(e.errors) ? { errors: strList(e.errors) } : {}),
      }));
  }
  if (Array.isArray(r.routes)) {
    brief.routes = arr(r.routes)
      .map(asObj)
      .filter((e): e is Record<string, unknown> => e !== null && nonEmpty(e.path))
      .map((e) => ({
        path: str(e.path),
        ...(nonEmpty(e.component) ? { component: str(e.component) } : {}),
        ...(Array.isArray(e.domLandmarks) ? { domLandmarks: strList(e.domLandmarks) } : {}),
        verified: typeof e.verified === "boolean" ? e.verified : false, // default false until the explorer navigated
      }));
  }
  if (Array.isArray(r.risks)) brief.risks = strList(r.risks);
  if (typeof r.notes === "string") brief.notes = r.notes.trim();

  return brief;
}

// Renders a brief as the prompt section the test-writer receives. Sanitizes every field (the brief
// is agent-produced from attacker-influenceable repo content — prompt-injection / secret-exfil
// defense) and is BOUNDED so a huge brief cannot blow the token budget, exactly like
// renderArchitectureContext. Leads with the selector-fidelity guard (decision D).
export function renderExplorationBrief(brief: ExplorationBrief): string {
  const s = (x: unknown): string => sanitizeText(String(x ?? "")).text;
  const MAX_ITEMS = 200;
  const MAX_LEN = 20_000;

  const lines: string[] = [];
  lines.push("## Exploration brief (distilled — verify before trusting)");
  lines.push(`Built for ${s(brief.builtForSha).slice(0, 7)} — a DISTILLED map of the blast radius so you do NOT re-explore the code.`);
  lines.push(
    "This brief is NOT authoritative: verify selectors against the live DOM — the domLandmarks below " +
      "are HINTS, never trusted selectors. If the brief disagrees with the code or the DOM, the code/DOM wins.",
  );
  lines.push("");

  lines.push(`### Objective`);
  lines.push(s(brief.objective));
  lines.push("");

  lines.push(`### Blast radius (${brief.blastRadius.length})`);
  for (const n of brief.blastRadius.slice(0, MAX_ITEMS)) {
    lines.push(`- \`${s(n.symbol)}\` (${s(n.file)}) — ${s(n.role)}`);
  }
  lines.push("");

  if (brief.feBe?.length) {
    lines.push(`### FE↔BE links (${brief.feBe.length})`);
    for (const l of brief.feBe.slice(0, MAX_ITEMS)) {
      lines.push(`- Route \`${s(l.route)}\` → \`${s(l.operationId)}\`${l.via ? ` (via ${s(l.via)})` : ""}`);
    }
    lines.push("");
  }

  if (brief.contracts?.length) {
    lines.push(`### Contracts (${brief.contracts.length})`);
    for (const c of brief.contracts.slice(0, MAX_ITEMS)) {
      const fields = c.fields?.length ? ` — fields: ${c.fields.slice(0, MAX_ITEMS).map(s).join(", ")}` : "";
      const errs = c.errors?.length ? ` — errors: ${c.errors.slice(0, MAX_ITEMS).map(s).join(", ")}` : "";
      lines.push(`- \`${s(c.operationId)}\`: ${s(c.method)} ${s(c.path)}${fields}${errs}`);
    }
    lines.push("");
  }

  if (brief.routes?.length) {
    lines.push(`### Routes (recon — landmarks are HINTS, verify against the live DOM)`);
    for (const r of brief.routes.slice(0, MAX_ITEMS)) {
      const comp = r.component ? ` → ${s(r.component)}` : "";
      const marks = r.domLandmarks?.length ? ` — landmarks (HINTS): ${r.domLandmarks.slice(0, MAX_ITEMS).map(s).join(", ")}` : "";
      lines.push(`- \`${s(r.path)}\`${comp}${marks} [${r.verified ? "verified" : "unverified"}]`);
    }
    lines.push("");
  }

  if (brief.risks?.length) {
    lines.push(`### Risks / what to assert (${brief.risks.length})`);
    for (const risk of brief.risks.slice(0, MAX_ITEMS)) lines.push(`- ${s(risk)}`);
    lines.push("");
  }

  if (nonEmpty(brief.notes)) {
    lines.push(`### Notes`);
    lines.push(s(brief.notes));
  }

  const out = lines.join("\n");
  return out.length > MAX_LEN ? out.slice(0, MAX_LEN) + "\n…(brief truncated)" : out;
}

function nonEmpty(x: unknown): boolean {
  return typeof x === "string" && x.trim().length > 0;
}
function str(x: unknown): string {
  return typeof x === "string" ? x.trim() : "";
}
function arr(x: unknown): unknown[] {
  return Array.isArray(x) ? x : [];
}
function asObj(x: unknown): Record<string, unknown> | null {
  return x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : null;
}
function strList(x: unknown): string[] {
  return Array.isArray(x) ? x.filter((e): e is string => typeof e === "string") : [];
}
