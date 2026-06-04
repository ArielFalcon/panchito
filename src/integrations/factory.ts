// Construye las integraciones MCP desde config/tools/mcp-servers.yaml. Si un
// servidor no está habilitado o no tiene URL, devuelve la implementación nula
// (comportamiento M0). Así el motor funciona con o sin MCP cableado.

import { createMcpClient, httpTransport } from "./mcp/client";
import { Codegraph, makeCodegraph, nullCodegraph } from "./codegraph";
import { Engram, makeEngram, nullEngram } from "./engram";
import { loadMcpServers } from "../orchestrator/config-loader";

export function buildCodegraph(root?: string): Codegraph {
  const s = loadMcpServers(root).codegraph;
  if (!s?.enabled || !s.url) return nullCodegraph;
  return makeCodegraph(createMcpClient(httpTransport(s.url)));
}

export function buildEngram(root?: string): Engram {
  const s = loadMcpServers(root).engram;
  if (!s?.enabled || !s.url) return nullEngram;
  return makeEngram(createMcpClient(httpTransport(s.url)));
}
