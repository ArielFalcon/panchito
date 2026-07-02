// Regex-based structural pattern fallback for languages without ast-grep rules.
// Ported verbatim from src/qa/learning/structural-pattern.ts — a small, self-contained pure
// function with a single local type dependency (the StructuralPattern union, also ported below
// rather than pulling in the whole learning/skill-exemplar.ts catalog module, which owns a large
// built-in exemplar catalog unrelated to pattern DETECTION). Kept local to patterns.ts's
// consumers only — this is the FALLBACK path (today js/ts/java all have ast-grep rules per
// LanguageRegistry.hasAstGrepRules, so this path is inert until a future language without
// ast-grep coverage is added to the registry).
export type StructuralPattern =
  | { kind: "form"; hasOnSubmit: boolean; hasValidation: boolean }
  | { kind: "api-call"; method: string; hasRequestBody: boolean; hasErrorHandling: boolean }
  | { kind: "stateful-cache"; sourceType: string; hasIndependentWritePath: boolean }
  | { kind: "auth-flow"; hasLogin: boolean; hasSessionToken: boolean }
  | { kind: "data-list"; hasFilter: boolean; hasPagination: boolean; hasEmptyState: boolean }
  | { kind: "generic" };

export function detectStructuralPatterns(diff: string, changedFiles: string[]): StructuralPattern[] {
  const patterns: StructuralPattern[] = [];
  const diffText = diff.toLowerCase();

  const hasHtmlForm = changedFiles.some((f) => f.endsWith(".html")) && /<form\b/i.test(diff);
  const hasTsxForm = changedFiles.some((f) => f.endsWith(".tsx") || f.endsWith(".jsx")) && /<form\b|formgroup|formcontrol|formbuilder/i.test(diff);
  const hasOnSubmit = /\bonsubmit\b/i.test(diffText);
  const hasValidation = /\b(?:validate|validation|validator|zod|yup|joi|required|minlength|maxlength|pattern)\b/i.test(diffText);

  if (hasHtmlForm || hasTsxForm) {
    patterns.push({
      kind: "form",
      hasOnSubmit: hasOnSubmit || hasTsxForm,
      hasValidation,
    });
  }

  const hasApiCall = /\b(?:fetch|axios|got|request|http\.(?:get|post|put|delete|patch)|usequery|usemutation|createApi)\b/i.test(diffText);
  const hasRequestBody = /\b(?:body|payload|data)\s*[:=]\s*/i.test(diffText);
  const hasErrorHandling = /\b(?:catch|error|onerror|onrejected|status\s*!==?\s*200|status\s*>=|response\.ok)\b/i.test(diffText);

  if (hasApiCall) {
    const method = /\b(?:\.post|\.put|\.patch|\.delete|method:\s*['"](?:POST|PUT|PATCH|DELETE))\b/i.test(diffText) ? "POST" : "GET";
    patterns.push({
      kind: "api-call",
      method,
      hasRequestBody,
      hasErrorHandling,
    });
  }

  const hasCache = /\b(?:cache|cached|memoize|memo|usememo|usecallback|redis|localstorage|sessionstorage|indexeddb)\b/i.test(diffText);
  const hasIndependentWrite = /\b(?:invalidate|evict|clear|delete|remove|purge|refresh)\b/i.test(diffText);

  if (hasCache) {
    patterns.push({
      kind: "stateful-cache",
      sourceType: /\bredis\b/i.test(diffText) ? "redis" : /\blocalstorage\b/i.test(diffText) ? "localStorage" : "memory",
      hasIndependentWritePath: hasIndependentWrite,
    });
  }

  const hasAuth = /\b(?:auth|login|signin|logout|signout|session|token|jwt|oauth)\b/i.test(diffText);
  if (hasAuth) {
    patterns.push({
      kind: "auth-flow",
      hasLogin: /\b(?:login|signin)\b/i.test(diffText),
      hasSessionToken: /\b(?:token|jwt|session)\b/i.test(diffText),
    });
  }

  const hasList = /\b(?:list|table|datagrid|datatable|items|results|rows)\b/i.test(diffText);
  const hasFilter = /\b(?:filter|search|query|sort|orderby)\b/i.test(diffText);
  const hasPagination = /\b(?:pag(?:e|ination)|offset|limit|cursor|loadmore|infinite)\b/i.test(diffText);
  const hasEmpty = /\b(?:empty|no\s+(?:results|data|items)|not\s+found|placeholder)\b/i.test(diffText);

  if (hasList) {
    patterns.push({
      kind: "data-list",
      hasFilter,
      hasPagination,
      hasEmptyState: hasEmpty,
    });
  }

  if (patterns.length === 0) {
    patterns.push({ kind: "generic" });
  }

  return patterns;
}
