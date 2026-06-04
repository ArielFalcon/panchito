// Servidor de webhook (opción 2: servicio hospedado). Recibe el aviso tras el
// merge a main + deploy a DEV y encola un run. El núcleo (verificación de
// firma, parseo del payload, decisión de status) es puro y verificable; el
// servidor HTTP solo lo envuelve.

import { createServer, Server } from "node:http";
import { createHmac, timingSafeEqual } from "node:crypto";

export interface WebhookPayload {
  repo: string;
  sha: string;
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

  // Forma simple { repo, sha }
  if (typeof b.repo === "string" && typeof b.sha === "string") {
    return { repo: b.repo, sha: b.sha };
  }

  // Evento push de GitHub: { repository: { full_name }, after }
  const repository = b.repository as { full_name?: unknown } | undefined;
  if (typeof repository?.full_name === "string" && typeof b.after === "string") {
    return { repo: repository.full_name, sha: b.after };
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
    return { status: 401, message: "firma inválida" };
  }
  let json: unknown;
  try {
    json = JSON.parse(rawBody);
  } catch {
    return { status: 400, message: "JSON inválido" };
  }
  const payload = parseWebhook(json);
  if (!payload) return { status: 422, message: "payload sin repo/sha reconocible" };
  return { status: 202, message: "encolado", payload };
}

const MAX_BODY_BYTES = 1_000_000; // 1 MB: cota contra payloads abusivos (DoS)

export function createWebhookServer(opts: {
  secret?: string;
  onRun: (p: WebhookPayload) => void;
}): Server {
  return createServer((req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ message: "método no permitido" }));
      return;
    }
    let body = "";
    let aborted = false;
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > MAX_BODY_BYTES) {
        aborted = true;
        res.writeHead(413, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message: "payload demasiado grande" }));
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
