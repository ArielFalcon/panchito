# Locators, esperas y flakiness

Adaptado de [TestDino playwright-skill](https://github.com/testdino-hq/playwright-skill) (MIT).

## Locators (de mejor a peor)

1. `getByRole("button", { name: /publicar/i })` — semántico, accesible. **Preferido.**
2. `getByLabel`, `getByPlaceholder`, `getByText` — para formularios/contenido.
3. `getByTestId("...")` — cuando no hay rol claro (atributo `data-testid`).
4. ❌ CSS/XPath crudos, clases autogeneradas, `nth-child` — frágiles, prohibidos.

Encadena por contexto para desambiguar: `page.getByRole("listitem").filter({ hasText: "X" })`.

## Esperas web-first (auto-retry)

Playwright reintenta las aserciones hasta que se cumplen o expira el timeout. Úsalo:

```ts
await expect(page.getByRole("status")).toHaveText(/listo/i);
await expect(page.getByRole("row")).toHaveCount(3);
```

- ❌ **Nunca** `page.waitForTimeout(ms)` (sleep): es la causa nº1 de flakiness.
- ❌ Evita `waitForLoadState("networkidle")`: poco fiable.
- ✅ Espera a un estado **observable** (un elemento visible, un texto, una URL):
  `await page.waitForURL(/\/exito/)`.

## Acciones con auto-waiting

`click`, `fill`, etc. ya esperan a que el elemento sea accionable. No metas
esperas manuales antes. Si una acción "necesita" un sleep para funcionar, el
problema es el locator o un estado no esperado, no el timing.

## Diagnosticar flakiness

La config guarda **trace `on-first-retry`**. Si un test es flaky, abre la traza
(`npx playwright show-trace`) y mira el paso exacto que falló: casi siempre es un
locator ambiguo, una aserción sobre algo aún no renderizado, o datos no
namespaced que colisionan. Arréglalo en origen; **no** subas retries ni sleeps.
