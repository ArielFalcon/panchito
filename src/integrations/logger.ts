import { createWriteStream, existsSync, mkdirSync, statSync } from "node:fs";
import { join } from "node:path";

// Simple JSON-structured logger for production use.
// Replaces ad-hoc console.log with a single stream so logs can be shipped to
// Loki/CloudWatch/etc without being interleaved with stdout noise.

const LOG_DIR = join(process.env.AI_PIPELINE_ROOT ?? process.cwd(), "data", "logs");
const MAX_LOG_SIZE = 50 * 1024 * 1024; // 50 MB
const MAX_LOG_FILES = 5;

let stream: ReturnType<typeof createWriteStream> | null = null;
let logFile: string | null = null;

function ensureStream(): ReturnType<typeof createWriteStream> {
  if (stream && !stream.destroyed) return stream;
  mkdirSync(LOG_DIR, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  logFile = join(LOG_DIR, `app-${timestamp}.log`);
  stream = createWriteStream(logFile, { flags: "a" });
  stream.on("error", (err) => {
    console.error("[logger] write failed:", err.message);
  });
  pruneOldLogs();
  return stream;
}

function pruneOldLogs(): void {
  try {
    const { readdirSync, unlinkSync } = require("node:fs");
    const files = readdirSync(LOG_DIR)
      .filter((f: string) => f.startsWith("app-") && f.endsWith(".log"))
      .map((f: string) => ({ name: f, path: join(LOG_DIR, f), mtime: statSync(join(LOG_DIR, f)).mtime }))
      .sort((a: { mtime: Date }, b: { mtime: Date }) => b.mtime.getTime() - a.mtime.getTime());
    while (files.length > MAX_LOG_FILES) {
      const old = files.pop();
      if (old) unlinkSync(old.path);
    }
  } catch {
    // ignore pruning errors
  }
}

export function logJson(
  level: "info" | "warn" | "error",
  message: string,
  meta?: Record<string, unknown>,
  // mirrorToConsole=false writes ONLY to the shipped JSON file. Used by the per-run pipeline log
  // sink, which already prints a human-readable plain line to stdout — so the structured,
  // runId-tagged copy goes to the log stream without duplicating console output.
  mirrorToConsole = true,
): void {
  const entry = {
    t: new Date().toISOString(),
    l: level,
    m: message,
    ...meta,
  };
  const line = JSON.stringify(entry) + "\n";
  const s = ensureStream();
  s.write(line);
  if (mirrorToConsole) {
    const consoleFn = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
    consoleFn(line.trimEnd());
  }
}
