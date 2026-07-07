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

export function classifyCommit(message: string, diff: string): CommitClassification {
  const { type, breaking } = parseHeader(message);
  const firstLine = (message.split("\n")[0] ?? "").trim();
  // The body (paragraphs after the subject) is the richest human statement of intent — what changed
  // and WHY. The subject alone is often too terse to derive a concrete test objective from.
  const body = message.split("\n").slice(1).join("\n").trim();
  const changedFiles = parseChangedFiles(diff);
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
  } else if (action === "skip") {
    // WS7.3(b)/(c) (full-flow remediation, conservative expansion): two DISTINCT blind spots that
    // both under-classify a skip-typed commit as untestable, closed the SAME way — escalate to
    // REGRESSION (run the existing suite; stale specs surface), never GENERATE. This is
    // deliberately weaker than the added-logic/added-config escalation above: a removal or a
    // migration invalidates EXISTING expectations more than it creates a brand-new surface to
    // cover, so the cheap, targeted response is re-running what already exists, not writing new
    // tests speculatively. A red result then flows through the normal fix/Issue machinery exactly
    // like any other regression run.
    const removedLogic = genuinelyRemovedLogic(diff);
    const migrationChange = genuinelyAddedMigration(diff);
    if (removedLogic > 0) {
      contradiction = true;
      action = "regression";
      reason = `message '${type}' expected no tests, but the diff REMOVES logic (${removedLogic} line(s)) → escalated to regression (stale specs may surface)`;
    } else if (migrationChange > 0) {
      contradiction = true;
      action = "regression";
      reason = `message '${type}' expected no tests, but the diff adds a DB migration → escalated to regression`;
    }
  }
  // WS7.3(d) (full-flow remediation, DECISION — documented known limit): constant-value changes
  // (e.g. `timeout: 5000` → `timeout: 10000`) are NOT auto-escalated. A value-diff heuristic on
  // arbitrary source is high-noise (nearly every line touches SOME literal) and the false-generate
  // cost at fleet scale is real. Accepted blind spot — revisit with telemetry if skip-then-fail
  // incidents against this exact shape show up in practice; do not add a heuristic here on a hunch.

  return { type, breaking, message: firstLine, body: body || undefined, changedFiles, hasLogicChange, contradiction, action, reason };
}

// WS7.1 (full-flow remediation, multi-commit range restoration): severity order for reducing
// several per-commit classifications down to ONE action. "skip < regression < generate" — the
// action must reflect the WORST (most test-worthy) change anywhere in the range: a single `feat`
// buried under a stack of `chore` commits must still generate, and any commit that needs the
// existing suite re-run (regression) must not be silently outvoted by a majority of skips.
//
// Twin of qa-engine/src/contexts/change-analysis/domain/commit-classification.ts's own
// classifyRange — keep the two in lockstep (parity test: commit-classification-parity.test.ts).
const ACTION_SEVERITY: Record<CommitAction, number> = { skip: 0, regression: 1, generate: 2 };

// Classifies a PUSH/PR range of commits as ONE decision. `headMessage` is the tip commit's own
// message (ALWAYS passed explicitly — never inferred from array position); `otherMessages` are the
// rest of the range (order-independent — only the MAX-severity action is derived from them).
// Mirrors classifyCommit() exactly when otherMessages is empty (the common, no-baseSha case).
export function classifyRange(headMessage: string, otherMessages: readonly string[], diff: string): CommitClassification {
  const headClassification = classifyCommit(headMessage, diff);
  const otherClassifications = otherMessages.map((m) => classifyCommit(m, diff));
  const all = [headClassification, ...otherClassifications];
  const winner = all.reduce((worst, cur) =>
    ACTION_SEVERITY[cur.action] > ACTION_SEVERITY[worst.action] ? cur : worst,
  );
  return {
    ...headClassification,
    action: winner.action,
    reason: otherMessages.length > 0 ? `range of ${all.length} commit(s): ${winner.reason}` : winner.reason,
    contradiction: winner.contradiction,
    hasLogicChange: all.some((c) => c.hasLogicChange),
  };
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

export function parseChangedFiles(diff: string): string[] {
  const files: string[] = [];
  for (const line of diff.split("\n")) {
    const m = line.match(/^diff --git a\/(\S+) b\/(\S+)/);
    if (m) files.push(m[2] ?? m[1]!);
  }
  return files;
}

// WS7.3(a) (full-flow remediation, conservative expansion — premise-corrected): .vue/.svelte were
// ALREADY present (verified against the live tree before this fix; the plan's original premise
// that they were missing was wrong). Only .html/.astro were the genuinely-missing framework
// template extensions — for an E2E engine, a template change IS a behavior change (it's what the
// browser renders), so it belongs in the same source-file set every other markup/component
// extension here already gets.
const SOURCE_EXT = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "java", "kt", "py", "go", "rb", "cs",
  "php", "rs", "swift", "scala", "c", "cc", "cpp", "h", "hpp", "vue", "svelte",
  "html", "astro",
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

// WS7.3(b) (full-flow remediation, conservative expansion): GENUINELY-removed logic — the
// symmetric twin of genuinelyAddedLogic above, same relocation subtraction, but counting the
// OPPOSITE direction (removed lines minus those that have an identical added counterpart — a
// relocation, not a deletion of behavior). A removal-only diff (deleting a guard, a branch, an
// entire function) never registered in genuinelyAddedLogic (which only ever counts the `+` side),
// so a skip-typed commit that REMOVES real logic previously escalated to nothing at all — the
// existing suite's coverage of that removed behavior goes stale and silently unverified. Kept as
// its OWN standalone walk (not a refactor of genuinelyAddedLogic) so the existing, tested function
// is never put at risk by this addition — the two are twins by construction, pinned by their own
// parity/behavior tests, not by sharing a code path.
function genuinelyRemovedLogic(diff: string): number {
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
  // Subtract relocations by content: a removed logic line with a matching added line is a move,
  // not deleted behavior. Each addition can cancel at most one removal (mirrors genuinelyAddedLogic's
  // own cancellation direction, reversed).
  const addedCounts = new Map<string, number>();
  for (const a of added) addedCounts.set(a, (addedCounts.get(a) ?? 0) + 1);
  let net = 0;
  for (const r of removed) {
    const c = addedCounts.get(r) ?? 0;
    if (c > 0) addedCounts.set(r, c - 1);
    else net++;
  }
  return net;
}

// WS7.3(c) (full-flow remediation, conservative expansion): SQL migration files — deliberately
// NARROW, matching the same "behavior-config, not everything" discipline BEHAVIOR_CONFIG below
// already applies: a bare `.sql` file changed under a conventional migration DIRECTORY (Flyway/
// Liquibase's own `db/migration`, `migrations`, or `db/changelog` layouts), or a `.sql` file whose
// NAME carries a migration-tool version/sequence prefix (Flyway `V1__`/`R__`, a bare numeric
// sequence like `001_add_column.sql`) — a schema migration invalidates existing expectations (a
// dropped column, a renamed table) more than it creates new coverage surface, so it escalates
// exactly like a removal (regression: run the suite, stale specs surface), never generate.
const MIGRATION_PATH = /(^|\/)(db[\\/]migration|migrations|db[\\/]changelog)[\\/][^/]+\.sql$/i;
const MIGRATION_FILENAME = /(^|\/)(v\d+(\.\d+)*__|r__|\d{3,}[_-]).*\.sql$/i;

function isMigrationFile(path: string): boolean {
  return MIGRATION_PATH.test(path) || MIGRATION_FILENAME.test(path);
}

// Net-added lines (any content, not just "looks like logic" — SQL DDL/DML has none of the
// LOGIC-regex keywords) in a migration file. Any added line is schema-affecting by definition of
// the file being a migration at all; relocations are subtracted by content, matching every other
// genuinely* walker's own discipline.
function genuinelyAddedMigration(diff: string): number {
  let inMigration = false;
  const added: string[] = [];
  const removed: string[] = [];
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      inMigration = isMigrationFile(line.replace(/^\+\+\+ (?:b\/)?/, ""));
      continue;
    }
    if (line.startsWith("--- ") || line.startsWith("diff --git")) {
      if (line.startsWith("diff --git")) inMigration = false;
      continue;
    }
    if (!inMigration) continue;
    if (line.startsWith("+")) {
      const c = line.slice(1).trim();
      if (c && !/^--/.test(c)) added.push(c);
    } else if (line.startsWith("-")) {
      const c = line.slice(1).trim();
      if (c && !/^--/.test(c)) removed.push(c);
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
