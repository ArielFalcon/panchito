// qa-engine/src/shared-infrastructure/code-graph/resolve-project-name.ts
//
// CodeGraph Phase 4 (design §6, deferred 4a.10, tasks 4b.6): resolves the codebase-memory-mcp
// project name indexed for a given repoDir, via `list_projects` — the CLI's own authoritative
// source. VERIFIED empirically against the real binary (v0.8.1):
//
//   codebase-memory-mcp cli list_projects '{}' <any-dir>
//   -> {"projects":[{"name":"Users-arielyumn-Desktop-TRABAJO-nname-ms-name-restaurants",
//                    "root_path":"/Users/arielyumn/Desktop/TRABAJO/nname/ms-name-restaurants", ...}]}
//
// Matches by root_path equality (NOT by re-deriving the name string from repoDir) — the CLI is the
// single source of truth for the name<->path mapping; re-deriving it here would silently desync if
// the indexer's own derivation rule ever changes. Fail-open throughout (ADR-4/§6): a CLI failure
// (code:null), malformed JSON, a missing/malformed `projects` array, or no matching root_path all
// resolve to `undefined` — NEVER a thrown error. A caller treats `undefined` exactly like an
// unindexed repo (CodeGraphPort's own "no structural signal" contract) — this is the path EVERY
// watched app without a pre-built index hits today (confirmed: this very repo, ai-pipeline, is
// itself unindexed and correctly resolves to undefined).
//
export interface ProjectNameCliClient {
  cli(tool: string, jsonArg: string, repoDir: string): Promise<{ code: number | null; stdout: string; stderr: string }>;
}

interface ListProjectsResponse {
  projects: { name: string; root_path: string }[];
}

function isListProjectsResponse(value: unknown): value is ListProjectsResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as ListProjectsResponse).projects)
  );
}

async function resolveUncached(client: ProjectNameCliClient, repoDir: string): Promise<string | undefined> {
  const res = await client.cli("list_projects", "{}", repoDir);
  if (res.code === null) return undefined;

  let payload: unknown;
  try {
    payload = JSON.parse(res.stdout);
  } catch {
    return undefined;
  }
  if (!isListProjectsResponse(payload)) return undefined;

  const match = payload.projects.find((p) => p.root_path === repoDir);
  return match?.name;
}

/** Free-function form: resolves once, no memoization. Callers that want memoization across
 *  repeated calls (the composition root's own long-lived-process concern) should use
 *  ProjectNameResolver below instead — kept as an INSTANCE, never module-level state, so tests stay
 *  isolated (this codebase's own "dependency injection is the testing strategy" invariant). */
export async function resolveProjectName(client: ProjectNameCliClient, repoDir: string): Promise<string | undefined> {
  return resolveUncached(client, repoDir);
}

/** Memoizes resolveProjectName per repoDir for the lifetime of THIS instance. The composition root
 *  is rebuilt PER RUN (not once per process), so this memoization amortizes repeated calls for the
 *  SAME repoDir WITHIN one run, not across runs — a fresh instance is constructed each run and
 *  starts with an empty cache. Mirrors CodebaseMemoryClient's own single-instance-per-composition
 *  construction pattern; no cross-run or cross-test/cross-process leakage. */
export class ProjectNameResolver {
  private readonly cache = new Map<string, string | undefined>();

  constructor(private readonly client: ProjectNameCliClient) {}

  async resolve(repoDir: string): Promise<string | undefined> {
    if (this.cache.has(repoDir)) return this.cache.get(repoDir);
    const resolved = await resolveUncached(this.client, repoDir);
    this.cache.set(repoDir, resolved);
    return resolved;
  }
}
