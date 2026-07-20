// sdd/migration-wiring-phase-2 Slice 4 (D-E skill-exemplar restore): this file was deleted during
// Phase 1's dead-code cleanup (migration-remediation 8.B, commit 3b59b90) because it had ZERO
// production callers — nothing ever threaded detectStructuralPatterns' output anywhere. Restored
// VERBATIM from git history (3b59b90^) because THIS slice gives it a genuine caller: the generation
// prompt's "skill-exemplars" section (src/integrations/prompts.ts), fed through
// OpencodeRunInput.structuralPatterns. Detection logic is byte-for-byte unchanged from the original.
import type { StructuralPattern } from "./skill-exemplar";

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
