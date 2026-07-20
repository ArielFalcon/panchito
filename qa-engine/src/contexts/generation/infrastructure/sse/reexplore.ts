// qa-engine/src/contexts/generation/infrastructure/sse/reexplore.ts
// RE-2 — objective re-exploration telemetry.
//
// The activity stream collapses every tool into a 4-value `kind` (activity-mapper.ts), so it cannot
// tell a `browser_navigate` from a file read. This module taps the RAW `part.tool` (before that
// collapse) to count the agent's re-exploration calls — browser navigation/snapshot and serena
// blast-radius — per generation cycle. It is OBSERVABILITY ONLY: a high count is an efficiency datum,
// never a quality defect, and must NOT be fed into the learning ledger.
//
// migration-tier-4c Slice 3 (D-4c-2, SSE two-tier split): moved WHOLE from
// src/integrations/reexplore.ts ("live half" — the whole file was already 100% live, no dead half
// found) — zero @opencode-ai/sdk import, a rider alongside the EventStreamManager/
// startScopedEventStream lifecycle migration (event-stream.ts, this directory).

import type { RawOpencodeEvent } from "./activity-mapper.ts";

export type ReexploreKind = "navigate" | "snapshot" | "serena";

export interface ReexploreCounts {
  navigate: number;
  snapshot: number;
  serena: number;
  total: number;
}

// Serena's orientation / blast-radius surface — symbol navigation AND the read/search tools, since
// regen-discipline forbids "re-skim the repository / re-read unchanged code", not just symbol lookups.
const SERENA_RE =
  /(activate_project|find_referencing_symbols|find_symbol|get_symbols_overview|read_file|search_for_pattern|find_file|list_dir)/i;

// Classify a raw tool name as a re-exploration tool, or null. Matches even when an MCP namespaces the
// tool id (e.g. "mcp__playwright__browser_snapshot"). browser_click/type are INTERACTION, not
// re-exploration, so they return null.
export function reexploreToolKind(tool: string): ReexploreKind | null {
  // `(?!_)` excludes browser_navigate_back / _forward (history INTERACTION, not orientation) while
  // still matching `browser_navigate` and MCP-prefixed `…__browser_navigate`.
  if (/browser_navigate(?!_)/i.test(tool)) return "navigate";
  if (/browser_snapshot/i.test(tool)) return "snapshot";
  if (SERENA_RE.test(tool)) return "serena";
  return null;
}

interface PartLike {
  type?: string;
  tool?: string;
  state?: { status?: string };
}

// Extract the re-exploration kind from a raw OpenCode event — only a TERMINAL tool part counts
// (`completed` OR `error`: a failed navigation still happened and still burned time). `running` and
// `pending` are skipped; the tracker dedups by callID so a re-streamed terminal update counts once.
export function reexploreKindFromEvent(event: RawOpencodeEvent): ReexploreKind | null {
  if (event.type !== "message.part.updated") return null;
  const part = event.properties?.part as PartLike | undefined;
  if (!part || part.type !== "tool" || !part.tool) return null;
  const status = part.state?.status;
  if (status !== "completed" && status !== "error") return null;
  return reexploreToolKind(part.tool);
}

// Per-session re-exploration counter. Keyed by sessionId so each generation cycle (one session) gets
// its own counts. The module singleton `reexploreTracker` is shared by the stream tap (which records)
// and runOpencode (which reads + logs + clears at the end of a turn).
export class ReexploreTracker {
  private counts = new Map<string, ReexploreCounts>();
  private seen = new Map<string, Set<string>>(); // sessionId → callIDs already counted (dedup)

  // `callId` (the tool part's callID) dedups re-streamed terminal updates for ONE tool call: a part
  // emits many `message.part.updated` events, so without this the same navigate/serena counts N times.
  // Calls without a callId fall back to counting every record (no dedup key available).
  record(sessionId: string, kind: ReexploreKind, callId?: string): void {
    if (callId) {
      const seenForSession = this.seen.get(sessionId) ?? new Set<string>();
      if (seenForSession.has(callId)) return;
      seenForSession.add(callId);
      this.seen.set(sessionId, seenForSession);
    }
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
    this.seen.delete(sessionId);
  }
}

export const reexploreTracker = new ReexploreTracker();
