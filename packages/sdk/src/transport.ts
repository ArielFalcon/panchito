// The hand-written half of the SDK: a thin fetch wrapper that every TS client shares.
// It owns base URL, Bearer auth, JSON encode/decode and error normalization — the glue
// that would otherwise be re-implemented (and drift) in each client. `fetchImpl` is
// injectable so the transport is unit-testable without a network.

export class ApiError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface TransportOptions {
  // "" for a same-origin client (the dashboard served at /app); a full origin otherwise.
  baseUrl: string;
  token?: string;
  fetchImpl?: typeof fetch;
}

export interface Transport {
  request<T>(method: string, path: string, body?: unknown): Promise<T>;
  base: string;
  token?: string;
  fetchImpl: typeof fetch;
}

export function createTransport(opts: TransportOptions): Transport {
  const base = opts.baseUrl.replace(/\/+$/, "");
  const fetchImpl = opts.fetchImpl ?? fetch;
  const token = opts.token;

  async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const headers: Record<string, string> = {};
    if (token) headers["authorization"] = `Bearer ${token}`;
    if (body !== undefined) headers["content-type"] = "application/json";

    let res: Response;
    try {
      res = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new ApiError(`cannot reach the orchestrator at ${base || "(same origin)"} — is it running?`);
    }

    const text = await res.text();
    if (!res.ok) {
      if (res.status === 401) throw new ApiError("unauthorized — check the API token", 401);
      let message = `request failed (HTTP ${res.status})`;
      try {
        const j = JSON.parse(text) as { error?: string; message?: string };
        message = j.error ?? j.message ?? message;
      } catch {
        /* non-JSON error body — keep the generic message */
      }
      throw new ApiError(message, res.status);
    }
    return (text ? JSON.parse(text) : null) as T;
  }

  return { request, base, token, fetchImpl };
}
