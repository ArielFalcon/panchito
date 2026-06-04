# Proyecto e2e compartido (harness)

Esqueleto común con el que corren **todos** los specs generados, vengan del repo
que vengan. Es la "Capa A" del harness: estandariza para que el resultado sea
consistente entre apps y entre runs.

## Qué hay aquí

| Fichero | Para qué |
|---|---|
| `playwright.config.ts` | Config base: retries (señal de flakiness), trace on-first-retry, reporter JSON, `data-testid`, un worker. |
| `fixtures.ts` | Caja de herramientas que el agente importa: fixture `namespace`, slot `authenticate`, helper `ns()`. |
| `eslint.config.js` | Filtro B (lint): caza esperas fijas, element handles, tests sin assert, locators crudos. |
| `tsconfig.json` | Filtro B (typecheck) sobre `specs/**`. |
| `specs/` | Donde el orchestrator persiste los specs de cada run (`specs/<qa-bot-sha>/`). |

## Modelo híbrido (común + por repo)

- **Común (este directorio):** reglas, config y el contrato de fixtures. Se
  escribe y revisa una vez.
- **Por repo (lo rellena el agente):** los pasos reales de login de *esa* app
  (sobreescribiendo el fixture `authenticate`) y sus fábricas de datos. Se
  generan leyendo el código de la app y se **persisten** para reusarlos en los
  siguientes runs (no se reinventan cada vez).

## Cómo lo invoca el orchestrator

Por entorno: `PW_BASE_URL` (DEV), `PW_SPEC_DIR` (carpeta de specs del run) y
`PW_NAMESPACE` (prefijo `qa-bot-<sha>`). El orchestrator corre, con `cwd` aquí:

```
npx tsc --noEmit -p tsconfig.json     # Filtro B: typecheck
npx eslint <PW_SPEC_DIR>              # Filtro B: lint
npx playwright test --list           # Filtro B: cargan
npx playwright test --reporter=json  # Filtro C: ejecuta + detecta flaky
```

> Requiere `npm ci` en este directorio (la imagen del orchestrator lo hace).
