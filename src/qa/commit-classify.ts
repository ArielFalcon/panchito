// Clasificador de commits (Conventional Commits / release-please). Da la
// INTENCIÓN del cambio para definir el objetivo del test y para filtrar commits
// que no llevan pruebas. Es ORIENTATIVO: la tabla tipo→acción es el defecto,
// pero se contrasta con el diff — si el mensaje dice "sin cambios" (refactor/
// style/chore...) pero el diff AÑADE lógica, se escala a generar (el mensaje
// contradice al código). El scope NO se lee del paréntesis: se deduce de los
// ficheros cambiados (el mensaje da intención, los ficheros dan el dónde).

export type CommitType =
  | "feat" | "fix" | "perf" | "refactor" | "chore"
  | "style" | "docs" | "ci" | "build" | "test" | "revert" | "unknown";

export type CommitAction = "generate" | "regression" | "skip";

export interface CommitIntent {
  type: CommitType;
  breaking: boolean;
  message: string; // primera línea (lo que el agente usa como intención)
  changedFiles: string[]; // de aquí el agente deduce el scope/área
}

export interface CommitClassification extends CommitIntent {
  hasLogicChange: boolean; // señal del diff: ¿añade lógica neta?
  contradiction: boolean; // el mensaje dice "sin pruebas" pero el diff añade lógica
  action: CommitAction;
  reason: string;
}

// Acción por defecto según el tipo. feat/fix → pruebas; perf/refactor → solo
// regresión (comportamiento igual); el resto no lleva pruebas.
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
  unknown: "generate", // sin convención reconocible: ante la duda, se prueba
};

export function classifyCommit(message: string, diff: string): CommitClassification {
  const { type, breaking } = parseHeader(message);
  const firstLine = (message.split("\n")[0] ?? "").trim();
  const changedFiles = parseChangedFiles(diff);
  const hasLogicChange = netLogicAdded(diff) > 0;

  let action: CommitAction = breaking ? "generate" : DEFAULT_ACTION[type];
  let contradiction = false;
  let reason = `tipo=${type}`;

  if (breaking) {
    reason = "breaking change → genera";
  } else if ((action === "skip" || action === "regression") && hasLogicChange) {
    // El mensaje no promete comportamiento nuevo, pero el diff sí lo añade.
    contradiction = true;
    action = "generate";
    reason = `mensaje '${type}' no esperaba pruebas, pero el diff añade lógica → se escala a generar`;
  }

  return { type, breaking, message: firstLine, changedFiles, hasLogicChange, contradiction, action, reason };
}

// --- parsing ---------------------------------------------------------------

const TYPES = new Set<string>([
  "feat", "fix", "perf", "refactor", "chore", "style", "docs", "ci", "build", "test", "revert",
]);

function parseHeader(message: string): { type: CommitType; breaking: boolean } {
  const first = (message.split("\n")[0] ?? "").trim();
  // tipo, scope opcional (ignorado), `!` opcional de breaking, `:`
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

// Lógica añadida NETA = (líneas de lógica añadidas) − (eliminadas), solo en
// ficheros de código. El neto distingue "añade lógica" (positivo) de "mueve una
// línea" (≈0): así un `style` que solo reubica código no se escala por error.
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
  if (/^(\/\/|\*|\/\*|\*\/|#|<!--|-->)/.test(t)) return false; // comentario
  return LOGIC.test(t);
}
