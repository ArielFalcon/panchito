# Proyecto e2e — SEED del harness

Este directorio es el **seed**: la plantilla que el orchestrator **copia dentro
de `e2e/` del repo de la app** la primera vez que ese repo no tiene proyecto de
tests. A partir de ahí, **la fuente de verdad es `e2e/` en el repo** (versionada
en git), y el agente la mantiene y mejora run tras run vía PRs.

## Qué siembra

| Fichero | Para qué |
|---|---|
| `playwright.config.ts` | Config base: retries (señal de flakiness), trace on-first-retry, reporter JSON, `data-testid`, un worker, `baseURL` desde `PW_BASE_URL`. |
| `fixtures.ts` | Caja de herramientas que el agente importa: fixture `namespace`, slot `authenticate`, helper `ns()`. |
| `eslint.config.js` | Filtro B (lint): caza esperas fijas, element handles, tests sin assert, locators crudos. |
| `tsconfig.json` | Filtro B (typecheck). |
| `package.json` | Deps del proyecto (Playwright runner, eslint, tsc). |

## Convenciones (una sola app, microservicios estandarizados)

- Una **única librería de fixtures compartida** (`fixtures.ts`) en la raíz de
  `e2e/`; los specs se organizan por microservicio en subcarpetas.
- El agente **reutiliza y mejora** lo existente; no duplica. El login real de la
  app se implementa una vez sobreescribiendo el fixture `authenticate`.

## Cómo lo invoca el orchestrator

Con `cwd` = `e2e/` del repo y por entorno `PW_BASE_URL` (DEV) + `PW_NAMESPACE`:

```
npm ci                               # setup (deps del proyecto)
npx tsc --noEmit                     # Filtro B: typecheck
npx eslint .                         # Filtro B: lint
npx playwright test --list           # Filtro B: cargan
npx playwright test --reporter=json  # Filtro C: ejecuta + detecta flaky
```

En verde, el agente comitea `e2e/` y se abre un PR (auto-merge si el repo lo
permite).
