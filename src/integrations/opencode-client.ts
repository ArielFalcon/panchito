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

import { AgentResult } from "../types";
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
  intent: CommitIntent; // commit intent (type + message + files)
}

// A session opened against `opencode serve`. prompt() sends the message to the
// `qa-generator` agent and returns its final text (including the closing JSON).
export interface OpencodeSession {
  prompt(text: string): Promise<string>;
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
}

// Assembles the dynamic message for the agent. The "how" lives in
// opencode/agent/qa-generator.md; only the change context goes here. The diff is
// sanitized anyway (cheap defense in depth).
export function buildPrompt(input: OpencodeRunInput): string {
  const { intent } = input;
  return [
    `Generate/update E2E tests for the flows affected by commit ${input.sha} of ${input.repo}.`,
    ``,
    `## Change intent (Conventional Commits)`,
    `- Type: ${intent.type}${intent.breaking ? " (BREAKING)" : ""}`,
    `- Message: ${sanitizeText(intent.message)}`,
    `- Changed files (derive the scope/area from these): ${intent.changedFiles.join(", ") || "(unknown)"}`,
    `The message gives the INTENT; derive each test's objective (acceptance criterion)`,
    `from it. But CROSS-CHECK against the diff: if the code does more than the message`,
    `claims, cover what the code actually changes, not just what the message promises.`,
    ``,
    `- Work in the repo's tests folder: ${input.e2eRelDir}/ (source of truth in git).`,
    `  Reuse and improve existing fixtures/specs; do not duplicate.`,
    `- For each test, add/update its entry in ${input.e2eRelDir}/.qa/manifest.json with`,
    `  { id, objective, flow, targets, changeRef:{sha:"${input.sha}",type:"${intent.type}"} }.`,
    `- Test-data prefix: ${input.namespace}`,
    input.needsReview
      ? `- Review required: invoke the qa-reviewer subagent and apply its corrections.`
      : `- Review disabled for this run: do not invoke qa-reviewer.`,
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
  const { createOpencodeClient } = await import("@opencode-ai/sdk");
  const client = createOpencodeClient({
    baseUrl: process.env.OPENCODE_SERVE_URL ?? "http://opencode:4096",
  });
  const timeoutMs = Number(process.env.OPENCODE_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS;

  return {
    // `directory` (query) positions the session in the repo working copy: the
    // agent reads/writes there. The working copy is a volume shared with the
    // `opencode` container, so the path is valid on both sides.
    open: async (agent, cwd) => {
      const created = await client.session.create({ query: { directory: cwd } });
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
              .then((res) => extractText(res.data?.parts)),
            timeoutMs,
            "OpenCode prompt",
          ),
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
