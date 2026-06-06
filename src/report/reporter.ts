// Renders the Issue body for a failing/invalid run. Everything embedded here is
// re-sanitized defensively (logs from execute are already sanitized, but the
// static-gate "invalid" errors and per-case details are NOT, and a secret the
// agent embedded in a spec could otherwise reach a public Issue). The body is
// structured to answer the three questions the requirement demands per failure:
// WHAT was tested, HOW it failed, and the PROPOSED fix.

import { QaRunResult, QaCase } from "../types";
import { sanitizeText } from "../orchestrator/sanitizer";

const s = (v: string | undefined): string => (v ? sanitizeText(v).text : "");

function renderFailedCase(c: QaCase): string {
  const parts = [`#### ❌ ${s(c.name)}`];
  if (c.objective || c.flow) {
    parts.push(`- **What was tested:** ${s(c.objective) || "—"}${c.flow ? ` _(flow: ${s(c.flow)})_` : ""}`);
  }
  if (c.detail) parts.push(`- **How it failed:** ${s(c.detail)}`);
  if (c.reason) parts.push(`- **Proposed fix:** ${s(c.reason)}`);
  return parts.join("\n");
}

export function renderIssue(run: QaRunResult, note?: string): string {
  const failed = run.cases.filter((c) => c.status === "fail");
  const flaky = run.cases.filter((c) => c.status === "flaky");
  const lines = [
    `**SHA:** \`${s(run.sha)}\``,
    `**Verdict:** ${run.verdict}`,
    note ? `**Note:** ${s(note)}` : "",
    "",
    "### Failed cases",
    failed.length ? failed.map(renderFailedCase).join("\n\n") : "_(no case detail — see logs below)_",
    flaky.length ? "\n### Flaky (quarantined)" : "",
    flaky.length ? flaky.map((c) => `- ⚠️ ${s(c.name)}`).join("\n") : "",
    "",
    "### Logs (sanitized)",
    "```",
    s(run.logs),
    "```",
    "",
    "_Trace available in the run artifacts (trace on-first-retry)._",
  ];
  return lines.filter((l) => l !== "").join("\n");
}
