// Memoria EPISÓDICA vía Engram (MCP, SQLite). Ortogonal a codegraph: el grafo
// sabe QUÉ ES el código; Engram sabe QUÉ HIZO el agente antes. Como el servicio
// es permanente y el SQLite vive en un volumen, la memoria SÍ persiste entre
// runs (a diferencia del modelo efímero original).

export const engram = {
  async getContext(_repo?: string): Promise<string | null> {
    // TODO(M1): mem_search por namespace repo/<repo>. Devuelve null en M0.
    return null;
  },
  async save(_entry: unknown): Promise<void> {
    // TODO(M1): mem_save persistente en el volumen.
  },
};
