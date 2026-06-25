// qa-engine/src/shared-kernel/qa-case.ts
// One executed test case and the structured per-spec metadata the agent emits. Carried from
// src/types.ts (QaCase / CaseStatus / SpecMeta / SpecRecord). Optional runtime-evidence fields
// (failureDom, httpStatus, finalUrl) follow the absent-warned best-effort contract: absent ⇒ the run
// degrades to string-only behaviour, never a guessed value.

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
