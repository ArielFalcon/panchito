// Commit classifier (Conventional Commits). Provides the change INTENT used to
// define the test objective and to filter commits that carry no tests. It is
// ADVISORY: the type→action table is the default, but it is cross-checked against
// the diff — if the message claims "no behavior change" (refactor/style/chore...)
// yet the diff ADDS logic, it escalates to generate (the message contradicts the
// code). The scope is NOT read from parentheses: it is derived from the changed
// files (the message gives intent, the files give the "where").
//
// Ported verbatim in behavior from src/qa/commit-classify.ts. The ONLY change:
// the inlined parseChangedFiles(diff) is replaced by the shared DiffParserService
// so the context consumes ONE canonical diff parser instead of a private duplicate.
// The genuinelyAddedLogic/genuinelyAddedConfig walkers stay private: they parse
// +++/---/+/- with content-relocation subtraction — that is classify-specific logic,
// NOT generic diff parsing, so it does NOT move to DiffParserService.
import { DiffParserService } from "@kernel/diff-parser/diff-parser.service.ts";

export type CommitType =
  | "feat" | "fix" | "perf" | "refactor" | "chore"
  | "style" | "docs" | "ci" | "build" | "test" | "revert" | "unknown";

export type CommitAction = "generate" | "regression" | "skip";

export interface CommitIntent {
  type: CommitType;
  breaking: boolean;
  message: string; // first line (what the agent uses as intent)
  body?: string; // the commit message body (lines after the subject) — the richest statement of intent
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

const diffParser = new DiffParserService();

export function classifyCommit(message: string, diff: string): CommitClassification {
  const { type, breaking } = parseHeader(message);
  const firstLine = (message.split("\n")[0] ?? "").trim();
  // The body (paragraphs after the subject) is the richest human statement of intent — what changed
  // and WHY. The subject alone is often too terse to derive a concrete test objective from.
  const body = message.split("\n").slice(1).join("\n").trim();
  const changedFiles = diffParser.changedFiles(diff); // was the inlined parseChangedFiles
  // Behavior can change in code (logic keywords) OR in config-as-code that the source-extension
  // logic check is blind to — a Spring application.yml/.properties setting under a chore/build
  // message changes runtime behavior yet would otherwise be classified skip and go untested.
  const hasLogicChange = genuinelyAddedLogic(diff) > 0;
  const hasBehaviorConfigChange = genuinelyAddedConfig(diff) > 0;

  let action: CommitAction = breaking ? "generate" : DEFAULT_ACTION[type];
  let contradiction = false;
  let reason = `type=${type}`;

  if (breaking) {
    reason = "breaking change → generate";
  } else if ((action === "skip" || action === "regression") && (hasLogicChange || hasBehaviorConfigChange)) {
    // The message promises no new behavior, but the diff adds it (code logic or behavior config).
    contradiction = true;
    action = "generate";
    const what = hasLogicChange ? "logic" : "behavior config";
    reason = `message '${type}' expected no tests, but the diff adds ${what} → escalated to generate`;
  }

  return { type, breaking, message: firstLine, body: body || undefined, changedFiles, hasLogicChange, contradiction, action, reason };
}

const TYPES = new Set<string>([
  "feat", "fix", "perf", "refactor", "chore", "style", "docs", "ci", "build", "test", "revert",
]);

function parseHeader(message: string): { type: CommitType; breaking: boolean } {
  const first = (message.split("\n")[0] ?? "").trim();
  if (/^Revert "/i.test(first)) return { type: "revert", breaking: false };
  const m = first.match(/^(\w+)(?:\([^)]*\))?(!)?:/);
  const raw = m?.[1]?.toLowerCase();
  const type = (raw && TYPES.has(raw) ? raw : "unknown") as CommitType;
  const breaking = Boolean(m?.[2]) || /(^|\n)BREAKING[ -]CHANGE:/.test(message);
  return { type, breaking };
}

const SOURCE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "java", "kt", "py", "go", "rb", "cs",
  "php", "rs", "swift", "scala", "c", "cc", "cpp", "h", "hpp", "vue", "svelte",
]);

function isSourceFile(path: string): boolean {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  return SOURCE_EXT.has(ext);
}

// GENUINELY-added logic = added logic lines MINUS those that have an identical removed
// counterpart (a relocation, not new behavior). Counted across source files only.
// Using added-minus-relocations instead of a single repo-wide NET is what stops a NEW
// branch in one file from being silently cancelled by an UNRELATED removal in another
// (which would let a behavior change go untested), while still not escalating a pure
// move (the relocated line is matched and subtracted).
function genuinelyAddedLogic(diff: string): number {
  let currentSource = false;
  const added: string[] = [];
  const removed: string[] = [];
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
      if (looksLikeLogic(line.slice(1))) added.push(line.slice(1).trim());
    } else if (line.startsWith("-")) {
      if (looksLikeLogic(line.slice(1))) removed.push(line.slice(1).trim());
    }
  }
  // Subtract relocations by content: an added logic line with a matching removed line is
  // a move, not new logic. Each removal can cancel at most one addition.
  const removedCounts = new Map<string, number>();
  for (const r of removed) removedCounts.set(r, (removedCounts.get(r) ?? 0) + 1);
  let net = 0;
  for (const a of added) {
    const c = removedCounts.get(a) ?? 0;
    if (c > 0) removedCounts.set(a, c - 1);
    else net++;
  }
  return net;
}

// Behavior-config files whose changes alter runtime behavior (Spring app/profile config, Spring
// Cloud bootstrap). Deliberately NARROW: dependency manifests (pom.xml, package.json, lockfiles)
// and CI yaml are excluded so routine bumps do not force-escalate.
const BEHAVIOR_CONFIG = /(^|\/)(application|bootstrap)(-[\w]+)?\.(ya?ml|properties)$/i;

function isBehaviorConfigFile(path: string): boolean {
  return BEHAVIOR_CONFIG.test(path);
}

// Net-added meaningful (non-blank, non-comment) lines in behavior-config files. Config carries
// no code keywords, so any added setting is a potential behavior change; relocations are
// subtracted by content exactly like genuinelyAddedLogic.
function genuinelyAddedConfig(diff: string): number {
  let inConfig = false;
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      inConfig = isBehaviorConfigFile(line.replace(/^\+\+\+ (?:b\/)?/, ""));
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("diff --git")) {
      if (line.startsWith("diff --git")) inConfig = false;
      continue;
    }
    if (!inConfig) continue;
    if (line.startsWith("+")) {
      const c = line.slice(1).trim();
      if (c && !/^#/.test(c)) added.push(c);
    } else if (line.startsWith("-")) {
      const c = line.slice(1).trim();
      if (c && !/^#/.test(c)) removed.push(c);
    }
  }
  const removedCounts = new Map<string, number>();
  for (const r of removed) removedCounts.set(r, (removedCounts.get(r) ?? 0) + 1);
  let net = 0;
  for (const a of added) {
    const c = removedCounts.get(a) ?? 0;
    if (c > 0) removedCounts.set(a, c - 1);
    else net++;
  }
  return net;
}

const LOGIC = /\b(if|else|for|while|switch|case|return|function|class|interface|enum|def|func|await|async|throw|try|catch|yield)\b|=>|\b\w+\s*\(/;

function looksLikeLogic(content: string): boolean {
  const t = content.trim();
  if (!t) return false;
  if (/^(\/\/|\*|\/\*|\*\/|#|<!--|-->)/.test(t)) return false; // comment line
  // Strip string/template-literal CONTENTS first, so code-like words or parens inside a
  // string (prose, CSS, a phone number) are not mistaken for logic — a copy change in a
  // `style`/`refactor` commit must not be force-escalated to generate.
  return LOGIC.test(stripStrings(t));
}

// Replaces the contents of "..." / '...' / `...` with empty strings (handles escapes).
function stripStrings(s: string): string {
  return s.replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`/g, '""');
}
