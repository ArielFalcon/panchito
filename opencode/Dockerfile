# Agentic engine image: the OpenCode CLI + Serena (baked at build time) and the
# language runtimes its language servers need.
FROM node:22-bookworm

# - opencode/codex: agent CLIs (npm global → PATH at /usr/local/bin).
# - engram: persistent episodic memory MCP (Go binary, single-file, no runtime deps).
# - uv: the Python toolchain used to install Serena at BUILD time (see below).
# - git: the agent/Serena read the working copy.
# - Language servers for Serena's blast-radius navigation, ONE PER watched-repo
#   language: openjdk (Java/Spring backend), python3 (Python), and the TypeScript
#   language server (Angular frontend — components/services are plain .ts). They are
#   baked into the image so Serena never downloads a server at run time (determinism;
#   without the TS server, blast radius on the Angular side degrades to reading whole
#   files, which is exactly what Serena exists to avoid).
ARG ENGRAM_VERSION=1.16.1
# Serena is installed at BUILD time (not fetched via `uvx` on first use), so a run never
# depends on outbound GitHub/PyPI access and startup is deterministic and fast. Pin a
# release tag for reproducibility — bump it deliberately, never float on a moving ref.
ARG SERENA_VERSION=v1.5.3
# NOTE: opencode-ai / @playwright/mcp install "latest" at image build time. The IMAGE
# is the version anchor — rebuilding the image is the deliberate bump point. Pin
# explicitly here if a future bump introduces a breaking change.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates git openjdk-17-jdk-headless python3 \
   && rm -rf /var/lib/apt/lists/* \
   && curl -LsSf https://astral.sh/uv/install.sh | sh \
   && export PATH="/root/.local/bin:${PATH}" \
   && uv tool install --python 3.11 "git+https://github.com/oraios/serena@${SERENA_VERSION}" \
   && npm install -g opencode-ai @openai/codex typescript typescript-language-server \
   && npm install -g @playwright/mcp \
   && npx playwright install --with-deps chromium \
   && curl -fsSL "https://github.com/Gentleman-Programming/engram/releases/download/v${ENGRAM_VERSION}/engram_${ENGRAM_VERSION}_linux_amd64.tar.gz" \
     | tar -xz -C /usr/local/bin engram \
   && chmod +x /usr/local/bin/engram
# Serena (`uv tool install`) and uv both land in /root/.local/bin → on PATH at run time.
ENV PATH="/root/.local/bin:${PATH}"

COPY agent-supervisor.mjs /usr/local/bin/agent-supervisor.mjs
RUN chmod +x /usr/local/bin/agent-supervisor.mjs

# KNOWN LIMITATION: this container currently runs as root. Switching to non-root
# requires re-homing /root/.local/share/opencode, /root/.cache/uv, /data, and the
# /app/.mirrors mount to a non-root user — a coordinated change across both
# Dockerfiles + docker-compose.yml. Tracked in the production hardening backlog.
ENTRYPOINT ["node", "/usr/local/bin/agent-supervisor.mjs"]
