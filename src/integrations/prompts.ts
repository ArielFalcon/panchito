// Prompt/task assembly for the agent boundary, extracted from opencode-client.ts (BND-08). The
// "how" lives in agents/agent/*.md and the skills; these functions assemble the dynamic per-run
// TASK + CONTEXT (diff, intent, namespace, architecture map, learned rules) the agent receives.
// Pure string assembly with cheap defense-in-depth sanitization; no client/session/network state.
//
// Phase 1b: each builder declares typed Section descriptors and delegates final assembly to the
// ContextAssembler, which enforces canonical order (STABLE → SEMI-STABLE → VOLATILE → TASK →
// CRITICAL recap) and emits per-section sectionSizes for Phase-0 telemetry. The FUNCTIONAL
// CONTENT of every section is preserved exactly; only the ORDER between sections changes.
//
// The input types are imported TYPE-ONLY from opencode-client (erased at runtime), so although
// opencode-client imports these functions as values, there is no runtime import cycle.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { sanitizeText, capText } from "../orchestrator/sanitizer";
import type { ArchitectureContext } from "../qa/context";
import type { CommitIntent } from "../qa/commit-classify";
import type { QaCase } from "../types";
// Seam-2 break: these input contracts are canonical in the qa-engine generation context. Re-rooting
// this type-only import off ./opencode-client dissolves the opencode-client ⇄ prompts cycle (the
// generation-ports parity test keeps the legacy opencode-client copies structurally in sync).
import type { OpencodeRunInput, ParallelWorkerInput, ReviewInput } from "@contexts/generation/application/ports/generation-ports.ts";
import { renderExplorationBrief } from "../qa/exploration-brief";
import { assemble, section, type AssembledPrompt } from "./context-assembler";
import { roleWindowBytes } from "./model-window-catalog";

// Re-export AssembledPrompt so callers that use the assembled variants only need one import.
export type { AssembledPrompt };

// The author's commit message as ONE block: subject + (optionally) body. The body is the richest
// statement of intent; the subject alone is often too terse to derive a concrete objective from. The
// subject is parsed for the TYPE deterministically upstream (first line only — robust against false
// matches in the body); here we just hand the agent the whole message to read as one coherent
// statement. The body is bounded (capText — attacker-influenceable prose with no natural length
// limit) and the whole thing sanitized. CommitIntent.message stays the subject ONLY so the GitHub
// Issue title is a concise one-liner; the agent gets subject+body merged.
function renderCommitMessage(intent: CommitIntent | undefined, includeBody: boolean): string {
  const subject = intent?.message ?? "";
  const body = includeBody ? intent?.body : undefined;
  return sanitizeText(body ? `${subject}\n\n${capText(body)}` : subject).text;
}

// The single source of the "commit to a concrete objective BEFORE writing" rule, shared by the
// single-agent diff task AND the manual task so the wording cannot drift (judgment-day finding: the
// single-agent diff path delegated the objective with no acceptance criterion, while the planner
// already required one — the rigor existed in one path and not the other). Phrased as the OBSERVABLE
// OUTCOME the change introduces — deliberately NOT full given/when/then ceremony, which over-constrains
// a trivial diff (the planner keeps G/W/T for structured multi-objective planning, a different surface).
// It ties the assertion to the CHANGE: the verifiable half of "does the change do what it should" — the
// spec must FAIL if the new behavior regresses (change-coverage then measures this deterministically).
// This is intentionally NOT the unverifiable "your assertion must fail on the pre-commit build" framing
// (the agent only ever runs against live DEV — it cannot check that), which would be an LLM proxy.
const ACCEPTANCE_CRITERION_RULE =
  `Before writing, state in ONE line the concrete, user-observable OUTCOME this change introduces — ` +
  `the specific thing a user can see that proves it works (e.g. "the discounted total shows after the ` +
  `cart re-queries"). Write the test to ASSERT that outcome, not merely that the flow runs: the spec ` +
  `MUST fail if this specific behavior regresses.`;

// ── (functions appended below from the original module, verbatim) ────────────────────────────
// A spec filename derived from a flow, safe for the filesystem and Playwright's testMatch.
export function specFileForFlow(flow: string): string {
  const safe = flow.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "flow";
  return `flows/${safe}.spec.ts`;
}
// Surgical, self-contained instructions for ONE worker. Adapts based on needsUi:
// UI workers transcribe the injected a11y tree — they have NO Playwright MCP and MUST NOT navigate.
// Code-only workers use serena exclusively to derive tests from the affected symbols.
// (Q2: Playwright MCP removed from qa-worker — navigation was ×N expensive, concurrent DEV pressure,
// and the prior 1/7 failure rate was caused by exploration+write competing for the step budget.
// The planner (qa-generator) explores ONCE with the MCP and injects the tree; workers transcribe it.)
//
// Phase 1b: internally uses the ContextAssembler. Return type is unchanged (string).
// Use buildWorkerPromptAssembled() to get the sectionSizes map for telemetry.
export function buildWorkerPromptAssembled(w: ParallelWorkerInput): AssembledPrompt {
  const rules = w.needsUi
    ? [
        w.domSnapshot
          ? `- You have NO browser. The injected a11y tree section in this prompt is your ONLY source of DOM truth — transcribe it directly into selectors; do NOT navigate or snapshot.`
          : `- You have NO browser. No a11y tree was injected — derive selectors from the brief and mark them unverified in a comment (e.g. // selector unverified — no snapshot available).`,
        `- Selector priority: (1) when a tree line's \`-> [attr]\` hint STARTS WITH the configured testIdAttribute name (e.g. \`data-testid=value\`) — not an \`id=\`/\`name=\`/href hint — use \`getByTestId('value')\`; (2) fall back to \`getByRole\`/\`getByLabel\` when no test-id hint is present; (3) no CSS/XPath.`,
        `- Dynamic-DOM: the injected tree is a STATIC snapshot of initial load. Post-interaction elements (modals, dynamic lists) are NOT in this tree — assert them with auto-waiting (\`await expect(locator).toBeVisible()\`, \`waitForURL\`), never \`waitForTimeout\`.`,
        `- getByRole matches the ACCESSIBILITY TREE, not the HTML tag: a <th> is often NOT a "columnheader", a <table> may lose its "table"/"row"/"cell" roles (Bootstrap/CSS strips them). Use ONLY roles + names you LITERALLY SEE in the injected tree; if the role isn't there, use getByText or a scoped locator. A getByRole that matches 0 elements passes review but TIMES OUT on execution.`,
        `- Framework authoring attributes are NOT runtime DOM attributes — never assert them. Examples: Angular's \`routerLink\` is transformed to a rendered \`href\` (assert the \`href\`); \`*ngIf\`, \`ng-reflect-*\`, and \`formControlName\` do not appear in the live DOM (use \`getByLabel\`, \`getByTestId\`, or \`getByRole\` targeting the rendered element instead). The same principle applies to Vue directive attrs and React prop-only attrs. Asserting them always fails at runtime.`,
        `- At least ONE real assertion on the observable OUTCOME (not just a click). Clean up created data via cleanup().`,
      ]
    : [
        `- This is a CODE-ONLY objective (no UI). Read the affected symbols with serena, write unit/integration tests using the repo's test framework.`,
        `- Assert on BEHAVIOR (the correct output for given inputs), not implementation details. Include edge cases from the objective.`,
        `- Do NOT attempt to navigate or use browser tools — you have no Playwright MCP.`,
      ];

  // STABLE prefix: procedural rules for this worker role (stable across turns/runs for same role).
  // The JSON output contract is kept in its own critical-recap section (canonical order places it
  // after volatile content such as learned-rules, so the "lessons precede the JSON contract" invariant
  // is preserved while also reinforcing the contract at the very end of the prompt).
  const rulesBlock = [
    ``,
    `## Rules`,
    ...(w.brief
      ? [`- The Exploration brief already distilled the code — do NOT re-explore it with serena.`]
      : []),
    ...rules,
    `- Do NOT write to the manifest — the orchestrator records metadata. Do NOT read or edit other workers' files.`,
  ].join("\n");

  // CRITICAL recap: JSON output contract repeated at the end (canonical order enforces this).
  const outputContract = `- End your reply with ONLY this JSON: {"spec":"${w.specFile}"}`;

  // TASK header: the critical "file must exist" requirement + objective.
  const taskHeader = [
    `Write ONE test for this objective. Write ONLY your assigned file.`,
    ``,
    `## ⚠ The ONE required outcome: the file exists on disk`,
    `Your step budget is LIMITED. Writing ${w.e2eRelDir}/${w.specFile} with the \`write\` tool is the only`,
    `result that counts — a perfect spec you never wrote is a TOTAL FAILURE (it counts as a phantom and`,
    `the whole flow is dropped). So: WRITE the file EARLY with selectors from the injected tree,`,
    `and only then refine if budget remains. Never end your turn without having written the file.`,
    ``,
    `## Objective`,
    sanitizeText(w.objective).text,
  ].join("\n");

  // SEMI-STABLE: context block (symbols, namespace, brief) — stable for this worker assignment.
  const contextLines = [
    `## Context`,
    `- Flow: ${w.flow}`,
    w.brief
      ? `- The blast radius is distilled in the Exploration brief below — use it; do NOT re-read the code.`
      : `- Affected code symbols (read them with serena): ${w.symbols.join(", ") || "(none specified)"}`,
    `- Namespace prefix for any data you create: ${w.namespace}`,
    `- Write EXACTLY this file: ${w.e2eRelDir}/${w.specFile}  — do not create or edit any other file.`,
    ...(w.needsUi ? [`- Import the shared harness: import { test, expect } from "../fixtures"`] : []),
    ...(w.brief ? [``, renderExplorationBrief(w.brief)] : []),
  ].join("\n");

  // VOLATILE: injected a11y tree (changes per worker assignment based on route capture).
  const domContent = w.needsUi && w.domSnapshot
    ? [
        `## Injected a11y tree (GROUND TRUTH — your ONLY source of DOM truth)`,
        `These are the roles + accessible names the browser ACTUALLY exposes for this flow's route(s).`,
        `You have NO browser MCP. You do NOT need to navigate or snapshot — the tree is below.`,
        `Author selectors ONLY from what appears here (transcribe, do NOT guess).`,
        `ONLY the route(s) printed below are grounded. If your objective also touches a route that is NOT`,
        `shown here, mark that route's selectors unverified (e.g. // selector unverified — route not captured).`,
        `If a role you expected (e.g. \`columnheader\`) is NOT listed, it is NOT in the tree:`,
        `use \`getByText\` or a scoped locator instead. If a name appears MORE THAN ONCE,`,
        `scope it to a unique parent (a bare getByRole/getByText would match multiple → strict-mode error).`,
        `Lines tagged [CHANGED: …] are what THIS change introduced — your objective targets these.`,
        w.domSnapshot,
      ].join("\n")
    : "";

  // VOLATILE: lessons from past runs (injected at call time, may change across runs).
  const learnedRulesContent = w.learnedRules
    ? [`## Lessons learned from past runs (avoid repeating these)`, w.learnedRules].join("\n")
    : "";

  // Stitcher→Generation seam (design §3.4/A.3, Slice A — structural-signals-expansion): worker-scoped
  // mirror of the single-agent S2.4 "Cross-service links" section. Same local s() sanitizer / caps /
  // gating discipline; the worker builder has NO isGenerationMode gate (workers always generate), so
  // that guard is dropped here. Dormant today — nothing constructs a worker with these fields yet.
  const s = (x: unknown): string => sanitizeText(String(x ?? "")).text;
  const MAX_LINKS = 40;
  const MAX_DRIFT = 20;
  const hasLinks = Boolean(w.serviceLinks?.length);
  const hasDrift = Boolean(w.contractDrift?.length);
  // Slice C (structural-signals-expansion, design §3.6) worker counterpart: extends this SAME
  // section with inline "[IMPACTED:<tier>]" markers on matched bullets — NOT a new/duplicate
  // subsection, mirroring the single-agent S2.4 section exactly. The lookup key matches the
  // bullet's own from/to identity exactly; built ONCE, byte-identical when crossRepoImpact is
  // absent (empty map -> tierFor always undefined -> prefix always "").
  const linkKey = (l: { from: { repo: string; file: string; symbol: string }; to: { repo: string } }): string =>
    `${l.from.repo}/${l.from.file}#${l.from.symbol}->${l.to.repo}`;
  const impactedTierByKey = new Map(
    (w.crossRepoImpact?.impactedLinks ?? []).map(({ link, tier }) => [linkKey(link), tier] as const),
  );
  const tierFor = (l: { from: { repo: string; file: string; symbol: string }; to: { repo: string } }): string | undefined =>
    impactedTierByKey.get(linkKey(l));
  // A link's [IMPACTED:tier] marker must survive the MAX_LINKS ceiling: the resolver returns links
  // in discovery order, so on a >MAX_LINKS app the one impacted link can sit past the cut and lose
  // the exact annotation this run exists to surface. Impacted links render first (stable order
  // inside each partition); an empty impacted set skips the reorder — byte-identical when absent.
  const orderedLinks =
    impactedTierByKey.size > 0 && hasLinks
      ? [
          ...w.serviceLinks!.filter((l) => tierFor(l) !== undefined),
          ...w.serviceLinks!.filter((l) => tierFor(l) === undefined),
        ]
      : w.serviceLinks ?? [];
  const workerServiceLinksContent =
    hasLinks || hasDrift
      ? [
          "## Cross-service links (deterministic — from the stitcher, advisory)",
          "Structural FE→BE contract links resolved from the code, NOT a gate. Verify against the live app; absent links do NOT imply no dependency.",
          "",
          ...(hasLinks
            ? orderedLinks.slice(0, MAX_LINKS).map((l) => {
                const tier = tierFor(l);
                return `- ${tier ? `[IMPACTED:${s(tier)}] ` : ""}\`${s(l.from.repo)}/${s(l.from.file)}#${s(l.from.symbol)}\` -> ` +
                  `${s(l.to.repo)} ${s(l.contractRef ?? l.to.symbol)} (${s(l.transport)}, confidence ${l.confidence.toFixed(2)})`;
              })
            : []),
          ...(hasDrift
            ? ["", "### Contract drift (WARNINGS — front calls an endpoint the backend contract does not declare):",
               ...w.contractDrift!.slice(0, MAX_DRIFT).map((d) =>
                 `- WARNING: \`${s(d.from.repo)}/${s(d.from.file)}#${s(d.from.symbol)}\` calls ${s(d.verb)} ${s(d.path)} — not in the contract`)]
            : []),
        ].join("\n")
      : "";

  return assemble([
    // STABLE prefix: procedural rules (deterministic given the worker role + needsUi).
    section("worker-rules", "stable-prefix", rulesBlock, { priority: 1, cacheable: true }),
    // SEMI-STABLE: objective + context (changes per worker assignment but stable within a turn).
    section("worker-context", "semi-stable", contextLines, { priority: 1 }),
    // SEMI-STABLE: static signal — same priority/role as the single-agent path (priority 3).
    ...(w.staticSignal ? [section("static-signal", "semi-stable", w.staticSignal, { priority: 3 })] : []),
    // Stitcher→Generation seam (design §3.4/A.3): priority 3 alongside static-signal, matching the
    // single-agent S2.4 precedent exactly.
    ...(workerServiceLinksContent ? [section("worker-service-links", "semi-stable", workerServiceLinksContent, { priority: 3 })] : []),
    // VOLATILE: injected DOM (changes per captured route snapshot).
    ...(domContent ? [section("worker-dom", "volatile", domContent, { priority: 1 })] : []),
    // VOLATILE: learned rules (changes as the learning layer accumulates knowledge).
    ...(learnedRulesContent ? [section("worker-learned-rules", "volatile", learnedRulesContent, { priority: 2 })] : []),
    // TASK: the write mandate + concrete objective.
    section("worker-task", "task", taskHeader, { priority: 1 }),
    // CRITICAL recap: output contract at the end so it is the last thing the agent sees before replying.
    section("worker-output-contract", "critical-recap", outputContract, { priority: 1 }),
  ], { budgetBytes: roleWindowBytes("qa-worker") });
}

export function buildWorkerPrompt(w: ParallelWorkerInput): string {
  return buildWorkerPromptAssembled(w).text;
}
// return STRUCTURED objectives (no spec files). It must question its own list (drop naive flows,
// keep main use cases + MVP happy paths + relevant edge cases).
//
// Phase 1b: internally uses the ContextAssembler. Return type is unchanged (string).
// Use buildPlanPromptAssembled() to get the sectionSizes map for telemetry.
export function buildPlanPromptAssembled(input: OpencodeRunInput): AssembledPrompt {
  // SEMI-STABLE: architecture map (stable for this run; changes between runs as the context evolves).
  const contextMapContent = input.contextMap
    ? [
        ``,
        `## Architecture map (FE↔BE — authoritative; distil the relevant links into each brief)`,
        renderArchitectureContext(input.contextMap, input.mode === "diff" ? input.intent?.changedFiles : undefined) ?? "",
        ``,
        `IMPORTANT — each brief's \`routes[].path\` MUST be the CONCRETE, directly-navigable URL the`,
        `worker will \`page.goto(...)\` (include any SPA/hash prefix, e.g. "/#!/owners"; for a parameterized`,
        `route use a real existing instance, e.g. "/#!/owners/1"), NOT the abstract pattern. The orchestrator`,
        `renders these to capture the live DOM for the workers, so an abstract or wrong route yields no grounding.`,
      ].join("\n")
    : "";

  // SEMI-STABLE: lessons from past runs (stable for this run; evolves between runs).
  const lessonsContent = input.learnedRules
    ? [``, `## Lessons learned from past runs (factor these into the objectives you plan)`, input.learnedRules].join("\n")
    : "";

  // CRITICAL recap: the output format that must appear at the very end.
  // For diff/manual the planner should say "no testable flow" when nothing applies;
  // for complete/exhaustive it should say "already covered".
  const outputFormatContent = (input.mode === "diff" || input.mode === "manual")
    ? [
        `## Output — end with ONLY this JSON (no spec files):`,
        `{"objectives":[{"flow":"checkout","objective":"given a cart with >10 items, when paying, then the bulk discount is applied and the order is created","needsUi":true,"brief":{"builtForSha":"<the sha above>","objective":"…","blastRadius":[{"symbol":"CheckoutService.pay","file":"src/checkout/checkout.service.ts","role":"applies the bulk discount and creates the order"}],"routes":[{"path":"/#!/checkout"}],"feBe":[{"route":"/checkout","operationId":"createOrder","via":"OrderClient.create"}],"contracts":[{"operationId":"createOrder","method":"POST","path":"/orders","fields":["items","total"]}],"risks":["assert the discounted total AFTER the cart re-queries"]}}]}`,
        input.mode === "diff"
          ? `If the commit's change is not testable through a user flow, output {"objectives":[],"reason":"<one-line explanation>"}.`
          : `If the guidance does not yield any testable flow, output {"objectives":[],"reason":"<one-line explanation>"}.`,
        `When returning an empty objectives array, ALWAYS include a one-line "reason" explaining why there is nothing to test.`,
      ].join("\n")
    : [
        `## Output — end with ONLY this JSON (no spec files):`,
        `{"objectives":[{"flow":"checkout","objective":"given a cart with >10 items, when paying, then the bulk discount is applied and the order is created","needsUi":true,"brief":{"builtForSha":"<the sha above>","objective":"…","blastRadius":[{"symbol":"CheckoutService.pay","file":"src/checkout/checkout.service.ts","role":"applies the bulk discount and creates the order"}],"routes":[{"path":"/#!/checkout"}],"feBe":[{"route":"/checkout","operationId":"createOrder","via":"OrderClient.create"}],"contracts":[{"operationId":"createOrder","method":"POST","path":"/orders","fields":["items","total"]}],"risks":["assert the discounted total AFTER the cart re-queries"]}}]}`,
        `If every important flow is already well covered, output {"objectives":[],"reason":"<one-line explanation>"}.`,
        `When returning an empty objectives array, ALWAYS include a one-line "reason" explaining why there is nothing to test.`,
      ].join("\n");

  // FIX 3: when the orchestrator already ran the read-only explorer pass (exploreForPack), its brief
  // is forwarded here as input.contextBrief. The planner must USE it — the blast radius is already
  // distilled — instead of paying for a second full Serena widen (find_referencing_symbols) that
  // re-derives the same thing the explorer just produced. The brief is rendered as its own SEMI-STABLE
  // section, and step 1 of the procedure switches to "trust the brief" when present.
  const planBriefContent = input.contextBrief
    ? [
        ``,
        `## Exploration brief (the blast radius was pre-mapped by the explorer pass — use it; do NOT redo the explorer's work)`,
        renderExplorationBrief(input.contextBrief),
        `Derive the objectives DIRECTLY from this brief's blast radius and routes. Do NOT re-run`,
        `find_referencing_symbols to re-derive the same blast radius — that redoes the explorer's work`,
        `and burns the planning budget. Exception: if the brief is clearly incomplete for a specific`,
        `changed symbol (e.g. a key file is absent from the blast radius), you MAY run ONE targeted`,
        `find_referencing_symbols call for that symbol only, then stop.`,
        ``,
      ].join("\n")
    : "";

  if (input.mode === "diff") {
    // STABLE prefix: the planning procedure (same structure for every diff-mode plan session).
    const planProcedure = [
      `## Phase 1 of 2 — PLANNING ONLY. Do NOT write any .spec.ts in this phase.`,
      input.contextBrief
        ? `1. The blast radius is pre-mapped in the Exploration brief below — derive the affected user flows by REASONING over it (with the commit intent/diff). Do NOT redo the explorer's work: do NOT activate serena, do NOT re-run find_referencing_symbols wholesale, do NOT re-analyze the repo. Exception: if the brief is clearly incomplete for a specific changed symbol, you MAY run ONE targeted find_referencing_symbols for that symbol only, then stop.`
        : `1. Activate serena (activate_project). Read the commit intent and diff below; derive the\n   affected user flows (use find_referencing_symbols to widen from the changed symbols).`,
      `2. Plan one objective per INDEPENDENT affected flow. Do NOT plan flows the commit does not`,
      `   touch; if everything fits one flow, return a single objective.`,
      `   Each objective is a concrete acceptance criterion in given/when/then form, with the code`,
      `   symbols it exercises. Set "needsUi": true when the flow involves page navigation or DOM`,
      `   interaction, and "needsUi": false for pure logic.`,
      `3. For each objective, include a distilled "brief" of its blast radius so the worker does NOT`,
      `   re-read the code: blastRadius (each touched symbol with its file + a ONE-LINE role), the FE↔BE`,
      `   links, the relevant contract facts (fields/enums/errors to assert), and risks/what-to-assert.`,
      `   Set the brief's builtForSha to ${input.sha}. The worker trusts the brief for CODE but still`,
      `   transcribes selectors from the injected a11y tree (workers have no browser MCP).`,
      `4. For each needsUi objective, declare its candidate entry routes in the brief's \`routes[]\`:`,
      `   the CONCRETE, directly-navigable URL the worker will page.goto(...) (include any SPA/hash`,
      `   prefix, e.g. "/#!/owners"; for a parameterized route use a real instance, e.g. "/#!/owners/1").`,
      `   Derive them from the code and the architecture map — do NOT navigate or open a browser. The`,
      `   orchestrator renders these routes to capture the live DOM and injects each objective's tree`,
      `   into its worker.`,
    ].join("\n");

    // SEMI-STABLE: the change intent + diff (specific to this commit but stable within this planning session).
    // The planner derives the worker objectives from the commit intent, so it must read the FULL
    // message (subject + body) via the shared renderCommitMessage helper — the same form buildTask
    // and buildExplorerPrompt use. The body is the richest statement of intent; rendering only the
    // subject (the old `- Message:` line) is exactly the drift the helper exists to prevent. The
    // planner is always a first pass (never a regen), so the body is included.
    const changeContent = [
      `## Change intent (Conventional Commits)`,
      `- Type: ${input.intent?.type ?? "unknown"}${input.intent?.breaking ? " (BREAKING)" : ""}`,
      `- Changed files: ${sanitizeText(input.intent?.changedFiles?.join(", ") ?? "").text || "(unknown)"}`,
      ``,
      `## Commit message (the author's intent — derive each objective from this)`,
      renderCommitMessage(input.intent, true),
      ``,
      `## Commit diff`,
      "```diff",
      sanitizeText(input.diff).text,
      "```",
      ...(input.service
        ? [
            ``,
            `## Cross-repo change (microservice)`,
            `The commit belongs to the microservice ${input.service.repo} (read-only working copy at`,
            `${input.service.mirrorDir}). Plan objectives for the FRONTEND flows that exercise the`,
            `changed service behavior through the UI.`,
          ]
        : []),
    ].join("\n");

    // TASK: the opening line that names what this session is doing.
    const taskContent = `Plan E2E test objectives for the blast radius of commit ${input.sha} of ${input.repo}.`;

    return assemble([
      section("plan-procedure", "stable-prefix", planProcedure, { priority: 1, cacheable: true }),
      section("plan-change", "semi-stable", changeContent, { priority: 1, language: "verbatim" }),
      // FIX 3: the explorer's distilled brief (priority 1 so it ranks alongside the change scope — the
      // planner reads it instead of re-widening). Absent when no orchestrator-level explorer ran.
      ...(planBriefContent ? [section("plan-brief", "semi-stable", planBriefContent, { priority: 1 })] : []),
      ...(contextMapContent ? [section("plan-arch-map", "semi-stable", contextMapContent, { priority: 2, cacheable: true })] : []),
      // Seam d: plan-lessons priority p3→p2 so it sheds AFTER plan-arch-map (p2 declared first,
      // stable sort) — aligns planner with the same signal-value hierarchy as the generator path.
      ...(lessonsContent ? [section("plan-lessons", "semi-stable", lessonsContent, { priority: 2 })] : []),
      section("plan-task", "task", taskContent, { priority: 1 }),
      section("plan-output-format", "critical-recap", outputFormatContent, { priority: 1 }),
    ], { budgetBytes: roleWindowBytes("qa-generator") });
  }

  // manual mode — the scope is the user's guidance, not a commit diff or whole-repo scan.
  // The planner decomposes the guidance into independent flow objectives so large manual
  // scopes fan out to workers the same way diff does. This is the unified diff/manual engine
  // (Phase 5): only objective derivation differs (guidance vs commits), not the plan→dispatch logic.
  if (input.mode === "manual") {
    const guidance = sanitizeText((input.guidance ?? "(no guidance provided)").trim()).text;

    // STABLE prefix: planning procedure for guidance-scoped runs.
    const manualPlanProcedure = [
      `## Phase 1 of 2 — PLANNING ONLY. Do NOT write any .spec.ts in this phase.`,
      input.contextBrief
        ? `1. The blast radius is pre-mapped in the Exploration brief below — derive the affected flows by REASONING over it (with the guidance). Do NOT redo the explorer's work: do NOT re-run find_referencing_symbols wholesale and do NOT re-analyze the blast radius. Exception: if the brief is clearly incomplete for a specific symbol the guidance covers, you MAY run ONE targeted find_referencing_symbols for that symbol only, then stop. You MAY also read the existing suite in ${input.e2eRelDir}/ to avoid duplicating already-covered flows.`
        : `1. Activate serena (activate_project). Read the guidance below and the existing suite in\n   ${input.e2eRelDir}/ to understand the scope.`,
      `2. Plan one objective per INDEPENDENT affected flow that the guidance asks to test. Stay`,
      `   strictly within the guidance scope; do NOT plan flows the guidance does not mention.`,
      `   If everything fits one flow, return a single objective.`,
      `   Each objective is a concrete acceptance criterion in given/when/then form, with the code`,
      `   symbols it exercises. Set "needsUi": true when the flow involves page navigation or DOM`,
      `   interaction, and "needsUi": false for pure logic.`,
      `3. For each objective, include a distilled "brief" of its blast radius so the worker does NOT`,
      `   re-read the code: blastRadius (each touched symbol with its file + a ONE-LINE role), the FE↔BE`,
      `   links, the relevant contract facts (fields/enums/errors to assert), and risks/what-to-assert.`,
      `   Set the brief's builtForSha to ${input.sha}. The worker trusts the brief for CODE but still`,
      `   transcribes selectors from the injected a11y tree (workers have no browser MCP).`,
      `4. For each needsUi objective, declare its candidate entry routes in the brief's \`routes[]\`:`,
      `   the CONCRETE, directly-navigable URL the worker will page.goto(...) (include any SPA/hash`,
      `   prefix, e.g. "/#!/owners"). Derive them from the code and the existing suite — do NOT navigate`,
      `   or open a browser. The orchestrator renders these routes to capture the live DOM and injects`,
      `   each objective's tree into its worker.`,
    ].join("\n");

    // SEMI-STABLE: the guidance (verbatim user input — the scope driver for manual mode).
    const guidanceContent = [
      `## Guidance (the user's instruction — derive ALL objectives from this)`,
      guidance,
    ].join("\n");

    // TASK: the opening line naming what this session is doing.
    const manualTaskContent = `Plan E2E test objectives for ${input.repo} guided by the instruction above.`;

    return assemble([
      section("plan-procedure", "stable-prefix", manualPlanProcedure, { priority: 1, cacheable: true }),
      section("plan-guidance", "semi-stable", guidanceContent, { priority: 1, language: "verbatim" }),
      // FIX 3: same brief-reuse as diff — the explorer pass already mapped the blast radius for manual.
      ...(planBriefContent ? [section("plan-brief", "semi-stable", planBriefContent, { priority: 1 })] : []),
      ...(contextMapContent ? [section("plan-arch-map", "semi-stable", contextMapContent, { priority: 2, cacheable: true })] : []),
      // Seam d: plan-lessons priority p3→p2 so it sheds AFTER plan-arch-map (p2 declared first,
      // stable sort) — aligns planner with the same signal-value hierarchy as the generator path.
      ...(lessonsContent ? [section("plan-lessons", "semi-stable", lessonsContent, { priority: 2 })] : []),
      section("plan-task", "task", manualTaskContent, { priority: 1 }),
      section("plan-output-format", "critical-recap", outputFormatContent, { priority: 1 }),
    ], { budgetBytes: roleWindowBytes("qa-generator") });
  }

  // complete / exhaustive mode
  const exhaustive = input.mode === "exhaustive";

  // STABLE prefix: the planning procedure for complete/exhaustive.
  const wholeProcedure = [
    `## Phase 1 of 2 — PLANNING ONLY. Do NOT write any .spec.ts in this phase.`,
    `1. Activate serena (activate_project) and build a COVERAGE + IMPORTANCE map: read the existing`,
    `   specs in ${input.e2eRelDir}/ and the app code (get_symbols_overview, find_symbol,`,
    `   find_referencing_symbols) to find the important user flows and which are NOT covered.`,
    `2. Persist this map to ${input.e2eRelDir}/.qa/analysis.json (flows, covered vs uncovered,`,
    `   importance, lastSha:"${input.sha}"); update it incrementally if it already exists.`,
    exhaustive
      ? `3. Plan objectives for EVERY important flow (the suite is regenerated from scratch).`
      : `3. Plan objectives ONLY for the important UNCOVERED flows (the delta over the existing suite).`,
    `   QUESTION your own list before finalizing: drop trivial/naive items (a single button, static`,
    `   content); KEEP the main use cases, the MVP happy paths, AND the relevant edge cases`,
    `   (boundaries, error paths, negative/invalid input). Each objective is a concrete acceptance`,
    `   criterion in given/when/then form, with the code symbols it exercises.`,
    `   For each objective, set "needsUi": true when the flow involves page navigation or DOM`,
    `   interaction, and "needsUi": false for pure logic (validation, calculation, data transformation).`,
    `   For each objective, include a distilled "brief" of its blast radius (blastRadius: each touched`,
    `   symbol with its file + a ONE-LINE role; plus FE↔BE links, relevant contract facts, and risks)`,
    `   so the worker does NOT re-read the code. Set the brief's builtForSha to ${input.sha}.`,
  ].join("\n");

  // TASK: the opening line naming what this session is doing.
  const wholeTaskContent = exhaustive
    ? `Audit the ENTIRE E2E suite of ${input.repo} and plan a full regeneration.`
    : `Analyze the WHOLE repository ${input.repo} and plan where to GROW the E2E suite.`;

  return assemble([
    section("plan-procedure", "stable-prefix", wholeProcedure, { priority: 1, cacheable: true }),
    ...(contextMapContent ? [section("plan-arch-map", "semi-stable", contextMapContent, { priority: 2, cacheable: true })] : []),
    // Seam d: plan-lessons priority p3→p2 so it sheds AFTER plan-arch-map (p2 declared first,
    // stable sort) — aligns complete/exhaustive planner with the same signal-value hierarchy as
    // the diff and manual planner paths.
    ...(lessonsContent ? [section("plan-lessons", "semi-stable", lessonsContent, { priority: 2 })] : []),
    section("plan-task", "task", wholeTaskContent, { priority: 1 }),
    section("plan-output-format", "critical-recap", outputFormatContent, { priority: 1 }),
  ], { budgetBytes: roleWindowBytes("qa-generator") });
}

export function buildPlanPrompt(input: OpencodeRunInput): string {
  return buildPlanPromptAssembled(input).text;
}

// Fase 3: the dynamic task for the read-only explorer (single-agent diff path). The "how" + the
// ExplorationBrief schema live in agents/agent/qa-explorer.md; here we hand it the change to map.
export function buildExplorerPrompt(input: OpencodeRunInput): string {
  // FIX 2: in manual mode there is no commit diff — the scope is the user's guidance. Rendering the
  // (empty) diff would give the explorer nothing to map, so its brief would be empty and the manual
  // Context Pack would carry no grounding. Drive the exploration from the guidance instead.
  if (input.mode === "manual") {
    const guidance = sanitizeText((input.guidance ?? "(no guidance provided)").trim()).text;
    return [
      `Explore the blast radius of the following GUIDANCE for ${input.repo} and return a distilled ExplorationBrief.`,
      `You are READ-ONLY: do NOT write tests or any file. Map the affected flows, then emit ONLY the brief JSON.`,
      ``,
      `## Guidance (the user's instruction — the scope to explore)`,
      guidance,
      ``,
      `Use serena (activate_project, find_symbol, find_referencing_symbols) to locate the code that`,
      `implements the guidance's flows and map its blast radius. Stay strictly within the guidance scope.`,
      ...(input.baseUrl ? [``, `Route context only — you do NOT navigate; selectors stay unverified. LIVE DEV URL: ${input.baseUrl}`] : []),
      ...(input.service
        ? [``, `## Cross-repo (microservice)`, `Related service: ${input.service.repo} (read-only copy at ${input.service.mirrorDir}). Map the FRONTEND flows that exercise it.`]
        : []),
      ``,
      `## Output — set builtForSha to ${input.sha}; end with ONLY the ExplorationBrief JSON (schema in your role prompt).`,
    ].join("\n");
  }
  return [
    `Explore the blast radius of commit ${input.sha} of ${input.repo} and return a distilled ExplorationBrief.`,
    `You are READ-ONLY: do NOT write tests or any file. Map the change, then emit ONLY the brief JSON.`,
    ``,
    `## Change intent (Conventional Commits)`,
    `- Type: ${input.intent?.type ?? "unknown"}${input.intent?.breaking ? " (BREAKING)" : ""}`,
    `- Changed files: ${sanitizeText(input.intent?.changedFiles?.join(", ") ?? "").text || "(unknown)"}`,
    ``,
    `## Commit message (the author's intent — subject + body)`,
    renderCommitMessage(input.intent, true),
    ``,
    `## Commit diff`,
    "```diff",
    sanitizeText(input.diff).text,
    "```",
    ...(input.baseUrl ? [``, `Route context only — you do NOT navigate; selectors stay unverified. LIVE DEV URL: ${input.baseUrl}`] : []),
    ...(input.service
      ? [``, `## Cross-repo change (microservice)`, `The change is in ${input.service.repo} (read-only copy at ${input.service.mirrorDir}). Map the FRONTEND flows that exercise it.`]
      : []),
    ``,
    `## Output — set builtForSha to ${input.sha}; end with ONLY the ExplorationBrief JSON (schema in your role prompt).`,
  ].join("\n");
}

// Assembles the dynamic message for the agent. The "how" lives in
// agents/agent/qa-generator.md and the skills; only the task + context go here.
// The diff/guidance are sanitized (cheap defense in depth).
//
// Phase 1b: internally uses the ContextAssembler (P3 canonical order fix). Return type
// is unchanged (string). Use buildPromptAssembled() to get the sectionSizes map for telemetry.
// JD-C3: `hasInjectedGrounding` is a coarse boolean — the injected grounding (Context Pack ≤6 routes /
// failure DOM ≤4 routes) may NOT cover the route a regen must touch. To avoid suppressing navigation
// into a blind/wrong fix, every grounded regen branch carries this explicit anti-blinding escape.
const GROUNDING_UNCOVERED_ESCAPE =
  `If a route you must touch is NOT represented in the injected grounding above, you MUST still ` +
  `browser_navigate that specific route before writing its selectors — never guess them.`;

// C1: renders the runtime evidence (httpStatus/finalUrl/runtimeErrors — captured by the
// orchestrator, see QaCase in ../types.ts) already carried on a failing case, so a fix-cases
// regen prompt can tell an app defect (5xx, console error) apart from a test defect instead of
// seeing only the Playwright error `detail`. Matches the fix-cases section's existing convention
// of NOT running `detail` through sanitizeText (only truncating) — these fields come from the
// SAME orchestrator-captured evidence, not user input.
function renderFixCaseEvidenceLines(c: QaCase): string[] {
  const lines: string[] = [];
  if (c.httpStatus !== undefined || c.finalUrl !== undefined) {
    const statusPart = c.httpStatus !== undefined ? `HTTP ${c.httpStatus}` : "HTTP (unknown)";
    const urlPart = c.finalUrl !== undefined ? ` at ${c.finalUrl}` : "";
    lines.push(`  ${statusPart}${urlPart}`);
  }
  if (c.runtimeErrors?.length) {
    for (const e of c.runtimeErrors.slice(0, 3)) {
      lines.push(`  [${e.type}] ${e.text.slice(0, 200)}`);
    }
  }
  return lines;
}

export function buildPromptAssembled(input: OpencodeRunInput): AssembledPrompt {
  const isGenerationMode = input.mode !== "context";
  const openapiHint = Array.isArray(input.openapi) ? input.openapi.join(", ") : input.openapi;
  const isCode = input.target === "code";
  const memTarget = input.mode === "context" ? "context" : input.target;
  // RE-1: the prompt carries authoritative grounding when a Context Pack (with its DOM slice) or an
  // injected a11y tree is present — in that case the regeneration prompts must NOT command a
  // re-navigation/re-orientation (the agent fixes from the injected grounding instead).
  const hasInjectedGrounding = isGenerationMode && Boolean(input.contextPack || input.domSnapshot);
  // RE-1: a re-generation turn (fix / reviewer-corrections / coverage-gap) has already explored and
  // distilled the blast radius — it must not re-activate serena or re-skim the repo.
  const isReGen =
    isGenerationMode &&
    Boolean(input.fixCases?.length || input.reviewCorrections?.length || input.coverageGap);

  // STABLE prefix: working rules for the generator role (mode-specific but stable within a session).
  const workingRulesLines: string[] = [
    `## Working rules`,
    ...(input.mode === "context"
      ? [
          `- This is a CONTEXT mode run: you are building the FE↔BE architecture map, not writing tests.`,
          `- Your ONLY output is ${input.e2eRelDir}/.qa/context.json — do not create or modify any .spec.ts files.`,
          `- Use ONLY serena to read code (activate_project, find_symbol, get_symbols_overview) — no Playwright MCP.`,
          `- Extract from STRUCTURED sources: every route from a routing file, every operation from an OpenAPI spec.`,
          `- Consult the architecture-mapping skill for detailed extraction patterns per source type.`,
          `- The task block in this prompt has the complete procedure. Follow it precisely.`,
        ]
      : isCode
      ? [
          `- This is a CODE mode run: you are testing source-code logic, not a deployed web app.`,
          `- Detect the test framework from the repo's dependencies. Read 2-3 existing test files for conventions. Match them exactly.`,
          `- Place generated tests alongside existing ones. Use the repo's existing test command. Do not install new dependencies.`,
          `- In your closing verdict JSON, include specMetas with {file, flow, objective, targets} for each spec so the orchestrator can write the manifest deterministically.`,
          `- Classify each affected symbol:`,
          `  * Pure function → unit test: call with inputs, assert outputs`,
          `  * Module with deps → integration test: real module + test doubles`,
          `  * Handler/endpoint → integration test: test client, real request, assert status + body`,
          `  * Trivial delegation/getter/setter → skip`,
          `- Assert on BEHAVIOR, not implementation. Include edge cases from the diff.`,
          `- One objective per test, derived from commit intent. Use realistic test data.`,
          `- Never write a test whose only assertion is "does not throw".`,
          `- COMPILE-CHECK before finishing: after writing/fixing the tests, compile them with the project's build tool (mvn -B test-compile · gradle testClasses · go vet ./... · cargo check --tests · npx tsc --noEmit) and FIX any errors BEFORE emitting your verdict. The orchestrator runs the suite only AFTER you finish — a compile failure costs a full regeneration round, so a clean compile is cheaper than a fix loop.`,
        ]
      : [
          `- Work in the repo's tests folder: ${input.e2eRelDir}/ (source of truth in git). Reuse and improve existing fixtures/specs; do not duplicate.`,
          `- In your closing verdict JSON, include specMetas with {file, flow, objective, targets} for each spec. The orchestrator writes the manifest deterministically from these.`,
          `- Test-data prefix: ${input.namespace}`,
          `- LIVE DEV URL: ${input.baseUrl ?? "(not provided — ABORT and report infra-error: no base URL)"}`,
          `  In the SPEC files, reach the app via the PW_BASE_URL env var (the orchestrator sets it at run time).`,
          ...(input.contextPack
            ? [
                `- A Context Pack (blast-radius + DOM slice + contracts) was pushed into this prompt by the`,
                `  orchestrator BEFORE this session started. Where the pack supplies the DOM for a route,`,
                `  TRANSCRIBE selectors directly from the "Live DOM" section — do NOT use browser_navigate or`,
                `  browser_snapshot on routes already covered in the pack (the ground truth is already here).`,
                `  For routes NOT covered in the pack (not listed in the DOM section), use the Playwright MCP`,
                `  to explore the live page before writing selectors.`,
              ]
            : input.domSnapshot
            ? [
                `- An injected a11y tree is provided below (the ground truth for the affected routes) —`,
                `  transcribe selectors from it; do NOT browser_navigate a route it covers. Use the Playwright`,
                `  MCP only for a route NOT present in that tree.`,
              ]
            : [
                `- Playwright MCP is AVAILABLE and you MUST use it BEFORE writing any test: browser_navigate to`,
                `  the LIVE DEV URL above, then browser_snapshot to read the ACTUAL DOM. Selectors MUST be verified`,
                `  against the real DOM, NEVER invented from code analysis alone.`,
              ]),
          `- Also inspect runtime signals with the Playwright MCP: browser_console_messages (catch JS errors`,
          `  and warnings — a console error on the changed flow is a real bug signal) and browser_network_requests`,
          `  (read the actual API calls/responses the flow makes, and assert against their real shape — status,`,
          `  required fields, error responses — not invented contracts). Drive the backend through the UI only.`,
          `- Consult the playwright-authoring skill for robust specs and this app's capabilities.`,
          ...(openapiHint
            ? [
                `- OpenAPI contract(s) for this repo: ${openapiHint}. For any backend endpoint the affected flow touches, read the matching operation and assert against its contract (required fields, enums, validation/error responses). Drive the app through the web UI like a user — never call the API directly.`,
              ]
            : []),
          // A3: selector-priority rule in the STABLE band — fires regardless of whether a DOM snapshot
          // was captured. When a DOM snapshot IS present, its section already contains a `-> [attr]`
          // hint for getByTestId; this stable rule is concise (no duplication of the tree guidance).
          // Audit C4a defect 1: `-> [attr]` hints are ALSO emitted for id=/name=/href/type= (see
          // buildAttrHint in dom-snapshot.ts) — only a hint STARTING WITH the testIdAttribute name
          // (e.g. "data-testid=value") is a test-id hint; other hints must NOT trigger getByTestId.
          `- Selector priority: (1) getByTestId when the tree line's \`-> [attr]\` hint STARTS WITH the configured testIdAttribute name (e.g. \`data-testid=value\`) — an \`id=\`/\`name=\`/href hint does NOT qualify; (2) getByRole / getByLabel when no test-id hint; (3) getByText for text-only elements; (4) scoped CSS/locator only as last resort. No raw CSS classes or XPath — these break on refactor.`,
        ]),
    `- engram memory: scoped per app AND per mode (e2e, code, or context). Use project="${input.appName}" on ALL mem_save, mem_search, mem_context, and mem_session_summary calls. Prefix every topic_key with "${memTarget}/" so each mode's memory lives in its own namespace (e.g. topic_key="context/angular-routes" or "e2e/checkout-flow"). When searching, include "${memTarget}" in the query text to filter results to this mode. Never save or search without the mode prefix.`,
    input.needsReview
      ? `- An INDEPENDENT reviewer judges your specs after you finish and may return corrections for a follow-up turn. Self-review against the test-value-review criteria BEFORE finishing (every spec must fail if its feature breaks); do not rely on spawning a subagent.`
      : `- Review disabled for this run.`,
  ];
  const workingRulesContent = workingRulesLines.join("\n");

  // SEMI-STABLE: architecture map (stable for this run, changes between runs).
  // Seam c: when a Context Pack is present, its blast-radius section already contains FE↔BE links;
  // pass suppressFeBeLinks:true to renderArchitectureContext so it omits the arch-map FE↔BE block,
  // keeping "FE↔BE links" rendered at most twice across the assembled prompt (pack + context-brief).
  const archMapContent = input.contextMap
    ? [
        renderArchitectureContext(
          input.contextMap,
          input.mode === "diff" ? input.intent?.changedFiles : undefined,
          { suppressFeBeLinks: !!input.contextPack },
        ) ?? "",
        ``,
      ].join("\n")
    : "";

  // SEMI-STABLE: exploration brief (set by the pre-write explorer pass; stable for this turn).
  // D3 fix: when a Context Pack is also present, the pack already carries FE↔BE links; pass
  // suppressFeBe:true so the brief's FE↔BE section is omitted and the deduplication budget is
  // freed for other signal. When only the brief is present, feBe renders normally.
  const contextBriefContent = input.contextBrief
    ? [
        renderExplorationBrief(input.contextBrief, { suppressFeBe: !!input.contextPack }),
        `(The brief above distilled the blast radius — do NOT re-read that code. Verify selectors against the live DOM.)`,
        ``,
      ].join("\n")
    : "";

  // VOLATILE: Live DEV accessibility tree of the target routes — the DETERMINISTIC ground truth for
  // selectors. When `failureSourced` is true, the domSnapshot is the captured failure-point tree
  // (not a live pre-write snapshot); the heading switches to "GROUND TRUTH AT FAILURE" and
  // source-framing, counterfactual, and quote-then-assert instructions are prepended (design §6.1).
  const domContent = input.domSnapshot && isGenerationMode
    ? input.failureSourced
      ? [
          `## GROUND TRUTH AT FAILURE`,
          ``,
          `The tree below is the page AT THE FAILURE POINT — the ONLY source of truth for this fix.`,
          `Do NOT use general knowledge of what tables, forms, or components usually contain.`,
          `The ACTUAL rendered tree is what matters, and it is captured below.`,
          ``,
          `⚠ Counterfactual warning: even if element types commonly expose a given role`,
          `(e.g. tables commonly expose \`columnheader\`, forms commonly expose \`textbox\`),`,
          `if THIS tree does NOT show it — trust the tree, not the convention. The live page`,
          `may use CSS \`role="presentation"\` or a custom component that drops standard roles.`,
          ``,
          `📌 Quote-then-assert contract: before writing any locator, cite the EXACT \`role: name\``,
          `line from the tree below that the locator relies on. An unquotable locator`,
          `(i.e. no matching line exists in this tree) MUST be rejected and replaced with a`,
          `\`getByText\` locator quoted from the SAME tree — text visible in the tree below. NEVER`,
          `invent a CSS selector or data-testid value that is not present in this grounding.`,
          ``,
          input.domSnapshot,
          ``,
        ].join("\n")
      : [
          `## Live DEV accessibility tree (GROUND TRUTH for selectors — trust this over HTML intuition)`,
          ``,
          `These are the roles + accessible names the browser ACTUALLY exposes for the target routes.`,
          `Lines may carry a trailing \`-> [attr=…]\` hint — it can show id=, name=, href, or type= as well as`,
          `the test-id attribute, so only a hint that STARTS WITH the configured testIdAttribute name (e.g.`,
          `\`data-testid=value\`) means \`getByTestId('value')\` will resolve; an \`id=\`/\`name=\`/href/type= hint does`,
          `NOT qualify — use \`getByRole\`/\`getByLabel\` with the accessible name from the tree instead.`,
          `When no \`-> [...]\` hint is present at all, also use \`getByRole\` with the accessible name from the tree.`,
          `Author selectors ONLY from what appears below:`,
          `- If a role you expected (e.g. \`columnheader\`) is NOT listed, it is NOT in the a11y tree —`,
          `  do NOT use \`getByRole\` for it. Fall back to \`getByText\` or a scoped locator.`,
          `- If a name appears MORE THAN ONCE, a bare \`getByRole\`/\`getByText\` matches multiple elements`,
          `  (strict-mode violation) — scope it to a unique parent/section, or use a unique attribute.`,
          `- This tree is a STATIC snapshot of initial load. Post-interaction elements (modals, dynamic`,
          `  lists, multi-step form steps) are NOT here. Assert them with auto-waiting`,
          `  (\`await expect(locator).toBeVisible()\`, \`waitForURL\`), never \`waitForTimeout\`.`,
          ``,
          `Lines tagged [CHANGED: …] are what THIS change introduced — your objective targets these.`,
          ``,
          input.domSnapshot,
          ``,
        ].join("\n")
    : "";

  // VOLATILE: Lever-2 deterministic selector contradictions (W1). Each is a VERIFIED finding from
  // comparing the generated specs' selectors against the captured failure-point a11y tree — an absent
  // selector ("role:name is NOT in the captured tree; present roles: …") or an ambiguous one
  // ("matches MULTIPLE nodes …"). Rendered as its OWN section so it is never truncated by the
  // 500-char detail slice. Positioned after the DOM (reads the contradiction against the tree).
  const selectorContradictionsContent =
    input.selectorContradictions?.length && isGenerationMode
      ? [
          `## ⚠ Lever-2 selector contradictions (DETERMINISTIC — resolve EVERY one)`,
          ``,
          `These selectors were checked against the captured failure-point tree above and FAILED.`,
          `Each is a verified fact, not a hint: a contradicted \`role:name\` is NOT in the captured tree`,
          `(the listed present roles are what IS there) — do NOT re-use it. Replace it with a role/name`,
          `that appears in the tree, or a \`getByText\`/scoped locator; for a "matches MULTIPLE" finding,`,
          `scope the locator to a unique parent. You MUST resolve every item before finishing:`,
          ``,
          ...input.selectorContradictions.map((c) => `- ${c}`),
          ``,
        ].join("\n")
      : "";

  // VOLATILE: Fix instructions for failed test cases. When `failureSourced` is true the fix
  // instructions remove the browser_navigate + browser_snapshot steps — the injected tree IS
  // the ground truth. Positioned after selector contradictions (references the tree above).
  const fixContent = input.fixCases?.length && isGenerationMode
    ? [
        `## Fix failing tests`,
        ``,
        `The following tests FAILED during execution against DEV. Fix ONLY these`,
        `tests; do NOT rewrite or touch tests that passed.`,
        ``,
        `Failed cases:`,
        ...input.fixCases.flatMap((c) => [
          `- ${c.name}\n  Error: ${c.detail?.slice(0, 500) ?? "(no detail)"}`,
          ...renderFixCaseEvidenceLines(c),
        ]),
        ``,
        ...(input.failureSourced
          ? [
              `The captured a11y tree at the failure point is injected ABOVE as "GROUND TRUTH AT FAILURE".`,
              `1. Read the test file to understand what it asserts`,
              `2. Consult ONLY the GROUND TRUTH tree above — do NOT navigate or snapshot the live page.`,
              `   The tree above is the page AT THE FAILURE POINT, not the current live state.`,
              `   ${GROUNDING_UNCOVERED_ESCAPE}`,
              `3. Fix the ROOT CAUSE, guided by the error type:`,
              `   - "strict mode violation" → scope the selector to a section first`,
              `   - "locator.click: … not found" → the element doesn't exist; check role/label in the GROUND TRUTH tree`,
              `   - "expect(…).toBeVisible() timed out" → the element exists but isn't visible; check loading states`,
              `   - "locator resolved to N elements" → use .filter({hasText:…}) or scope to a unique parent`,
              `4. PRESERVE each test's objective and assertions — fix only what's broken`,
            ]
          : hasInjectedGrounding
          ? [
              `Fix from the injected grounding above (Context Pack / DOM tree) — do NOT navigate to re-derive`,
              `a route it already covers; navigate ONLY a route absent from the injected grounding.`,
              GROUNDING_UNCOVERED_ESCAPE,
              `1. Read the test file to understand what it asserts`,
              `2. Resolve the failing selector/assertion against the injected grounding above`,
              `3. Fix the ROOT CAUSE, guided by the error type:`,
              `   - "strict mode violation" → scope the selector to a section first`,
              `   - "locator.click: … not found" → the element doesn't exist; check role/label in the injected grounding`,
              `   - "expect(…).toBeVisible() timed out" → the element exists but isn't visible; check loading states`,
              `   - "locator resolved to N elements" → use .filter({hasText:…}) or scope to a unique parent`,
              `4. PRESERVE each test's objective and assertions — fix only what's broken`,
            ]
          : [
              `For each failure, use the Playwright MCP to explore the page and verify`,
              `your fix BEFORE writing it:`,
              `1. Read the test file to understand what it asserts`,
              `2. Use browser_navigate + browser_snapshot to see the ACTUAL page structure`,
              `3. Fix the ROOT CAUSE, guided by the error type:`,
              `   - "strict mode violation" → scope the selector to a section first`,
              `   - "locator.click: … not found" → the element doesn't exist; check role/label`,
              `   - "expect(…).toBeVisible() timed out" → the element exists but isn't visible; check loading states`,
              `   - "NS_ERROR_…" / network error → the URL or route is wrong; verify with browser_navigate`,
              `   - "locator resolved to N elements" → use .first() ONLY as last resort; prefer scoping`,
              `4. PRESERVE each test's objective and assertions — fix only what's broken`,
            ]),
        ``,
      ].join("\n")
    : "";

  // VOLATILE: Reviewer corrections — the highest-priority re-generation signal. The agent must
  // resolve every flagged item before finishing. Positioned in VOLATILE after DOM so the DOM
  // grounding is already established when the corrections reference it.
  const reviewContent = input.reviewCorrections?.length && isGenerationMode
    ? [
        `## Apply reviewer corrections (HIGHEST priority)`,
        ``,
        `An independent reviewer REJECTED the previous specs. Fix EACH item below precisely;`,
        `do NOT rewrite specs that were not flagged.`,
        hasInjectedGrounding
          ? `Re-verify against the injected grounding above (Context Pack / DOM tree) before editing — do NOT re-navigate a route it already covers. ${GROUNDING_UNCOVERED_ESCAPE}`
          : `Where a fix concerns a selector or an assertion, re-verify it against the live DOM with the Playwright MCP before editing.`,
        ``,
        ...input.reviewCorrections.map((c) => `- ${c}`),
        ``,
      ].join("\n")
    : "";

  // VOLATILE: Coverage improvement — the executed tests did not exercise some changed lines.
  const coverageContent = input.coverageGap && isGenerationMode
    ? [
        `## Cover the change (HIGH priority)`,
        ``,
        `The tests ran green but did NOT exercise all the lines this commit changed. Extend or add`,
        `tests so those lines are actually executed and asserted (covering ≠ asserting — assert the`,
        `behavior of the changed code, do not just touch the line):`,
        ``,
        ...(hasInjectedGrounding
          ? [
              `Resolve any new selectors from the injected grounding above — do NOT re-navigate routes it already covers.`,
              GROUNDING_UNCOVERED_ESCAPE,
              ``,
            ]
          : []),
        input.coverageGap,
        ``,
      ].join("\n")
    : "";

  // VOLATILE: learned anti-patterns from past runs.
  const learnedRulesContent = input.learnedRules && isGenerationMode
    ? [input.learnedRules, ``].join("\n")
    : "";

  // RE-1: regen-discipline — a re-generation turn must not re-orient; the blast radius was already
  // distilled into the grounding above. Suppress serena re-activation / blast-radius re-derivation.
  const regenDisciplineContent = isReGen
    ? [
        `## Re-generation turn — do NOT re-orient`,
        ``,
        `Re-generation turn: the blast radius was already explored and distilled above. Do NOT re-activate`,
        `serena, do NOT re-run find_referencing_symbols, do NOT re-skim the repository or re-read unchanged`,
        `code. Work from the grounding already in this prompt and change only what the correction requires.`,
        `(One exception: if a correction names a specific symbol that is NOT in the grounding above, read ONLY that symbol.)`,
        ``,
      ].join("\n")
    : "";

  // VOLATILE: Context Pack — pushed by the orchestrator before the first write (Slice G / P8).
  // Carries the blast-radius (code symbols from the ExplorationBrief), the live DOM slice
  // (captured orchestrator-side via Playwright), and the relevant API contracts.
  // Positioned at priority 0 within VOLATILE so it is the FIRST volatile section seen by
  // the model — near the task, within the compaction preserve window. When the pack is
  // present the generator transcribes; when absent the explore-first mandate stays active.
  const contextPackContent = input.contextPack && isGenerationMode ? input.contextPack : "";

  // TASK: mode-specific task (the concrete objective for this session).
  const taskContent = buildTask(input);

  // SEMI-STABLE: static signal (deterministic pre-computed analysis — stable for this diff).
  const staticSignalContent = input.staticSignal && isGenerationMode ? input.staticSignal : "";

  // Stitcher→Generation seam (design §3.4, S2.4): "Cross-service links (deterministic)" — the
  // deterministic FE→BE contract links ServiceLinksPort.resolve() produced, plus any contract-drift
  // WARNINGS. Local sanitize wrapper (this function's own scope — NOT the DIFFERENT s() declared
  // inside renderArchitectureContext further down this file) so untrusted cross-repo strings (data
  // leaving/entering the model boundary) are redacted before reaching the prompt.
  const s = (x: unknown): string => sanitizeText(String(x ?? "")).text;
  const MAX_LINKS = 40; // advisory noise ceiling — this section's own budget guard.
  const MAX_DRIFT = 20;
  const hasServiceLinks = Boolean(input.serviceLinks?.length);
  const hasContractDrift = Boolean(input.contractDrift?.length);
  // Slice C (structural-signals-expansion, design §3.6): extends this SAME section with inline
  // "[IMPACTED:<tier>]" markers on matched bullets — NOT a new/duplicate subsection. The lookup key
  // matches the bullet's own from/to identity exactly; built ONCE, byte-identical when
  // crossRepoImpact is absent (empty map -> tierFor always undefined -> prefix always "").
  const linkKey = (l: { from: { repo: string; file: string; symbol: string }; to: { repo: string } }): string =>
    `${l.from.repo}/${l.from.file}#${l.from.symbol}->${l.to.repo}`;
  const impactedTierByKey = new Map(
    (input.crossRepoImpact?.impactedLinks ?? []).map(({ link, tier }) => [linkKey(link), tier] as const),
  );
  const tierFor = (l: { from: { repo: string; file: string; symbol: string }; to: { repo: string } }): string | undefined =>
    impactedTierByKey.get(linkKey(l));
  // A link's [IMPACTED:tier] marker must survive the MAX_LINKS ceiling: the resolver returns links
  // in discovery order, so on a >MAX_LINKS app the one impacted link can sit past the cut and lose
  // the exact annotation this run exists to surface. Impacted links render first (stable order
  // inside each partition); an empty impacted set skips the reorder — byte-identical when absent.
  const orderedLinks =
    impactedTierByKey.size > 0 && hasServiceLinks
      ? [
          ...input.serviceLinks!.filter((l) => tierFor(l) !== undefined),
          ...input.serviceLinks!.filter((l) => tierFor(l) === undefined),
        ]
      : input.serviceLinks ?? [];
  const serviceLinksContent =
    (hasServiceLinks || hasContractDrift) && isGenerationMode
      ? [
          "## Cross-service links (deterministic — from the stitcher, advisory)",
          "Structural FE→BE contract links resolved from the code, NOT a gate. Verify against the live app; absent links do NOT imply no dependency.",
          "",
          ...(hasServiceLinks
            ? orderedLinks.slice(0, MAX_LINKS).map((l) => {
                const tier = tierFor(l);
                return `- ${tier ? `[IMPACTED:${s(tier)}] ` : ""}\`${s(l.from.repo)}/${s(l.from.file)}#${s(l.from.symbol)}\` -> ` +
                  `${s(l.to.repo)} ${s(l.contractRef ?? l.to.symbol)} (${s(l.transport)}, confidence ${l.confidence.toFixed(2)})`;
              })
            : []),
          ...(hasContractDrift
            ? ["", "### Contract drift (WARNINGS — front calls an endpoint the backend contract does not declare):",
               ...input.contractDrift!.slice(0, MAX_DRIFT).map((d) =>
                 `- WARNING: \`${s(d.from.repo)}/${s(d.from.file)}#${s(d.from.symbol)}\` calls ${s(d.verb)} ${s(d.path)} — not in the contract`)]
            : []),
        ].join("\n")
      : "";

  // C1: diff archetypes — a one-line structural hint for the generator ("Change shape
  // (deterministic): auth-flow, data-list — prioritise tests that exercise these").
  // Rendered only when archetypes are present and non-empty; absent = no section.
  const diffArchetypesContent =
    input.diffArchetypes?.length && isGenerationMode
      ? `Change shape (deterministic): ${input.diffArchetypes.join(", ")} — prioritise tests that exercise these`
      : "";

  return assemble([
    // STABLE prefix: working rules (mode-specific but stable for the generator role per session).
    section("working-rules", "stable-prefix", workingRulesContent, { priority: 1, cacheable: true }),
    // JD-C2: regen-discipline in the STABLE band (not volatile) so it sheds no earlier than the
    // navigate/serena commands it overrides — a volatile placement shed FIRST under budget pressure,
    // silently no-opping RE-1 exactly on the largest prompts. Renders right after working-rules.
    ...(regenDisciplineContent ? [section("regen-discipline", "stable-prefix", regenDisciplineContent, { priority: 2 })] : []),
    // SEMI-STABLE: architecture map and exploration brief (change between runs, stable within).
    ...(archMapContent ? [section("arch-map", "semi-stable", archMapContent, { priority: 1, cacheable: true })] : []),
    ...(contextBriefContent ? [section("context-brief", "semi-stable", contextBriefContent, { priority: 2 })] : []),
    // Seam b: existing-suite-manifest — a deterministic filesystem-enumerated list of existing spec
    // file paths, rendered here so the generator can see what flows are already covered without a
    // serena delegation. Priority 2 (alongside context-brief, sheds before arch-map). Guarded by
    // isGenerationMode (diff and manual only; not emitted for complete/exhaustive/context).
    ...(() => {
      const specFiles = isGenerationMode && (input.mode === "diff" || input.mode === "manual")
        ? input.existingSpecFiles
        : undefined;
      if (!specFiles?.length) return [];
      const manifestContent = [
        `## existing-suite-manifest (${specFiles.length} spec file(s) — do NOT rewrite flows already covered here)`,
        ...specFiles.map((f) => `- ${f}`),
      ].join("\n");
      return [section("existing-suite-manifest", "semi-stable", manifestContent, { priority: 2 })];
    })(),
    ...(staticSignalContent ? [section("static-signal", "semi-stable", staticSignalContent, { priority: 3 })] : []),
    // Stitcher→Generation seam (design §3.4): priority 3 alongside static-signal — sheds before
    // arch-map, after existing-suite-manifest, matching staticSignal's own precedence exactly.
    ...(serviceLinksContent ? [section("service-links", "semi-stable", serviceLinksContent, { priority: 3 })] : []),
    // C1: diff archetypes one-line hint (tiny semi-stable section, priority 3 alongside static-signal).
    // Absent when no archetypes or non-generation mode — no empty header emitted.
    ...(diffArchetypesContent ? [section("diff-archetypes", "semi-stable", diffArchetypesContent, { priority: 3 })] : []),
    // VOLATILE priority 0: Context Pack (blast-radius + DOM + contracts, pushed by orchestrator).
    // Placed FIRST in VOLATILE so the ground-truth is nearest the task and within the
    // compaction-preserved tail. The domSnapshot (failure-point capture) stays at priority 1
    // so it follows the pack on regen passes without conflicting.
    // FIX 5: shedAs "critical-recap" → the pack is LEAST-SHEDABLE under budget pressure. Its DOM
    // ground-truth is captured live and is NOT recoverable by the agent, whereas the raw diff (in the
    // TASK band) is recoverable via `git show`. Without this, VOLATILE sheds FIRST and the pack died
    // before the diff. Assembly POSITION is unchanged (still volatile, near the task); only the shed
    // precedence moves so the diff/task content is dropped before the unrecoverable pack.
    ...(contextPackContent ? [section("context-pack", "volatile", contextPackContent, { priority: 0, shedAs: "critical-recap" })] : []),
    // VOLATILE: grounding (DOM snapshot — priority 1 within VOLATILE so it's first and the
    // selectorContradictions section can reference "the tree above" correctly).
    ...(domContent ? [section("dom-snapshot", "volatile", domContent, { priority: 1 })] : []),
    // VOLATILE: selector contradictions must appear AFTER the DOM tree (priority 2).
    ...(selectorContradictionsContent ? [section("selector-contradictions", "volatile", selectorContradictionsContent, { priority: 2 })] : []),
    // VOLATILE: fix instructions reference the DOM tree above (priority 3).
    ...(fixContent ? [section("fix-cases", "volatile", fixContent, { priority: 3 })] : []),
    // VOLATILE: reviewer corrections (priority 4 — after grounding context is established).
    ...(reviewContent ? [section("reviewer-corrections", "volatile", reviewContent, { priority: 4, maxBytes: 20_000, overflow: "drop" })] : []),
    // VOLATILE: coverage gap (priority 5).
    ...(coverageContent ? [section("coverage-gap", "volatile", coverageContent, { priority: 5 })] : []),
    // VOLATILE: learned rules — raised to priority 2 (from p6) so the cross-run learning signal
    // outlasts lower-value volatile sections. Shed order: coverage-gap (p5) → reviewer-corrections
    // (p4) → fix-cases (p3) → learned-rules (p2) → dom-snapshot (p1). Learned-rules sheds LAST
    // among volatile content, preserving the anti-pattern memory under budget pressure.
    ...(learnedRulesContent ? [section("learned-rules", "volatile", learnedRulesContent, { priority: 2 })] : []),
    // TASK: the concrete mode-specific objective (criterion before diff — seam e).
    section("task", "task", taskContent, { priority: 1 }),
    // Seam a: the commit diff in its own task-band section with shedAs:"semi-stable".
    // Assembly order: task(p1) renders before diff(p2) → criterion precedes diff in output (seam e ✓).
    // Shed order: shedAs:"semi-stable" places this in band 2, so it sheds after volatile DOM/pack
    // (band 1) and before arch-map (semi-stable p1) — the diff is recoverable via `git show`, unlike
    // the DOM ground-truth, so it correctly sheds before the unrecoverable context-pack (band 4).
    ...(() => {
      const diffContent = isGenerationMode ? buildDiffSection(input) : "";
      return diffContent ? [section("diff", "task", diffContent, { priority: 2, shedAs: "semi-stable" })] : [];
    })(),
  ], { budgetBytes: roleWindowBytes("qa-generator") });
}

export function buildPrompt(input: OpencodeRunInput): string {
  return buildPromptAssembled(input).text;
}

// RE-3: the follow-up prompt for a re-generation on a CONTINUED session. The session already holds
// the working rules, blast-radius brief, Context Pack and diff from the initial turn, so re-sending
// them wastes tokens and invites re-exploration. This carries ONLY the new failure signal + a
// "do not re-explore" framing. The failure-point a11y tree IS new (captured at the failure), so it
// is injected; everything else the agent already has in its session history.
export function buildFollowupPrompt(input: OpencodeRunInput): string {
  const parts: string[] = [
    `## Continuation — same session; do NOT re-explore`,
    ``,
    `The suite you wrote was executed against DEV. The working rules, blast-radius brief, Context Pack`,
    `and diff are ALREADY in this session above — do NOT re-read them, do NOT re-activate serena, do NOT`,
    `re-run find_referencing_symbols, and do NOT re-navigate a route you already explored. Fix from what`,
    `you already have, plus the new failure signal below.`,
    GROUNDING_UNCOVERED_ESCAPE,
    ``,
  ];
  if (input.domSnapshot && input.failureSourced) {
    parts.push(
      `## GROUND TRUTH AT FAILURE`,
      ``,
      `The tree below is the page AT THE FAILURE POINT — the ONLY source of truth for this fix. Quote the`,
      `exact \`role: name\` line before writing any locator; an unquotable locator MUST be replaced.`,
      ``,
      input.domSnapshot,
      ``,
    );
  }
  if (input.selectorContradictions?.length) {
    parts.push(
      `## ⚠ Selector contradictions (DETERMINISTIC — resolve EVERY one)`,
      `Each was checked against the captured tree and FAILED — replace it with a role/name that appears there:`,
      ...input.selectorContradictions.map((c) => `- ${c}`),
      ``,
    );
  }
  if (input.fixCases?.length) {
    parts.push(
      `## Fix failing tests`,
      `These tests FAILED against DEV. Fix ONLY these; do NOT touch tests that passed.`,
      ...input.fixCases.flatMap((c) => [
        `- ${c.name}\n  Error: ${c.detail?.slice(0, 500) ?? "(no detail)"}`,
        ...renderFixCaseEvidenceLines(c),
      ]),
      ``,
    );
  }
  if (input.reviewCorrections?.length) {
    parts.push(
      `## Apply reviewer corrections (HIGHEST priority)`,
      `An independent reviewer REJECTED the previous specs. Fix EACH item; do NOT rewrite specs not flagged.`,
      ...input.reviewCorrections.map((c) => `- ${c}`),
      ``,
    );
  }
  if (input.coverageGap) {
    parts.push(
      `## Cover the change (HIGH priority)`,
      `The tests ran green but did NOT exercise all the changed lines. Extend/add tests so they are asserted:`,
      input.coverageGap,
      ``,
    );
  }
  return parts.join("\n");
}

// ── Architecture context injection ──────────────────────────────────────────
//
// The orchestrator loads e2e/.qa/context.json and passes it via contextMap. This
// function renders the relevant slice as a prompt section so the agent receives
// the FE↔BE map as a FIRST-CLASS input — no "read it if it exists" ambiguity.
// For diff mode, it filters to only the routes/operations touched by the changed
// files. For other modes (complete/exhaustive/manual), it renders the full map.

// context.json is read from the WATCHED repo (and committed by this system's own PRs), so
// it is attacker-influenceable. Every field is sanitized before it reaches the test-writing
// agent (prompt-injection / secret-exfil defense), and the map is BOUNDED so a huge file
// cannot blow the token budget. `s()` redacts; MAX_ITEMS caps each section.
export function renderArchitectureContext(
  ctx: ArchitectureContext,
  changedFiles?: string[],
  // Seam c: when a Context Pack is present, its blast-radius section already contains FE↔BE links;
  // suppress the arch-map duplicate to keep FE↔BE rendered ≤2x across the assembled prompt.
  opts: { suppressFeBeLinks?: boolean } = {},
): string | null {
  if (!ctx.routes?.length && !ctx.api?.length) return null;

  const s = (x: unknown): string => sanitizeText(String(x ?? "")).text;
  const MAX_ITEMS = 200;
  const MAX_LEN = 20_000;

  const relevantLinks = (changedFiles?.length
    ? ctx.feBe?.filter((link) => {
        // Scope by terms specific enough to be meaningful: a route of "/" (or any 1-2 char
        // term) is a substring of EVERY file path and would defeat the scoping entirely.
        const terms = [link.route, link.via ?? "", link.operationId].filter((t) => t && t.length >= 3);
        return changedFiles.some((f) => terms.some((t) => f.includes(t)));
      }) ?? ctx.feBe ?? []
    : ctx.feBe ?? []
  ).slice(0, MAX_ITEMS);

  const lines: string[] = [];
  lines.push("## Architecture context (from e2e/.qa/context.json)");
  lines.push(`Built at ${s(ctx.builtAtSha).slice(0, 7)} — the FE↔BE map this app's QA uses to cross the frontend→backend boundary.`);
  lines.push(
    "This map is a non-authoritative AID, extracted from source and possibly STALE or INCOMPLETE: " +
      "use it to widen the blast radius and locate flows, but verify every route, selector and contract " +
      "against the actual code and the live DOM. If the map and what you observe disagree, the code/DOM wins.",
  );
  lines.push("");

  if (ctx.routes.length) {
    lines.push(`### Routes (${ctx.routes.length} entry points)`);
    for (const r of ctx.routes.slice(0, MAX_ITEMS)) {
      lines.push(`- \`${s(r.path)}\` → ${s(r.component ?? "(unknown component)")}${r.name ? ` ("${s(r.name)}")` : ""}`);
    }
    lines.push("");
  }

  if (ctx.api.length) {
    lines.push(`### API operations (${ctx.api.length} endpoints)`);
    for (const o of ctx.api.slice(0, MAX_ITEMS)) {
      lines.push(`- \`${s(o.operationId)}\`: ${s(o.method)} ${s(o.path)}${o.service ? ` (${s(o.service)})` : ""}`);
    }
    lines.push("");
  }

  if (relevantLinks.length && !opts.suppressFeBeLinks) {
    // Seam c: when a Context Pack is present, its blast-radius section already contains FE↔BE links;
    // suppress the arch-map duplicate to keep FE↔BE rendered ≤2x across the assembled prompt.
    lines.push(`### FE↔BE links (${relevantLinks.length} of ${ctx.feBe?.length ?? 0} total)`);
    lines.push("Each link tells you which frontend route calls which backend operation — use this to widen the blast radius:");
    for (const l of relevantLinks) {
      lines.push(`- Route \`${s(l.route)}\` → \`${s(l.operationId)}\`${l.via ? ` (via ${s(l.via)})` : ""}`);
    }
    lines.push("");
  }

  if (ctx.flows?.length) {
    lines.push("### Named flows");
    for (const f of ctx.flows.slice(0, MAX_ITEMS)) {
      const opList = f.operations?.length ? ` → ${f.operations.slice(0, MAX_ITEMS).map(s).join(", ")}` : "";
      lines.push(`- **${s(f.id)}**: ${f.routes.slice(0, MAX_ITEMS).map(s).join(", ")}${opList}`);
    }
    lines.push("");
  }

  lines.push("When the blast radius from the diff touches a route, use its FE↔BE links");
  lines.push("to also consider the backend operations — a frontend change can break backend");
  lines.push("behaviour and vice-versa.");
  const out = lines.join("\n");
  return out.length > MAX_LEN ? out.slice(0, MAX_LEN) + "\n…(context truncated)" : out;
}

// ── context mode: build the FE↔BE architecture map ──────────────────────────
//
// The agent extracts routes from Angular routing, API operations from OpenAPI specs,
// and joins them via the generated API clients' operationIds. The result is written
// to e2e/.qa/context.json and validated deterministically by the orchestrator.
// This map is then consumed by diff-mode runs to cross the FE→BE boundary without
// re-deriving the architecture from raw code on every run.

export function buildContextTask(input: OpencodeRunInput): string {
  const openapiHint = Array.isArray(input.openapi) ? input.openapi.join(", ") : input.openapi;
  const serviceLines = input.services?.length
    ? [
        ``,
        `## Microservice repos (${input.services.length})`,
        `This app's backend is split into microservices. Each repo below is mirrored READ-ONLY;`,
        `extract its OpenAPI operations into the SAME context.json, setting each operation's`,
        `"service" field to the repo name shown here:`,
        ``,
        ...input.services.flatMap((s) => {
          const hint = Array.isArray(s.openapi) ? s.openapi.join(", ") : s.openapi;
          return [
            `- **${s.repo}** — working copy at: ${s.mirrorDir}`,
            ...(hint ? [`  OpenAPI hint: ${hint} (relative to that working copy)`] : [`  No OpenAPI hint — search that working copy for openapi/swagger files.`]),
          ];
        }),
        ``,
        `The feBe JOIN is still derived from THIS frontend repo's API clients: a client method's`,
        `operationId must match an operation extracted from one of the services above (or from`,
        `this repo's own specs). Do not invent links for services the frontend never calls.`,
      ]
    : [];
  return [
    `Build or refresh the FE↔BE architecture map for ${input.repo}.`,
    ``,
    `## Goal`,
    `Produce a distilled map of the app's architecture so future QA runs can cross the`,
    `frontend→backend boundary without re-deriving it from raw code.`,
    ``,
    `## What to produce`,
    `Write a single JSON file at ${input.e2eRelDir}/.qa/context.json with these sections:`,
    ``,
    `1. **routes** — every frontend entry URL (the unit an E2E targets) + the component it renders.`,
    `   Extract FROM the Angular routing files (e.g. app.routes.ts, *.routes.ts).`,
    `   Required per entry: path (e.g. "/checkout"). Optional: name, component, source.`,
    ``,
    `2. **api** — every backend operation the app calls.`,
    `   Extract FROM the OpenAPI specs${openapiHint ? ` (hint: ${openapiHint})` : " (search with serena/glob for openapi or swagger files)"}.`,
    `   Required per entry: operationId, method (GET/POST/...), path. Optional: service, spec.`,
    ``,
    `3. **feBe** — the JOIN between frontend routes and backend operations: which route calls which operation.`,
    `   Derive BY following each generated API client method to its operationId.`,
    `   Required per entry: route (a path from routes), operationId (from api). Optional: via (the client method).`,
    `   THE JOIN IS THE WHOLE POINT: every link must resolve to a known route AND a known operation.`,
    ``,
    `4. **flows** (optional) — named user flows grouping routes + operations for readability.`,
    ...serviceLines,
    ``,
    `## Procedure`,
    `1. Activate serena (activate_project) on the working directory.`,
    `2. Find ALL Angular routing files (serena glob: **/*routes*.ts, **/app-routing*.ts).`,
    `   For each route definition (path + component), add an entry to routes.`,
    `3. Find ALL OpenAPI spec files${openapiHint ? ` (start with ${openapiHint})` : ""}.${input.services?.length ? " Include every microservice repo listed above (their working copies are local paths you can read)." : ""}`,
    `   For each operation (operationId + method + path), add an entry to api.`,
    `4. Find the generated API client files (typically src/app/generated/ or similar).`,
    `   For each client method that calls a backend operation, map its call site to a route`,
    `   and add the link to feBe. The operationId in the client MUST match an api entry.`,
    `5. Self-validate: every feBe route exists in routes AND every feBe operationId exists in api.`,
    `   Remove any dangling link BEFORE writing.`,
    `6. Write ${input.e2eRelDir}/.qa/context.json with the four sections + "builtAtSha":"${input.sha}".`,
    ``,
    `## Rules`,
    `- Extract from STRUCTURED sources, never invent. Every route comes from a routing file;`,
    `  every operation from an OpenAPI spec; every link from a generated client.`,
    `- If no OpenAPI spec is found, leave api and feBe empty (a repo with no backend).`,
    `- If routing is file-based (not a central Routes array), enumerate the route files.`,
    `- Do NOT guess or hallucinate paths/operationIds. If a source is missing, leave that section empty.`,
    `- Keep the map small: this is an E2E authoring aid, not exhaustive documentation.`,
    ``,
    `## Output`,
    `End with ONLY this JSON (no other text):`,
    `{"approved":true,"specs":["${input.e2eRelDir}/.qa/context.json"],"note":"built architecture map with X routes, Y api operations, Z links"}`,
  ].join("\n");
}

// The mode-specific task block.
// The CODE-mode task: source-code testing framed for the agent. No "E2E", no page/browser, no
// context.json, no page-scope budget — the code-mode failures the e2e tasks would otherwise inject.
function buildCodeTask(input: OpencodeRunInput): string {
  if (input.mode === "manual") {
    return [
      `Generate or update UNIT/INTEGRATION tests for the source code of ${input.repo}, FOCUSED on:`,
      ``,
      sanitizeText(input.guidance ?? "(no guidance provided)").text,
      ``,
      `## Objective — commit to this BEFORE writing`,
      ACCEPTANCE_CRITERION_RULE,
      ``,
      `Read the relevant source and the repo's existing tests (serena); match their framework and conventions.`,
      `Stay focused on the guidance; do not generate unrelated tests.`,
    ].join("\n");
  }
  if (input.mode === "complete" || input.mode === "exhaustive") {
    return [
      input.mode === "exhaustive"
        ? `Audit and REGENERATE the source-code test suite of ${input.repo} from scratch.`
        : `Analyze the WHOLE repository ${input.repo} and grow its source-code test suite where it matters.`,
      ``,
      `Read the existing tests and the code (serena: activate_project, get_symbols_overview, find_symbol).`,
      `Test important, UNCOVERED logic; match the repo's existing test framework and conventions.`,
      input.mode === "exhaustive"
        ? `Re-evaluate every existing test for correctness, value and necessity; remove or rewrite the trivial, false-positive, redundant or obsolete.`
        : `Generate tests ONLY for important UNCOVERED logic (the delta). Do not duplicate existing coverage.`,
    ].join("\n");
  }

  // diff (default): test the source-code change of one commit.
  const intent = input.intent;
  const isReGen = Boolean(input.fixCases?.length || input.reviewCorrections?.length || input.coverageGap);
  return [
    `Generate or update UNIT/INTEGRATION tests for the source-code changes in commit ${input.sha} of ${input.repo}.`,
    ``,
    `## Change intent (Conventional Commits)`,
    `- Type: ${intent?.type ?? "unknown"}${intent?.breaking ? " (BREAKING)" : ""}`,
    `- Changed files (derive the scope from these): ${sanitizeText(intent?.changedFiles?.join(", ") ?? "").text || "(unknown)"}`,
    ``,
    `## Commit message (the author's intent — derive each test's objective from this)`,
    renderCommitMessage(intent, !isReGen),
    ``,
    `Cross-check against the diff: if the code does more than the message claims, test what the code`,
    `actually changes, not just what the message promises.`,
    ``,
    `## Commit diff`,
    "```diff",
    sanitizeText(input.diff).text,
    "```",
    ``,
    `Test the changed logic DIRECTLY (no web, no browser, no Playwright): call the changed functions/`,
    `modules and assert behavior + edge cases. Match the repo's existing test framework and conventions.`,
  ].join("\n");
}

function buildTask(input: OpencodeRunInput): string {
  // CODE mode is source-code testing — no web/browser, no Playwright, no FE↔BE context map, no
  // page-scope budget. Falling through to the e2e tasks below would tell the agent to "Generate E2E
  // tests", read e2e/.qa/context.json, and "explore ONLY the page(s)" — all meaningless here.
  if (input.target === "code") return buildCodeTask(input);
  if (input.mode === "complete" || input.mode === "exhaustive") {
    return [
      input.mode === "exhaustive"
        ? `Audit and REGENERATE the entire E2E suite of ${input.repo} from scratch.`
        : `Analyze the WHOLE repository ${input.repo} and grow the E2E suite where it matters.`,
      ``,
      `1. Read the existing tests in ${input.e2eRelDir}/ and the app code (use serena:`,
      `   activate_project, get_symbols_overview, find_symbol, find_referencing_symbols) to`,
      `   build a COVERAGE + IMPORTANCE map: which user flows already have tests and which`,
      `   important/complex flows do NOT. Until real coverage instrumentation exists,`,
      `   estimate coverage by reading the existing specs and the code.`,
      `2. Persist this analysis in ${input.e2eRelDir}/.qa/analysis.json (flows, covered vs`,
      `   uncovered, importance, lastSha:"${input.sha}") so it need not be redone from`,
      `   scratch next time; if it already exists, update it incrementally.`,
      input.mode === "exhaustive"
        ? `3. Re-evaluate EVERY existing test for correctness, value and necessity (apply the test-value-review criteria): remove or rewrite tests that are trivial, false positives, redundant or obsolete. Ensure every important flow is covered — a fully re-evaluated suite, not a delta.`
        : `3. Generate tests ONLY for the important UNCOVERED flows (the delta over the existing suite). Do not duplicate existing coverage.`,
    ].join("\n");
  }
  if (input.mode === "manual") {
    return [
      `Generate/update E2E tests for ${input.repo}, FOCUSED on the following guidance:`,
      ``,
      sanitizeText(input.guidance ?? "(no guidance provided)").text,
      ``,
      `## Objective — commit to this BEFORE writing`,
      ACCEPTANCE_CRITERION_RULE,
      ``,
      `Use serena to read the relevant code and the existing ${input.e2eRelDir}/ suite.`,
      `Stay focused on the guidance; do not generate unrelated tests.`,
    ].join("\n");
  }
  if (input.mode === "context") return buildContextTask(input);

  // diff (default)
  const intent = input.intent;
  // The body is richest on the FIRST pass; the re-generation passes (fix / reviewer-corrections /
  // coverage-gap) already carry a sharper established objective, so rendering it again would only
  // re-spend tokens on the system's largest prompts. capText bounds it on the first pass either way.
  const isReGen = Boolean(input.fixCases?.length || input.reviewCorrections?.length || input.coverageGap);
  const svcOpenapi = Array.isArray(input.service?.openapi) ? input.service.openapi.join(", ") : input.service?.openapi;
  const serviceBlock = input.service
    ? [
        ``,
        `## Cross-repo change (microservice)`,
        `The commit under test belongs to the microservice ${input.service.repo}, NOT to this frontend repo.`,
        `- The service's working copy (READ-ONLY) is at: ${input.service.mirrorDir}`,
        ...(svcOpenapi ? [`- The service's OpenAPI contract(s): ${svcOpenapi} (paths relative to that working copy)`] : []),
        `- Use the architecture context below (operations whose service matches this repo) plus the`,
        `  service's code and contract to find which frontend routes and flows this change affects.`,
        `- Exercise the backend ONLY through the frontend UI at the LIVE DEV URL — never call the service directly.`,
      ]
    : [];
  // Seam e: acceptance-criterion appears BEFORE the diff block. The diff itself is moved to a
  // dedicated section in buildPromptAssembled (buildDiffSection) so that it can carry
  // shedAs:"semi-stable" while the task band retains the objective/criterion/scope content.
  return [
    `Generate/update E2E tests for the flows affected by commit ${input.sha} of ${input.repo}.`,
    ``,
    `## Change intent (Conventional Commits)`,
    `- Type: ${intent?.type ?? "unknown"}${intent?.breaking ? " (BREAKING)" : ""}`,
    `- Changed files (derive the scope/area from these): ${sanitizeText(intent?.changedFiles?.join(", ") ?? "").text || "(unknown)"}`,
    ``,
    `## Commit message (the author's intent — derive each test's objective from this)`,
    renderCommitMessage(intent, !isReGen),
    ``,
    `Cross-check against the diff: if the code does more than the message claims, cover what`,
    `the code actually changes, not just what the message promises.`,
    ``,
    // Seam e: objective/acceptance-criterion now precedes the diff block so the agent reads
    // the GOAL before the evidence. The diff is rendered as a separate task-band section in
    // buildPromptAssembled (with shedAs:"semi-stable") so both orderings are satisfied:
    // assembly order places criterion first (task band, declared before diff section), and
    // the diff sheds as semi-stable (band 2) under budget pressure.
    `## Objective — commit to this BEFORE writing`,
    ACCEPTANCE_CRITERION_RULE,
    ``,
    `## Architecture context`,
    `If ${input.e2eRelDir}/.qa/context.json exists, READ it to understand which routes and`,
    `API operations the changed files belong to. Use the feBe links to widen the blast`,
    `radius across the frontend→backend boundary: a frontend change may affect the`,
    `backend behaviour and vice-versa. If the map is missing or stale, note the`,
    `limitation explicitly in your verdict note.`,
    ``,
    // JD-C1: the first pass scopes the blast radius (serena + page exploration). A RE-generation pass
    // already has that grounding distilled above and is governed by the regen-discipline section —
    // re-commanding `find_referencing_symbols` / "explore the page" here would CONTRADICT it and let
    // the agent justify re-exploring. So the scope-budget orientation lines are first-pass only.
    ...(isReGen
      ? [
          `## Scope (re-generation pass)`,
          `Change ONLY what the correction/coverage-gap above requires. Do not broaden scope or re-survey`,
          `the repo — work from the grounding already in this prompt.`,
        ]
      : [
          `## Scope budget (diff mode — do NOT over-work)`,
          `The blast radius IS your budget. This is ONE commit, so keep generation fast and focused:`,
          `- Read ONLY the changed symbols and their direct callers/callees (find_referencing_symbols).`,
          `- Do NOT read the whole repository, the entire e2e suite, or unrelated flows/files.`,
          `- Read existing specs ONLY for the one or two flows this commit actually touches.`,
          `- Explore ONLY the page(s) the change affects — not the whole app.`,
          `A handful of focused specs is the right output for a single-commit diff, not a suite rewrite.`,
        ]),
    ...serviceBlock,
  ].join("\n");
}

// Seam a: the diff content for diff-mode generator prompts. Extracted from buildTask so it can be
// placed as its own section in the task band with shedAs:"semi-stable" — this way the assembly order
// (task band) keeps the criterion BEFORE the diff (seam e) while the shed order treats the diff as
// semi-stable (band 2), making it shed after volatile DOM/pack (band 1) and before arch-map (band 2 p1).
// Returns empty string for all non-diff modes, code mode, and re-generation passes (where the diff
// is already distilled in the grounding above and repeating it burns tokens).
function buildDiffSection(input: OpencodeRunInput): string {
  if (input.target === "code") return "";
  if (input.mode !== "diff") return "";
  const isReGen = Boolean(input.fixCases?.length || input.reviewCorrections?.length || input.coverageGap);
  if (isReGen) return "";
  return [
    `## Commit diff`,
    "```diff",
    sanitizeText(input.diff).text,
    "```",
  ].join("\n");
}

// ── Reviewer prompt assembly (Phase 1a precursor) ──────────────────────────
//
// The prompt for the independent reviewer session. Extracted from the inline
// build inside reviewIndependently so the ContextAssembler (Phase 1b) can own
// the boundary — the assembly logic is pure and can be unit-tested without
// opening a session. The contract-repair re-prompt and session lifecycle stay
// in reviewIndependently; only the BUILD of the initial prompt string lives here.

// The "what must these tests defend?" framing, per run mode.  Diff runs judge
// against the commit's changed code; MANUAL runs against the user's guidance;
// whole-repo (complete/exhaustive) runs against each spec's own stated objective.
// `targetNoun` flows into the question, the rationale ask, and the [wrong-objective]
// definition so the judge measures the spec against the RIGHT goal.
export function reviewObjective(input: ReviewInput): { subject: string; heading: string; body: string[]; targetNoun: string } {
  if (input.mode === "manual") {
    const g = sanitizeText(((input.guidance ?? "").trim() || "(no guidance was provided)")).text;
    return {
      subject: "a guided (manual) run",
      heading: `## Objective — the requested behavior (judge against THIS, NOT any commit diff)`,
      body: [g],
      targetNoun: "the requested behavior",
    };
  }
  if (input.mode === "complete" || input.mode === "exhaustive") {
    return {
      subject: `a whole-repo ${input.mode} run`,
      heading: `## Objective — there is no single commit; judge each spec against its OWN stated objective`,
      body: [
        `Each spec declares the user flow it targets (in its header comment / the manifest). Judge`,
        `whether it meaningfully exercises that flow, or could the flow break while the test stays green.`,
      ],
      targetNoun: "the targeted user flow",
    };
  }
  const commitDiffObjective = () => ({
    subject: "this commit",
    heading: `## Commit diff`,
    body: ["```diff", sanitizeText(input.diff).text, "```"],
    targetNoun: "the change",
  });
  // diff and code-mode runs are commit-driven: the commit's changed code is the objective.
  if (input.mode === "diff" || input.target === "code") return commitDiffObjective();
  // Any other (unexpected) mode reached the reviewer. Fall back to the commit-diff framing so the
  // reviewer still has a concrete objective, but log it: a future mode must not silently
  // mis-objective the independent judge.
  console.warn(`[qa] reviewObjective: unhandled review mode ${JSON.stringify(input.mode)} — defaulting to the commit-diff objective`);
  return commitDiffObjective();
}

const REVIEW_SPECS_MAX_BYTES = 40_000;

// Read and inline the spec files for the reviewer. Byte-caps at REVIEW_SPECS_MAX_BYTES;
// above the cap, degrades to a file-list so the reviewer reads files itself (surfaced loudly
// as a mode switch). A spec that cannot be read is replaced with a placeholder — never
// silently dropped — so the gate cannot be bypassed by an unreadable spec.
export function renderReviewSpecs(input: ReviewInput): string {
  // e2e specs are e2e/-relative; code-mode tests are repo-relative (e2eRelDir = "").
  const rel = (s: string) => (input.e2eRelDir ? `${input.e2eRelDir}/${s}` : s);
  const contents: string[] = [];
  let totalBytes = 0;
  for (const s of input.specs) {
    let content: string;
    try {
      content = readFileSync(join(input.mirrorDir, input.e2eRelDir, s), "utf8");
    } catch (err) {
      // A spec the independent reviewer NEVER sees can otherwise ship inside an approved batch — that
      // silently bypasses the quality gate. Surface it loudly (CLAUDE.md: never swallow), like the
      // byte-cap branch below does for its own mode switch.
      console.warn(`[qa] WARNING: could not read spec '${rel(s)}' for review (${err instanceof Error ? err.message : String(err)}) — it will be judged from a placeholder, NOT its real content.`);
      contents.push(`### ${rel(s)}\n( could not read file — review skipped for this spec )`);
      continue;
    }
    const block = `### ${rel(s)}\n\`\`\`typescript\n${content}\n\`\`\``;
    totalBytes += Buffer.byteLength(block, "utf8");
    if (totalBytes > REVIEW_SPECS_MAX_BYTES) {
      // The review silently degrades from "judge inline content" (deterministic, what the
      // orchestrator placed in the prompt) to "agent reads the files itself" (a weaker,
      // agent-driven path). Surface that mode switch to the operator instead of hiding it.
      console.warn(
        `[qa] WARNING: the combined contents of ${input.specs.length} spec(s) exceed the ${REVIEW_SPECS_MAX_BYTES}-byte inline cap — ` +
          `the reviewer will read files itself instead of judging inlined contents (weaker determinism).`,
      );
      return `## Specs to review\n\n${input.specs.map((n, i) => `${i + 1}. ${rel(n)}`).join("\n")}\n\n( spec contents exceed ${REVIEW_SPECS_MAX_BYTES} bytes — read each file with the read tool )`;
    }
    contents.push(block);
  }
  return `## Specs to review (${contents.length} file(s) — contents provided inline)\n\n${contents.join("\n\n")}`;
}

// Renders a deterministic RUNTIME EXECUTION RESULT section from the orchestrator's
// evidence (HTTP status codes and final URLs captured during test execution). This is
// authoritative evidence the reviewer can use to distinguish an app defect (5xx) from a
// test defect — injected by the orchestrator, not inferred from the generator's reasoning,
// so reviewer independence is preserved.
//
// Output is bounded at 4000 chars total; per-case detail is capped at 500 chars.
// finalUrl is sanitized via sanitizeText before being included in the prompt (prevents
// secrets in redirect URLs from leaking to the reviewer model).
export interface ExecutionResultCase {
  name: string;
  httpStatus?: number;
  finalUrl?: string;
  detail?: string;
}

export function renderExecutionResult(evidence: {
  verdict: string;
  cases: ExecutionResultCase[];
}): string {
  // 4000 is the user-visible bound; capText appends a truncation note of up to ~120 chars
  // when the raw content exceeds the limit. Reserve that headroom so the FINAL output
  // (including the note) stays at or below 4000 chars.
  const CAP_TOTAL = 4000;
  const CAP_TOTAL_INTERNAL = CAP_TOTAL - 130; // truncation note headroom
  const CAP_DETAIL = 500;
  const CAP_DETAIL_INTERNAL = CAP_DETAIL - 130;

  const lines: string[] = [
    `## RUNTIME EXECUTION RESULT (authoritative — captured by the orchestrator, not inferred)`,
    ``,
    `Verdict: ${evidence.verdict}`,
    ``,
  ];

  for (const c of evidence.cases) {
    lines.push(`- ${c.name}`);
    if (c.httpStatus !== undefined) {
      lines.push(`  httpStatus: ${c.httpStatus}`);
    }
    if (c.finalUrl !== undefined) {
      const { text: sanitized } = sanitizeText(c.finalUrl);
      lines.push(`  finalUrl: ${sanitized}`);
    }
    if (c.detail !== undefined) {
      const capped = capText(c.detail, CAP_DETAIL_INTERNAL);
      lines.push(`  detail: ${capped}`);
    }
  }

  const raw = lines.join("\n");
  if (raw.length <= CAP_TOTAL) return raw;
  return capText(raw, CAP_TOTAL_INTERNAL);
}

// Assemble the reviewer prompt string for `input`. Pure: reads spec files from disk
// (paths come from ReviewInput) but otherwise depends only on its argument. The
// contract-repair re-prompt and session lifecycle stay in reviewIndependently —
// only this initial BUILD moves here so it can be owned by the ContextAssembler later.
//
// Phase 1b: internally uses the ContextAssembler. Return type is unchanged (string).
// Use buildReviewerPromptAssembled() to get the sectionSizes map for telemetry.
export function buildReviewerPromptAssembled(input: ReviewInput): AssembledPrompt {
  const changeType = input.intent?.type ?? input.mode;
  const specBlock = renderReviewSpecs(input);
  const kind = input.target === "code" ? "tests" : "E2E tests";
  // What these tests must defend depends on the run mode. A diff run is judged against the
  // commit's changed code; a MANUAL run against the user's guidance; a whole-repo
  // (complete/exhaustive) run against each spec's own stated objective. Judging a
  // manual/whole-repo run against the commit diff is the [wrong-objective] bug: it rejects good
  // tests for "not testing the change" when the change was never the objective.
  const obj = reviewObjective(input);

  // STABLE prefix: the reviewer's role framing + independence mandate (same for every review).
  const roleFramingContent = [
    `## Independent review — judge these ${kind} WITHOUT the generator's reasoning`,
    ``,
    `You are reviewing tests written for ${obj.subject}, but you have NO access to the`,
    `generator's thought process. Judge the tests on their own merit using the`,
    `test-value-review skill.`,
    ``,
    `## Review context`,
    `- Run type: ${changeType}`,
    `- Base URL: ${input.baseUrl ?? "(not provided)"}`,
  ].join("\n");

  // STABLE prefix: the reviewing instructions (stable for the reviewer role).
  const rulesInstruction = input.learnedRules
    ? [`6. Also REJECT if any spec violates an app-specific reject-on-sight rule provided in this prompt.`]
    : [];
  const instructionsContent = [
    `## Instructions`,
    `1. The spec contents are provided in this prompt — no need to read files.`,
    `2. Apply the test-value-review skill from BOTH perspectives (value + robustness).`,
    `3. Answer: could ${obj.targetNoun} be BROKEN and these tests STILL be green?`,
    `4. Be strict — a single anti-pattern in any spec means rejection.`,
    `5. STAY IN YOUR LANE — judge VALUE and ROBUSTNESS. The GENERATOR owns ground-truth against the`
      + ` live app (it navigated DEV). Judge a concrete UI fact (exact label, button/link text, route)`
      + ` ONLY when the ${input.domSnapshot ? "Live DEV DOM section" : "spec itself"} confirms it. NEVER`
      + ` assert a UI fact from memory: an unconfirmed guess that a label/route "should be" something is`
      + ` NOT a valid correction — omit it. Reject on what you can SEE (no assertions, fragile selectors,`
      + ` wrong objective, missing cleanup), not on guessed app specifics.`,
    ...rulesInstruction,
  ].join("\n");

  // CRITICAL recap: the output contract — must appear last so the model's final action is the JSON.
  // Phase 4: each correction is a structured object with `text` and `severity`.
  // - "blocking": the test is broken/worthless as-is (false-positive, wrong-objective, missing-cleanup).
  // - "advisory": style/robustness nit that does not make the test worthless on its own.
  // The gate passes when zero BLOCKING corrections remain (advisory corrections are recorded but
  // do not fail the gate and do not require regeneration).
  // When priorCorrections are present, APPROVE once the previously-raised BLOCKING issues are
  // resolved — do NOT invent new nits on specs that were not changed.
  const outputContractContent = [
    `Output your verdict as JSON with no text before or after. Always include a one or two`,
    `sentence "rationale" explaining the verdict — on APPROVAL too (why these tests genuinely`,
    `defend ${obj.targetNoun}), not only on rejection.`,
    `Prefix EVERY correction with exactly one class tag from this closed list so the failure`,
    `is machine-classifiable: [false-positive] (asserts nothing / passes when the feature is`,
    `broken), [wrong-objective] (does not test ${obj.targetNoun}), [fragile-selector] (ambiguous or`,
    `brittle locator), [no-cleanup] (leaves test data behind), or [other].`,
    `Each correction MUST be a structured object with "text" (the actionable message, prefixed with the class tag) and "severity":`,
    `- "blocking": this issue makes the test worthless (false-positive, wrong-objective, missing cleanup) — fails the gate.`,
    `- "advisory": style/robustness nit that does not make the test worthless alone — recorded but does not fail the gate.`,
    `An unconfirmable UI selector (no DOM evidence in this prompt) MUST be advisory, never blocking.`,
    `{"approved":false,"rationale":"why, in 1-2 sentences","corrections":[{"text":"[fragile-selector] file.spec.ts: specific actionable fix","severity":"blocking"},{"text":"[other] file.spec.ts: minor style nit","severity":"advisory"}]}`,
  ].join("\n");

  // SEMI-STABLE: the objective heading + body (changes per run — diff commits vs guidance).
  const objectiveContent = [obj.heading, ...obj.body].join("\n");

  // VOLATILE: Live DEV DOM — the ACTUAL roles + accessible names on the routes this spec targets.
  // Captured deterministically by the ORCHESTRATOR (independence holds). Grounds the reviewer's
  // UI-fact claims in reality instead of training memory of "similar apps".
  const domContent = input.domSnapshot
    ? [
        `## Live DEV DOM — the ACTUAL roles + accessible names on the routes this spec targets`,
        `Captured by the orchestrator from ${input.baseUrl ?? "DEV"}. Judge EVERY concrete UI fact`,
        `(button/link labels, headings, routes) against THIS, never against prior knowledge of similar apps.`,
        "```",
        input.domSnapshot,
        "```",
      ].join("\n")
    : "";

  // VOLATILE: spec contents to review (the actual test code — changes each review session).
  // P5: typed maxBytes cap on reviewer corrections via REVIEW_SPECS_MAX_BYTES in renderReviewSpecs.
  const specContent = specBlock;

  // VOLATILE: proven app-specific rules as extra reject criteria (changes as the learning layer grows).
  const learnedRulesContent = input.learnedRules ? [``, input.learnedRules].join("\n") : "";

  // VOLATILE: Phase 4 — prior-round corrections. Injected on round 2+ so the reviewer can
  // converge: approve once the previously-raised BLOCKING issues are resolved; do not invent
  // new nits on specs that were not changed since the last round.
  // Capped at 8,000 bytes: this section is supplementary context, not the primary artifact.
  const PRIOR_CORRECTIONS_MAX_BYTES = 8_000;
  const priorCorrectionsContent = (() => {
    if (!input.priorCorrections || input.priorCorrections.length === 0) return "";
    const lines = input.priorCorrections.map((c, i) => `${i + 1}. ${c}`).join("\n");
    const raw = [
      `## Prior-round corrections (from YOUR previous verdict on these specs)`,
      ``,
      `The generator has addressed these corrections. Your task for this round:`,
      `- APPROVE if the previously-raised BLOCKING issues are now resolved (do not re-raise them as new blocking corrections).`,
      `- NEW blocking issues on UNCHANGED specs: only if the prior-round fix introduced a new anti-pattern.`,
      `- Advisory nits on specs that are functionally identical to the prior round: omit.`,
      ``,
      lines,
    ].join("\n");
    // Truncate to budget if needed (graceful degradation — reviewer still has the spec contents).
    if (Buffer.byteLength(raw, "utf8") > PRIOR_CORRECTIONS_MAX_BYTES) {
      const truncated = raw.slice(0, PRIOR_CORRECTIONS_MAX_BYTES);
      return truncated + "\n… (truncated — see spec contents for the full picture)";
    }
    return raw;
  })();

  // VOLATILE: runtime execution evidence — D4/D5 injection. Deterministic orchestrator evidence
  // (HTTP status codes + final URLs captured via page.on('response')) injected BEFORE the spec
  // contents so the reviewer can weigh the objective server-error signal before reading test code.
  // Priority 1.5 — after DOM grounding (which grounds UI facts) but before specs themselves.
  // Absent when the run produced no execution evidence (first-time generate, code mode, etc.).
  const executionResultContent = input.executionResult ?? "";

  return assemble([
    // STABLE prefix: role framing + independence mandate.
    section("reviewer-role-framing", "stable-prefix", roleFramingContent, { priority: 1, cacheable: true }),
    // STABLE prefix: reviewing instructions (stable for the reviewer role).
    section("reviewer-instructions", "stable-prefix", instructionsContent, { priority: 2, cacheable: true }),
    // SEMI-STABLE: the objective (commit diff for diff mode, guidance for manual, etc.).
    section("reviewer-objective", "semi-stable", objectiveContent, { priority: 1, language: "verbatim" }),
    // VOLATILE: DOM grounding (priority 1 — first in VOLATILE so it precedes the spec contents that
    // reference it; the instructions refer to it position-independently as "the Live DEV DOM section").
    ...(domContent ? [section("reviewer-dom", "volatile", domContent, { priority: 1 })] : []),
    // VOLATILE: runtime execution result — authoritative orchestrator evidence (HTTP statuses,
    // final URLs). Priority 1.5 (after DOM, before specs) so the reviewer weighs the objective
    // 5xx signal before reading test code. Absent when execution evidence is not available.
    ...(executionResultContent ? [section("reviewer-execution-result", "volatile", executionResultContent, { priority: 1.5 })] : []),
    // VOLATILE: spec contents (priority 2 — the primary content the reviewer judges).
    section("reviewer-specs", "volatile", specContent, { priority: 2 }),
    // VOLATILE: proven app-specific learned rules (priority 3 — supplementary reject criteria).
    ...(learnedRulesContent ? [section("reviewer-learned-rules", "volatile", learnedRulesContent, { priority: 3 })] : []),
    // VOLATILE: Phase 4 prior-round corrections (priority 4 — convergence context; lowest priority
    // in VOLATILE so it does not crowd out the spec contents or DOM grounding on budget overflow).
    ...(priorCorrectionsContent ? [section("reviewer-prior-corrections", "volatile", priorCorrectionsContent, { priority: 4 })] : []),
    // CRITICAL recap: the output contract (must appear at the very end).
    section("reviewer-output-contract", "critical-recap", outputContractContent, { priority: 1 }),
  ], { budgetBytes: roleWindowBytes("qa-reviewer") });
}

export function buildReviewerPrompt(input: ReviewInput): string {
  return buildReviewerPromptAssembled(input).text;
}
