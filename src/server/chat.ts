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

export function buildRunContext(record: RunRecord, limits: ContextLimits = DEFAULT_LIMITS): string {
  const lines: string[] = [];
  lines.push(`App: ${record.app}   Commit: ${record.sha.slice(0, 12)}   Mode: ${record.mode}`);
  lines.push(
    `Status: ${record.status}   Verdict: ${record.verdict ?? "running"}   Passed: ${record.passed ?? 0}   Failed: ${record.failed ?? 0}`,
  );
  if (record.note) lines.push(`Note: ${record.note}`);

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
