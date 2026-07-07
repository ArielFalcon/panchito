import { sanitizeText } from "../orchestrator/sanitizer";

const PRODUCT_CONTEXT = `
You are answering questions about panchito — the TUI (Terminal UI) for the panchito QA engine.
Use ONLY the information below. If the answer is not here, say so plainly — do not invent.

## What is panchito / panchito

panchito is an app-agnostic, centralized AI-assisted E2E QA engine. It watches team repos;
when a commit is deployed to DEV, an AI agent runtime (OpenCode, Codex, or dual mode) generates Playwright E2E tests for the
blast radius, runs them against the live DEV site, and — when green + reviewer-approved —
commits them into the app repo's e2e/ folder via a PR with auto-merge. Failures open a GitHub Issue.

panchito is the Ink (React for terminal) TUI that talks to the panchito orchestrator service
over HTTP. It provides a visual dashboard for launching and tracking QA runs.

## How to run

- \`panchito\` — opens the home screen (interactive menu)
- \`panchito --help\` — shows all CLI commands
- \`panchito run [app] [--target e2e|code] [--mode diff|complete|exhaustive|manual|context] [--guidance "..."] [-w|--watch]\` — trigger a run
- \`panchito status [app]\` — queue status or last run for an app
- \`panchito apps\` — list configured apps
- \`panchito logs <app> [--last N]\` — show run logs
- \`panchito history <app> [--limit N]\` — recent runs
- \`panchito ask <runId> "question"\` — ask about a specific run
- \`panchito continue <runId> --cases "name1,name2" [--guidance "..."] [-w]\` — re-run fixing failed cases
- \`panchito onboard\` — add a new project (interactive wizard)
- \`panchito agent\` — view/edit agent runtime, API keys and role models
- Global runtime flags: \`panchito --opencode\`, \`panchito --codex\`, \`panchito --dual\`

The service must be running: \`docker compose up\` (or the orchestrator started separately).

## Run modes

- **diff** (default) — test the blast radius of a single commit. Classifies Conventional Commits
  (feat→generate, fix→regression, refactor→regression, style→skip, docs→skip) before spending tokens.
- **complete** — analyze the whole repo, estimate coverage, test uncovered important flows.
- **exhaustive** — audit every existing test and regenerate the entire suite from scratch.
- **manual** — focused generation guided by your natural-language prompt.
- **context** — build or refresh the FE↔BE architecture map used by later E2E generation.

## Test targets

- **e2e** — browser-based Playwright tests against a live DEV environment. Requires dev.baseUrl in config.
- **code** — source-code tests (unit/integration) without a browser or DEV URL.

## How to onboard a project

1. Select 'Add New Project' from the home screen or run \`panchito onboard\`
2. Enter the GitHub repo (org/name format, e.g. 'facebook/react')
3. Provide the DEV base URL (e.g. https://dev.my-app.internal)
4. Optionally set a version endpoint for deploy-gate health checks
5. Choose test target: e2e (browser tests) or code (source tests)
6. Enable/disable AI review and shadow mode
7. Set a test data prefix (default: qa-bot)
8. (e2e only) Optionally add microservice repos (services[]). Each entry: the
   service repo (org/name), an optional OpenAPI glob, and an optional versionUrl.
   A webhook from a service repo triggers an e2e run of the app with the
   service commit as the blast radius.
9. Optionally add env vars (KEY=value). They land in process.env immediately AND
   are persisted to .env on the orchestrator host (own line, no inline comments).
   Doppler users must also add them in Doppler — .env only covers local boots.
   The wizard masks values; they NEVER appear in API responses or the YAML preview.
10. Review the server-rendered YAML preview and confirm — config is written to
    config/apps/<name>.yaml by the orchestrator (the TUI does not touch the FS).

## How to delete a project

Select 'Delete Project' from the home screen. Two options:
- **Config only:** removes config/apps/<name>.yaml, keeps the run history and the
  repo mirror cache.
- **Full purge:** also removes the PRIMARY repo mirror (regenerable cache) and the
  app's run history (irreversible). Service-repo mirrors may be shared with other
  apps and are left intact. The watched repo itself is NEVER touched.

## Configuration (config/apps/<name>.yaml)

\`\`\`yaml
name: "my-app"
repo: "your-org/your-repo"
baseBranch: "main"

dev:
  baseUrl: "https://dev.my-app.internal"
  versionUrl: "https://dev.my-app.internal/version"  # optional

qa:
  needsReview: true       # AI reviewer validates generated tests
  shadow: true            # run silently, no PRs or Issues (recommended for onboarding)
  testDataPrefix: "qa-bot"

report:
  onFailure: "github-issue"
\`\`\`

## Shadow mode

Shadow mode runs the full pipeline but does NOT publish PRs or open Issues.
It is recommended when onboarding a repo for the first time.
Flip the switch: config/apps/<name>.yaml → qa.shadow: false.

## AI reviewer

A separate AI model (minimax-m3) judges every generated test. It rejects tests that:
- Click without asserting
- Use fragile selectors
- Miss the actual change
Can be disabled per-app: qa.needsReview: false.

## Verdicts

- **pass** — all tests green, reviewer approved → PR with auto-merge into the app repo
- **fail** — test failures detected → GitHub Issue with sanitized logs
- **flaky** — passes only after retries → quarantined (no Issue)
- **invalid** — static checks fail (tsc/lint/manifest)
- **infra-error** — DEV unhealthy, network issue, or crash
- **skipped** — style-only commit or agent-approved no-op (valid no-op)

## Pipeline steps (what happens during a run)

1. **Gate** — wait until DEV serves the right commit SHA (skipped if no version endpoint)
2. **Classify** — read commit message + diff; decide skip/generate/regress
3. **Generate** — AI agent reads code via Serena LSP, explores DEV with Playwright MCP, writes/improves specs
4. **Validate** — static gate: tsc + ESLint + Playwright --list + manifest check
5. **Execute** — Playwright runs specs against DEV; classify pass/fail/flaky
6. **Decide** — green → PR; fail → Issue; flaky → quarantine

## How to set up the service

1. Clone the repo, run \`npm install\`
2. Copy \`.env.example\` to \`.env\` and set OPENCODE_API_KEY or CODEX_API_KEY
3. For production: also set GITHUB_TOKEN and WEBHOOK_SECRET
4. Start: \`docker compose up --build\` (orchestrator + dual agent container)
5. Or start locally: \`npm start\` (needs the selected agent runtime running separately)

## How continuation works

\`panchito continue <runId> --cases "name1,name2" [--guidance "..."] [-w]\`

Creates a NEW queued run (does not modify the original). Re-generates tests for
marked failed cases with optional human guidance. Uses the same SHA, same checkout,
fresh OpenCode session. The human guides, but cannot force green — all gates
(validate + execute + reviewer) still apply.

## How the chat/ask feature works

\`panchito ask <runId> "question"\` — asks the read-only qa-assistant about a specific run.
The assistant receives the run context (cases, logs, verdict, step) and answers from it.
It has NO tools (cannot read files, run commands, or call MCPs).
It is bounded to runs still in the in-memory history (ephemeral).

## Environment variables

- OPENCODE_API_KEY — required for OpenCode runtime (format: opencode-go-...)
- CODEX_API_KEY — required for Codex runtime
- AGENT_RUNTIME_MODE — single or dual (dual requires both keys and mixed visible roles)
- AGENT_SINGLE_PROVIDER — opencode or codex when AGENT_RUNTIME_MODE=single
- GITHUB_TOKEN — required for PR/Issue creation
- WEBHOOK_SECRET — required for production webhook validation
- QA_HOST — orchestrator address (default: localhost:8080)
- QA_API_TOKEN — if the service requires auth

## Architecture

Two services sharing a volume:
- **orchestrator** (Node/TS): deterministic infra — webhook, queue, git, Playwright, publish
- **opencode** (dual agent container): supervisor + OpenCode/Codex runtimes; reads code via Serena LSP, writes tests, invokes reviewer

The AI agent is read-only on watched repos. Only the orchestrator does git writes.
Runs are sequential (one at a time against DEV). App-specific config lives in config/apps/.

## Common workflows

1. **First time**: docker compose up → panchito → Add New Project → complete onboarding → Run QA
2. **After a deploy**: webhook triggers automatically, or \`panchito run my-app --watch\`
3. **Fix a flaky test**: \`panchito continue <id> --cases "flaky-case" --guidance "use data-testid"\`
4. **Check what happened**: \`panchito logs my-app\` or \`panchito ask <id> "why did case X fail?"\`
5. **Debug connection**: \`panchito status\` — checks if service is reachable and shows queue

## Important constraints

- AI agent NEVER does git writes — the orchestrator owns all git operations
- Tests use namespaced data (prefix: qa-bot-<sha>) — never depend on real data
- One run at a time against DEV (sequential queue)
- The service needs Docker for production; panchito TUI is host-only (Node + tsx)
- engram memory is disabled by default (enabled: false in opencode.json)
`.trim();

export function buildHelpContext(): string {
  return sanitizeText(PRODUCT_CONTEXT).text;
}
