// Webhook server (hosted-service option). Receives the notification after a
// merge to main + deploy to DEV and enqueues a run. The core (signature check,
// payload parsing, status decision) is pure and verifiable; the HTTP server only
// wraps it.

import { createServer, Server } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";
import { RunMode } from "../types";

export interface WebhookPayload {
  repo: string;
  sha: string;
  mode: RunMode; // defaults to "diff" when absent
  guidance?: string; // for "manual" mode
}

const MODES: RunMode[] = ["diff", "complete", "exhaustive", "manual"];
function asMode(v: unknown): RunMode {
  return typeof v === "string" && (MODES as string[]).includes(v) ? (v as RunMode) : "diff";
}

export function verifySignature(secret: string, body: string, signature?: string): boolean {
  if (!signature) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function parseWebhook(body: unknown): WebhookPayload | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const guidance = typeof b.guidance === "string" ? b.guidance : undefined;

  // Simple shape { repo, sha, mode?, guidance? }
  if (typeof b.repo === "string" && typeof b.sha === "string") {
    return { repo: b.repo, sha: b.sha, mode: asMode(b.mode), guidance };
  }

  // GitHub push event: { repository: { full_name }, after } → always "diff"
  const repository = b.repository as { full_name?: unknown } | undefined;
  if (typeof repository?.full_name === "string" && typeof b.after === "string") {
    return { repo: repository.full_name, sha: b.after, mode: "diff" };
  }

  return null;
}

export interface WebhookResult {
  status: number;
  message: string;
  payload?: WebhookPayload;
}

export function handleWebhook(
  rawBody: string,
  signature: string | undefined,
  opts: { secret?: string },
): WebhookResult {
  if (opts.secret && !verifySignature(opts.secret, rawBody, signature)) {
    return { status: 401, message: "invalid signature" };
  }
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { status: 400, message: "invalid JSON" };
  }
  const payload = parseWebhook(json);
  if (!payload) return { status: 422, message: "payload without a recognizable repo/sha" };
  return { status: 202, message: "enqueued", payload };
}

const MAX_BODY_BYTES = 1_000_000; // 1 MB: bound against abusive payloads (DoS)

export function createWebhookServer(opts: {
  secret?: string;
  onRun: (p: WebhookPayload) => void;
}): Server {
  return createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "method not allowed" }));
      return;
    }
    let body = "";
    let aborted = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        aborted = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "payload too large" }));
        req.destroy();
      }
    });
    req.on("end", () => {
      if (aborted) return;
      const header = req.headers["x-hub-signature-256"];
      const sig = typeof header === "string" ? header : undefined;
      const result = handleWebhook(body, sig, { secret: opts.secret });
      if (result.payload) opts.onRun(result.payload);
      res.writeHead(result.status, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: result.message }));
    });
  });
}
