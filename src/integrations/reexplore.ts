// RE-2 — objective re-exploration telemetry.
//
// The activity stream collapses every tool into a 4-value `kind` (activity-mapper.ts), so it cannot
// tell a `browser_navigate` from a file read. This module taps the RAW `part.tool` (before that
// collapse) to count the agent's re-exploration calls — browser navigation/snapshot and serena
// blast-radius — per generation cycle. It is OBSERVABILITY ONLY: a high count is an efficiency datum,
// never a quality defect, and must NOT be fed into the learning ledger.

import type { RawOpencodeEvent } from "./activity-mapper";

export type ReexploreKind = "navigate" | "snapshot" | "serena";

export interface ReexploreCounts {
  navigate: number;
  snapshot: number;
  serena: number;
  total: number;
}

// Serena's orientation / blast-radius tools (project activation + symbol navigation).
const SERENA_RE = /(activate_project|find_referencing_symbols|find_symbol|get_symbols_overview)/i;

// Classify a raw tool name as a re-exploration tool, or null. Matches even when an MCP namespaces the
// tool id (e.g. "mcp__playwright__browser_snapshot"). browser_click/type are INTERACTION, not
// re-exploration, so they return null.
export function reexploreToolKind(tool: string): ReexploreKind | null {
  if (/browser_navigate/i.test(tool)) return "navigate";
  if (/browser_snapshot/i.test(tool)) return "snapshot";
  if (SERENA_RE.test(tool)) return "serena";
  return null;
}

interface PartLike {
  type?: string;
  tool?: string;
  state?: { status?: string };
}

// Extract the re-exploration kind from a raw OpenCode event — only a COMPLETED tool part counts (a
// tool emits `running` then `completed`; counting `completed` only avoids double-counting one call).
export function reexploreKindFromEvent(event: RawOpencodeEvent): ReexploreKind | null {
  if (event.type !== "message.part.updated") return null;
  const part = event.properties?.part as PartLike | undefined;
  if (!part || part.type !== "tool" || !part.tool) return null;
  if (part.state?.status !== "completed") return null;
  return reexploreToolKind(part.tool);
}

// Per-session re-exploration counter. Keyed by sessionId so each generation cycle (one session) gets
// its own counts. The module singleton `reexploreTracker` is shared by the stream tap (which records)
// and runOpencode (which reads + logs + clears at the end of a turn).
export class ReexploreTracker {
  private counts = new Map<string, ReexploreCounts>();

  record(sessionId: string, kind: ReexploreKind): void {
    const c = this.counts.get(sessionId) ?? { navigate: 0, snapshot: 0, serena: 0, total: 0 };
    c[kind] += 1;
    c.total += 1;
    this.counts.set(sessionId, c);
  }

  snapshot(sessionId: string): ReexploreCounts {
    const c = this.counts.get(sessionId);
    return c ? { ...c } : { navigate: 0, snapshot: 0, serena: 0, total: 0 };
  }

  clear(sessionId: string): void {
    this.counts.delete(sessionId);
  }
}

export const reexploreTracker = new ReexploreTracker();
