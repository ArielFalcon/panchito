// Caja de herramientas compartida (Filtro A). El agente IMPORTA `test`/`expect`
// de aquí en cada spec, en vez de empezar de cero. Esto estandariza login,
// datos namespaced y limpieza entre todos los repos.
//
// HÍBRIDO: el esqueleto es común (este fichero); lo ESPECÍFICO de cada app
// (los pasos reales de login, las fábricas de datos) lo rellena el agente por
// repo sobreescribiendo el fixture `authenticate` y añadiendo sus factories,
// y se persiste para reusarlo en los siguientes runs.

import { test as base, expect } from "@playwright/test";

export interface QaFixtures {
  // Prefijo de datos del run (qa-bot-<sha>). Toda entidad de prueba lo lleva.
  namespace: string;
  // SLOT que el agente implementa por app: realiza el login real leyendo
  // credenciales de process.env (NUNCA en literal). Por defecto, no-op.
  authenticate: () => Promise<void>;
}

export const test = base.extend<QaFixtures>({
  namespace: async ({}, use) => {
    await use(process.env.PW_NAMESPACE ?? "qa-bot-local");
  },
  authenticate: async ({}, use) => {
    await use(async () => {
      /* el agente sobreescribe este fixture con el login de la app */
    });
  },
});

export { expect };

// Nombra una entidad de prueba con el prefijo del run, para poder identificarla
// y limpiarla después: ns("qa-bot-abc1234", "user") → "qa-bot-abc1234-user".
export function ns(namespace: string, name: string): string {
  return `${namespace}-${name}`;
}
