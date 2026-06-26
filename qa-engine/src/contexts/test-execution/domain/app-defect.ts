// "App is broken" as ONE value object. Collapses the three legacy expressions: the infra-error
// verdict, the 5xx health probe, and allFailuresAreRunnerInfra reclassification (execute.ts).
// Carries the 5xx httpStatus as evidence so the deploy gate and the adjudicator agree on one shape.
export class AppDefect {
  private constructor(
    readonly isDefect: boolean,
    readonly httpStatus: number | null,
    readonly evidence: string,
  ) {}

  static none(): AppDefect {
    return new AppDefect(false, null, "");
  }

  // A 5xx from the DEV health probe (/version) is an app-side defect — never a test failure.
  static fromHttpStatus(status: number): AppDefect {
    const defect = status >= 500 && status <= 599;
    return new AppDefect(defect, status, defect ? `DEV returned HTTP ${status}` : "");
  }

  // A Playwright runner-infrastructure fault (browser could not launch): the run never
  // exercised the app, so it is infra, never `fail`. Mirrors PLAYWRIGHT_INFRA_RE intent.
  static fromRunnerInfra(detail: string): AppDefect {
    return new AppDefect(true, null, `runner-infra: ${detail}`);
  }
}
