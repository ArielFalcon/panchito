# `orchestrator` container: the Node infrastructure (webhook, gate, working copy,
# E2E execution, reporting). The agentic generation runs in the separate
# `opencode` container (see docker-compose.yml + opencode/Dockerfile).
#
# Base = the official Playwright image (Node + browsers preinstalled): this is
# where the agent-generated E2E tests RUN, against DEV.
FROM mcr.microsoft.com/playwright:v1.50.0-jammy

# git: to clone/check out the working copies of the watched repos.
RUN apt-get update && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev || npm install

COPY . .

# The e2e tooling (Playwright runner + eslint + tsc) is NOT installed here: it
# lives in each repo's `e2e/`, and the orchestrator runs `npm ci` there per run
# (qa/setup.ts). The image already ships the Playwright browsers.

# Service entry point: webhook + sequential queue.
CMD ["npm", "run", "start"]
