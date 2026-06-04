// Contracts shared across the system. A trigger (webhook, manual) builds the run
// context and the orchestration lives in pipeline.ts.

export type TriggerSource = "webhook" | "manual";

// Outcome of an OpenCode agent run. The agent writes the E2E tests directly into
// the working copy's `e2e/` folder (git is the source of truth, not this object);
// only the reviewer subagent's verdict (resolved inside OpenCode) and the final
// text travel here.
export interface AgentResult {
  output: string; // the agent's final text, including its closing verdict
  specs: string[]; // names of the specs it reported writing/updating
  reviewed: boolean; // whether review was enabled
  approved: boolean; // reviewer verdict (true when not reviewed)
  note?: string; // reason when not approved (e.g. did not converge)
}

// Outcome of RUNNING the E2E tests against DEV.
//   pass        → everything green and stable
//   fail        → at least one case fails consistently (real Issue)
//   flaky       → unstable cases (pass sometimes, fail others) → quarantine
//   invalid     → generated specs did not pass the static gate (do not compile,
//                 lint, or load): they were never executed
//   infra-error → the run is inconclusive due to infrastructure (DEV down, etc.):
//                 NOT reported as a code bug
//   skipped     → the commit carries no tests (style/docs/chore without logic):
//                 nothing is run
export type RunVerdict = "pass" | "fail" | "flaky" | "invalid" | "infra-error" | "skipped";
export type CaseStatus = "pass" | "fail" | "flaky";

export interface QaCase {
  name: string;
  status: CaseStatus;
  detail?: string;
}

export interface QaRunResult {
  sha: string;
  verdict: RunVerdict;
  passed: boolean; // shorthand for verdict === "pass"
  cases: QaCase[];
  logs: string; // sanitized before any reuse by the LLM
}
