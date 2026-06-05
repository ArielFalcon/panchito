# Agentic engine image: the OpenCode CLI + Serena (run via uvx) and the language
# runtimes its language servers need.
FROM node:22-bookworm

# - opencode: the agent CLI/server (npm global → ends up on PATH at /usr/local/bin).
# - engram: persistent episodic memory MCP (Go binary, single-file, no runtime deps).
# - uv: runs Serena via `uvx` (see opencode.json); Serena is fetched on first use.
# - git: the agent/Serena read the working copy.
# - Language servers for Serena's blast-radius navigation, ONE PER watched-repo
#   language: openjdk (Java/Spring backend), python3 (Python), and the TypeScript
#   language server (Angular frontend — components/services are plain .ts). They are
#   baked into the image so Serena never downloads a server at run time (determinism;
#   without the TS server, blast radius on the Angular side degrades to reading whole
#   files, which is exactly what Serena exists to avoid).
ARG ENGRAM_VERSION=1.16.1
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates git openjdk-17-jdk-headless python3 \
  && rm -rf /var/lib/apt/lists/* \
  && curl -LsSf https://astral.sh/uv/install.sh | sh \
  && npm install -g opencode-ai typescript typescript-language-server \
  && curl -fsSL "https://github.com/Gentleman-Programming/engram/releases/download/v${ENGRAM_VERSION}/engram_${ENGRAM_VERSION}_linux_amd64.tar.gz" \
    | tar -xz -C /usr/local/bin engram \
  && chmod +x /usr/local/bin/engram
ENV PATH="/root/.local/bin:${PATH}"

ENTRYPOINT ["opencode"]
# docker-compose passes the args (`serve --hostname 0.0.0.0 --port 4096`).
