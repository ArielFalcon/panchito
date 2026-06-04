# Imagen del motor agéntico: OpenCode + los servidores MCP que el agente usa.
# OpenCode los arranca como procesos `local` (stdio) según opencode.json, así
# que sus dependencias deben estar en el PATH de ESTE contenedor.
FROM ghcr.io/sst/opencode:latest

# --- Serena (MCP de navegación semántica de código) -----------------------
# Se ejecuta con `uvx ... serena start-mcp-server` (ver opencode.json), así que
# necesita `uv`/`uvx`. Serena usa Language Servers (LSP) por debajo: el RUNTIME
# de cada lenguaje de los repos vigilados debe estar presente. Aquí: Java (JDK)
# y Python; añade los que uses (Node ya viene en la imagen de OpenCode).
#
#   - `uv` instala/ejecuta Serena (se cachea en la primera activación).
#   - Para fijar versión y evitar sorpresas, pinea el ref en opencode.json:
#     git+https://github.com/oraios/serena@<tag>
RUN apt-get update && apt-get install -y --no-install-recommends \
      curl ca-certificates openjdk-21-jdk-headless python3 \
  && rm -rf /var/lib/apt/lists/* \
  && curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.local/bin:${PATH}"

# --- engram (memoria episódica persistente, SQLite) -----------------------
# Reemplaza por la instalación real del MCP de memoria; debe quedar invocable
# como `engram-mcp` en el PATH. Ejemplo ilustrativo:
#   RUN npm install -g engram-mcp

# El CMD/entrypoint lo fija docker-compose (`serve --hostname 0.0.0.0 ...`).
