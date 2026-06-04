# Condiciones del navegador: geolocalización, móvil, offline

## Geolocalización

La app ubica al usuario en el mapa y, al subir foto, lista **sitios cercanos**.
Hay una ubicación determinista por defecto en la config. Para forzar otra (p. ej.
para que aparezcan sitios concretos), usa el helper:

```ts
import { setLocation } from "../fixtures";

test("muestra sitios cercanos a la ubicación", async ({ page, context }) => {
  await setLocation(context, 41.3874, 2.1686);   // Barcelona
  await page.goto("/mapa");
  await expect(page.getByRole("list", { name: /sitios cercanos/i })).toBeVisible();
});
```
El permiso `geolocation` ya está concedido en la config. `setLocation` también lo
concede por si el test creó un contexto nuevo.

## Modo móvil

Dos opciones:
- Ejecutar el spec en el **proyecto `mobile`** (ya definido en la config), o
- Forzarlo por test con device emulation:

```ts
import { devices } from "@playwright/test";
test.use({ ...devices["iPhone 13"] });

test("el menú se colapsa en móvil", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: /menú/i })).toBeVisible();
});
```

## Modo offline

```ts
import { goOffline, goOnline } from "../fixtures";

test("muestra aviso sin conexión", async ({ page, context }) => {
  await page.goto("/");
  await goOffline(context);
  await page.getByRole("button", { name: /recargar/i }).click();
  await expect(page.getByText(/sin conexión/i)).toBeVisible();
  await goOnline(context);   // restaura para el cleanup
});
```
Vuelve siempre a online antes de terminar para no romper el teardown.
