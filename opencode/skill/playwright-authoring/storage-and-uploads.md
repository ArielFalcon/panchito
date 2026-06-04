# Cookies/cache y subida de fotos

## Leer cookies, cache y localStorage

La app guarda información en cookies y cache; algunos tests asertan sobre ella.

```ts
import { readCookies, readStorage } from "../fixtures";

test("guarda la sesión en cookie", async ({ page, context, authenticate }) => {
  await authenticate();
  const [session] = await readCookies(context, "session_id");
  expect(session?.value).toBeTruthy();

  const theme = await readStorage(page, "theme");   // un valor de localStorage
  expect(theme).toBe("dark");
});
```
Para todas las cookies: `readCookies(context)`. Para todo el localStorage:
`readStorage(page)`.

## Subir fotos (assets + su metadata)

Las imágenes viven en `e2e/assets/` y su **metadata opcional** (qué probar con
cada una) en `e2e/assets/assets.json`. Antes de escribir un test de subida,
**lee `assets.json`** para elegir el asset adecuado y saber qué verificar.

```ts
import { asset } from "../fixtures";

test("sube foto y sugiere sitios cercanos", async ({ page, authenticate, cleanup }) => {
  await authenticate();
  await page.goto("/subir");
  await page.getByLabel(/foto/i).setInputFiles(asset("playa.jpg"));
  // la app, por la geolocalización + EXIF, sugiere sitios cercanos:
  await expect(page.getByRole("list", { name: /sitios cercanos/i })).toBeVisible();
  await page.getByRole("option").first().click();
  await page.getByRole("button", { name: /publicar/i }).click();
  cleanup(async () => { /* borra la publicación creada */ });
  await expect(page.getByText(/publicado/i)).toBeVisible();
});
```
Si necesitas un asset que no existe, créalo en `e2e/assets/` y añádelo a
`assets.json` con su `whatToTest`.
