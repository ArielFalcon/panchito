// Config base de Playwright — SEED del harness (Filtro A). Se copia en `e2e/`
// del repo la primera vez; luego el repo es su dueño y el agente la mantiene.
//
// El orchestrator inyecta por entorno: PW_BASE_URL (DEV) y PW_NAMESPACE.
// Dos capas de credenciales (no confundir):
//   - DEV_ENV_USER/PASS → HTTP Basic Auth que protege TODO el entorno DEV (el
//     diálogo nativo del navegador con usuario/contraseña). Va en httpCredentials.
//   - DEV_TEST_USER/PASS → login de la APP vía Keycloak (formulario). Va en el
//     fixture `authenticate` (ver fixtures.ts), NO aquí.

import { defineConfig, devices } from "@playwright/test";

const appOrigin = process.env.PW_BASE_URL ?? "http://localhost";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 2, // retries = SEÑAL de flakiness (Filtro C), no arreglo
  reporter: [["json"]],
  use: {
    baseURL: process.env.PW_BASE_URL,
    trace: "on-first-retry",
    testIdAttribute: "data-testid",
    // Capa 1: pasa el gate HTTP Basic del entorno DEV. `origin` lo restringe a
    // la app, para NO enviar estas credenciales a Keycloak (otro dominio).
    httpCredentials: process.env.DEV_ENV_USER
      ? {
          username: process.env.DEV_ENV_USER,
          password: process.env.DEV_ENV_PASS ?? "",
          origin: appOrigin,
        }
      : undefined,
    // Geolocalización determinista por defecto (la app ubica al usuario en el
    // mapa). Los tests que necesiten otra ubicación usan setLocation() (fixtures).
    permissions: ["geolocation"],
    geolocation: {
      latitude: Number(process.env.PW_GEO_LAT ?? 40.4168),
      longitude: Number(process.env.PW_GEO_LNG ?? -3.7038),
    },
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    // Modo móvil: los tests móviles se ejecutan con este proyecto o con
    // test.use({ ...devices["iPhone 13"] }) por test.
    { name: "mobile", use: { ...devices["iPhone 13"] } },
  ],
});
