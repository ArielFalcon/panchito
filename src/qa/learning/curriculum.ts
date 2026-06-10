import type { ErrorClass } from "./taxonomy";

export type ScenarioArchetype =
  | "happy-path"
  | "empty-state"
  | "boundary-value"
  | "invalid-input"
  | "re-query-after-mutation"
  | "concurrent-update"
  | "permission-denied"
  | "network-error"
  | "loading-state"
  | "stale-data";

export const ALL_ARCHETYPES: ScenarioArchetype[] = [
  "happy-path", "empty-state", "boundary-value", "invalid-input",
  "re-query-after-mutation", "concurrent-update", "permission-denied",
  "network-error", "loading-state", "stale-data",
];

export interface ArchetypeEntry {
  archetype: ScenarioArchetype;
  caughtRealBug: boolean;
  firstCaughtAt: string | null;
  promotionCount: number;
  lastPromoted: string | null;
}

export interface Curriculum {
  app: string;
  updatedAt: string;
  archetypes: ArchetypeEntry[];
}

export function initCurriculum(app: string): Curriculum {
  return {
    app,
    updatedAt: new Date().toISOString(),
    archetypes: ALL_ARCHETYPES.map((a) => ({
      archetype: a,
      caughtRealBug: false,
      firstCaughtAt: null,
      promotionCount: 0,
      lastPromoted: null,
    })),
  };
}

export function recordArchetypeHit(
  curriculum: Curriculum,
  archetype: ScenarioArchetype,
): Curriculum {
  const idx = curriculum.archetypes.findIndex((a) => a.archetype === archetype);
  if (idx === -1) return curriculum;

  const entry = { ...curriculum.archetypes[idx]! };
  if (!entry.caughtRealBug) {
    entry.caughtRealBug = true;
    entry.firstCaughtAt = new Date().toISOString();
  }
  entry.promotionCount++;
  entry.lastPromoted = new Date().toISOString();

  const archetypes = [...curriculum.archetypes];
  archetypes[idx] = entry;

  return { ...curriculum, archetypes, updatedAt: new Date().toISOString() };
}

export function selectActiveArchetypes(curriculum: Curriculum): ScenarioArchetype[] {
  return curriculum.archetypes
    .filter((a) => a.caughtRealBug)
    .sort((a, b) => b.promotionCount - a.promotionCount)
    .map((a) => a.archetype);
}

const activeCache = new Map<string, ScenarioArchetype[]>();

export function selectActiveArchetypesCached(curriculum: Curriculum): ScenarioArchetype[] {
  const key = `${curriculum.app}:${curriculum.updatedAt}`;
  const cached = activeCache.get(key);
  if (cached) return cached;
  const active = selectActiveArchetypes(curriculum);
  activeCache.set(key, active);
  return active;
}

export function clearActiveArchetypesCache(app: string): void {
  for (const k of [...activeCache.keys()]) {
    if (k === app || k.startsWith(`${app}:`)) activeCache.delete(k);
  }
}

export function renderArchetypesForPrompt(archetypes: ScenarioArchetype[]): string {
  if (archetypes.length === 0) return "";

  const descriptions: Record<ScenarioArchetype, string> = {
    "happy-path": "the primary success flow — the main thing the user wants to do",
    "empty-state": "what happens when there is no data (empty list, first visit)",
    "boundary-value": "edge values (zero, max, min, overflow, empty string)",
    "invalid-input": "bad data submitted (wrong format, missing required fields, too long)",
    "re-query-after-mutation": "after a write, re-read to verify the change persisted",
    "concurrent-update": "two actors changing the same thing at the same time",
    "permission-denied": "what happens when an unauthorized user tries the action",
    "network-error": "what the UI shows when the backend is unreachable",
    "loading-state": "what the user sees while data is being fetched",
    "stale-data": "cached data that becomes outdated after an independent write path changes it",
  };

  const lines = [
    "## Scenario archetypes proven to matter for this app",
    "These scenario types caught real bugs in the past. Generate tests for them when they apply to the current change.",
    "",
  ];

  for (const a of archetypes) {
    lines.push(`- **${a}**: ${descriptions[a]}`);
  }

  return lines.join("\n") + "\n";
}
