// Metadata estándar por test (vive en e2e/.qa/manifest.json del repo). Es la
// pieza de la que cuelgan el dedup, la poda, la selección por impacto y el
// mérito. Aquí solo definimos el esquema y su VALIDACIÓN (parte del Filtro B):
// un test sin metadata válida hace inválido el run. Los campos MEDIDOS/derivados
// (coverage, sensitivity, ledger, merit) los rellena el sistema más adelante;
// los de día 1 (objetivo, flujo, targets, changeRef) los escribe el agente.

export interface QaTestMeta {
  id: string; // estable y único (p. ej. "checkout/over-10-items")
  objective: string; // criterio de aceptación: "dado X, cuando Y, entonces Z"
  flow: string; // flujo de usuario (p. ej. "checkout")
  useCase?: string;
  targets: string[]; // INTENCIÓN: símbolos/rutas que pretende ejercitar (blast radius)
  changeRef: { sha: string; type: string; pr?: number; ticket?: string };
  criticality?: "critical" | "normal";
  owner?: string; // "qa-bot" | "human"
  createdAt?: string;

  // --- medido/derivado (opcional; lo completa el sistema, no el agente) ---
  coverage?: { files?: string[]; functions?: string[] }; // MEDIDO en el último run
  sensitivity?: { status: "pass" | "fail" | "unknown"; method?: string; at?: string };
  stability?: { runs: number; flakyRuns: number };
  ledger?: { caughtRegressions: number; falsePositives: number };
  merit?: number; // derivado de lo anterior (no fuente)
}

export interface ManifestValidation {
  ok: boolean;
  errors: string[];
}

// Valida el manifest (array de QaTestMeta). Exige solo los campos de día 1; los
// medidos son opcionales. Un array vacío es válido (repo sin tests todavía).
export function validateManifest(raw: unknown): ManifestValidation {
  if (!Array.isArray(raw)) {
    return { ok: false, errors: ["el manifest (e2e/.qa/manifest.json) debe ser un array"] };
  }
  const errors: string[] = [];
  const ids = new Set<string>();

  raw.forEach((entry, i) => {
    const m = (entry ?? {}) as Partial<QaTestMeta>;
    const tag = nonEmpty(m.id) ? m.id! : `#${i}`;

    if (!nonEmpty(m.id)) errors.push(`entrada #${i}: falta 'id'`);
    else if (ids.has(m.id!)) errors.push(`'${m.id}': id duplicado`);
    else ids.add(m.id!);

    if (!nonEmpty(m.objective)) errors.push(`'${tag}': falta 'objective'`);
    if (!nonEmpty(m.flow)) errors.push(`'${tag}': falta 'flow'`);
    if (!Array.isArray(m.targets) || m.targets.length === 0) {
      errors.push(`'${tag}': 'targets' vacío (¿qué pretende ejercitar?)`);
    }
    if (!m.changeRef || !nonEmpty(m.changeRef.sha) || !nonEmpty(m.changeRef.type)) {
      errors.push(`'${tag}': 'changeRef' incompleto (sha + type)`);
    }
  });

  return { ok: errors.length === 0, errors };
}

function nonEmpty(s: unknown): boolean {
  return typeof s === "string" && s.trim().length > 0;
}
