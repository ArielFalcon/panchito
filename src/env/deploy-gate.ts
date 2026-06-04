// Gate de deploy: no se prueba nada hasta confirmar que DEV corre exactamente
// el SHA esperado y está healthy. Resuelve el "DEV tarda unos minutos en
// estabilizar". fetch/sleep/now se inyectan para poder verificar el gate con
// stubs en tests unitarios (sin red real ni esperas reales).

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
    super(`Deploy gate timeout: ${app} no alcanzó el SHA ${sha} a tiempo`);
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
