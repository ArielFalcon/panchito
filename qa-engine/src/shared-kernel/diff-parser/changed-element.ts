// A stable HTML selector signal extracted from a diff's added lines (or from manual guidance).
// Shape lifted verbatim from src/qa/changed-elements.ts ChangedElement so callers migrate 1:1.
export interface ChangedElement {
  file: string;       // repo-relative; "" for guidance-derived entries
  line: number;       // 1-based new-side line; 0 for guidance-derived entries
  testId?: string;    // data-cy / data-testid / data-test
  id?: string;        // id="" value
  name?: string;      // name="" / formControlName value
  text?: string;      // visible inner text (button/link/heading/label)
  href?: string;      // resolved path (href OR routerLink → href), / or # only
  role?: string;      // best-effort tag → ARIA role
  raw: string;        // trimmed added line (debug/telemetry)
}
