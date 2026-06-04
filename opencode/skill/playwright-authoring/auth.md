# Autenticación (dos capas)

Esta app tiene **dos credenciales distintas**. No las confundas.

## Capa 1 — Gate del entorno DEV (HTTP Basic Auth)

Todo el entorno DEV está protegido por el diálogo nativo del navegador
(usuario/contraseña). **No se interactúa con ese diálogo**: se resuelve con
`httpCredentials`, ya configurado en `playwright.config.ts` desde
`DEV_ENV_USER`/`DEV_ENV_PASS` y restringido al origen de la app. No tienes que
hacer nada en el spec; solo saber que por eso DEV "ya está abierto".

## Capa 2 — Login de la app (Keycloak, redirección externa)

Al pulsar el botón de login, la app **redirige al dominio de Keycloak** (fuera
del dominio de la app), donde se introduce usuario y contraseña
(`DEV_TEST_USER`/`DEV_TEST_PASS`), y al aceptar **vuelve a la app**.

El fixture `authenticate()` ya hace este flujo; **ajusta los selectores** al
login real (el botón de la app y, en Keycloak, normalmente `#username`,
`#password`, `#kc-login`). Cross-domain funciona dentro del mismo contexto.

```ts
test("área privada visible tras login", async ({ page, authenticate }) => {
  await authenticate();
  await expect(page.getByRole("heading", { name: /mi perfil/i })).toBeVisible();
});
```

## Páginas públicas (sin login)

La app tiene navegación pública. Para esos tests **no llames a `authenticate()`**
(seguirás pasando la capa 1, que es del entorno).

## Optimización: cachear la sesión con storageState

El login por Keycloak es lento. Para no repetirlo en cada test, hazlo **una vez**
en un setup y guarda el estado, y reúsalo:

```ts
// auth.setup.ts (proyecto de setup)
import { test as setup } from "../fixtures";
setup("login", async ({ page, authenticate, context }) => {
  await authenticate();
  await context.storageState({ path: "e2e/.auth/user.json" });
});
```
Luego los tests autenticados usan `test.use({ storageState: "e2e/.auth/user.json" })`.
Guarda `.auth/` en `.gitignore` del proyecto e2e (es estado de sesión, no código).
