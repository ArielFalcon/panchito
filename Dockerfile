# `orchestrator` container: the Node infrastructure (webhook, gate, working copy,
# E2E execution, reporting). The agentic generation runs in the separate
# `opencode` container (see docker-compose.yml + opencode/Dockerfile).
#
# Base = the official Playwright image (Node + browsers preinstalled): this is
# where the agent-generated E2E tests RUN, against DEV.
FROM mcr.microsoft.com/playwright:v1.50.0-jammy

# git: to clone/check out the working copies of the watched repos.
# Code-mode runtimes: the orchestrator runs the watched repo's own test suite
# (Python/pytest, Go, Rust/Cargo, Maven, Gradle) for code-mode apps. These run
# in the orchestrator process, NOT in the opencode container — see code-runner.ts.
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    python3 python3-pip python3-venv \
    golang \
    cargo rustc \
    maven \
    gradle \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
# Install ALL deps (not --omit=dev): the service runs TypeScript directly via
# `tsx` at runtime (no build step), and tsx is a devDependency.
RUN npm install

COPY . .

# The e2e tooling (Playwright runner + eslint + tsc) is NOT installed here: it
# lives in each repo's `e2e/`, and the orchestrator runs `npm ci` there per run
# (qa/setup.ts). The image already ships the Playwright browsers.

# Service entry point: webhook + sequential queue.
CMD ["npm", "run", "start"]
