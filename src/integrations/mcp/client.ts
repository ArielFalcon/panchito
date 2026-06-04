// Cliente MCP mínimo (JSON-RPC 2.0). El transporte se inyecta: en producción
// es HTTP contra los sidecars; en tests es un stub. Mantiene el núcleo
// verificable sin servidores reales.
//
// Nota: el handshake `initialize` del protocolo MCP se completa cuando se
// cableen servidores reales; aquí cubrimos la llamada a herramientas, que es
// lo que el motor consume.

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number;
  result?: unknown;
  error?: { code: number; message: string };
}

export interface McpTransport {
  send(req: JsonRpcRequest): Promise<JsonRpcResponse>;
}

export interface McpClient {
  callTool(name: string, args: Record<string, unknown>): Promise<unknown>;
}

export function createMcpClient(transport: McpTransport): McpClient {
  let id = 0;
  return {
    async callTool(name, args) {
      const res = await transport.send({
        jsonrpc: "2.0",
        id: ++id,
        method: "tools/call",
        params: { name, arguments: args },
      });
      if (res.error) {
        throw new Error(`MCP ${name} error ${res.error.code}: ${res.error.message}`);
      }
      return extractToolResult(res.result);
    },
  };
}

// Un resultado tools/call de MCP es { content: [{ type: "text", text }], ... }.
// Devolvemos el texto concatenado; si no es esa forma, el result crudo.
export function extractToolResult(result: unknown): unknown {
  if (result && typeof result === "object" && "content" in result) {
    const content = (result as { content: unknown }).content;
    if (Array.isArray(content)) {
      const text = content
        .filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text")
        .map((c) => (c as { text?: string }).text ?? "")
        .join("\n");
      return text || content;
    }
  }
  return result;
}

// Normaliza un resultado de herramienta a texto (o null si vacío). Compartido
// por las integraciones para no repetir la coerción.
export function coerceText(res: unknown): string | null {
  if (res == null || res === "") return null;
  return typeof res === "string" ? res : JSON.stringify(res);
}

export function httpTransport(url: string): McpTransport {
  return {
    async send(req) {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(req),
      });
      if (!res.ok) throw new Error(`MCP transport HTTP ${res.status}`);
      return (await res.json()) as JsonRpcResponse;
    },
  };
}
