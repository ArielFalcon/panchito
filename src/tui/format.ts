// Pure presentation helpers — no Ink, no React. These hold the formatting logic so
// it is unit-testable in isolation; the components only place these strings/colors.

import { RunVerdict, CaseStatus, TestTarget, RunMode, AgentActivity } from "../types";

// The visible pipeline (the OpenCode-internal generate↔review loop stays opaque).
export const PIPELINE_STEPS = ["classify", "generate", "validate", "execute"] as const;
export type PipelineStep = (typeof PIPELINE_STEPS)[number];

export type StepState = "done" | "active" | "pending";

// Target descriptions (sourced from types.ts doc comments).
export const TARGET_INFO: Record<TestTarget, string> = {
  e2e: "Browser-based Playwright tests against a live DEV environment",
  code: "Source-code tests (unit/integration) without a browser or DEV URL",
};

// Mode descriptions — what each mode does at a glance.
export const MODE_INFO: Record<RunMode, string> = {
  diff:        "Test the blast radius of a single commit (default). Classifies Conventional Commits to skip, regress, or generate.",
  complete:    "Analyze the whole repo, estimate coverage, and test uncovered important flows.",
  exhaustive:  "Audit every existing test and regenerate the entire suite from scratch.",
  manual:      "Focused generation guided by a natural-language prompt.",
  context:     "Build or refresh the FE↔BE architecture map (context.json) from routing, OpenAPI, and generated clients.",
};

// Section label for each pipeline step, with a summary when complete.
export function sectionLabel(step: PipelineStep, state: StepState, cases: { passed: number; failed: number; total: number }, specCount?: number): string {
  const labels: Record<PipelineStep, string> = {
    classify: "classify commit",
    generate: "generate tests",
    validate: "validate specs",
    execute:  "execute tests",
  };
  if (state === "done") {
    if (step === "execute" && cases.total > 0) {
      return `${labels[step]} — ${cases.total} run, ${cases.passed} passed, ${cases.failed} failed`;
    }
    if (step === "generate" && specCount !== undefined && specCount > 0) {
      return `${labels[step]} — ${specCount} spec${specCount !== 1 ? "s" : ""}`;
    }
    return labels[step];
  }
  return labels[step];
}

// Given the run's current `step`, what state should `step` render in?
export function stepState(current: string | undefined, step: PipelineStep): StepState {
  if (current === "done") return "done";
  const execIdx = PIPELINE_STEPS.indexOf("execute");
  if (current === "retry") {
    return step === "execute" ? "active" : PIPELINE_STEPS.indexOf(step) < execIdx ? "done" : "pending";
  }
  const ci = current ? PIPELINE_STEPS.indexOf(current as PipelineStep) : -1;
  const si = PIPELINE_STEPS.indexOf(step);
  if (ci < 0) return "pending"; // enqueued / unknown
  if (si < ci) return "done";
  if (si === ci) return "active";
  return "pending";
}

// A 20-wide block progress bar. passed/total clamped; 0 total → empty bar.
export function progressBar(passed: number, total: number, width = 20): string {
  if (total <= 0) return "░".repeat(width);
  const filled = Math.max(0, Math.min(width, Math.round((passed / total) * width)));
  return "▓".repeat(filled) + "░".repeat(width - filled);
}

export function verdictColor(verdict: RunVerdict | undefined): string {
  switch (verdict) {
    case "pass":
      return "#3b7a57";
    case "fail":
    case "invalid":
      return "#c0392b";
    case "skipped":
      return "#6b685b";
    case "flaky":
      return "#c2891b";
    case "infra-error":
      return "#4a6877";
    default:
      return "cyan";
  }
}

export function verdictIcon(verdict: RunVerdict | undefined): string {
  switch (verdict) {
    case "pass":
      return "✓";
    case "fail":
    case "invalid":
      return "✗";
    case "skipped":
      return "⊘";
    case "flaky":
      return "⚠";
    case "infra-error":
      return "⚙";
    default:
      return "·";
  }
}

export function caseColor(status: CaseStatus): string {
  return status === "fail" ? "#c0392b" : status === "flaky" ? "#c2891b" : "#6b685b";
}

export function caseIcon(status: CaseStatus): string {
  return status === "fail" ? "✗" : status === "flaky" ? "⚠" : "✓";
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

// ── Live activity aggregation ────────────────────────────────────────────────
// Pure: turns the flat, chronological AgentActivity[] into the shape the live
// panel renders. No Ink, no time side effects except an injectable `now`.

export type TodoStatus = "pending" | "in_progress" | "completed";
export interface TodoView { text: string; status: TodoStatus; }

// The highlighted "what is happening right now" card. `title` is the in-progress
// todo when there is one, else the last action (quiet state keeps the last action
// visible alongside the ticking clock instead of inventing data).
export interface FocusItem {
  title: string;
  progress?: string;     // e.g. "3/5" of todos
  lastFile?: string;
  lastCommand?: string;
}

export interface ActivityView {
  todos: TodoView[];
  filesWritten: string[];
  fileCount: number;
  commands: string[];
  focus: FocusItem | null;
  elapsedMs: number;
  lastText: string | null;
}

export function deriveActivityView(
  activity: AgentActivity[] | undefined,
  opts: { stepStartedAt?: string; now?: number } = {},
): ActivityView {
  const now = opts.now ?? Date.now();
  const startMs = opts.stepStartedAt ? Date.parse(opts.stepStartedAt) : NaN;
  const elapsedMs = Number.isNaN(startMs) ? 0 : Math.max(0, now - startMs);

  // Scope the feed to the CURRENT phase: events stamped before this phase began
  // (e.g. generate's todos while we are now in execute) would otherwise leak into
  // the focus card. Unparseable timestamps are kept (fail-open, never hide signal).
  const all = activity ?? [];
  const events = Number.isNaN(startMs)
    ? all
    : all.filter((a) => { const t = Date.parse(a.ts); return Number.isNaN(t) || t >= startMs; });
  // Insertion-ordered maps: updating a key keeps its position, latest value wins.
  const todoMap = new Map<string, TodoStatus>();
  const files = new Map<string, true>();
  const commands: string[] = [];
  let lastText: string | null = null;

  for (const a of events) {
    if (!a.text) continue;
    lastText = a.text;
    if (a.kind === "todo") {
      todoMap.set(a.text, (a.status as TodoStatus) ?? "pending");
    } else if (a.kind === "file") {
      files.set(a.text, true);
    } else if (a.kind === "command") {
      commands.push(a.text);
    }
  }

  const todos: TodoView[] = [...todoMap.entries()].map(([text, status]) => ({ text, status }));
  const filesWritten = [...files.keys()];
  const completed = todos.filter((t) => t.status === "completed").length;
  const inProgress = todos.find((t) => t.status === "in_progress");

  const focusTitle = inProgress?.text ?? lastText;
  const focus: FocusItem | null = focusTitle
    ? {
        title: focusTitle,
        ...(todos.length > 0 ? { progress: `${completed}/${todos.length}` } : {}),
        ...(filesWritten.length > 0 ? { lastFile: filesWritten[filesWritten.length - 1] } : {}),
        ...(commands.length > 0 ? { lastCommand: commands[commands.length - 1] } : {}),
      }
    : null;

  return {
    todos,
    filesWritten,
    fileCount: filesWritten.length,
    commands,
    focus,
    elapsedMs,
    lastText,
  };
}

// Single-line truncation with an ellipsis. Display-only; the stored value is never
// cut (the broken `"file": "s` came from slicing a raw stream fragment — gone now).
export function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)).trimEnd() + "…";
}

// Compact "8m 21s" / "47s" elapsed label from milliseconds.
export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rem = s % 60;
  if (m < 60) return `${m}m ${rem}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// ── Error display ────────────────────────────────────────────────────────────
// Node.js AssertionError detail strings carry the full stack trace + diff.
// Extract only the actionable parts: the assertion message and the file location.

export interface ParsedError {
  message: string;
  expectLine?: string;
  actualLine?: string;
  location?: string;
  raw: string;
}

export function parseAssertionError(detail: string): ParsedError {
  const lines = detail.split("\n");
  const firstLine = (lines[0] ?? detail.slice(0, 200)).trim();
  let location: string | undefined;
  for (const l of lines) {
    const m = l.match(/\((.+?:\d+:\d+)\)/);
    if (m) { location = m[1]!; break; }
  }
  let expectLine: string | undefined;
  let actualLine: string | undefined;
  for (const l of lines) {
    if (l.startsWith("+") && !l.startsWith("+++")) actualLine = l.slice(1).trim();
    if (l.startsWith("-") && !l.startsWith("---")) expectLine = l.slice(1).trim();
  }
  if (!expectLine || !actualLine) {
    for (const l of lines) {
      const em = l.match(/(?:Expected|expected):\s*(.+)/i);
      const am = l.match(/(?:Actual|actual):\s*(.+)/i);
      if (em) expectLine = em[1]!.trim();
      if (am) actualLine = am[1]!.trim();
    }
  }
  return { message: firstLine, expectLine, actualLine, location, raw: detail };
}
