# Imagen del motor agéntico: OpenCode + los MCP que el agente usa (serena, engram).
# Los MCP se INSTALAN aquí (build time, una vez) y `opencode serve` los arranca
# como procesos `local` (stdio) al iniciar el contenedor: viven mientras vive el
# servidor, NO se reinstalan ni relanzan por cada run.

# --- Stage 1: compila engram (memoria episódica: binario Go, SQLite+FTS5) ---
FROM golang:1.23-bookworm AS engram-build
# Pinea un tag para reproducibilidad: ...@vX.Y.Z en vez de @latest.
RUN go install github.com/Gentleman-Programming/engram/cmd/engram@latest

# --- Stage 2: motor ---
FROM ghcr.io/sst/opencode:latest

# Serena se ejecuta con `uvx ... serena` (ver opencode.json) → necesita uv. Usa
# Language Servers por debajo: el RUNTIME de cada lenguaje de los repos vigilados
# debe estar presente. Aquí Java (JDK) y Python; Node ya viene en la imagen.
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates openjdk-21-jdk-headless python3 \
  && rm -rf /var/lib/apt/lists/* \
  && curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

# engram: binario único, sin dependencias. Se lanza como `engram mcp` (stdio) y
# persiste su SQLite en ENGRAM_DATA_DIR (volumen).
COPY --from=engram-build /go/bin/engram /usr/local/bin/engram

# El CMD/entrypoint lo fija docker-compose (`serve --hostname 0.0.0.0 ...`).
