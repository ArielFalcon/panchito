// Assembles the BOUNDED, SANITIZED run-context blob fed to the read-only qa-assistant
// (the interactive layer's `ask`). Read-only and sanitization are infra-enforced here,
// not trusted to the agent: the context is capped (recent cases + truncated logs) and
// passes through src/orchestrator/sanitizer.ts on the way IN. The answer is sanitized
// again on the way OUT (in the API handler) — logs→chat is a new egress.

import { RunRecord } from "../types";
import { sanitizeText } from "../orchestrator/sanitizer";
import { listRunOutcomes, listLearningRules, loadCurriculum } from "./history";

export function buildLearningContext(app: string): string | null {
  try {
    const outcomes = listRunOutcomes(app, 10);
    const rules = listLearningRules(app, 20);
    const curriculum = loadCurriculum(app);

    if (outcomes.length === 0 && rules.length === 0 && !curriculum) return null;

    const lines: string[] = ["## Learning state for this app", ""];

    if (outcomes.length > 0) {
      lines.push(`### Recent outcomes (${outcomes.length}):`);
      for (const o of outcomes.slice(0, 5)) {
        const vs = o.gateSignals.valueScore !== null ? ` valueScore=${(o.gateSignals.valueScore * 100).toFixed(0)}%` : "";
        const ec = o.errorClass ? ` ${o.errorClass}` : "";
        lines.push(`- ${o.verdict}${ec}${vs} (${o.mode}/${o.target}, ${o.sha.slice(0, 7)})`);
      }
      lines.push("");
    }

    if (rules.length > 0) {
      const active = rules.filter((r) => r.status === "active" || r.status === "candidate");
      lines.push(`### Learned rules (${active.length} active/candidate):`);
      for (const r of active.slice(0, 5)) {
        const sr = r.successRate !== null ? ` successRate=${(r.successRate * 100).toFixed(0)}%` : "";
        lines.push(`- [${r.status}] ${r.errorClass} (${r.confidence}${sr}, used ${r.usageCount}x)`);
        lines.push(`  trigger: ${r.trigger.slice(0, 120)}`);
        lines.push(`  action: ${r.action.slice(0, 120)}`);
      }
      lines.push("");
    }

    if (curriculum) {
      const proven = curriculum.archetypes.filter((a) => a.caughtRealBug);
      if (proven.length > 0) {
        lines.push(`### Proven scenario archetypes (${proven.length}):`);
        lines.push(proven.map((a) => `- ${a.archetype} (promoted ${a.promotionCount}x)`).join("\n"));
        lines.push("");
      }
    }

    // Cap to avoid blowing the context budget
    const text = lines.join("\n");
    return text.length > 3000 ? text.slice(0, 3000) + "\n…(truncated)" : text;
  } catch {
    return null;
  }
}

export interface ContextLimits {
  maxCases: number;
  caseDetailChars: number;
  logTailChars: number;
}

const DEFAULT_LIMITS: ContextLimits = { maxCases: 20, caseDetailChars: 300, logTailChars: 8000 };

export function buildRunContext(
  record: RunRecord,
  limits: ContextLimits = DEFAULT_LIMITS,
  appInfo?: { repo: string; baseUrl?: string },
  activityContext?: string,
  learningContext?: string,
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

  if (learningContext) {
    lines.push("", learningContext);
  }

  // Sanitize the whole blob on ingress (run data can carry DEV secrets/PII).
  return sanitizeText(lines.join("\n")).text;
}
