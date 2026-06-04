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
      const res = await fetch(url);
      if (!res.ok) return null;
      return (await res.json()) as VersionInfo;
    } catch {
      return null;
    }
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  now: () => Date.now(),
};

export async function waitForDeploy(
  app: DeployTarget,
  sha: string,
  deps: GateDeps = defaultDeps,
): Promise<void> {
  const deadline = deps.now() + app.deployTimeoutMs;
  while (deps.now() < deadline) {
    const v = await deps.fetchVersion(app.versionUrl);
    if (v?.sha === sha && v.healthy === true) return;
    await deps.sleep(app.pollIntervalMs);
  }
  throw new DeployTimeoutError(app.name, sha);
}
