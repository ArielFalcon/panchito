# Agentic engine image: the OpenCode CLI + Serena (run via uvx) and the language
# runtimes its language servers need. engram (memory) is disabled for the initial
# smoke test to keep the build minimal; re-enable it later (see opencode.json).
FROM node:22-bookworm

# - opencode: the agent CLI/server (npm global → ends up on PATH at /usr/local/bin).
# - uv: runs Serena via `uvx` (see opencode.json); Serena is fetched on first use.
# - git: the agent/Serena read the working copy. JDK + python: language servers.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates git openjdk-17-jdk-headless python3 \
  && rm -rf /var/lib/apt/lists/* \
  && curl -LsSf https://astral.sh/uv/install.sh | sh \
  && npm install -g opencode-ai
ENV PATH="/root/.local/bin:${PATH}"

ENTRYPOINT ["opencode"]
# docker-compose passes the args (`serve --hostname 0.0.0.0 --port 4096`).
