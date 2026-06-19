// Serves the web dashboard (a static SPA build) same-origin at /app, so the dashboard shares
// the orchestrator's origin and the operator's credentials — no CORS. The API stays
// Bearer-protected; only the static shell is public. Until web/dist exists this no-ops to a
// placeholder, so wiring it into the server is safe before the dashboard ships.
import { IncomingMessage, ServerResponse } from "node:http";
import { existsSync, readFileSync, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

const PLACEHOLDER =
  '<!doctype html><meta charset="utf-8"><title>panchito · dashboard</title>' +
  '<body style="font-family:system-ui;background:#14100e;color:#f5f1ee;display:grid;place-items:center;height:100vh;margin:0">' +
  '<div style="text-align:center;max-width:32rem;padding:1rem">' +
  '<h1 style="font-weight:500">panchito · dashboard</h1>' +
  '<p style="color:#b9aea6">The web dashboard is not built yet. Build it into <code>web/dist</code> and it will be served here at <code>/app</code>.</p>' +
  "</div></body>";

export interface ServeDashboardOptions {
  distDir: string;
}

// The deployed build is immutable at runtime, so reads are cached: index.html once (lazy), and each
// resolved asset on first hit. Keyed by distDir so a different build dir gets its own cache.
interface DistCache {
  index: Buffer | null; // null until first read
  assets: Map<string, Buffer>; // resolved absolute path → bytes
}
const distCaches = new Map<string, DistCache>();

function cacheFor(distDir: string): DistCache {
  let c = distCaches.get(distDir);
  if (!c) {
    c = { index: null, assets: new Map() };
    distCaches.set(distDir, c);
  }
  return c;
}

// Returns true when it has written the response (always, for a /app request). The caller only
// routes GET /app and /app/* here.
export async function serveDashboard(
  req: IncomingMessage,
  res: ServerResponse,
  opts: ServeDashboardOptions,
): Promise<boolean> {
  const url = (req.url ?? "/app").split("?")[0] ?? "/app";
  const index = join(opts.distDir, "index.html");

  if (!existsSync(index)) {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(PLACEHOLDER);
    return true;
  }

  // Strip the /app prefix → the path within the build.
  let rel = url.replace(/^\/app/, "");
  if (rel === "" || rel === "/") rel = "/index.html";

  // Resolve and confine to distDir — never serve outside the build (path traversal).
  const root = normalize(opts.distDir);
  const resolved = normalize(join(opts.distDir, rel));
  if (resolved !== root && !resolved.startsWith(root + "/") && !resolved.startsWith(root + "\\")) {
    res.writeHead(403, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("forbidden");
    return true;
  }

  // SPA fallback: a client-side route (no real file) → index.html.
  const cache = cacheFor(opts.distDir);
  const file = existsSync(resolved) && statSync(resolved).isFile() ? resolved : index;

  let body: Buffer;
  if (file === index) {
    if (cache.index === null) cache.index = readFileSync(index);
    body = cache.index;
  } else {
    let cached = cache.assets.get(file);
    if (!cached) {
      cached = readFileSync(file);
      cache.assets.set(file, cached);
    }
    body = cached;
  }

  res.writeHead(200, { "Content-Type": MIME[extname(file)] ?? "application/octet-stream" });
  res.end(body);
  return true;
}
