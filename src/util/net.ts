// Global outbound-HTTP setup for Node's built-in fetch (undici), shared by every fetch in the
// process (the OpenCode SDK, the GitHub API in github.ts, health probes).
//
// Node's fetch does NOT honor HTTP_PROXY/HTTPS_PROXY/NO_PROXY on its own. EnvHttpProxyAgent
// reads those env vars and routes accordingly — and is a no-op (direct connections) when none
// are set, so it is safe with or without a proxy and makes the system proxy-ready for free.
// The timeout options keep our per-prompt withTimeout as the real deadline for long agent turns
// rather than a transport-level abort. Idempotent: the last setGlobalDispatcher call wins.

export async function installHttpDispatcher(timeoutMs: number): Promise<void> {
  const { setGlobalDispatcher, EnvHttpProxyAgent } = await import("undici");
  setGlobalDispatcher(
    new EnvHttpProxyAgent({
      headersTimeout: timeoutMs + 30_000,
      bodyTimeout: timeoutMs + 30_000,
    }),
  );
}
