// Prompt/task assembly for the agent boundary, extracted from opencode-client.ts (BND-08). The
// "how" lives in agents/agent/*.md and the skills; these functions assemble the dynamic per-run
// TASK + CONTEXT (diff, intent, namespace, architecture map, learned rules) the agent receives.
// Pure string assembly with cheap defense-in-depth sanitization; no client/session/network state.
//
// The input types are imported TYPE-ONLY from opencode-client (erased at runtime), so although
// opencode-client imports these functions as values, there is no runtime import cycle.

import { sanitizeText } from "../orchestrator/sanitizer";
import type { ArchitectureContext } from "../qa/context";
import type { OpencodeRunInput, ParallelWorkerInput } from "./opencode-client";
import { renderExplorationBrief } from "../qa/exploration-brief";

// ── (functions appended below from the original module, verbatim) ────────────────────────────
// A spec filename derived from a flow, safe for the filesystem and Playwright's testMatch.
export function specFileForFlow(flow: string): string {
  const safe = flow.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "flow";
  return `flows/${safe}.spec.ts`;
}
// Surgical, self-contained instructions for ONE worker. Adapts based on needsUi:
// UI workers get the Playwright MCP and explore-before-write instructions; code-only
// workers use serena exclusively to derive tests from the affected symbols.
export function buildWorkerPrompt(w: ParallelWorkerInput): string {
  const rules = w.needsUi
    ? [
        w.baseUrl
          ? `- Explore YOUR flow FIRST with the Playwright MCP: browser_navigate to the LIVE DEV URL, browser_snapshot, and use ONLY selectors verified against the real DOM. Never invent selectors.`
          : `- No LIVE DEV URL: derive selectors from the code (serena) and note this limitation in a spec comment.`,
        `- Prefer getByRole/getByLabel/getByTestId; scope to a section; no waitForTimeout; no network mocks.`,
        `- At least ONE real assertion on the observable OUTCOME (not just a click). Clean up created data via cleanup().`,
      ]
    : [
        `- This is a CODE-ONLY objective (no UI). Read the affected symbols with serena, write unit/integration tests using the repo's test framework.`,
        `- Assert on BEHAVIOR (the correct output for given inputs), not implementation details. Include edge cases from the objective.`,
        `- Do NOT attempt to navigate or use browser tools — you have no Playwright MCP.`,
      ];
  return [
    `Write ONE test for this objective. Write ONLY your assigned file.`,
    ``,
    `## Objective`,
    sanitizeText(w.objective).text,
    ``,
    `## Context`,
    `- Flow: ${w.flow}`,
    w.brief
      ? `- The blast radius is distilled in the Exploration brief below — use it; do NOT re-read the code.`
      : `- Affected code symbols (read them with serena): ${w.symbols.join(", ") || "(none specified)"}`,
    `- Namespace prefix for any data you create: ${w.namespace}`,
    w.needsUi ? `- LIVE DEV URL: ${w.baseUrl ?? "(not provided)"}` : null,
    `- Write EXACTLY this file: ${w.e2eRelDir}/${w.specFile}  — do not create or edit any other file.`,
    w.needsUi ? `- Import the shared harness: import { test, expect } from "../fixtures"` : null,
    ...(w.brief ? [``, renderExplorationBrief(w.brief)] : []),
    ``,
    `## Rules`,
    ...(w.brief
      ? [`- The Exploration brief already distilled the code — do NOT re-explore it with serena; verify only selectors against the live DOM.`]
      : []),
    ...rules,
    `- Do NOT write to the manifest — the orchestrator records metadata. Do NOT read or edit other workers' files.`,
    ...(w.learnedRules
      ? [
          ``,
          `## Lessons learned from past runs (avoid repeating these)`,
          w.learnedRules,
        ]
      : []),
    `- End your reply with ONLY this JSON: {"spec":"${w.specFile}"}`,
  ].filter((l): l is string => l !== null).join("\n");
}
// return STRUCTURED objectives (no spec files). It must question its own list (drop naive flows,
// keep main use cases + MVP happy paths + relevant edge cases).
export function buildPlanPrompt(input: OpencodeRunInput): string {
  const lessonsBlock = input.learnedRules
    ? [``, `## Lessons learned from past runs (factor these into the objectives you plan)`, input.learnedRules]
    : [];
  if (input.mode === "diff") {
    return [
      `Plan E2E test objectives for the blast radius of commit ${input.sha} of ${input.repo}.`,
      ``,
      `## Phase 1 of 2 — PLANNING ONLY. Do NOT write any .spec.ts in this phase.`,
      `1. Activate serena (activate_project). Read the commit intent and diff below; derive the`,
      `   affected user flows (use find_referencing_symbols to widen from the changed symbols).`,
      `2. Plan one objective per INDEPENDENT affected flow. Do NOT plan flows the commit does not`,
      `   touch; if everything fits one flow, return a single objective.`,
      `   Each objective is a concrete acceptance criterion in given/when/then form, with the code`,
      `   symbols it exercises. Set "needsUi": true when the flow involves page navigation or DOM`,
      `   interaction, and "needsUi": false for pure logic.`,
      `3. For each objective, include a distilled "brief" of its blast radius so the worker does NOT`,
      `   re-read the code: blastRadius (each touched symbol with its file + a ONE-LINE role), the FE↔BE`,
      `   links, the relevant contract facts (fields/enums/errors to assert), and risks/what-to-assert.`,
      `   Set the brief's builtForSha to ${input.sha}. The worker trusts the brief for CODE but still`,
      `   verifies selectors against the live DOM.`,
      ``,
      `## Change intent (Conventional Commits)`,
      `- Type: ${input.intent?.type ?? "unknown"}${input.intent?.breaking ? " (BREAKING)" : ""}`,
      `- Message: ${sanitizeText(input.intent?.message ?? "").text}`,
      `- Changed files: ${sanitizeText(input.intent?.changedFiles.join(", ") ?? "").text || "(unknown)"}`,
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
      ...lessonsBlock,
      ``,
      `## Output — end with ONLY this JSON (no spec files):`,
      `{"objectives":[{"flow":"checkout","objective":"given a cart with >10 items, when paying, then the bulk discount is applied and the order is created","needsUi":true,"brief":{"builtForSha":"<the sha above>","objective":"…","blastRadius":[{"symbol":"CheckoutService.pay","file":"src/checkout/checkout.service.ts","role":"applies the bulk discount and creates the order"}],"feBe":[{"route":"/checkout","operationId":"createOrder","via":"OrderClient.create"}],"contracts":[{"operationId":"createOrder","method":"POST","path":"/orders","fields":["items","total"]}],"risks":["assert the discounted total AFTER the cart re-queries"]}}]}`,
      `If the commit's change is not testable through a user flow, output {"objectives":[]}.`,
    ].join("\n");
  }
  const exhaustive = input.mode === "exhaustive";
  return [
    exhaustive
      ? `Audit the ENTIRE E2E suite of ${input.repo} and plan a full regeneration.`
      : `Analyze the WHOLE repository ${input.repo} and plan where to GROW the E2E suite.`,
    ``,
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
    ...lessonsBlock,
    ``,
    `## Output — end with ONLY this JSON (no spec files):`,
    `{"objectives":[{"flow":"checkout","objective":"given a cart with >10 items, when paying, then the bulk discount is applied and the order is created","needsUi":true,"brief":{"builtForSha":"<the sha above>","objective":"…","blastRadius":[{"symbol":"CheckoutService.pay","file":"src/checkout/checkout.service.ts","role":"applies the bulk discount and creates the order"}],"feBe":[{"route":"/checkout","operationId":"createOrder","via":"OrderClient.create"}],"contracts":[{"operationId":"createOrder","method":"POST","path":"/orders","fields":["items","total"]}],"risks":["assert the discounted total AFTER the cart re-queries"]}}]}`,
    `If every important flow is already well covered, output {"objectives":[]}.`,
  ].join("\n");
}

// Fase 3: the dynamic task for the read-only explorer (single-agent diff path). The "how" + the
// ExplorationBrief schema live in agents/agent/qa-explorer.md; here we hand it the change to map.
export function buildExplorerPrompt(input: OpencodeRunInput): string {
  return [
    `Explore the blast radius of commit ${input.sha} of ${input.repo} and return a distilled ExplorationBrief.`,
    `You are READ-ONLY: do NOT write tests or any file. Map the change, then emit ONLY the brief JSON.`,
    ``,
    `## Change intent (Conventional Commits)`,
    `- Type: ${input.intent?.type ?? "unknown"}${input.intent?.breaking ? " (BREAKING)" : ""}`,
    `- Message: ${sanitizeText(input.intent?.message ?? "").text}`,
    `- Changed files: ${sanitizeText(input.intent?.changedFiles.join(", ") ?? "").text || "(unknown)"}`,
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
export function buildPrompt(input: OpencodeRunInput): string {
  const isGenerationMode = input.mode !== "context";

  // Review-fix mode: prepend the reviewer's actionable corrections before anything else, so
  // the agent's first priority is to resolve them (the reviewer→generator feedback loop).
  const reviewBlock = input.reviewCorrections?.length && isGenerationMode
    ? [
        `## Apply reviewer corrections (HIGHEST priority)`,
        ``,
        `An independent reviewer REJECTED the previous specs. Fix EACH item below precisely;`,
        `do NOT rewrite specs that were not flagged. Where a fix concerns a selector or an`,
        `assertion, re-verify it against the live DOM with the Playwright MCP before editing.`,
        ``,
        ...input.reviewCorrections.map((c) => `- ${c}`),
        ``,
      ]
    : [];

  // Coverage-improvement mode: the executed tests did not exercise some changed lines. Tell the
  // agent exactly which, so it extends/adds tests to cover the change (the change-coverage loop).
  const coverageBlock = input.coverageGap && isGenerationMode
    ? [
        `## Cover the change (HIGH priority)`,
        ``,
        `The tests ran green but did NOT exercise all the lines this commit changed. Extend or add`,
        `tests so those lines are actually executed and asserted (covering ≠ asserting — assert the`,
        `behavior of the changed code, do not just touch the line):`,
        ``,
        input.coverageGap,
        ``,
      ]
    : [];

  const learnedRulesBlock = input.learnedRules && isGenerationMode
    ? [input.learnedRules, ``]
    : [];

  // Fix mode: prepend failure feedback before the original task.
  const fixBlock = input.fixCases?.length && isGenerationMode
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
      ]
    : [];

  const changeType = input.intent?.type ?? input.mode;
  const openapiHint = Array.isArray(input.openapi) ? input.openapi.join(", ") : input.openapi;
  const isCode = input.target === "code";
  const memTarget = input.mode === "context" ? "context" : input.target;
  return [
    ...reviewBlock,
    ...coverageBlock,
    ...learnedRulesBlock,
    ...fixBlock,
    ...(fixBlock.length ? [``] : []),
    buildTask(input),
    ``,
    ...(input.contextMap
      ? [
          renderArchitectureContext(
            input.contextMap,
            input.mode === "diff" ? input.intent?.changedFiles : undefined,
          ) ?? "",
          ``,
        ]
      : []),
    ...(input.contextBrief
      ? [
          renderExplorationBrief(input.contextBrief),
          `(The brief above distilled the blast radius — do NOT re-read that code. Verify selectors against the live DOM.)`,
          ``,
        ]
      : []),
    `## Working rules`,
    input.mode === "context"
      ? [
          `- This is a CONTEXT mode run: you are building the FE↔BE architecture map, not writing tests.`,
          `- Your ONLY output is ${input.e2eRelDir}/.qa/context.json — do not create or modify any .spec.ts files.`,
          `- Use ONLY serena to read code (activate_project, find_symbol, get_symbols_overview) — no Playwright MCP.`,
          `- Extract from STRUCTURED sources: every route from a routing file, every operation from an OpenAPI spec.`,
          `- Consult the architecture-mapping skill for detailed extraction patterns per source type.`,
          `- The task block above has the complete procedure. Follow it precisely.`,
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
          `- Playwright MCP is AVAILABLE and you MUST use it BEFORE writing any test: browser_navigate to`,
          `  the LIVE DEV URL above, then browser_snapshot to read the ACTUAL DOM. Selectors MUST be verified`,
          `  against the real DOM, NEVER invented from code analysis alone.`,
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
        ],
    `- engram memory: scoped per app AND per mode (e2e, code, or context). Use project="${input.appName}" on ALL mem_save, mem_search, mem_context, and mem_session_summary calls. Prefix every topic_key with "${memTarget}/" so each mode's memory lives in its own namespace (e.g. topic_key="context/angular-routes" or "e2e/checkout-flow"). When searching, include "${memTarget}" in the query text to filter results to this mode. Never save or search without the mode prefix.`,
    input.needsReview
      ? `- An INDEPENDENT reviewer judges your specs after you finish and may return corrections for a follow-up turn. Self-review against the test-value-review criteria BEFORE finishing (every spec must fail if its feature breaks); do not rely on spawning a subagent.`
      : `- Review disabled for this run.`,
  ].join("\n");
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
      `Use serena to read the relevant code and the existing ${input.e2eRelDir}/ suite.`,
      `Stay focused on the guidance; do not generate unrelated tests.`,
    ].join("\n");
  }
  if (input.mode === "context") return buildContextTask(input);

  // diff (default)
  const intent = input.intent;
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
    `- Message: ${sanitizeText(intent?.message ?? "").text}`,
    `- Changed files (derive the scope/area from these): ${intent?.changedFiles.join(", ") || "(unknown)"}`,
    `The message gives the INTENT; derive each test's objective from it. But CROSS-CHECK`,
    `against the diff: if the code does more than the message claims, cover what the code`,
    `actually changes, not just what the message promises.`,
    ``,
    `## Commit diff`,
    "```diff",
    sanitizeText(input.diff).text,
    "```",
    ...serviceBlock,
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
