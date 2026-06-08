// Assembles the BOUNDED, SANITIZED run-context blob fed to the read-only qa-assistant
// (the interactive layer's `ask`). Read-only and sanitization are infra-enforced here,
// not trusted to the agent: the context is capped (recent cases + truncated logs) and
// passes through src/orchestrator/sanitizer.ts on the way IN. The answer is sanitized
// again on the way OUT (in the API handler) — logs→chat is a new egress.

import { RunRecord } from "../types";
import { sanitizeText } from "../orchestrator/sanitizer";

export interface ContextLimits {
  maxCases: number;
  caseDetailChars: number;
  logTailChars: number;
}

const DEFAULT_LIMITS: ContextLimits = { maxCases: 20, caseDetailChars: 300, logTailChars: 4000 };

export function buildRunContext(
  record: RunRecord,
  limits: ContextLimits = DEFAULT_LIMITS,
  appInfo?: { repo: string; baseUrl?: string },
  activityContext?: string,
): string {
  const lines: string[] = [];

  // Pipeline phase reference so the assistant can interpret the step field.
  // Descriptions are target-aware: code mode has no browser, no DEV, no Playwright.
  const isCode = record.target === "code";
  lines.push(
    isCode
      ? [
          "Pipeline phases for CODE target (source-code tests — no browser, no DEV environment, no Playwright):",
          "classify (reads commit diff + message, decides to skip/generate/regress),",
          "generate (AI agent analyzes source code and writes/updates unit or integration tests),",
          "validate (typecheck + lint + test discovery + metadata check),",
          "execute (runs source-code tests locally via the project's test runner),",
          "retry (tests failed — agent is re-generating with failure feedback).",
        ].join("\n")
      : [
          "Pipeline phases for E2E target (browser tests against the live DEV environment):",
          "classify (reads commit diff + message, decides to skip/generate/regress),",
          "generate (AI agent analyzes code, explores DEV with Playwright MCP, writes E2E specs),",
          "validate (typecheck + lint + test discovery + metadata check),",
          "execute (runs Playwright tests against the live DEV environment),",
          "retry (tests failed — agent is re-generating with failure feedback).",
        ].join("\n"),
    "",
    "IMPORTANT: Trust the actual run data (logs, cases, step, verdict, target, mode) over these generic",
    "phase descriptions. If logs show unit tests but the description mentions Playwright, the logs are",
    "correct — the description is wrong for this run. Targets: e2e = browser + DEV; code = source only.",
    "",
  );

  lines.push(`App: ${record.app}   Commit: ${record.sha.slice(0, 12)}   Target: ${record.target ?? "e2e"}   Mode: ${record.mode}`);
  if (appInfo) {
    lines.push(`Repository: ${appInfo.repo}${appInfo.baseUrl ? `   DEV URL: ${appInfo.baseUrl}` : ""}`);
  }
  lines.push(
    `Status: ${record.status}   Step: ${record.step ?? "enqueued"}   Verdict: ${record.verdict ?? "running"}   Passed: ${record.passed ?? 0}   Failed: ${record.failed ?? 0}`,
  );
  if (record.stepDetail) lines.push(`Step detail: ${record.stepDetail}`);
  if (record.retrying) lines.push("Currently RETRYING after a test failure — re-generating with failure feedback.");
  if (record.note) lines.push(`Note: ${record.note}`);
  if (activityContext) lines.push("", `Agent activity: ${activityContext}`);

  const cases = record.cases.slice(0, limits.maxCases);
  if (cases.length > 0) {
    lines.push("", "Cases:");
    for (const c of cases) {
      const detail = c.detail ? `: ${c.detail.slice(0, limits.caseDetailChars)}` : "";
      lines.push(`  [${c.status}] ${c.name}${detail}`);
    }
    if (record.cases.length > cases.length) lines.push(`  … and ${record.cases.length - cases.length} more`);
  }

  const logLines: string[] = [];
  let logChars = 0;
  for (let i = record.logs.length - 1; i >= 0; i--) {
    const line = record.logs[i]!;
    if (logChars + line.length > limits.logTailChars) break;
    logLines.unshift(line);
    logChars += line.length + 1;
  }

  if (logLines.length > 0) {
    lines.push("", "Logs (tail):", ...logLines);
  }

  // Sanitize the whole blob on ingress (run data can carry DEV secrets/PII).
  return sanitizeText(lines.join("\n")).text;
}
