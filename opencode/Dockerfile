# Agentic engine image: OpenCode + the MCPs the agent uses (serena, engram). The
# MCPs are INSTALLED here (build time, once) and `opencode serve` starts them as
# `local` (stdio) processes when the container boots: they live as long as the
# server, and are NOT reinstalled or restarted per run.

# --- Stage 1: build engram (episodic memory: Go binary, SQLite+FTS5) ---
FROM golang:1.23-bookworm AS engram-build
# Pin a tag for reproducibility: ...@vX.Y.Z instead of @latest.
RUN go install github.com/Gentleman-Programming/engram/cmd/engram@latest

# --- Stage 2: engine ---
FROM ghcr.io/sst/opencode:latest

# Serena runs via `uvx ... serena` (see opencode.json) → it needs uv. It uses
# language servers underneath: the RUNTIME of each watched-repo language must be
# present. Here Java (JDK) and Python; Node already ships in the image.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates openjdk-21-jdk-headless python3 \
  && rm -rf /var/lib/apt/lists/* \
  && curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

# engram: a single, dependency-free binary. Started as `engram mcp` (stdio) and
# persists its SQLite in ENGRAM_DATA_DIR (a volume).
COPY --from=engram-build /go/bin/engram /usr/local/bin/engram

# docker-compose sets the CMD/entrypoint (`serve --hostname 0.0.0.0 ...`).
