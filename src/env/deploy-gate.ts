// Deploy gate: nothing is tested until DEV is confirmed to run exactly the
// expected SHA and to be healthy (DEV takes a few minutes to stabilize after a
// deploy). fetch/sleep/now are injected so the gate is verifiable with stubs in
// unit tests, without real network or real waits.

export interface DeployTarget {
  name: string;
  versionUrl: string;
  pollIntervalMs: number;
  deployTimeoutMs: number;
}

export interface VersionInfo {
  sha?: string;
  healthy?: boolean;
}

export class DeployTimeoutError extends Error {
  constructor(
    public readonly app: string,
    public readonly sha: string,
  ) {
    super(`Deploy gate timeout: ${app} did not reach SHA ${sha} in time`);
    this.name = "DeployTimeoutError";
  }
}

export interface GateDeps {
  fetchVersion(url: string): Promise<VersionInfo | null>;
  sleep(ms: number): Promise<void>;
  now(): number;
}

const defaultDeps: GateDeps = {
  fetchVersion: async (url) => {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return null;
      return (await res.json()) as VersionInfo;
    } catch {
      return null;
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

// DEV's /version may report a SHORT SHA (the 7-char form from Vercel/`git
// rev-parse --short`/`$GITHUB_SHA`) while the trigger carries the full 40-char SHA
// (or vice versa). Match when equal, or when one is a >=7-char prefix of the other,
// case-insensitive. The 7-char floor avoids accidental weak matches on tiny prefixes.
export function shaMatches(a: string | undefined, b: string | undefined): boolean {
  const x = (a ?? "").toLowerCase();
  const y = (b ?? "").toLowerCase();
  if (!x || !y) return false;
  if (x === y) return true;
  if (x.length >= 7 && y.startsWith(x)) return true;
  if (y.length >= 7 && x.startsWith(y)) return true;
  return false;
}

// The optional signal stops the poll loop early: the pipeline aborts the gate when the
// run is cancelled or when classification decides the commit is a skip (the gate runs
// concurrently with local work, so by the time a skip is known it may still be polling).
export async function waitForDeploy(
  app: DeployTarget,
  sha: string,
  deps: GateDeps = defaultDeps,
  signal?: AbortSignal,
): Promise<void> {
  const deadline = deps.now() + app.deployTimeoutMs;
  while (deps.now() < deadline) {
    if (signal?.aborted) throw new Error(`deploy gate aborted for ${app.name}`);
    const v = await deps.fetchVersion(app.versionUrl);
    if (shaMatches(v?.sha, sha) && v?.healthy === true) return;
    await deps.sleep(app.pollIntervalMs);
  }
  throw new DeployTimeoutError(app.name, sha);
}
