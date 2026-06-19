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
import type { OpencodeRunInput, ParallelWorkerInput, ReviewInput } from "./opencode-client";
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
        `- Prefer getByRole/getByLabel/getByTestId; scope to a section; no waitForTimeout; no network mocks.`,
        `- getByRole matches the ACCESSIBILITY TREE, not the HTML tag: a <th> is often NOT a "columnheader", a <table> may lose its "table"/"row"/"cell" roles (Bootstrap/CSS strips them). Use ONLY roles + names you LITERALLY SEE in the injected tree; if the role isn't there, use getByText or a scoped locator. A getByRole that matches 0 elements passes review but TIMES OUT on execution.`,
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
        `If a role you expected (e.g. \`columnheader\`) is NOT listed, it is NOT in the tree:`,
        `use \`getByText\` or a scoped locator instead. If a name appears MORE THAN ONCE,`,
        `scope it to a unique parent (a bare getByRole/getByText would match multiple → strict-mode error).`,
        w.domSnapshot,
      ].join("\n")
    : "";

  // VOLATILE: lessons from past runs (injected at call time, may change across runs).
  const learnedRulesContent = w.learnedRules
    ? [`## Lessons learned from past runs (avoid repeating these)`, w.learnedRules].join("\n")
    : "";

  return assemble([
    // STABLE prefix: procedural rules (deterministic given the worker role + needsUi).
    section("worker-rules", "stable-prefix", rulesBlock, { priority: 1, cacheable: true }),
    // SEMI-STABLE: objective + context (changes per worker assignment but stable within a turn).
    section("worker-context", "semi-stable", contextLines, { priority: 1 }),
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
        `{"objectives":[{"flow":"checkout","objective":"given a cart with >10 items, when paying, then the bulk discount is applied and the order is created","needsUi":true,"brief":{"builtForSha":"<the sha above>","objective":"…","blastRadius":[{"symbol":"CheckoutService.pay","file":"src/checkout/checkout.service.ts","role":"applies the bulk discount and creates the order"}],"routes":[{"path":"/#!/checkout","verified":true}],"feBe":[{"route":"/checkout","operationId":"createOrder","via":"OrderClient.create"}],"contracts":[{"operationId":"createOrder","method":"POST","path":"/orders","fields":["items","total"]}],"risks":["assert the discounted total AFTER the cart re-queries"]}}]}`,
        input.mode === "diff"
          ? `If the commit's change is not testable through a user flow, output {"objectives":[]}.`
          : `If the guidance does not yield any testable flow, output {"objectives":[]}.`,
      ].join("\n")
    : [
        `## Output — end with ONLY this JSON (no spec files):`,
        `{"objectives":[{"flow":"checkout","objective":"given a cart with >10 items, when paying, then the bulk discount is applied and the order is created","needsUi":true,"brief":{"builtForSha":"<the sha above>","objective":"…","blastRadius":[{"symbol":"CheckoutService.pay","file":"src/checkout/checkout.service.ts","role":"applies the bulk discount and creates the order"}],"routes":[{"path":"/#!/checkout","verified":true}],"feBe":[{"route":"/checkout","operationId":"createOrder","via":"OrderClient.create"}],"contracts":[{"operationId":"createOrder","method":"POST","path":"/orders","fields":["items","total"]}],"risks":["assert the discounted total AFTER the cart re-queries"]}}]}`,
        `If every important flow is already well covered, output {"objectives":[]}.`,
      ].join("\n");

  // FIX 3: when the orchestrator already ran the read-only explorer pass (exploreForPack), its brief
  // is forwarded here as input.contextBrief. The planner must USE it — the blast radius is already
  // distilled — instead of paying for a second full Serena widen (find_referencing_symbols) that
  // re-derives the same thing the explorer just produced. The brief is rendered as its own SEMI-STABLE
  // section, and step 1 of the procedure switches to "trust the brief" when present.
  const planBriefContent = input.contextBrief
    ? [
        ``,
        `## Exploration brief (the blast radius was ALREADY mapped by the explorer pass — use it; do NOT re-widen)`,
        renderExplorationBrief(input.contextBrief),
        `Derive the objectives DIRECTLY from this brief's blast radius and routes. Do NOT re-run`,
        `find_referencing_symbols to re-discover the blast radius — it is already distilled above.`,
        ``,
      ].join("\n")
    : "";

  if (input.mode === "diff") {
    // STABLE prefix: the planning procedure (same structure for every diff-mode plan session).
    const planProcedure = [
      `## Phase 1 of 2 — PLANNING ONLY. Do NOT write any .spec.ts in this phase.`,
      input.contextBrief
        ? `1. The blast radius is ALREADY mapped in the Exploration brief below — read it (and the commit intent/diff) and derive the affected user flows from it. Do NOT re-run find_referencing_symbols to re-discover the blast radius. Activate serena only if you need to confirm a specific symbol.`
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
      `4. Lever-3 route verification (REQUIRED for needsUi objectives): use the Playwright MCP to`,
      `   navigate each flow — especially interaction flows that land on a NEW route (e.g.`,
      `   owner-register → /#!/owners/{id}). Discover and verify the post-interaction landing routes.`,
      `   Declare them in \`routes[]\` with \`"verified": true\`. Only mark verified routes you actually`,
      `   navigated to and confirmed exist. Unverified (static/pattern) routes keep \`"verified": false\`.`,
      `   The orchestrator captures the live DOM for ONLY the verified routes and injects it into workers.`,
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
      ...(lessonsContent ? [section("plan-lessons", "semi-stable", lessonsContent, { priority: 3 })] : []),
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
        ? `1. The blast radius is ALREADY mapped in the Exploration brief below — read it (and the guidance) and derive the affected flows from it. Do NOT re-run find_referencing_symbols to re-discover the blast radius. Activate serena only to confirm a specific symbol or to read the existing suite in ${input.e2eRelDir}/.`
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
      `4. Lever-3 route verification (REQUIRED for needsUi objectives): use the Playwright MCP to`,
      `   navigate each flow. Discover and verify the routes the guidance targets.`,
      `   Declare them in \`routes[]\` with \`"verified": true\`. Only mark verified routes you actually`,
      `   navigated to and confirmed exist. Unverified routes keep \`"verified": false\`.`,
      `   The orchestrator captures the live DOM for ONLY the verified routes and injects it into workers.`,
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
      ...(lessonsContent ? [section("plan-lessons", "semi-stable", lessonsContent, { priority: 3 })] : []),
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
    ...(lessonsContent ? [section("plan-lessons", "semi-stable", lessonsContent, { priority: 3 })] : []),
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
export function buildPromptAssembled(input: OpencodeRunInput): AssembledPrompt {
  const isGenerationMode = input.mode !== "context";
  const openapiHint = Array.isArray(input.openapi) ? input.openapi.join(", ") : input.openapi;
  const isCode = input.target === "code";
  const memTarget = input.mode === "context" ? "context" : input.target;

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
        ]),
    `- engram memory: scoped per app AND per mode (e2e, code, or context). Use project="${input.appName}" on ALL mem_save, mem_search, mem_context, and mem_session_summary calls. Prefix every topic_key with "${memTarget}/" so each mode's memory lives in its own namespace (e.g. topic_key="context/angular-routes" or "e2e/checkout-flow"). When searching, include "${memTarget}" in the query text to filter results to this mode. Never save or search without the mode prefix.`,
    input.needsReview
      ? `- An INDEPENDENT reviewer judges your specs after you finish and may return corrections for a follow-up turn. Self-review against the test-value-review criteria BEFORE finishing (every spec must fail if its feature breaks); do not rely on spawning a subagent.`
      : `- Review disabled for this run.`,
  ];
  const workingRulesContent = workingRulesLines.join("\n");

  // SEMI-STABLE: architecture map (stable for this run, changes between runs).
  const archMapContent = input.contextMap
    ? [
        renderArchitectureContext(
          input.contextMap,
          input.mode === "diff" ? input.intent?.changedFiles : undefined,
        ) ?? "",
        ``,
      ].join("\n")
    : "";

  // SEMI-STABLE: exploration brief (set by the pre-write explorer pass; stable for this turn).
  const contextBriefContent = input.contextBrief
    ? [
        renderExplorationBrief(input.contextBrief),
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
          `(i.e. no matching line exists in this tree) MUST be rejected and replaced with`,
          `\`getByText\` or a scoped CSS/data-testid locator instead.`,
          ``,
          input.domSnapshot,
          ``,
        ].join("\n")
      : [
          `## Live DEV accessibility tree (GROUND TRUTH for selectors — trust this over HTML intuition)`,
          ``,
          `These are the roles + accessible names the browser ACTUALLY exposes for the target routes.`,
          `Author selectors ONLY from what appears below:`,
          `- If a role you expected (e.g. \`columnheader\`) is NOT listed, it is NOT in the a11y tree —`,
          `  do NOT use \`getByRole\` for it. Fall back to \`getByText\` or a scoped locator.`,
          `- If a name appears MORE THAN ONCE, a bare \`getByRole\`/\`getByText\` matches multiple elements`,
          `  (strict-mode violation) — scope it to a unique parent/section, or use a unique attribute.`,
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
        ...input.fixCases.map(
          (c) => `- ${c.name}\n  Error: ${c.detail?.slice(0, 500) ?? "(no detail)"}`,
        ),
        ``,
        ...(input.failureSourced
          ? [
              `The captured a11y tree at the failure point is injected ABOVE as "GROUND TRUTH AT FAILURE".`,
              `1. Read the test file to understand what it asserts`,
              `2. Consult ONLY the GROUND TRUTH tree above — do NOT navigate or snapshot the live page.`,
              `   The tree above is the page AT THE FAILURE POINT, not the current live state.`,
              `3. Fix the ROOT CAUSE, guided by the error type:`,
              `   - "strict mode violation" → scope the selector to a section first`,
              `   - "locator.click: … not found" → the element doesn't exist; check role/label in the GROUND TRUTH tree`,
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
        `do NOT rewrite specs that were not flagged. Where a fix concerns a selector or an`,
        `assertion, re-verify it against the live DOM with the Playwright MCP before editing.`,
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
        input.coverageGap,
        ``,
      ].join("\n")
    : "";

  // VOLATILE: learned anti-patterns from past runs.
  const learnedRulesContent = input.learnedRules && isGenerationMode
    ? [input.learnedRules, ``].join("\n")
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

  return assemble([
    // STABLE prefix: working rules (mode-specific but stable for the generator role per session).
    section("working-rules", "stable-prefix", workingRulesContent, { priority: 1, cacheable: true }),
    // SEMI-STABLE: architecture map and exploration brief (change between runs, stable within).
    ...(archMapContent ? [section("arch-map", "semi-stable", archMapContent, { priority: 1, cacheable: true })] : []),
    ...(contextBriefContent ? [section("context-brief", "semi-stable", contextBriefContent, { priority: 2 })] : []),
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
    // VOLATILE: learned rules (priority 6 — lowest, as they're supplementary anti-patterns).
    ...(learnedRulesContent ? [section("learned-rules", "volatile", learnedRulesContent, { priority: 6 })] : []),
    // TASK: the concrete mode-specific objective.
    section("task", "task", taskContent, { priority: 1 }),
  ], { budgetBytes: roleWindowBytes("qa-generator") });
}

export function buildPrompt(input: OpencodeRunInput): string {
  return buildPromptAssembled(input).text;
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

  if (relevantLinks.length) {
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
function buildTask(input: OpencodeRunInput): string {
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
    `## Commit diff`,
    "```diff",
    sanitizeText(input.diff).text,
    "```",
    ...serviceBlock,
    ``,
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
    `## Scope budget (diff mode — do NOT over-work)`,
    `The blast radius IS your budget. This is ONE commit, so keep generation fast and focused:`,
    `- Read ONLY the changed symbols and their direct callers/callees (find_referencing_symbols).`,
    `- Do NOT read the whole repository, the entire e2e suite, or unrelated flows/files.`,
    `- Read existing specs ONLY for the one or two flows this commit actually touches.`,
    `- Explore ONLY the page(s) the change affects — not the whole app.`,
    `A handful of focused specs is the right output for a single-commit diff, not a suite rewrite.`,
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
