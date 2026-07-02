// service-topology/infrastructure/openapi-http-resolver.adapter.ts
// OpenAPI-anchored FE↔BE link resolver. Config-driven: every app-specific pattern (the front
// call-site shape and receiver, the service-prefix and repo-slug naming templates, and the
// per-repo OpenAPI path) comes from the injected HttpBoundaryProfile — this class carries no
// literal from any one watched app (Invariant #1: app-specificity lives only in config).
//   INGRESS: parse each backend's OpenAPI file at profile.openApiPath (yaml dep; fallback to line-parser)
//   EGRESS:  scan profile.frontFiles for call-sites matching profile.frontCallSite
//   JOIN:    strip the profile.servicePrefixTemplate prefix, structural segment match ({param} matches any segment)
//   OUTPUTS: links (matched), drift (contract gap), external (unknown service), unresolved (dynamic arg)
//
// Fail-open: any per-repo error degrades to an empty result for that repo. Never throws past this class.
//
// Level 2: from.symbol uses tree-sitter to walk UP the AST from the call-site node to the nearest
// enclosing method_definition / function_declaration / public_field_definition (arrow), giving the
// correct method name even when the call-site is nested inside .pipe(switchMap(...), catchError(...)).
// Falls back to a backward-scan heuristic if tree-sitter fails to load.
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { createRequire } from "node:module";
import { parse as parseYaml } from "yaml";
import type { ServiceBoundaryResolverPort, ResolveLinksResult } from "../application/ports/index.ts";
import type {
  RepoRef, ServiceLink, ServiceSymbolRef, ContractDrift, ExternalCall, UnresolvedCall,
  HttpBoundaryProfile,
} from "../domain/index.ts";
import { CallSiteCatalog, type CallSiteOccurrence } from "./call-site-catalog.ts";
import { compilePrefixTemplate, compileRepoTemplate, type PrefixMatch } from "./boundary-template.ts";
import { compileFileGlob } from "./glob-suffix.ts";

// ---- Constants ----
// Standard across every profile — NOT app-specific. HTTP verbs and const-declaration syntax
// are transport/language facts, not a watched app's convention (Invariant #1).
const VERBS = new Set(["get", "post", "put", "patch", "delete"]);
// Matches: const NAME = 'value' or export const NAME = 'value' (for const resolution)
const CONST_RE = /(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*(['"`])((?:\\.|(?!\2).)*)\2/g;

// ---- Segment helpers ----
function segs(p: string): string[] {
  return String(p).replace(/^\/+/, "").replace(/\/+$/, "").split("/").filter(Boolean);
}
function isParam(s: string): boolean {
  return s.startsWith("{") && s.endsWith("}");
}

// ---- Ingress: parsed OpenAPI operation ----
interface IngressOp {
  service: string;
  path: string;
  verb: string;       // uppercase
  operationId: string;
  segs: string[];
}

/** Parse a backend's OpenAPI YAML using the yaml package; return typed operation entries. */
function parseOpenApiYaml(service: string, content: string): IngressOp[] {
  const ops: IngressOp[] = [];
  let doc: Record<string, unknown>;
  try {
    doc = parseYaml(content) as Record<string, unknown>;
  } catch {
    return ops;
  }
  const paths = doc["paths"] as Record<string, unknown> | undefined;
  if (!paths) return ops;
  for (const [path, pathItem] of Object.entries(paths)) {
    if (typeof pathItem !== "object" || pathItem === null) continue;
    for (const [verb, operation] of Object.entries(pathItem as Record<string, unknown>)) {
      if (!VERBS.has(verb.toLowerCase())) continue;
      if (typeof operation !== "object" || operation === null) continue;
      const operationId = (operation as Record<string, unknown>)["operationId"];
      if (typeof operationId !== "string") continue;
      ops.push({ service, path, verb: verb.toUpperCase(), operationId, segs: segs(path) });
    }
  }
  return ops;
}

/** Find an ingress operation matching (service, verb, frontSegments) via structural segment match.
 *  Determinism rule: when the contract has both a literal segment (e.g. /orders/active) and a
 *  param segment (e.g. /orders/{id}) at the same slot, the all-literal match wins.
 *  Array.find() alone would return whichever is declared first in the YAML — non-deterministic. */
function findOp(ingress: IngressOp[], service: string, verb: string, frontSegs: string[]): IngressOp | undefined {
  const candidates = ingress.filter((o) =>
    o.service === service &&
    o.verb === verb &&
    o.segs.length === frontSegs.length &&
    o.segs.every((c, i) => isParam(c) || c === (frontSegs[i] ?? "")),
  );
  if (candidates.length === 0) return undefined;
  // Prefer an exact all-literal match (no {param} segments matched against a concrete value).
  const exact = candidates.find((o) => o.segs.every((c) => !isParam(c)));
  return exact ?? candidates[0];
}

// ---- Egress: parsed frontend call-site ----
interface EgressCallSite {
  file: string;           // repo-relative path
  verb: string;           // uppercase
  rawArg: string;         // original argument text
  path: string | null;    // resolved path, or null if unresolvable
  enclosingMethod: string | null; // the method/function name enclosing this call-site (Level 2)
}

/** Recursively walk a directory, collecting files matching the predicate. */
function walk(dir: string, predicate: (name: string) => boolean, out: string[] = []): string[] {
  let entries: string[];
  // .sort() for deterministic traversal order (invariant #1) — readdirSync order is FS-dependent.
  try { entries = readdirSync(dir).sort(); } catch { return out; }
  for (const entry of entries) {
    const full = join(dir, entry);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, predicate, out);
    else if (predicate(entry)) out.push(full);
  }
  return out;
}

/** Build a const-resolution map from all *.api.ts files. Cross-file const refs use the last-seen value. */
function buildConstMap(apiFiles: string[]): Record<string, string> {
  const consts: Record<string, string> = {};
  for (const f of apiFiles) {
    let text: string;
    try { text = readFileSync(f, "utf8"); } catch { continue; }
    CONST_RE.lastIndex = 0;
    for (let m; (m = CONST_RE.exec(text)) !== null;) {
      const name = m[1];
      const value = m[3];
      if (name !== undefined && value !== undefined) consts[name] = value;
    }
  }
  return consts;
}

/** Recursively resolve template literals and const refs (same as spike). Returns null on unresolvable. */
function resolveVal(raw: string, consts: Record<string, string>, seen = new Set<string>()): string {
  return String(raw).replace(/\$\{([^}]+)\}/g, (_, expr: string) => {
    const k = expr.trim();
    if (consts[k] !== undefined && !seen.has(k)) {
      // Clone `seen` before passing to the recursive call so that sibling substitutions
      // (e.g. both ${API} in `${API}/${API}`) each start with a fresh cycle-guard state.
      // Sharing the same Set would cause the second ${API} to appear "already seen" and
      // resolve to {p} — a false unresolvable result.
      const childSeen = new Set(seen);
      childSeen.add(k);
      return resolveVal(consts[k]!, consts, childSeen);
    }
    return "{p}"; // method param / unresolved import → placeholder segment
  });
}

/** Resolve a single call-site arg to a path string (or null = unresolvable method param). */
function resolveArg(arg: string, consts: Record<string, string>): string | null {
  const trimmed = arg.trim();
  const q = trimmed[0];
  if (q === "'" || q === '"' || q === "`") {
    // Use indexOf(q, 1) — the FIRST closing quote — not lastIndexOf.
    // The call-site extractor's stop-set ([^,)\n]+) already prevents a spurious second
    // delimiter from being captured, but lastIndexOf would return -1 if the closing quote
    // was trimmed by that stop-set boundary, silently dropping the last character of the path.
    const close = trimmed.indexOf(q, 1);
    return resolveVal(close === -1 ? trimmed.slice(1) : trimmed.slice(1, close), consts);
  }
  if (consts[trimmed] !== undefined) return resolveVal(consts[trimmed]!, consts);
  return null; // bare identifier that's not a const = method param = unresolvable
}

// ---- Tree-sitter enclosing-method extraction (Level 2) ----
// Primary: parse the file with the TypeScript grammar and walk UP from the call-site node.
// This correctly handles nested calls (RxJS pipe/switchMap/catchError, toString, etc.) —
// the backward-scan heuristic mis-attributes operators inside .pipe() as the method name.
// Fallback: backward scan (retained when tree-sitter fails to load in the environment).

// AST node types that represent named callable declarations in TypeScript.
// public_field_definition covers arrow-function class fields: `myMethod = () => { ... }`.
// NOTE: "arrow_function" is intentionally EXCLUDED — it never carries a name child in tree-sitter.
// For `const listOrders = () => ...`, the name lives in the parent variable_declarator's identifier.
// walkUpToMethod handles variable_declarator explicitly.
const ENCLOSING_NODE_TYPES = new Set([
  "method_definition",          // object literal or class method
  "function_declaration",       // top-level function
  "function",                   // function expression
  "method_signature",           // interface method signature
  "public_field_definition",    // class field (arrow function assigned)
]);

// Lazily-resolved tree-sitter parser for TypeScript. null = failed to load (fail-open).
// Using a module-level promise so initialization runs once across all resolver calls.
type TsParser = { parse(src: string): { rootNode: { namedDescendantForIndex(i: number): TsSyntaxNode } } };
type TsSyntaxNode = {
  type: string;
  parent: TsSyntaxNode | null;
  children: TsSyntaxNode[];
  namedChildren: TsSyntaxNode[];
  text: string;
};
let tsParserPromise: Promise<TsParser | null> | null = null;

function getTsParser(): Promise<TsParser | null> {
  if (tsParserPromise) return tsParserPromise;
  tsParserPromise = (async (): Promise<TsParser | null> => {
    try {
      // Dynamic import: keeps this module loadable even when web-tree-sitter is absent.
      // Mirrors the loading pattern from src/qa/static-signal/symbols.ts.
      // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
      const Parser = (await import("web-tree-sitter")).default;
      await (Parser as { init(): Promise<void> }).init();
      // Resolve the WASM grammar directory the same way symbols.ts does.
      const _require = createRequire(import.meta.url);
      let wasmPath: string;
      try {
        const pkgJson = _require.resolve("tree-sitter-wasms/package.json");
        wasmPath = resolve(dirname(pkgJson), "out", "tree-sitter-typescript.wasm");
      } catch (err) {
        console.warn(
          "[OpenApiHttpResolver] tree-sitter-wasms not installed — enclosing-method extraction will use fallback backward scan. Install tree-sitter-wasms@0.1.13 for accurate results.",
          err instanceof Error ? err.message : String(err),
        );
        return null; // tree-sitter-wasms not installed — fail-open
      }
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-explicit-any
      const language = await (Parser as any).Language.load(wasmPath);
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-explicit-any
      const parser = new (Parser as any)();
      // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
      parser.setLanguage(language);
      return parser as TsParser;
    } catch (err) {
      // web-tree-sitter or WASM missing — degrade gracefully to backward scan.
      console.warn(
        "[OpenApiHttpResolver] web-tree-sitter failed to load — enclosing-method extraction will use fallback backward scan. Install web-tree-sitter@0.20.8 for accurate results.",
        err instanceof Error ? err.message : String(err),
      );
      return null;
    }
  })();
  return tsParserPromise;
}

/** Walk UP the AST from `node` to the nearest enclosing named method/function.
 *  Returns the method name string, or null if none found.
 *
 *  Handles two patterns:
 *  1. ENCLOSING_NODE_TYPES nodes (method_definition, function_declaration, etc.) — the name is
 *     a direct named child of type "property_identifier" or "identifier".
 *  2. variable_declarator — `const listOrders = () => ...` in tree-sitter produces:
 *       lexical_declaration → variable_declarator[identifier "listOrders", arrow_function]
 *     The arrow_function has no name child; the identifier is a SIBLING inside variable_declarator.
 *     We detect this by checking cur.parent.type === "variable_declarator" and extracting
 *     the identifier sibling. */
function walkUpToMethod(node: TsSyntaxNode | null): string | null {
  let cur = node?.parent ?? null;
  while (cur !== null) {
    if (ENCLOSING_NODE_TYPES.has(cur.type)) {
      // Find the name child: for method_definition it is a child with fieldName "name";
      // for function_declaration it is the identifier child.
      for (const child of cur.namedChildren) {
        if (child.type === "property_identifier" || child.type === "identifier") {
          const name = child.text;
          if (name && name.length > 0) return name;
        }
      }
    } else if (cur.type === "variable_declarator") {
      // `const listOrders = () => ...` — name is the identifier child of variable_declarator.
      // The arrow_function is never in ENCLOSING_NODE_TYPES because it has no name child.
      for (const child of cur.namedChildren) {
        if (child.type === "identifier") {
          const name = child.text;
          if (name && name.length > 0) return name;
        }
      }
    }
    cur = cur.parent;
  }
  return null;
}

// Maximum number of characters to scan backward — retained as fallback when tree-sitter unavailable.
const BACKWARD_SCAN_LIMIT = 2048;

/** Fallback backward-scan heuristic: scan the text before `matchIndex` for the last
 *  "name(" pattern that is not a keyword. Used only when tree-sitter fails to load.
 *  Exported for isolated unit-testing of the fallback path (independent of WASM availability). */
export function extractEnclosingMethodFallback(text: string, matchIndex: number): string | null {
  const start = Math.max(0, matchIndex - BACKWARD_SCAN_LIMIT);
  const slice = text.slice(start, matchIndex);
  // Scan for the last opening-brace-preceded by a named signature.
  // This heuristic is known to mis-attribute RxJS operators (catchError, switchMap) —
  // it is retained ONLY as a fallback when tree-sitter is unavailable.
  const METHOD_DECL_RE = /\b(?:async\s+)?([a-zA-Z_$][a-zA-Z0-9_$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::[^{]*)?\s*\{/g;
  let lastName: string | null = null;
  for (let mm; (mm = METHOD_DECL_RE.exec(slice)) !== null;) {
    const name = mm[1];
    if (
      name !== undefined &&
      name !== "if" && name !== "for" && name !== "while" && name !== "switch" &&
      name !== "catch" && name !== "function" && name !== "return" && name !== "new" &&
      name !== "typeof" && name !== "instanceof" && name !== "await" && name !== "get" &&
      name !== "set" && name !== "this" && name !== "rest"
    ) {
      lastName = name;
    }
  }
  return lastName;
}

/** Build a per-file enclosing-method map using tree-sitter.
 *  Maps each call-site match index (from the CallSiteCatalog extractor) → enclosing method name.
 *  Uses the parser when available; returns empty map on failure (fallback path kicks in). */
async function buildEnclosingMethodMap(
  text: string,
  matchIndices: number[],
): Promise<Map<number, string | null>> {
  const result = new Map<number, string | null>();
  if (matchIndices.length === 0) return result;
  const parser = await getTsParser();
  if (!parser) return result; // tree-sitter unavailable — fallback will handle it
  let tree: { rootNode: { namedDescendantForIndex(i: number): TsSyntaxNode } };
  try {
    tree = parser.parse(text);
  } catch {
    return result; // parse error — fallback handles it
  }
  for (const idx of matchIndices) {
    try {
      const callNode = tree.rootNode.namedDescendantForIndex(idx);
      result.set(idx, walkUpToMethod(callNode));
    } catch {
      result.set(idx, null);
    }
  }
  return result;
}

/** Extract all HTTP call-sites from a set of front egress files, using the call-site shape
 *  selected by `frontCallSite.kind` (looked up in the in-core CallSiteCatalog) and the concrete
 *  receiver from config. Async because tree-sitter initialization is async (WASM load). */
async function extractEgress(
  apiFiles: string[],
  mirrorDir: string,
  consts: Record<string, string>,
  frontCallSite: HttpBoundaryProfile["frontCallSite"],
): Promise<EgressCallSite[]> {
  const extractor = CallSiteCatalog[frontCallSite.kind];
  if (!extractor) return []; // unknown call-site kind in config — fail-open, no match

  const result: EgressCallSite[] = [];
  for (const full of apiFiles) {
    let text: string;
    try { text = readFileSync(full, "utf8"); } catch { continue; }
    const relFile = full.slice(mirrorDir.length + 1); // make repo-relative

    // Collect all match indices first, then resolve enclosing methods in one tree parse.
    const callSites: CallSiteOccurrence[] = extractor(text, frontCallSite);

    // Build enclosing-method map via tree-sitter (or empty map if unavailable).
    const enclosingMap = await buildEnclosingMethodMap(text, callSites.map((c) => c.index));

    for (const { index, verb, rawArg } of callSites) {
      // Primary: tree-sitter AST walk (avoids RxJS-operator mis-attribution).
      // Fallback: backward scan when tree-sitter is unavailable.
      let enclosingMethod: string | null;
      if (enclosingMap.has(index)) {
        enclosingMethod = enclosingMap.get(index) ?? null;
      } else {
        enclosingMethod = extractEnclosingMethodFallback(text, index);
      }
      result.push({
        file: relFile,
        verb: verb.toUpperCase(),
        rawArg,
        path: resolveArg(rawArg, consts),
        enclosingMethod,
      });
    }
  }
  return result;
}

export class OpenApiHttpResolver implements ServiceBoundaryResolverPort {
  // Compiled once from the injected profile — the ONLY place these app-specific shapes are
  // read from config rather than hardcoded (Invariant #1).
  private readonly serviceOfRepoSlug: (slug: string) => string;
  private readonly matchServicePrefix: (path: string) => PrefixMatch | null;
  private readonly isFrontEgressFile: (filename: string) => boolean;

  constructor(private readonly profile: HttpBoundaryProfile) {
    this.serviceOfRepoSlug = compileRepoTemplate(profile.serviceRepoTemplate);
    this.matchServicePrefix = compilePrefixTemplate(profile.servicePrefixTemplate);
    this.isFrontEgressFile = compileFileGlob(profile.frontFiles);
  }

  /** Derive the service name for a repo via the config-supplied serviceRepoTemplate
   *  (e.g. nname's "ms-name-{service}": ms-name-orders → "orders"). Single source of truth —
   *  every call-site that needs a repo's service name goes through this one method. */
  private serviceOfRepo(repo: RepoRef): string {
    const slug = repo.repo.split("/").pop() ?? repo.repo;
    return this.serviceOfRepoSlug(slug);
  }

  async resolveLinks(system: RepoRef[], front: RepoRef): Promise<ResolveLinksResult> {
    // --- INGRESS: parse each backend's OpenAPI ---
    const ingress: IngressOp[] = [];
    const knownServices = new Set<string>();
    // Built once here (service → repo) so the JOIN below can look up the backend repo for a
    // matched service in O(1) instead of re-scanning `system` with .find() per call-site
    // (previously O(egress × system)).
    const repoOfService = new Map<string, RepoRef>();
    for (const repo of system) {
      const openapiPath = join(repo.mirrorDir, this.profile.openApiPath);
      let content: string;
      try { content = readFileSync(openapiPath, "utf8"); } catch { continue; }
      const service = this.serviceOfRepo(repo);
      knownServices.add(service);
      repoOfService.set(service, repo);
      ingress.push(...parseOpenApiYaml(service, content));
    }

    // --- EGRESS: scan front egress files matching profile.frontFiles ---
    const apiFiles = walk(front.mirrorDir, (name) => this.isFrontEgressFile(name));
    const consts = buildConstMap(apiFiles);
    const egress = await extractEgress(apiFiles, front.mirrorDir, consts, this.profile.frontCallSite);

    // --- JOIN: classify each call-site ---
    const links: ServiceLink[] = [];
    const drift: ContractDrift[] = [];
    const external: ExternalCall[] = [];
    const unresolved: UnresolvedCall[] = [];

    for (const e of egress) {
      // Unresolvable path (dynamic/method-param arg)
      if (e.path === null) {
        unresolved.push({ rawArg: e.rawArg, file: e.file });
        continue;
      }

      // Strip service prefix via the config-supplied servicePrefixTemplate
      const m = this.matchServicePrefix(e.path);
      if (!m) {
        // No recognized service prefix → unresolved (bare path, not service-routed).
        // Note: semantically these could also be "external" (e.g. absolute URLs like "https://..."),
        // but without a service prefix we cannot classify the target — unresolved is the safe bucket.
        unresolved.push({ rawArg: e.rawArg, file: e.file });
        continue;
      }
      const { service, resource } = m;

      // External service (not in the indexed repo set)
      if (!knownServices.has(service)) {
        external.push({
          path: e.path,
          verb: e.verb,
          from: { repo: front.repo, file: e.file, symbol: e.enclosingMethod ?? e.rawArg },
        });
        continue;
      }

      // Try structural segment match against the backend contract
      const resourceSegs = segs(resource);
      const op = findOp(ingress, service, e.verb, resourceSegs);
      if (op) {
        // Build ServiceLink
        const fromRef: ServiceSymbolRef = {
          repo: front.repo,
          file: e.file,
          // Level 2: from.symbol = enclosing method name (tells the generator which front flow to exercise).
          // Falls back to rawArg when the backward scan finds no enclosing method (e.g. top-level code).
          symbol: e.enclosingMethod ?? e.rawArg,
        };
        // Look up the backend repo for this service from the map built once in the ingress
        // loop (single source of truth via serviceOfRepo, O(1) instead of a per-call-site scan).
        const backendRepo = repoOfService.get(service);
        const toRef: ServiceSymbolRef = {
          repo: backendRepo?.repo ?? `service:${service}`,
          file: this.profile.openApiPath,
          symbol: op.operationId,
        };
        // Confidence: 1.0 only for all-literal/explicit front segments.
        // When a {p} placeholder (unresolved method param) was matched against a contract {param}
        // segment, lower the confidence: the match is structurally valid but not statically proven.
        const hasPlaceholderSegment = resourceSegs.some((s) => s === "{p}");
        const consumedPlaceholder = hasPlaceholderSegment && op.segs.some(isParam);
        const confidence = consumedPlaceholder ? 0.6 : 1.0;
        links.push({
          from: fromRef,
          to: toRef,
          transport: "http",
          contractRef: op.operationId,
          confidence,
          source: "openapi-http",
        });
      } else {
        // Known service but no matching operation → contract drift
        drift.push({
          from: {
            repo: front.repo,
            file: e.file,
            symbol: e.enclosingMethod ?? e.rawArg,
          },
          verb: e.verb,
          path: e.path,
        });
      }
    }

    return { links, drift, external, unresolved };
  }
}
