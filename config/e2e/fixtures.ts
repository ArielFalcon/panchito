// Caja de herramientas compartida (Filtro A). El agente IMPORTA `test`/`expect`
// y los helpers de aquí en cada spec, en vez de empezar de cero. Estandariza
// login, datos namespaced, limpieza y las capacidades propias de la app
// (geolocalización, móvil/offline, cookies/cache, subida de fotos).
//
// HÍBRIDO: el esqueleto es común (este fichero); lo ESPECÍFICO de la app (los
// selectores reales del login de Keycloak, etc.) lo rellena el agente y se
// persiste en git. Para el "cómo" de cada capacidad, ver la skill
// `playwright-authoring`.

import { test as base, expect, type BrowserContext, type Page } from "@playwright/test";

export interface QaFixtures {
  namespace: string; // prefijo de datos del run (qa-bot-<sha>)
  authenticate: () => Promise<void>; // login real de la app (Keycloak)
  cleanup: (undo: () => Promise<void>) => void; // registra borrados (LIFO, auto)
}

export const test = base.extend<QaFixtures>({
  namespace: async ({}, use) => {
    await use(process.env.PW_NAMESPACE ?? "qa-bot-local");
  },

  // Login de la APP vía Keycloak: al pulsar login, la página redirige al dominio
  // de Keycloak (fuera de la app), se rellena usuario/contraseña y se vuelve.
  // AJUSTA los selectores marcados al login real de la app. Para tests de páginas
  // PÚBLICAS, simplemente NO llames a authenticate().
  // Optimización recomendada (ver skill): hacerlo una vez y cachear storageState.
  authenticate: async ({ page }, use) => {
    await use(async () => {
      const user = process.env.DEV_TEST_USER;
      const pass = process.env.DEV_TEST_PASS;
      if (!user || !pass) throw new Error("Faltan DEV_TEST_USER/PASS (login Keycloak)");
      await page.goto("/");
      await page.getByRole("link", { name: /iniciar sesión|log ?in/i }).click(); // AJUSTA al botón real
      // Ya en el dominio de Keycloak (otro origen):
      await page.locator("#username").fill(user); // selectores estándar de Keycloak
      await page.locator("#password").fill(pass);
      await page.locator("#kc-login, [type=submit]").first().click();
      await page.waitForURL((url) => !/\/(auth|realms)\//.test(url.pathname)); // de vuelta en la app
    });
  },

  // Limpieza automática (LIFO, best-effort): cada test registra cómo deshacer lo
  // que crea, así los datos namespaced no se acumulan en DEV.
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

// Nombra una entidad de prueba con el prefijo del run: ns("qa-bot-x","user").
export function ns(namespace: string, name: string): string {
  return `${namespace}-${name}`;
}

// --- Capacidades de la app (helpers) ---------------------------------------

// Geolocalización: la app ubica al usuario en el mapa y lista sitios cercanos al
// subir foto. Fuerza una ubicación determinista que detecta la API del navegador.
export async function setLocation(context: BrowserContext, latitude: number, longitude: number): Promise<void> {
  await context.grantPermissions(["geolocation"]);
  await context.setGeolocation({ latitude, longitude });
}

// Modo offline (la app tiene modo offline). Acuérdate de volver con goOnline().
export async function goOffline(context: BrowserContext): Promise<void> {
  await context.setOffline(true);
}
export async function goOnline(context: BrowserContext): Promise<void> {
  await context.setOffline(false);
}

// Lectura de cookies/almacenamiento (algunos tests asertan sobre esto).
export async function readCookies(context: BrowserContext, name?: string) {
  const cookies = await context.cookies();
  return name ? cookies.filter((c) => c.name === name) : cookies;
}
export async function readStorage(page: Page, key?: string) {
  return page.evaluate((k) => (k ? localStorage.getItem(k) : { ...localStorage }), key);
}

// Subida de foto: resuelve la ruta de un asset de e2e/assets/ y lo sube. La
// metadata opcional de cada asset (qué probar) vive en e2e/assets/assets.json.
export function asset(name: string): string {
  return new URL(`./assets/${name}`, import.meta.url).pathname;
}
