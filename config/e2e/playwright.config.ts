// Config base de Playwright — SEED del harness (Filtro A: estandarización).
// Se copia dentro de `e2e/` del repo la primera vez; a partir de ahí el repo es
// su dueño y el agente la mantiene. Todos los specs corren con esta config, así
// el comportamiento es consistente entre microservicios y runs.
//
// El orchestrator inyecta por entorno: PW_BASE_URL (DEV) y PW_NAMESPACE (prefijo
// de datos qa-bot-<sha>, que leen las fixtures).

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  // Un run a la vez contra DEV (la cola del servicio ya serializa los runs;
  // dentro del run evitamos colisiones de datos namespaced).
  fullyParallel: false,
  workers: 1,
  // Retries = SEÑAL de flakiness (Filtro C), NO un arreglo: un test que necesita
  // reintento se marca "flaky" y va a cuarentena, no se da por bueno.
  retries: 2,
  reporter: [["json"]],
  use: {
    baseURL: process.env.PW_BASE_URL,
    trace: "on-first-retry", // traza para diagnosticar el fallo, sin coste en verde
    testIdAttribute: "data-testid",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
