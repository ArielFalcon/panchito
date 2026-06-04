// Persistencia de los E2E generados en el volumen del servicio, indexados por
// namespace (= run). Es la suite de regresión que crece. Un repo de tests
// dedicado se evalúa después (decisión diferida).

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Artifact } from "../types";

function storeRoot(): string {
  return process.env.QA_STORE_DIR ?? join(process.cwd(), ".qa-store");
}

export interface SavedArtifacts {
  dir: string;
  files: string[];
}

export async function saveArtifacts(
  artifacts: Artifact[],
  namespace: string,
): Promise<SavedArtifacts> {
  const dir = join(storeRoot(), namespace);
  mkdirSync(dir, { recursive: true });
  const files = artifacts.map((a, i) => {
    const file = join(dir, a.path || `e2e-${i + 1}.spec.ts`);
    writeFileSync(file, a.content, "utf8");
    return file;
  });
  return { dir, files };
}
