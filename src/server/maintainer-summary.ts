// Parsing + validation of the qa-maintainer agent's closing summary. Extracted from the index.ts
// god entrypoint (ARCH-01): this is pure, self-contained logic (no server/queue/fs state) that
// gates whether a self-fix is allowed to merge, so it belongs in its own testable module.

export interface MaintainerJustification {
  rootCause: string; // what actually causes the incident
  whyNecessary: string; // why this change is needed (vs. doing nothing)
  whyMinimal: string; // why this is the smallest safe fix (not over-engineering)
}

export interface MaintainerSummary {
  fixed: boolean;
  changes: string[];
  prTitle?: string;
  justification?: MaintainerJustification;
}

// A justification is only valid when all three arguments are present and non-trivial — the
// requirement that the system "prove the change is necessary and the solution is optimal and safe"
// before it is allowed to self-merge and hot-swap.
export function validJustification(j: unknown): MaintainerJustification | undefined {
  if (!j || typeof j !== "object") return undefined;
  const o = j as Record<string, unknown>;
  const ok = (v: unknown): v is string => typeof v === "string" && v.trim().length >= 10;
  if (ok(o.rootCause) && ok(o.whyNecessary) && ok(o.whyMinimal)) {
    return { rootCause: o.rootCause, whyNecessary: o.whyNecessary, whyMinimal: o.whyMinimal };
  }
  return undefined;
}

export function parseMaintainerSummary(text: string): MaintainerSummary {
  const start = text.indexOf("<!--MAINTAINER_SUMMARY");
  if (start === -1) return { fixed: false, changes: [] };
  const end = text.indexOf("END_MAINTAINER_SUMMARY-->", start);
  if (end === -1) return { fixed: false, changes: [] };

  try {
    const json = JSON.parse(text.slice(start + "<!--MAINTAINER_SUMMARY".length, end).trim());
    return {
      fixed: json.fixed === true,
      changes: Array.isArray(json.changes) ? json.changes : [],
      prTitle: typeof json.prTitle === "string" ? json.prTitle : undefined,
      justification: validJustification(json.justification),
    };
  } catch {
    return { fixed: false, changes: [] };
  }
}
