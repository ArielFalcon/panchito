// qa-engine/src/shared-kernel/qa-case.ts
// One executed test case and the structured per-spec metadata the agent emits. Carried from
// src/types.ts (QaCase / CaseStatus / SpecMeta / SpecRecord). Optional runtime-evidence fields
// (failureDom, httpStatus, finalUrl, runtimeErrors) follow the absent-warned best-effort contract:
// absent ⇒ the run degrades to string-only behavior, never a guessed value.

export type CaseStatus = "pass" | "fail" | "flaky";

export interface QaCase {
  name: string;
  status: CaseStatus;
  detail?: string;
  flow?: string;
  objective?: string;
  reason?: string;
  durationMs?: number;
  failureDom?: string;
  file?: string;
  httpStatus?: number;
  finalUrl?: string;
  // G1 (addendum §2): feature B — app-defect detection via browser console/page-error capture.
  // Mirrors src/types.ts QaCase.runtimeErrors EXACTLY. Deduped, capped (~15) browser-console
  // `error`-level entries and uncaught `pageerror` exceptions observed during the failing test, each
  // with `text` truncated (~200 chars). Optional and best-effort, same absent-warned contract as
  // httpStatus/finalUrl: absent when capture missed (env unset, page closed on a nav-crash, or
  // nothing was emitted). Feeds classifyRuntimeErrors (failure-adjudicator.ts) as a diagnostic
  // signal ONLY — it steers the adjudicator/report toward "probable app-side defect" but never
  // blocks, auto-passes, or masks a real generated-test defect. Additive/behavior-neutral widen:
  // closes the false-green gap where a Rule 2.6 (runtime-error -> app_defect) characterization
  // scenario could not reproduce through the port.
  runtimeErrors?: { type: string; text: string }[];
}

export interface SpecMeta {
  file: string;
  flow: string;
  objective: string;
  targets: string[];
  sha256?: string;
}

export interface SpecRecord {
  name: string;
  objective?: string;
  flow?: string;
}
