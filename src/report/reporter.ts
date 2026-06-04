// Renderizado del Issue. Los logs ya vienen sanitizados desde qa/execute (o son
// los errores del gate estático cuando el run es "invalid"); aquí solo se
// formatean para humanos.

import { QaRunResult } from "../types";

export function renderIssue(run: QaRunResult, note?: string): string {
  const failed = run.cases.filter((c) => c.status === "fail");
  const flaky = run.cases.filter((c) => c.status === "flaky");
  const lines = [
    `**SHA:** \`${run.sha}\``,
    `**Veredicto:** ${run.verdict}`,
    note ? `**Nota:** ${note}` : "",
    "",
    "### Casos fallidos",
    failed.length
      ? failed.map((c) => `- ❌ ${c.name}${c.detail ? ` — ${c.detail}` : ""}`).join("\n")
      : "_(sin detalle de casos)_",
    flaky.length ? "\n### Inestables (cuarentena)" : "",
    flaky.length ? flaky.map((c) => `- ⚠️ ${c.name}`).join("\n") : "",
    "",
    "### Logs (sanitizados)",
    "```",
    run.logs,
    "```",
    "",
    "_Traza disponible en los artefactos del run (trace on-first-retry)._",
  ];
  return lines.filter((l) => l !== "").join("\n");
}
