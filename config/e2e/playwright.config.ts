// Config base de Playwright — parte del HARNESS (Filtro A: estandarización).
// Todos los specs generados (de cualquier app) corren con ESTA config, así el
// comportamiento es consistente entre repos y runs.
//
// El orchestrator inyecta por entorno: PW_BASE_URL (DEV), PW_SPEC_DIR (carpeta
// de specs de este run) y PW_NAMESPACE (prefijo de datos qa-bot-<sha>).

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: process.env.PW_SPEC_DIR ?? "./specs",
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
