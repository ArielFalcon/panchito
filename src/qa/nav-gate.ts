// The deterministic navigation gate (precise) — pure decision core.
//
// On a RE-generation turn the agent must fix from the injected grounding (Context Pack / failure
// tree) instead of re-navigating routes that are already grounded. RE-1 asked it to; the live
// validation proved the agent ignores a prompt instruction. This gate makes it DETERMINISTIC: the
// MCP proxy (Section C) calls decideNav() to physically reject a `browser_navigate` to a grounded
// route — while still ALLOWING navigation to a route the grounding does not cover (the anti-blinding
// escape). It FAILS OPEN: anything unparseable or uncertain is allowed, because wrongly blocking a
// navigation blinds the agent (worse than wasted exploration) — determinism over zeal, the same
// doctrine as change-coverage's "unknown never blocks".

export interface NavGateInput {
  isRegen: boolean;
  groundedRoutes: string[];
  requestedUrl: string;
}

export interface NavGateDecision {
  allow: boolean;
  reason: string;
}

// Reduce a URL (full or relative, hash-routed or path-routed) to a canonical route path, or null if
// it cannot be parsed. Hash routing wins when present (SPA: the route lives after `#`/`#!`).
export function normalizeRoute(raw: string): string | null {
  if (typeof raw !== "string") return null;
  const s = raw.trim();
  if (!s) return null;

  let routePart: string;
  const hashIdx = s.indexOf("#");
  if (hashIdx >= 0) {
    routePart = s.slice(hashIdx + 1); // SPA route lives after the hash
    const frag = routePart.indexOf("#"); // a trailing UI fragment (#tab=…) is not part of the route
    if (frag >= 0) routePart = routePart.slice(0, frag);
  } else {
    try {
      const u = new URL(s);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null; // non-web scheme → not a route
      routePart = u.pathname; // full URL → strip the origin
    } catch {
      if (s.startsWith("//") || /^[a-z][a-z0-9+.-]*:/i.test(s)) return null; // protocol-relative or a scheme
      routePart = s; // already a relative path
    }
  }

  routePart = routePart.replace(/^!/, ""); // hashbang `#!`
  const q = routePart.indexOf("?");
  if (q >= 0) routePart = routePart.slice(0, q); // drop query
  if (!routePart.startsWith("/")) routePart = "/" + routePart;
  if (routePart.length > 1) routePart = routePart.replace(/\/+$/, ""); // drop trailing slash (not root)
  return routePart || "/";
}

// Does the GROUNDED route cover the REQUESTED concrete route? Exact match, OR a `:param` template
// segment matches any concrete segment. We deliberately do NOT collapse bare numbers to a wildcard:
// a numeric segment can be a year/page/month (`/reports/2024`), not an entity id, and collapsing it
// would FALSELY block a sibling route the agent has never seen — blinding it (the gate's cardinal
// sin). True `/:id` routes are matched only when the orchestrator supplies the explicit template.
export function routesMatch(grounded: string, requested: string): boolean {
  if (grounded === requested) return true;
  const g = grounded.split("/");
  const r = requested.split("/");
  if (g.length !== r.length) return false;
  return g.every((seg, i) => seg.startsWith(":") || seg === r[i]);
}

export function decideNav(input: NavGateInput): NavGateDecision {
  if (!input.isRegen) return { allow: true, reason: "first-pass: exploration allowed" };

  const route = normalizeRoute(input.requestedUrl);
  if (route === null) return { allow: true, reason: "fail-open: unparseable URL" };

  const grounded = (input.groundedRoutes ?? [])
    .map(normalizeRoute)
    .filter((r): r is string => r !== null);
  if (grounded.length === 0) return { allow: true, reason: "fail-open: no grounded routes" };

  if (grounded.some((g) => routesMatch(g, route))) {
    return { allow: false, reason: `route ${route} is already grounded — transcribe from the injected tree` };
  }
  return { allow: true, reason: `route ${route} not grounded — navigation allowed` };
}
