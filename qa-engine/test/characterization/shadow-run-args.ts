// test/characterization/shadow-run-args.ts
// Pure --app/--sha arg parsing for shadow-run.operator.ts. Mirrors the flat --key value scan in
// src/cli.ts parseArgs, scoped to the two flags this operator script needs. Unknown flags are
// ignored (the operator script has no other options today); a missing --app/--sha throws so the
// operator gets an immediate, specific error instead of an undefined propagating into the run.
export interface ShadowRunArgs {
  app: string;
  sha: string;
}

export function parseShadowRunArgs(argv: readonly string[]): ShadowRunArgs {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const key = argv[i]?.replace(/^--/, "");
    if (key && argv[i + 1] !== undefined) {
      out[key] = argv[i + 1]!;
      i++;
    }
  }
  if (!out.app) throw new Error("shadow-run.operator.ts: missing required --app <name>");
  if (!out.sha) throw new Error("shadow-run.operator.ts: missing required --sha <sha>");
  return { app: out.app, sha: out.sha };
}
