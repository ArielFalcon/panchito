// Webhook core. Receives the notification after a merge to main + deploy to DEV and
// decides whether to enqueue a run. Pure and verifiable: signature check, payload
// parsing, status decision. The HTTP wrapper lives in src/index.ts (which multiplexes
// the webhook with the control API on one port).

import { createHmac, timingSafeEqual } from "node:crypto";
import { RUN_MODES, RunMode } from "../types";

export interface WebhookPayload {
  repo: string;
  sha: string;
  mode: RunMode; // defaults to "diff" when absent
  guidance?: string; // for "manual" mode
}

function asMode(v: unknown): RunMode {
  return typeof v === "string" && (RUN_MODES as readonly string[]).includes(v) ? (v as RunMode) : "diff";
}

export function verifySignature(secret: string, body: string, signature?: string): boolean {
  if (!signature) return false;
  const expected = "sha256=" + createHmac("sha256", secret).update(body).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

const HEX_SHA = /^[0-9a-f]{7,40}$/i;

export function parseWebhook(body: unknown): WebhookPayload | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const guidance = typeof b.guidance === "string" ? b.guidance.slice(0, 2000) : undefined;

  // Simple shape { repo, sha, mode?, guidance? } — sha must be a hex commit id.
  if (typeof b.repo === "string" && typeof b.sha === "string" && HEX_SHA.test(b.sha)) {
    return { repo: b.repo, sha: b.sha, mode: asMode(b.mode), guidance };
  }

  // GitHub push event: { repository: { full_name }, after } → always "diff"
  const repository = b.repository as { full_name?: unknown } | undefined;
  if (typeof repository?.full_name === "string" && typeof b.after === "string" && HEX_SHA.test(b.after)) {
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
