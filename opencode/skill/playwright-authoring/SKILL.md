---
name: playwright-authoring
description: Cómo escribir tests E2E Playwright robustos y deterministas (locators, esperas, fixtures, autenticación, geolocalización, móvil/offline, cookies/cache, subida de ficheros). Úsala SIEMPRE que generes o corrijas un spec.
---

# Autoría de E2E con Playwright

Conocimiento de oficio para escribir specs que pasen el harness a la primera y
no sean flaky. Patrón base: **fixtures** (no Page Object Model). Material de
referencia adaptado de [TestDino playwright-skill](https://github.com/testdino-hq/playwright-skill) (MIT).

> **Precedencia:** las reglas de `AGENTS.md` y del prompt del agente MANDAN sobre
> cualquier guía de aquí. En concreto: **nada de mocks de red** (ejercitamos DEV
> real), datos namespaced, `cleanup` obligatorio, locators por rol/testid.

## Reglas duras (siempre)

- **Locators**: `getByRole`, `getByLabel`, `getByTestId`. Nunca CSS/XPath frágil.
- **Esperas web-first**: usa los `expect(locator).toBeVisible()` etc. con
  auto-retry. **Prohibido `waitForTimeout`** (sleep) y `networkidle`.
- **Un assert real** sobre el resultado observable, no solo clics.
- **Fixtures** del repo (`./fixtures`): `test`, `expect`, `ns`, y los helpers
  (`setLocation`, `goOffline`, `readCookies`, `readStorage`, `asset`).
- **Determinismo**: sin orden implícito entre tests; cada uno se basta solo.

## Cuándo leer cada referencia (divulgación progresiva)

Lee el fichero concreto solo cuando el test lo necesite:

- **`auth.md`** — login de la app. Esta app tiene DOS capas: el gate HTTP Basic
  del entorno DEV y el login por **Keycloak** (redirección fuera del dominio).
  También cómo cachear sesión con storageState y cómo probar páginas públicas.
- **`browser-conditions.md`** — **geolocalización**, modo **móvil** y modo
  **offline**, y permisos del navegador.
- **`storage-and-uploads.md`** — leer **cookies/cache/localStorage** para
  asertar, y **subir fotos** usando los assets y su metadata.
- **`locators-and-waiting.md`** — patrones finos de locators y esperas, y cómo
  diagnosticar flakiness (trace viewer).

## Estructura de un spec

```ts
import { test, expect, ns } from "../fixtures";

test("checkout con >10 ítems completa el pago", async ({ page, namespace, authenticate, cleanup }) => {
  await authenticate();                         // omite esto en tests públicos
  const item = ns(namespace, "item");           // datos namespaced
  cleanup(async () => { /* borra `item` */ });  // limpia lo que creas
  // ... ejercita el flujo real contra DEV ...
  await expect(page.getByRole("status")).toHaveText(/pago completado/i); // assert real
});
```
