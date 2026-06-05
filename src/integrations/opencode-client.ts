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

import { AgentResult, QaCase, RunMode } from "../types";
import { CommitIntent } from "../qa/commit-classify";
import { sanitizeText } from "../orchestrator/sanitizer";

export interface OpencodeRunInput {
  repo: string;
  sha: string;
  diff: string;
  mirrorDir: string; // the agent's cwd: working copy of the repo (holds `e2e/`)
  e2eRelDir: string; // tests folder relative to mirrorDir (e.g. "e2e")
  namespace: string; // test-data prefix (qa-bot-<sha>)
  needsReview: boolean;
  mode: RunMode;
  appName: string; // engram project — scopes all memory to this app
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
  // Opens a session for `agent` with `cwd` as the project directory.
  open(agent: string, cwd: string): Promise<OpencodeSession>;
}

interface FinalVerdict {
  approved: boolean;
  specs: string[];
  note?: string;
}

export async function runOpencode(
  input: OpencodeRunInput,
  deps: OpencodeDeps,
): Promise<AgentResult> {
  const session = await deps.open("qa-generator", input.mirrorDir);
  try {
    const finalText = await session.prompt(buildPrompt(input));

    const verdict = parseVerdict(finalText);
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
    await session.dispose().catch(() => {
      // Session cleanup is best-effort; never let a cleanup failure shadow the result.
    });
  }
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
          (c) => `- ${c.name}${c.detail ? `: ${c.detail.slice(0, 300)}` : ""}`,
        ),
        ``,
        `For each failure:`,
        `1. Read the test file to understand what it asserts`,
        `2. Fix the root cause (scope the selector to a section, use getByRole,`,
        `   make the regex unambiguous — do NOT just add .first())`,
        `3. Keep the test's objective and assertions — fix only what's broken`,
        `4. Update the manifest if the test id or targets changed`,
      ]
    : [];

  const changeType = input.intent?.type ?? input.mode;
  const openapiHint = Array.isArray(input.openapi) ? input.openapi.join(", ") : input.openapi;
  return [
    ...fixBlock,
    ...(fixBlock.length ? [``] : []),
    buildTask(input),
    ``,
    `## Working rules`,
    `- Work in the repo's tests folder: ${input.e2eRelDir}/ (source of truth in git). Reuse and improve existing fixtures/specs; do not duplicate.`,
    `- For each test, add/update its entry in ${input.e2eRelDir}/.qa/manifest.json with { id, objective, flow, targets, changeRef:{sha:"${input.sha}",type:"${changeType}"} }.`,
    `- Test-data prefix: ${input.namespace}`,
    `- engram memory: use project="${input.appName}" on ALL mem_save, mem_search, mem_context, and mem_session_summary calls. Never omit the project parameter — this isolates memory per app and prevents cross-contamination across different applications.`,
    `- Consult the playwright-authoring skill for robust specs and this app's capabilities.`,
    ...(openapiHint
      ? [
          `- OpenAPI contract(s) for this repo: ${openapiHint}. For any backend endpoint the affected flow touches, read the matching operation and assert against its contract (required fields, enums, validation/error responses). Drive the app through the web UI like a user — never call the API directly.`,
        ]
      : []),
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
      sanitizeText(input.guidance ?? "(no guidance provided)"),
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
    `- Message: ${sanitizeText(intent?.message ?? "")}`,
    `- Changed files (derive the scope/area from these): ${intent?.changedFiles.join(", ") || "(unknown)"}`,
    `The message gives the INTENT; derive each test's objective from it. But CROSS-CHECK`,
    `against the diff: if the code does more than the message claims, cover what the code`,
    `actually changes, not just what the message promises.`,
    ``,
    `## Commit diff`,
    "```diff",
    sanitizeText(input.diff),
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
        };
      }
    } catch {
      /* not parseable JSON; keep trying earlier candidates */
    }
  }
  return { approved: false, specs: [], note: "the agent emitted no verdict" };
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

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000; // 15 minutes per agent run

// Integration boundary: real connection to `opencode serve`. Not covered by unit
// tests (like the Playwright runner). The SDK is imported lazily so tests do not
// require the package. OPENCODE_SERVE_URL points to the `opencode` container.
export async function defaultOpencodeDeps(): Promise<OpencodeDeps> {
  const timeoutMs = Number(process.env.OPENCODE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;
  // The agent turn is a single long-held HTTP request: the server sends no
  // response until the agent finishes, which can exceed undici's default 5-minute
  // headers timeout (e.g. complete/exhaustive runs). Raise undici's timeouts so
  // our withTimeout is the effective deadline, not a transport-level abort.
  const { setGlobalDispatcher, Agent } = await import("undici");
  setGlobalDispatcher(new Agent({ headersTimeout: timeoutMs + 30_000, bodyTimeout: timeoutMs + 30_000 }));

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
    open: async (agent, cwd) => {
      const created = await client.session.create({ query: { directory: cwd } });
      if (created.error) throw new Error(`OpenCode session.create failed: ${JSON.stringify(created.error)}`);
      const id = created.data?.id;
      if (!id) throw new Error("OpenCode: the session returned no id");
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
                // Surface OpenCode errors instead of silently returning empty
                // (e.g. unknown agent, model not found, auth failure).
                if (res.error) throw new Error(`OpenCode session.prompt failed: ${JSON.stringify(res.error)}`);
                return extractText(res.data?.parts);
              }),
            timeoutMs,
            "OpenCode prompt",
          ),
        dispose: () => client.session.delete({ path: { id } }).then(() => {}),
      };
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
