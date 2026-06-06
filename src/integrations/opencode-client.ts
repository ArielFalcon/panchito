// Trigger for the OpenCode agentic engine. Generation, review (subagent) and
// access to serena/engram all live INSIDE OpenCode (see opencode/opencode.json).
// Here we only open a session against `opencode serve`, pass it the change
// context, and the agent writes/updates the tests in the working copy's `e2e/`
// folder (a git repo: the source of truth). We collect no artifacts: the harness
// runs over `e2e/` and publishing commits the git diff.
//
// The SDK is injected via OpencodeDeps: the verifiable logic (prompt building,
// verdict parsing, orchestration) is tested with stubs; the real connection to
// `opencode serve` is the boundary not covered by unit tests.

import { AgentResult, QaCase, RunMode, TestTarget } from "../types";
import { CommitIntent } from "../qa/commit-classify";
import { sanitizeText } from "../orchestrator/sanitizer";

interface SessionEntry {
  id: string;
  agent: string;
  cwd: string;
  openedAt: number;
}

const sessionRegistry = new Map<string, SessionEntry>();

export function getOpenSessions(): SessionEntry[] {
  return [...sessionRegistry.values()];
}

export function getOpenSessionCount(): number {
  return sessionRegistry.size;
}

// Read-only Q&A about a run. Opens a short-lived qa-assistant session.
export async function askAssistant(
  input: { context: string; question: string },
  deps: OpencodeDeps,
  cwd: string,
): Promise<string> {
  const session = await deps.open("qa-assistant", cwd);
  try {
    return await session.prompt([
      `Answer the operator's question about this QA run using ONLY the run context below.`,
      `Do not use any tools. If the context does not contain the answer, say so plainly.`,
      ``,
      `## Run context`,
      input.context,
      ``,
      `## Question`,
      input.question,
    ].join("\n"));
  } finally {
    await session.dispose().catch((err) => {
      console.warn(`[qa] session dispose failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

export interface OpencodeRunInput {
  repo: string;
  sha: string;
  diff: string;
  mirrorDir: string; // the agent's cwd: working copy of the repo (holds `e2e/`)
  e2eRelDir: string; // tests folder relative to mirrorDir (e.g. "e2e")
  namespace: string; // test-data prefix (qa-bot-<sha>)
  needsReview: boolean;
  target: TestTarget; // "e2e" or "code" — what KIND of tests to generate
  mode: RunMode;
  appName: string; // engram project — scopes all memory to this app
  baseUrl?: string; // e2e: the LIVE DEV URL the agent must navigate to (Playwright MCP)
  intent?: CommitIntent; // diff mode: commit intent (type + message + files)
  guidance?: string; // manual mode: user instructions
  openapi?: string | string[]; // optional hint (from app config): where the repo's OpenAPI contract(s) live
  fixCases?: QaCase[]; // re-generation: failed cases from a previous execution to fix
}

// A session opened against `opencode serve`. prompt() sends the message to the
// `qa-generator` agent and returns its final text (including the closing JSON).
// dispose() cleans up the session; call it when the session is no longer needed
// to avoid memory leaks on the server (sessions are never auto-cleaned).
export interface OpencodeSession {
  prompt(text: string): Promise<string>;
  dispose(): Promise<void>;
}

export interface OpencodeDeps {
  open(agent: string, cwd: string, opts?: { signal?: AbortSignal; timeoutMs?: number }): Promise<OpencodeSession>;
  cleanupOrphans?(maxAgeMs: number): Promise<number>;
}

interface FinalVerdict {
  approved: boolean;
  specs: string[];
  note?: string;
  parsed: boolean; // false when NO verdict JSON was found (fail-closed default), so
                   // callers can distinguish "agent rejected" from "we couldn't parse it".
}

export async function runOpencode(
  input: OpencodeRunInput,
  deps: OpencodeDeps,
  opts?: { signal?: AbortSignal; onProgress?: (msg: string) => void },
): Promise<AgentResult> {
  const timeoutMs = agentTimeout(input.mode);
  const session = await deps.open("qa-generator", input.mirrorDir, { signal: opts?.signal, timeoutMs });

  // Heartbeat: while the agent prompt is blocking, emit periodic progress logs so
  // the TUI and chat assistant have live feedback during the (potentially long)
  // generation phase instead of complete silence.
  const startedAt = Date.now();
  let heartbeat: ReturnType<typeof setInterval> | undefined;
  if (opts?.onProgress) {
    heartbeat = setInterval(() => {
      const elapsed = Math.round((Date.now() - startedAt) / 1000);
      opts.onProgress?.(`[qa] agent is working... (${elapsed}s elapsed)`);
    }, 15_000);
  }

  try {
    const finalText = await session.prompt(buildPrompt(input));

    const verdict = parseVerdict(finalText);
    // Surface a parse miss loudly: a good run must not be silently turned into a
    // rejection because we failed to read the agent's closing JSON (the #1 invariant).
    if (!verdict.parsed && input.needsReview) {
      console.warn(
        "[qa] WARNING: the agent emitted no parseable verdict JSON — failing closed " +
          "(treated as NOT approved). This is a parse miss, not necessarily a rejection.",
      );
    }
    // When review is disabled, the subagent verdict does not apply: approve.
    const approved = input.needsReview ? verdict.approved : true;

    return {
      output: finalText,
      specs: verdict.specs,
      reviewed: input.needsReview,
      approved,
      note: approved ? undefined : verdict.note ?? "the reviewer did not approve the E2E tests",
    };
  } finally {
    if (heartbeat) clearInterval(heartbeat);
    await session.dispose().catch((err) => {
      console.warn(`[qa] session dispose failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

// Independent reviewer invocation. Opens a SEPARATE qa-reviewer session (NOT a
// subagent of the generator) so the review is genuinely independent — the generator
// cannot influence the reviewer's verdict by controlling the prompt context. The
// orchestrator uses THIS verdict, not the generator's self-reported approval, when
// review is enabled.
export interface ReviewInput {
  diff: string;
  specs: string[]; // relative paths of the specs to review (under e2e/)
  mirrorDir: string;
  e2eRelDir: string;
  baseUrl?: string;
  intent?: CommitIntent;
  appName: string;
  mode: RunMode;
}

export interface ReviewResult {
  approved: boolean;
  corrections: string[];
}

export async function reviewIndependently(
  input: ReviewInput,
  deps: OpencodeDeps,
  opts?: { signal?: AbortSignal },
): Promise<ReviewResult> {
  const session = await deps.open("qa-reviewer", input.mirrorDir, { signal: opts?.signal });
  try {
    const changeType = input.intent?.type ?? input.mode;
    const prompt = [
      `## Independent review — judge these E2E tests WITHOUT the generator's reasoning`,
      ``,
      `You are reviewing tests written for this commit, but you have NO access to the`,
      `generator's thought process. Judge the tests on their own merit using the`,
      `test-value-review skill.`,
      ``,
      `## Change context`,
      `- Commit type: ${changeType}`,
      `- Base URL: ${input.baseUrl ?? "(not provided)"}`,
      ``,
      `## Commit diff`,
      "```diff",
      sanitizeText(input.diff).text,
      "```",
      ``,
      `## Specs to review`,
      ...input.specs.map((s, i) => `${i + 1}. ${input.e2eRelDir}/${s}`),
      ``,
      `## Instructions`,
      `1. Read each spec file listed above (they are in ${input.e2eRelDir}/).`,
      `2. Apply the test-value-review skill from BOTH perspectives (value + robustness).`,
      `3. Answer: could the changed feature be BROKEN and these tests STILL be green?`,
      `4. Be strict — a single anti-pattern in any spec means rejection.`,
      ``,
      `Output your verdict as JSON with no text before or after:`,
      `{"approved":false,"corrections":["file.spec.ts: specific actionable fix"]}`,
    ].join("\n");

    const output = await session.prompt(prompt);
    try {
      const json = JSON.parse(output.slice(output.lastIndexOf("{")));
      return {
        approved: json.approved === true,
        corrections: Array.isArray(json.corrections) ? json.corrections : [],
      };
    } catch {
      return { approved: false, corrections: ["the independent reviewer produced no parseable verdict"] };
    }
  } finally {
    await session.dispose().catch((err) => {
      console.warn(`[qa] reviewer session dispose failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }
}

// Parallel generation for complete/exhaustive modes. The primary agent analyzes the
// repo and produces a list of test objectives. Each objective is dispatched to a
// SEPARATE qa-worker session (flash model, cheaper) running concurrently, so N flows
// are tested in the time of one. The orchestrator then consolidates with the strong
// model.
export interface ParallelWorkerInput {
  objective: string; // the test objective (derived from code analysis)
  flow: string; // the user flow name (for the spec filename and manifest)
  symbols: string[]; // affected symbols the test should exercise
  repo: string;
  mirrorDir: string;
  e2eRelDir: string; // where to write the spec (e.g. "e2e/complete")
  namespace: string;
  baseUrl?: string;
  appName: string;
  mode: RunMode;
}

export async function generateParallel(
  workers: ParallelWorkerInput[],
  deps: OpencodeDeps,
  opts?: { signal?: AbortSignal; concurrency?: number },
): Promise<{ specs: string[]; errors: string[] }> {
  if (workers.length === 0) return { specs: [], errors: [] };
  const concurrency = opts?.concurrency ?? Math.min(workers.length, 5);
  const specs: string[] = [];
  const errors: string[] = [];

  // Process in batches to limit concurrent sessions (avoid overwhelming the API).
  for (let i = 0; i < workers.length; i += concurrency) {
    const batch = workers.slice(i, i + concurrency);
    const results = await Promise.all(
      batch.map(async (w) => {
        try {
          const session = await deps.open("qa-worker", w.mirrorDir, { signal: opts?.signal });
          try {
            const prompt = [
              `Write ONE E2E Playwright spec for this test objective:`,
              ``,
              `## Objective`,
              w.objective,
              ``,
              `## Context`,
              `- Flow: ${w.flow}`,
              `- Affected symbols (serena): ${w.symbols.join(", ")}`,
              `- Namespace prefix: ${w.namespace}`,
              `- LIVE DEV URL: ${w.baseUrl ?? "(not provided)"}`,
              `- Write the spec to: ${w.e2eRelDir}/${w.flow.replace(/[^a-z0-9-]/gi, "-")}.spec.ts`,
              `- Import: import { test, expect } from "../fixtures"`,
              ``,
              `## Rules`,
              `- Write EXACTLY ONE spec file and ONE manifest entry in ${w.e2eRelDir}/.qa/manifest.json`,
              `- Use selectors from ${w.baseUrl ? "Playwright MCP (browser_snapshot the DEV URL first)" : "the code analysis (DEV URL unavailable)"}`,
              `- End with JSON: {"spec":"filename.spec.ts"}`,
            ].join("\n");
            const output = await session.prompt(prompt);
            try {
              const json = JSON.parse(output.slice(output.lastIndexOf("{")));
              if (json.spec) specs.push(json.spec);
            } catch {
              errors.push(`${w.flow}: worker produced no parseable spec name`);
            }
          } finally {
            await session.dispose().catch(() => {});
          }
        } catch (err) {
          errors.push(`${w.flow}: ${err instanceof Error ? err.message : String(err)}`);
        }
        return null; // results collected via side effects
      }),
    );
    void results;
  }

  return { specs, errors };
}

// Assembles the dynamic message for the agent. The "how" lives in
// opencode/agent/qa-generator.md and the skills; only the task + context go here.
// The diff/guidance are sanitized (cheap defense in depth).
export function buildPrompt(input: OpencodeRunInput): string {
  // Fix mode: prepend failure feedback before the original task.
  const fixBlock = input.fixCases?.length
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
        `5. Update the manifest if the test id or targets changed`,
      ]
    : [];

  const changeType = input.intent?.type ?? input.mode;
  const openapiHint = Array.isArray(input.openapi) ? input.openapi.join(", ") : input.openapi;
  const isCode = input.target === "code";
  return [
    ...fixBlock,
    ...(fixBlock.length ? [``] : []),
    buildTask(input),
    ``,
    `## Working rules`,
    isCode
      ? [
          `- This is a CODE mode run: you are testing source-code logic, not a deployed web app.`,
          `- Detect the test framework from the repo's dependencies. Read 2-3 existing test files for conventions. Match them exactly.`,
          `- Place generated tests alongside existing ones. Use the repo's existing test command. Do not install new dependencies.`,
          `- For each test, record metadata in ${input.e2eRelDir}/.qa/manifest.json with { id, objective, targets, changeRef:{sha:"${input.sha}",type:"${changeType}"} }.`,
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
          `- For each test, add/update its entry in ${input.e2eRelDir}/.qa/manifest.json with { id, objective, flow, targets, changeRef:{sha:"${input.sha}",type:"${changeType}"} }.`,
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
    `- engram memory: scoped per app AND per mode (e2e or code). Use project="${input.appName}" on ALL mem_save, mem_search, mem_context, and mem_session_summary calls. Prefix every topic_key with "${input.target}/" so each mode's memory lives in its own namespace (e.g. topic_key="e2e/checkout-flow" or "code/order-total", not "checkout-flow"). When searching, include "${input.target}" in the query text to filter results to this mode. Never save or search without the mode prefix.`,
    input.needsReview
      ? `- Review required: invoke the qa-reviewer subagent and apply its corrections.`
      : `- Review disabled for this run: do not invoke qa-reviewer.`,
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
  // diff (default)
  const intent = input.intent;
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
  ].join("\n");
}

// Extracts the agent's closing JSON. Tolerant: looks for the LAST JSON object
// with `approved` (whether or not it sits in a ```json block). If none is valid,
// it assumes not approved (fail-closed) so nothing is published by accident.
export function parseVerdict(text: string): FinalVerdict {
  const candidates = text.match(/\{[\s\S]*?\}/g) ?? [];
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(candidates[i]!);
      if (typeof parsed.approved === "boolean") {
        return {
          approved: parsed.approved,
          specs: Array.isArray(parsed.specs) ? parsed.specs : [],
          note: typeof parsed.note === "string" ? parsed.note : undefined,
          parsed: true,
        };
      }
    } catch {
      /* not parseable JSON; keep trying earlier candidates */
    }
  }
  return { approved: false, specs: [], note: "the agent emitted no parseable verdict", parsed: false };
}

// Timeout wrapper for a promise: rejects if it elapses. Prevents a hung agent run
// from blocking the (sequential) queue, which would block every repo. Verifiable
// with stubs.
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label}: timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

const TIMEOUT_BY_MODE: Record<RunMode, number> = {
  diff: 5 * 60 * 1000,
  complete: 15 * 60 * 1000,
  exhaustive: 25 * 60 * 1000,
  manual: 10 * 60 * 1000,
};

export function agentTimeout(mode: RunMode): number {
  return Number(process.env.OPENCODE_TIMEOUT_MS) || TIMEOUT_BY_MODE[mode];
}

const MAX_AGENT_TIMEOUT_MS = Math.max(...Object.values(TIMEOUT_BY_MODE));

// Integration boundary: real connection to `opencode serve`. Not covered by unit
// tests (like the Playwright runner). The SDK is imported lazily so tests do not
// require the package. OPENCODE_SERVE_URL points to the `opencode` container.
export async function defaultOpencodeDeps(): Promise<OpencodeDeps> {
  const dispatcherTimeoutMs = Number(process.env.OPENCODE_TIMEOUT_MS) || MAX_AGENT_TIMEOUT_MS;
  // Raise undici timeouts for the worst-case agent turn (exhaustive = 25 min)
  // so our per-prompt withTimeout is the effective deadline.
  const { setGlobalDispatcher, Agent } = await import("undici");
  setGlobalDispatcher(new Agent({ headersTimeout: dispatcherTimeoutMs + 30_000, bodyTimeout: dispatcherTimeoutMs + 30_000 }));

  const { createOpencodeClient } = await import("@opencode-ai/sdk");

  const serverPassword = process.env.OPENCODE_SERVER_PASSWORD;
  const client = createOpencodeClient({
    baseUrl: process.env.OPENCODE_SERVE_URL ?? "http://opencode:4096",
    ...(serverPassword
      ? {
          headers: {
            Authorization: `Basic ${Buffer.from(`opencode:${serverPassword}`).toString("base64")}`,
          },
        }
      : {}),
  });

  return {
    // `directory` (query) positions the session in the repo working copy: the
    // agent reads/writes there. The working copy is a volume shared with the
    // `opencode` container, so the path is valid on both sides.
    open: async (agent, cwd, opts) => {
      const created = await client.session.create({ query: { directory: cwd } });
      if (created.error) throw new Error(`OpenCode session.create failed: ${JSON.stringify(created.error)}`);
      const id = created.data?.id;
      if (!id) throw new Error("OpenCode: the session returned no id");
      const entry: SessionEntry = { id, agent, cwd, openedAt: Date.now() };
      sessionRegistry.set(id, entry);

      // Wire external abort signal (cancel endpoint) to session deletion.
      const onAbort = () => client.session.delete({ path: { id } }).catch(() => {});
      opts?.signal?.addEventListener("abort", onAbort, { once: true });

      const promptTimeoutMs = opts?.timeoutMs ?? dispatcherTimeoutMs;

      return {
        prompt: (text) =>
          withTimeout(
            client.session
              .prompt({
                path: { id },
                query: { directory: cwd },
                body: { agent, parts: [{ type: "text", text }] },
              })
              .then((res) => {
                if (res.error) throw new Error(`OpenCode session.prompt failed: ${JSON.stringify(res.error)}`);
                return extractText(res.data?.parts);
              }),
            promptTimeoutMs,
            "OpenCode prompt",
          ),
        dispose: async () => {
          try {
            await client.session.delete({ path: { id } });
          } catch (err) {
            console.warn(`[qa] session ${id} dispose failed: ${err instanceof Error ? err.message : String(err)}`);
          } finally {
            opts?.signal?.removeEventListener("abort", onAbort);
            sessionRegistry.delete(id);
          }
        },
      };
    },
    cleanupOrphans: async (maxAgeMs: number) => {
      const now = Date.now();
      let cleaned = 0;
      for (const [id, entry] of sessionRegistry) {
        if (now - entry.openedAt > maxAgeMs) {
          try {
            await client.session.delete({ path: { id } });
          } catch (err) {
            console.warn(`[qa] orphan cleanup failed for session ${id}: ${err instanceof Error ? err.message : String(err)}`);
          }
          sessionRegistry.delete(id);
          cleaned++;
        }
      }
      return cleaned;
    },
  };
}

// Concatenates the text of the text parts in the agent's response.
function extractText(parts: Array<{ type: string }> | undefined): string {
  return (parts ?? [])
    .filter((p): p is { type: "text"; text: string } => p.type === "text")
    .map((p) => p.text)
    .join("");
}
