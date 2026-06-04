// Contexto ESTRUCTURAL del código vía code-review-graph (MCP). getImpactRadius
// devuelve solo el subgrafo afectado por el diff (blast radius), no el repo
// entero. Como el servicio es permanente, el MCP corre como sidecar de larga
// vida (ver docker-compose) — sin el problema de bootstrap del modelo efímero.

export const codegraph = {
  async getImpactRadius(_repo: string, _diff: string): Promise<string | null> {
    // TODO(M1): conectar al MCP code-review-graph (get_impact_radius) usando un
    // espejo local del repo en el SHA. Devuelve null en M0 (sin MCP cableado).
    return null;
  },
};
