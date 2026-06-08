// Architecture-as-explicit-knowledge artifact (lives in the app repo's
// e2e/.qa/context.json, git-versioned). It makes the cross-boundary structure the
// agent needs for E2E authoring EXPLICIT — the frontend entry points (routes), the
// backend contract (endpoints), and the join between them — so the agent consumes a
// small distilled map instead of re-deriving the architecture from raw code on every
// run (Serena gives blast radius WITHIN one repo/language; it cannot cross from an
// Angular HttpClient call to the Spring controller it hits — this map does).
//
// The map is EXTRACTED from structured sources (Angular routing, OpenAPI specs, the
// generated API clients), not invented: it is an authoring AID, never a quality gate
// (so its residual error is bounded — it scopes work, it does not decide what ships).
// Here we define the schema and its deterministic VALIDATION — the gate that keeps the
// (agent-produced) map internally consistent, exactly as metadata.ts gates the test
// manifest. The builder (agent, "context" mode) and the consumer (diff mode) live
// elsewhere; this module is generic and app-agnostic.

export interface RouteEntry {
  path: string; // frontend entry URL, e.g. "/checkout" (the unit an E2E test targets)
  name?: string; // human flow label, e.g. "Checkout"
  component?: string; // the Angular component/page symbol it renders
  source?: string; // file where the route is declared
}

export interface ApiOperation {
  operationId: string; // stable join key (matches the generated client + the OpenAPI op)
  method: string; // GET | POST | PUT | ...
  path: string; // "/orders/{id}"
  service?: string; // owning microservice
  spec?: string; // path to the OpenAPI file it came from
}

export interface FeBeLink {
  route: string; // a RouteEntry.path
  operationId: string; // an ApiOperation.operationId that route exercises
  via?: string; // the client/method symbol that makes the call
}

export interface FlowEntry {
  id: string; // stable id, e.g. "checkout"
  routes: string[]; // entry routes for the flow
  operations?: string[]; // operationIds the flow touches
}

export interface ArchitectureContext {
  builtAtSha: string; // provenance: the SHA the map was derived from (staleness signal)
  routes: RouteEntry[];
  api: ApiOperation[];
  feBe: FeBeLink[];
  flows?: FlowEntry[];
}

export interface ContextValidation {
  ok: boolean;
  errors: string[];
}

// Validates an ArchitectureContext. Requires provenance + well-formed sections, and
// crucially that every FE↔BE link RESOLVES (its route and operationId exist) — the
// join is the whole point, so a dangling link is an error. Empty sections are valid
// (a repo with no backend, or not yet mapped). The optional measured/labelled fields
// (name, flows, via) are not required.
export function validateContext(raw: unknown): ContextValidation {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { ok: false, errors: ["context (e2e/.qa/context.json) must be an object"] };
  }
  const c = raw as Partial<ArchitectureContext>;
  const errors: string[] = [];

  if (!nonEmpty(c.builtAtSha)) errors.push("missing 'builtAtSha' (the SHA the map was built from)");

  const routePaths = new Set<string>();
  if (!Array.isArray(c.routes)) {
    errors.push("'routes' must be an array");
  } else {
    c.routes.forEach((entry, i) => {
      const r = (entry ?? {}) as Partial<RouteEntry>;
      if (!nonEmpty(r.path)) errors.push(`routes[${i}]: missing 'path'`);
      else if (routePaths.has(r.path!)) errors.push(`routes[${i}]: duplicate path '${r.path}'`);
      else routePaths.add(r.path!);
    });
  }

  const opIds = new Set<string>();
  if (!Array.isArray(c.api)) {
    errors.push("'api' must be an array");
  } else {
    c.api.forEach((entry, i) => {
      const o = (entry ?? {}) as Partial<ApiOperation>;
      const tag = nonEmpty(o.operationId) ? o.operationId! : `#${i}`;
      if (!nonEmpty(o.operationId)) errors.push(`api[${i}]: missing 'operationId'`);
      else if (opIds.has(o.operationId!)) errors.push(`api[${i}]: duplicate operationId '${o.operationId}'`);
      else opIds.add(o.operationId!);
      if (!nonEmpty(o.method)) errors.push(`api '${tag}': missing 'method'`);
      if (!nonEmpty(o.path)) errors.push(`api '${tag}': missing 'path'`);
    });
  }

  if (!Array.isArray(c.feBe)) {
    errors.push("'feBe' must be an array");
  } else {
    c.feBe.forEach((entry, i) => {
      const l = (entry ?? {}) as Partial<FeBeLink>;
      if (!nonEmpty(l.route)) errors.push(`feBe[${i}]: missing 'route'`);
      else if (Array.isArray(c.routes) && !routePaths.has(l.route!)) {
        errors.push(`feBe[${i}]: route '${l.route}' is not declared in 'routes'`);
      }
      if (!nonEmpty(l.operationId)) errors.push(`feBe[${i}]: missing 'operationId'`);
      else if (Array.isArray(c.api) && !opIds.has(l.operationId!)) {
        errors.push(`feBe[${i}]: operationId '${l.operationId}' is not declared in 'api'`);
      }
    });
  }

  if (c.flows !== undefined) {
    if (!Array.isArray(c.flows)) {
      errors.push("'flows' must be an array when present");
    } else {
      const flowIds = new Set<string>();
      c.flows.forEach((entry, i) => {
        const f = (entry ?? {}) as Partial<FlowEntry>;
        const tag = nonEmpty(f.id) ? f.id! : `#${i}`;
        if (!nonEmpty(f.id)) errors.push(`flows[${i}]: missing 'id'`);
        else if (flowIds.has(f.id!)) errors.push(`flows[${i}]: duplicate id '${f.id}'`);
        else flowIds.add(f.id!);
        if (!Array.isArray(f.routes) || f.routes.length === 0) {
          errors.push(`flows '${tag}': empty 'routes' (a flow groups at least one route)`);
        }
      });
    }
  }

  return { ok: errors.length === 0, errors };
}

function nonEmpty(s: unknown): boolean {
  return typeof s === "string" && s.trim().length > 0;
}

// ── Staleness detection ────────────────────────────────────────────────────
// The map carries a `builtAtSha` for provenance. When the HEAD has moved past it
// by more than `maxCommitsBehind`, the map is considered stale — useful for
// triggering automatic regeneration (e.g. via cron or on a routing/OpenAPI change).
// The threshold is permissive by default (20 commits) because the map changes only
// when routing or API contracts change, not on every commit.

export interface StalenessInput {
  builtAtSha: string; // the SHA the map was built from (from context.builtAtSha)
  headSha: string; // the current HEAD of the branch
  commitsBehind: number; // how many commits HEAD is ahead of builtAtSha
}

export function isContextStale(
  input: StalenessInput,
  maxCommitsBehind = 20,
): { stale: boolean; commitsBehind: number; reason: string } {
  if (input.commitsBehind <= 0) {
    return { stale: false, commitsBehind: 0, reason: "map is at or ahead of HEAD" };
  }
  if (input.commitsBehind > maxCommitsBehind) {
    return {
      stale: true,
      commitsBehind: input.commitsBehind,
      reason: `map built at ${input.builtAtSha.slice(0, 7)} is ${input.commitsBehind} commits behind HEAD (${input.headSha.slice(0, 7)}), threshold is ${maxCommitsBehind}`,
    };
  }
  return {
    stale: false,
    commitsBehind: input.commitsBehind,
    reason: `map is ${input.commitsBehind} commits behind HEAD (threshold: ${maxCommitsBehind})`,
  };
}
