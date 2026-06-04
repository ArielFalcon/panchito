# Imagen del motor agéntico: OpenCode + los servidores MCP que el agente usa.
# OpenCode los arranca como procesos `local` (stdio) según opencode.json, así
# que sus binarios deben estar en el PATH de ESTE contenedor.
FROM ghcr.io/sst/opencode:latest

# --- Servidores MCP -------------------------------------------------------
# Instala aquí los binarios que opencode.json invoca como `local`:
#   - codegraph-mcp : contexto estructural / blast radius sobre los espejos
#   - engram-mcp    : memoria episódica persistente (SQLite)
#
# Reemplaza estas líneas por la instalación real de cada MCP (npm i -g, go
# install, descarga del release, etc.). Ejemplos ilustrativos:
#
#   RUN npm install -g codegraph-mcp engram-mcp
#   # o:  RUN go install github.com/tu-org/codegraph-mcp@latest
#
# Deben quedar invocables como `codegraph-mcp` y `engram-mcp` en el PATH.

# El CMD/entrypoint lo fija docker-compose (`serve --hostname 0.0.0.0 ...`).
