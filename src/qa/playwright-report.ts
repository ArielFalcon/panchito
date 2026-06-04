// Parser puro del reporter JSON de Playwright → casos pass/fail/flaky. Aislado
// para poder verificarlo con un reporte de muestra sin ejecutar navegadores.
//
// Flaky = Filtro C del harness: Playwright marca un test como "flaky" cuando
// falla y luego pasa en un reintento (retries configurados en la config base).
// Tratamos esa inestabilidad como NO fiable → cuarentena, no fallo real.

import { CaseStatus, RunVerdict } from "../types";

export interface PwCase {
  name: string;
  status: CaseStatus;
  detail?: string;
}

export interface ParsedReport {
  verdict: RunVerdict; // "pass" | "fail" | "flaky" (nunca "invalid": eso es el gate estático)
  passed: boolean; // atajo: verdict === "pass"
  cases: PwCase[];
}

interface PwResult {
  status?: string;
  error?: { message?: string };
}
interface PwTest {
  results?: PwResult[];
  status?: string; // expected | unexpected | flaky | skipped
}
interface PwSpec {
  title?: string;
  ok?: boolean;
  tests?: PwTest[];
}
interface PwSuite {
  title?: string;
  specs?: PwSpec[];
  suites?: PwSuite[];
}
interface PwReport {
  suites?: PwSuite[];
  stats?: { unexpected?: number; flaky?: number };
}

const OK_STATUSES = new Set(["passed", "expected"]);

export function parsePlaywrightReport(json: unknown): ParsedReport {
  const report = (json ?? {}) as PwReport;
  const cases: PwCase[] = [];

  const walk = (suites: PwSuite[] | undefined, prefix: string): void => {
    for (const suite of suites ?? []) {
      const title = [prefix, suite.title].filter(Boolean).join(" › ");
      for (const spec of suite.specs ?? []) {
        cases.push({
          name: [title, spec.title].filter(Boolean).join(" › "),
          status: specStatus(spec),
          detail: specStatus(spec) === "pass" ? undefined : firstError(spec),
        });
      }
      walk(suite.suites, title);
    }
  };
  walk(report.suites, "");

  const verdict = aggregate(cases, report);
  return { verdict, passed: verdict === "pass", cases };
}

// Estado de un spec, priorizando el `status` por test de Playwright cuando
// existe (expected/unexpected/flaky); si no, cae al `ok`/results heredado.
function specStatus(spec: PwSpec): CaseStatus {
  const statuses = (spec.tests ?? []).map((t) => t.status).filter(Boolean) as string[];
  if (statuses.length) {
    if (statuses.includes("unexpected")) return "fail";
    if (statuses.includes("flaky")) return "flaky";
    return "pass";
  }
  // Fallback (reportes sin status por test): no distingue flaky.
  const ok =
    spec.ok ??
    (spec.tests ?? []).every((t) =>
      (t.results ?? []).every((r) => OK_STATUSES.has(r.status ?? "")),
    );
  return ok ? "pass" : "fail";
}

function aggregate(cases: PwCase[], report: PwReport): RunVerdict {
  if (cases.length > 0) {
    if (cases.some((c) => c.status === "fail")) return "fail";
    if (cases.some((c) => c.status === "flaky")) return "flaky";
    return "pass";
  }
  // Sin specs detectados: usa los stats globales.
  if ((report.stats?.unexpected ?? 0) > 0) return "fail";
  if ((report.stats?.flaky ?? 0) > 0) return "flaky";
  return "pass";
}

function firstError(spec: PwSpec): string | undefined {
  for (const t of spec.tests ?? []) {
    for (const r of t.results ?? []) {
      if (r.error?.message) return r.error.message;
    }
  }
  return undefined;
}
