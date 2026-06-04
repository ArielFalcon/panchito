// Renderizado del Issue de fallo. Los logs ya vienen sanitizados desde
// qa/execute; aquí solo se formatean para humanos.

import { QaRunResult } from "../types";

export function renderIssue(run: QaRunResult, note?: string): string {
  const failed = run.cases.filter((c) => c.status === "fail");
  const lines = [
    `**SHA:** \`${run.sha}\``,
    note ? `**Nota del revisor:** ${note}` : "",
    "",
    "### Casos fallidos",
    failed.length
      ? failed.map((c) => `- ❌ ${c.name}${c.detail ? ` — ${c.detail}` : ""}`).join("\n")
      : "_(sin detalle de casos)_",
    "",
    "### Logs (sanitizados)",
    "```",
    run.logs,
    "```",
  ];
  return lines.filter((l) => l !== "").join("\n");
}
