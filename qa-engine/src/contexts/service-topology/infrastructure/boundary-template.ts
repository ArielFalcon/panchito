// service-topology/infrastructure/boundary-template.ts
// Compiles a config-supplied "{service}" template string into a matcher. This is what lets
// HttpBoundaryProfile.servicePrefixTemplate / serviceRepoTemplate be arbitrary app config
// instead of a hardcoded regex in the core — the SAME compiler serves any app's naming
// convention (prefix-and-suffix, suffix-only, or anything else containing "{service}").

const PLACEHOLDER = "{service}";
// Service-name charset: letters, digits, hyphen/underscore (covers "auth-v2" style names).
const SERVICE_CHARSET = "[A-Za-z0-9_-]+";

function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Count non-overlapping occurrences of "{service}" in a template. */
function countPlaceholders(template: string): number {
  return template.split(PLACEHOLDER).length - 1;
}

/** Split a template on its ONE "{service}" placeholder into its literal prefix/suffix.
 *  Returns null when the template does not contain EXACTLY one placeholder — 0 placeholders
 *  degenerates into a phantom optional-capture group (see compilePrefixTemplate), and 2+
 *  placeholders can only match the FIRST occurrence, silently treating the rest as literal
 *  text that (almost) never matches. Both shapes are unsupported config, not a valid template. */
function splitTemplate(template: string): { prefix: string; suffix: string } | null {
  if (countPlaceholders(template) !== 1) return null;
  const idx = template.indexOf(PLACEHOLDER);
  return {
    prefix: template.slice(0, idx),
    suffix: template.slice(idx + PLACEHOLDER.length),
  };
}

export interface PrefixMatch {
  service: string;
  resource: string;
}

/** Compile a path-prefix template (e.g. "name-{service}-api") into a matcher over a full
 *  path string. Accepts an optional leading slash. The captured service is non-greedy so a
 *  literal suffix (e.g. "-api") is never swallowed into the service name; the remainder after
 *  the suffix becomes `resource` ("" when the path ends at the suffix). The suffix must be
 *  followed by a "/" or end-of-string (a segment boundary) — otherwise the SERVICE_CHARSET's
 *  "-" would let a substring match swallow trailing characters into `resource` (e.g.
 *  "name-{service}-api" matching "name-orders-apifoo" as {service: orders, resource: foo}).
 *
 *  Requires EXACTLY one "{service}" token in the template (see splitTemplate); an unsupported
 *  shape (0 or 2+ placeholders) warns loudly and fails CLOSED — the returned matcher always
 *  returns null, never a phantom capture. */
export function compilePrefixTemplate(template: string): (path: string) => PrefixMatch | null {
  const split = splitTemplate(template);
  if (!split) {
    console.warn(
      `[compilePrefixTemplate] unsupported servicePrefixTemplate "${template}" — expected ` +
        `exactly one "{service}" token. Failing closed: this matcher will never match.`,
    );
    return (): null => null;
  }
  const { prefix, suffix } = split;
  const re = new RegExp(
    `^/?${escapeRegExp(prefix)}(${SERVICE_CHARSET}?)${escapeRegExp(suffix)}(?:/(.*)|)$`,
  );
  return (path: string): PrefixMatch | null => {
    const m = path.match(re);
    if (!m) return null;
    const service = m[1] ?? "";
    if (service.length === 0) return null; // placeholder must capture at least one character
    return { service, resource: m[2] ?? "" };
  };
}

/** Compile a repo-slug template (e.g. "ms-name-{service}") into a slug→service extractor.
 *  Returns the ORIGINAL slug unchanged when the template does not match (mirrors the adapter's
 *  existing "fall back to the raw slug" behavior for unrecognized repo names).
 *
 *  Requires EXACTLY one "{service}" token (see splitTemplate); an unsupported shape (0 or 2+
 *  placeholders) warns loudly and fails CLOSED — the returned extractor always returns the raw
 *  slug unchanged, never a phantom capture (e.g. template "no-placeholder" must never turn slug
 *  "no-placeholderXYZ" into service "XYZ"). */
export function compileRepoTemplate(template: string): (slug: string) => string {
  const split = splitTemplate(template);
  if (!split) {
    console.warn(
      `[compileRepoTemplate] unsupported serviceRepoTemplate "${template}" — expected exactly ` +
        `one "{service}" token. Failing closed: this extractor will always return the raw slug.`,
    );
    return (slug: string): string => slug;
  }
  const { prefix, suffix } = split;
  const re = new RegExp(`^${escapeRegExp(prefix)}(${SERVICE_CHARSET}?)${escapeRegExp(suffix)}$`);
  return (slug: string): string => {
    const m = slug.match(re);
    const service = m?.[1];
    return service && service.length > 0 ? service : slug;
  };
}
