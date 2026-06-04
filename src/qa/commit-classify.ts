// Commit classifier (Conventional Commits). Provides the change INTENT used to
// define the test objective and to filter commits that carry no tests. It is
// ADVISORY: the type→action table is the default, but it is cross-checked against
// the diff — if the message claims "no behavior change" (refactor/style/chore...)
// yet the diff ADDS logic, it escalates to generate (the message contradicts the
// code). The scope is NOT read from parentheses: it is derived from the changed
// files (the message gives intent, the files give the "where").

export type CommitType =
  | "feat" | "fix" | "perf" | "refactor" | "chore"
  | "style" | "docs" | "ci" | "build" | "test" | "revert" | "unknown";

export type CommitAction = "generate" | "regression" | "skip";

export interface CommitIntent {
  type: CommitType;
  breaking: boolean;
  message: string; // first line (what the agent uses as intent)
  changedFiles: string[]; // the agent derives the scope/area from these
}

export interface CommitClassification extends CommitIntent {
  hasLogicChange: boolean; // diff signal: does it add net logic?
  contradiction: boolean; // the message claims "no tests" but the diff adds logic
  action: CommitAction;
  reason: string;
}

// Default action per type. feat/fix → tests; perf/refactor → regression only
// (behavior unchanged); the rest carry no tests.
const DEFAULT_ACTION: Record<CommitType, CommitAction> = {
  feat: "generate",
  fix: "generate",
  perf: "regression",
  refactor: "regression",
  chore: "skip",
  style: "skip",
  docs: "skip",
  ci: "skip",
  build: "skip",
  test: "skip",
  revert: "skip",
  unknown: "generate", // no recognizable convention: when in doubt, test
};

export function classifyCommit(message: string, diff: string): CommitClassification {
  const { type, breaking } = parseHeader(message);
  const firstLine = (message.split("\n")[0] ?? "").trim();
  const changedFiles = parseChangedFiles(diff);
  const hasLogicChange = netLogicAdded(diff) > 0;

  let action: CommitAction = breaking ? "generate" : DEFAULT_ACTION[type];
  let contradiction = false;
  let reason = `type=${type}`;

  if (breaking) {
    reason = "breaking change → generate";
  } else if ((action === "skip" || action === "regression") && hasLogicChange) {
    // The message promises no new behavior, but the diff adds it.
    contradiction = true;
    action = "generate";
    reason = `message '${type}' expected no tests, but the diff adds logic → escalated to generate`;
  }

  return { type, breaking, message: firstLine, changedFiles, hasLogicChange, contradiction, action, reason };
}

const TYPES = new Set<string>([
  "feat", "fix", "perf", "refactor", "chore", "style", "docs", "ci", "build", "test", "revert",
]);

function parseHeader(message: string): { type: CommitType; breaking: boolean } {
  const first = (message.split("\n")[0] ?? "").trim();
  // type, optional scope (ignored), optional `!` for breaking, `:`
  const m = first.match(/^(\w+)(?:\([^)]*\))?(!)?:/);
  const raw = m?.[1]?.toLowerCase();
  const type = (raw && TYPES.has(raw) ? raw : "unknown") as CommitType;
  const breaking = Boolean(m?.[2]) || /(^|\n)BREAKING[ -]CHANGE:/.test(message);
  return { type, breaking };
}

export function parseChangedFiles(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split("\n")) {
    const m = line.match(/^diff --git a\/(\S+) b\/(\S+)/);
    if (m) files.push(m[2] ?? m[1]!);
  }
  return files;
}

const SOURCE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "java", "kt", "py", "go", "rb", "cs",
  "php", "rs", "swift", "scala", "c", "cc", "cpp", "h", "hpp", "vue", "svelte",
]);

function isSourceFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return SOURCE_EXT.has(ext);
}

// Net added logic = (added logic lines) − (removed logic lines), counting source
// files only. The net distinguishes "adds logic" (positive) from "moves a line"
// (≈0), so a `style` commit that only relocates code is not escalated by mistake.
function netLogicAdded(diff: string): number {
  let currentSource = false;
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      currentSource = isSourceFile(line.replace(/^\+\+\+ (?:b\/)?/, ""));
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("diff --git")) {
      if (line.startsWith("diff --git")) currentSource = false;
      continue;
    }
    if (!currentSource) continue;
    if (line.startsWith("+")) {
      if (looksLikeLogic(line.slice(1))) added++;
    } else if (line.startsWith("-")) {
      if (looksLikeLogic(line.slice(1))) removed++;
    }
  }
  return added - removed;
}

const LOGIC = /\b(if|else|for|while|switch|case|return|function|class|interface|enum|def|func|await|async|throw|try|catch|yield)\b|=>|\b\w+\s*\(/;

function looksLikeLogic(content: string): boolean {
  const t = content.trim();
  if (!t) return false;
  if (/^(\/\/|\*|\/\*|\*\/|#|<!--|-->)/.test(t)) return false; // comment line
  return LOGIC.test(t);
}
