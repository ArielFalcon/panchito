// Memoria EPISÓDICA vía Engram (MCP, SQLite). Como el servicio es permanente y
// el SQLite vive en un volumen, la memoria persiste entre runs. El cliente MCP
// se inyecta; sin servidor configurado se usa nullEngram.

import { McpClient } from "./mcp/client";

export interface Engram {
  getContext(repo?: string): Promise<string | null>;
  save(entry: Record<string, unknown>): Promise<void>;
}

export const nullEngram: Engram = {
  getContext: async () => null,
  save: async () => {},
};

export function makeEngram(client: McpClient): Engram {
  return {
    async getContext(repo) {
      const res = await client.callTool("mem_search", {
        query: repo ?? "",
        namespace: `repo/${repo ?? ""}`,
      });
      if (res == null || res === "") return null;
      return typeof res === "string" ? res : JSON.stringify(res);
    },
    async save(entry) {
      const repo = (entry as { repo?: string }).repo ?? "";
      await client.callTool("mem_save", { ...entry, namespace: `repo/${repo}` });
    },
  };
}
