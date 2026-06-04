// Parser puro del reporter JSON de Playwright → casos pass/fail. Aislado para
// poder verificarlo con un reporte de muestra sin ejecutar navegadores.

export interface PwCase {
  name: string;
  status: "pass" | "fail";
  detail?: string;
}

export interface ParsedReport {
  passed: boolean;
  cases: PwCase[];
}

interface PwResult {
  status?: string;
  error?: { message?: string };
}
interface PwTest {
  results?: PwResult[];
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
  stats?: { unexpected?: number };
}

const OK_STATUSES = new Set(["passed", "expected"]);

export function parsePlaywrightReport(json: unknown): ParsedReport {
  const report = (json ?? {}) as PwReport;
  const cases: PwCase[] = [];

  const walk = (suites: PwSuite[] | undefined, prefix: string): void => {
    for (const suite of suites ?? []) {
      const title = [prefix, suite.title].filter(Boolean).join(" › ");
      for (const spec of suite.specs ?? []) {
        const ok =
          spec.ok ??
          (spec.tests ?? []).every((t) =>
            (t.results ?? []).every((r) => OK_STATUSES.has(r.status ?? "")),
          );
        cases.push({
          name: [title, spec.title].filter(Boolean).join(" › "),
          status: ok ? "pass" : "fail",
          detail: ok ? undefined : firstError(spec),
        });
      }
      walk(suite.suites, title);
    }
  };
  walk(report.suites, "");

  const passed =
    cases.length > 0
      ? cases.every((c) => c.status === "pass")
      : (report.stats?.unexpected ?? 0) === 0;

  return { passed, cases };
}

function firstError(spec: PwSpec): string | undefined {
  for (const t of spec.tests ?? []) {
    for (const r of t.results ?? []) {
      if (r.error?.message) return r.error.message;
    }
  }
  return undefined;
}
