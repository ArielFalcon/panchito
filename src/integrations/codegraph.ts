// Contexto ESTRUCTURAL del código vía code-review-graph (MCP). getImpactRadius
// devuelve solo el subgrafo afectado por el diff (blast radius), no el repo
// entero. El cliente MCP se inyecta (factory lo construye desde config); si no
// hay servidor configurado se usa nullCodegraph (comportamiento M0).

import { McpClient, coerceText } from "./mcp/client";

export interface Codegraph {
  getImpactRadius(repo: string, diff: string): Promise<string | null>;
}

export const nullCodegraph: Codegraph = {
  getImpactRadius: async () => null,
};

export function makeCodegraph(client: McpClient): Codegraph {
  return {
    async getImpactRadius(repo, diff) {
      return coerceText(await client.callTool("get_impact_radius", { repo, diff }));
    },
  };
}
