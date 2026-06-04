// Caja de herramientas compartida (Filtro A). El agente IMPORTA `test`/`expect`
// de aquí en cada spec, en vez de empezar de cero. Esto estandariza login,
// datos namespaced y limpieza entre todos los microservicios.
//
// HÍBRIDO: el esqueleto es común (este fichero); lo ESPECÍFICO de la app (los
// pasos reales de login, las fábricas y borrados de datos) lo rellena el agente
// sobreescribiendo el fixture `authenticate` y registrando borrados en
// `cleanup`, y se persiste en git para reusarlo en los siguientes runs.

import { test as base, expect } from "@playwright/test";

export interface QaFixtures {
  // Prefijo de datos del run (qa-bot-<sha>). Toda entidad de prueba lo lleva.
  namespace: string;
  // SLOT que el agente implementa por app: realiza el login real leyendo
  // credenciales de process.env (NUNCA en literal). Por defecto, no-op.
  authenticate: () => Promise<void>;
  // Registra un borrado a ejecutar al terminar el test (LIFO). El test crea una
  // entidad y registra cómo deshacerla → cada test limpia lo suyo, así los datos
  // namespaced NO se acumulan en DEV (clave para que el entorno no se degrade).
  cleanup: (undo: () => Promise<void>) => void;
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
  // Fixture automático: recoge los borrados registrados y los ejecuta tras el
  // test (en orden inverso). Best-effort: un fallo al limpiar no tumba el test,
  // pero deja rastro para que el namespacing permita un barrido posterior.
  cleanup: [
    async ({}, use) => {
      const undos: Array<() => Promise<void>> = [];
      await use((undo) => undos.push(undo));
      for (const undo of undos.reverse()) {
        try {
          await undo();
        } catch (e) {
          console.error("[cleanup] fallo al deshacer dato de prueba:", e);
        }
      }
    },
    { auto: true },
  ],
});

export { expect };

// Nombra una entidad de prueba con el prefijo del run, para poder identificarla
// y limpiarla después: ns("qa-bot-abc1234", "user") → "qa-bot-abc1234-user".
export function ns(namespace: string, name: string): string {
  return `${namespace}-${name}`;
}
