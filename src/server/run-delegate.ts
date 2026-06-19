// Delegate a manual run to an already-running orchestrator instead of starting a second
// in-process queue. This keeps the "one run at a time against DEV" invariant (the server owns
// the only queue) AND makes the run execute IN the server process, so the TUI attached to that
// server streams it live natively — the root cause the freeze fix addresses end-to-end.
//
// The HTTP collaborators are injected (fetch) so this is unit-testable without a real server.

import type { RunMode, TestTarget } from "../types";

export interface DelegateRunInput {
  app: string;
  sha: string;
  target: TestTarget;
  mode: RunMode;
  guidance?: string;
}

export interface DelegateRunDeps {
  fetch: typeof fetch;
  baseUrl: string; // e.g. http://localhost:8080
  token?: string;
  pollMs?: number; // cadence of the run-status poll (default 1500)
  timeoutMs?: number; // give up WAITING after this long — the run keeps going server-side (default 30 min)
  now?: () => number;
  onUpdate?: (rec: { status: string; step?: string }) => void;
}

export interface DelegateRunResult {
  id: string;
  status: string;
  verdict: string | null;
  passed: number;
  failed: number;
  note?: string;
  timedOut: boolean; // true when we stopped waiting before the run finished
}

export async function delegateRun(input: DelegateRunInput, deps: DelegateRunDeps): Promise<DelegateRunResult> {
  const pollMs = deps.pollMs ?? 1500;
  const timeoutMs = deps.timeoutMs ?? 30 * 60_000;
  const now = deps.now ?? Date.now;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (deps.token) headers.Authorization = `Bearer ${deps.token}`;

  const createRes = await deps.fetch(`${deps.baseUrl}/api/v1/runs`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      app: input.app,
      sha: input.sha,
      target: input.target,
      mode: input.mode,
      ...(input.guidance ? { guidance: input.guidance } : {}),
    }),
  });
  const createBody = (await createRes.json().catch(() => ({}))) as Record<string, unknown>;
  if (!createRes.ok) {
    const msg = typeof createBody.error === "string" ? createBody.error : `HTTP ${createRes.status}`;
    throw new Error(`the service rejected the run: ${msg}`);
  }
  const id = typeof createBody.id === "string" ? createBody.id : "";
  if (!id) throw new Error("the service accepted the run but returned no run id");

  const start = now();
  let last: DelegateRunResult = { id, status: "enqueued", verdict: null, passed: 0, failed: 0, timedOut: false };
  for (;;) {
    // A transient network error (a brief server reload, a Docker network blip) must NOT abort the
    // wait — the run keeps running server-side. Tolerate it and keep polling until timeoutMs; only
    // an explicit terminal record or a permanent auth failure ends the loop.
    let res: Response;
    try {
      res = await deps.fetch(`${deps.baseUrl}/api/v1/runs/${encodeURIComponent(id)}`, { headers });
    } catch {
      deps.onUpdate?.({ status: "reconnecting" });
      if (now() - start > timeoutMs) return { ...last, timedOut: true };
      await new Promise((r) => setTimeout(r, pollMs));
      continue;
    }
    // A permanent auth failure must not spin forever (surface it loudly — CLAUDE.md invariant).
    if (res.status === 401 || res.status === 403) {
      throw new Error("the service rejected the token (401/403) — set QA_API_TOKEN or config/.api_token");
    }
    if (res.ok) {
      const rec = (await res.json().catch(() => null)) as Record<string, unknown> | null;
      if (rec) {
        last = {
          id,
          status: typeof rec.status === "string" ? rec.status : "running",
          verdict: typeof rec.verdict === "string" ? rec.verdict : null,
          passed: typeof rec.passed === "number" ? rec.passed : 0,
          failed: typeof rec.failed === "number" ? rec.failed : 0,
          note: typeof rec.note === "string" ? rec.note : undefined,
          timedOut: false,
        };
        deps.onUpdate?.({ status: last.status, step: typeof rec.step === "string" ? rec.step : undefined });
        if (last.status === "done") return last;
      }
    }
    if (now() - start > timeoutMs) return { ...last, timedOut: true };
    await new Promise((r) => setTimeout(r, pollMs));
  }
}
