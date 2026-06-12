// The version/capability handshake (Phase D). The connect screen calls this
// BEFORE auth so a stale Homebrew binary can be told to update even with a wrong
// token. The server is the single authority on compatibility — it owns the policy
// (oldest supported client) and what it can do (capabilities a forward-compatible
// client can feature-detect against). See docs/tui-vnext.md §3.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { VersionInfo } from "../contract/commands";

// The wire-API major the client speaks (the /api/v1 prefix). Distinct from the
// OpenAPI document version in contract/openapi.ts.
export const WIRE_API_VERSION = "v1";

// The oldest client this server still accepts. Bump deliberately when a breaking
// contract change ships, so older binaries get a clear "update panchito".
export const MIN_CLIENT_VERSION = "0.1.0";

// What the control plane can do — a forward-compatible client feature-detects
// against this instead of hard-coding the server's age.
export const CAPABILITIES = [
  "runs", "run-events-sse", "ask", "continue", "cancel",
  "queue", "apps", "repos", "agent-runtime", "history",
] as const;

export const SERVER_VERSION = readServerVersion();

function readServerVersion(): string {
  try {
    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function handshake(clientVersion?: string): VersionInfo {
  const compatible = clientVersion ? versionGte(clientVersion, MIN_CLIENT_VERSION) : true;
  return {
    serverVersion: SERVER_VERSION,
    apiVersion: WIRE_API_VERSION,
    minClientVersion: MIN_CLIENT_VERSION,
    compatible,
    capabilities: [...CAPABILITIES],
    ...(compatible ? {} : { message: `Update panchito: this server requires client >= ${MIN_CLIENT_VERSION} (you have ${clientVersion}).` }),
  };
}

// Minimal numeric semver >= (major.minor.patch); pre-release tags are ignored.
// Avoids a dependency for the project's pin-everything/minimalist ethos.
export function versionGte(a: string, b: string): boolean {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    const x = pa[i] ?? 0;
    const y = pb[i] ?? 0;
    if (x > y) return true;
    if (x < y) return false;
  }
  return true;
}

function parseVersion(v: string): number[] {
  const core = v.replace(/^v/, "").split("-")[0] ?? "";
  return core.split(".").map((n) => Number.parseInt(n, 10) || 0);
}
