// Renders the Issue body. Logs arrive already sanitized from qa/execute (or are
// the static-gate errors when the run is "invalid"); here we only format them
// for humans.

import { QaRunResult } from "../types";

export function renderIssue(run: QaRunResult, note?: string): string {
  const failed = run.cases.filter((c) => c.status === "fail");
  const flaky = run.cases.filter((c) => c.status === "flaky");
  const lines = [
    `**SHA:** \`${run.sha}\``,
    `**Verdict:** ${run.verdict}`,
    note ? `**Note:** ${note}` : "",
    "",
    "### Failed cases",
    failed.length
      ? failed.map((c) => `- ❌ ${c.name}${c.detail ? ` — ${c.detail}` : ""}`).join("\n")
      : "_(no case detail)_",
    flaky.length ? "\n### Flaky (quarantined)" : "",
    flaky.length ? flaky.map((c) => `- ⚠️ ${c.name}`).join("\n") : "",
    "",
    "### Logs (sanitized)",
    "```",
    run.logs,
    "```",
    "",
    "_Trace available in the run artifacts (trace on-first-retry)._",
  ];
  return lines.filter((l) => l !== "").join("\n");
}
