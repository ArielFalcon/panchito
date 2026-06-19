import { IncomingMessage, ServerResponse } from "node:http";
import { Incident, IncidentSeverity, IncidentSource } from "../types";
import { json, readBody } from "./helpers";

const MAX_INCIDENTS = 30;
const incidents: Incident[] = [];

let maintainerStatus: "idle" | "diagnosing" | "fixing" = "idle";

function nextId(): string {
  return `inc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

function validSeverity(v: unknown): IncidentSeverity | null {
  const s = ["warn", "error", "critical"] as IncidentSeverity[];
  return typeof v === "string" && (s as string[]).includes(v) ? (v as IncidentSeverity) : null;
}

function validSource(v: unknown): IncidentSource | null {
  const s = ["health-check", "log-scraper", "qa-generator", "qa-reviewer", "cli", "process-audit"] as IncidentSource[];
  return typeof v === "string" && (s as string[]).includes(v) ? (v as IncidentSource) : null;
}

export function getMaintainerStatus(): string {
  return maintainerStatus;
}

export function setMaintainerStatus(s: typeof maintainerStatus): void {
  maintainerStatus = s;
}

export function getIncidents(): Incident[] {
  return [...incidents];
}

export function getIncident(id: string): Incident | undefined {
  return incidents.find((i) => i.id === id);
}

export function recordIncident(opts: {
  source: IncidentSource;
  severity: IncidentSeverity;
  summary: string;
  detail?: string;
}): Incident {
  const incident: Incident = {
    id: nextId(),
    source: opts.source,
    severity: opts.severity,
    summary: opts.summary,
    detail: opts.detail,
    status: "pending",
    at: new Date().toISOString(),
  };
  incidents.push(incident);
  if (incidents.length > MAX_INCIDENTS) incidents.shift();
  return incident;
}

export function updateIncident(id: string, patch: Partial<Pick<Incident, "status" | "prUrl">>): void {
  const i = incidents.find((x) => x.id === id);
  if (i) Object.assign(i, patch);
}

export async function handleMaintainerApi(
  req: IncomingMessage,
  res: ServerResponse,
  onTrigger?: () => Promise<void>,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const path = url.pathname;

  if (req.method === "POST" && path === "/api/maintainer/report") {
    return handleReport(req, res);
  }

  if (req.method === "GET" && path === "/api/maintainer/incidents") {
    return handleListIncidents(res, url.searchParams.get("status"));
  }

  const incMatch = path.match(/^\/api\/maintainer\/incidents\/([^/]+)$/);
  if (req.method === "GET" && incMatch) {
    return handleGetIncident(res, incMatch[1]!);
  }

  if (req.method === "POST" && path === "/api/maintainer/trigger") {
    return handleTrigger(res, onTrigger);
  }

  if (req.method === "GET" && path === "/api/maintainer/status") {
    json(res, 200, { status: maintainerStatus, pendingIncidents: incidents.filter((i) => i.status === "pending").length });
    return true;
  }

  return false;
}

async function handleReport(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(await readBody(req, 50_000));
  } catch {
    json(res, 400, { error: "invalid JSON or payload too large" });
    return true;
  }

  const source = validSource(body.source);
  if (!source) {
    json(res, 400, { error: "'source' must be one of: health-check, log-scraper, qa-generator, qa-reviewer, cli" });
    return true;
  }

  const severity = validSeverity(body.severity);
  if (!severity) {
    json(res, 400, { error: "'severity' must be one of: warn, error, critical" });
    return true;
  }

  if (typeof body.summary !== "string" || !body.summary.trim()) {
    json(res, 400, { error: "'summary' is required" });
    return true;
  }

  const incident = recordIncident({
    source,
    severity,
    summary: body.summary,
    detail: typeof body.detail === "string" ? body.detail : undefined,
  });

  json(res, 202, { id: incident.id, status: "recorded" });
  return true;
}

function handleListIncidents(res: ServerResponse, statusFilter?: string | null): boolean {
  let list = [...incidents];
  if (statusFilter) {
    list = list.filter((i) => i.status === statusFilter);
  }
  json(res, 200, list.reverse());
  return true;
}

function handleGetIncident(res: ServerResponse, id: string): boolean {
  const incident = getIncident(id);
  if (!incident) {
    json(res, 404, { error: `incident not found: ${id}` });
    return true;
  }
  json(res, 200, incident);
  return true;
}

function handleTrigger(res: ServerResponse, onTrigger?: () => Promise<void>): boolean {
  const pending = incidents.filter((i) => i.status === "pending");
  if (pending.length === 0) {
    json(res, 200, { message: "no pending incidents to diagnose" });
    return true;
  }
  if (maintainerStatus !== "idle") {
    json(res, 409, { message: `maintainer is already ${maintainerStatus}` });
    return true;
  }
  json(res, 202, { message: `triggered diagnosis for ${pending.length} pending incident(s)`, pending: pending.length });
  onTrigger?.();
  return true;
}
