# Revisión de cierre — Fase 2/3 + keystone (measured) + feature context.json

> Evaluación consciente y detallada del estado actual, pedida antes de dar por
> cerrados los cambios. Auditoría adversarial multi-agente (5 revisores) +
> verificación manual del PO de los hallazgos críticos. Cada conclusión está
> fundamentada en `file:line`.

## Veredicto

**NO está listo para cerrar. No es "extraordinario" — todavía.** El gate verde
(331 tests, typecheck) es **engañoso por dos razones distintas**, y la afirmación
"todo lo crítico y medio está resuelto" **es falsa**: quedan **2 críticos** y
~**6 altos** sin resolver, incluyendo **dentro del caso de uso exacto que querés**
(code-only apuntándose a sí misma).

> **El objetivo concreto —correr code-only contra sí misma y obtener resultados
> valiosos— hoy NO se cumple: reportaría `pass` habiendo ejecutado CERO tests.**
> Es el fallo Goodhart que todo el proyecto existe para prevenir, justo en tu
> caso de uso principal.

Dicho esto: **mucho de Fase 2/3 sí está bien hecho** (ver la sección final). El
problema son las piezas nuevas más complejas (keystone, context, scrub, code-mode).

---

## 🔴 CRÍTICOS (2) — bloquean el objetivo

### C1 · `main` no compila — la feature context se commiteó invertida
El consumidor (`pipeline.ts`, commiteado en `e1437fa`) importa `getCommitsBehind`,
`publishContext`, `isContextStale`; los proveedores (`repo-mirror.ts`,
`publish.ts`, `context.ts` + `opencode-client`, `cli`, `tui/format`, el `.md` del
agente, la skill) están **sin commitear**. Verificado por mí:
`git show HEAD:src/integrations/repo-mirror.ts | grep -c getCommitsBehind` → **0**
(idem `publishContext`, `isContextStale`). Un `git checkout main` limpio está
**rojo**; el 331-verde depende por completo del working tree. **CI en `main` está
en rojo ahora mismo.**
**Fix:** commitear los proveedores junto con el consumidor (un solo work-unit) —
no son polish opcional, son la mitad faltante de una feature ya mergeada.

### C2 · El self-test code-only reporta verde sobre CERO tests
Dos bugs que se componen:
1. La imagen del orquestador (`Dockerfile:7`, `playwright:v1.50.0-jammy`) trae
   **Node 20**, que **no expande los globs** de `node --test`; el script de test
   de ai-pipeline tiene los globs **entre comillas** (`"src/**/*.test.ts"`), así
   que tampoco los expande el shell → **0 tests ejecutados**. (CI usa Node 22, así
   que ahí no se ve.)
2. `ranZeroTests` (la guarda anti-falso-verde) exige `cmd.includes("node --test")`
   (`code-runner.ts:218`), pero el comando resuelto para ai-pipeline es **`npm
   test`** → la guarda **nunca dispara**. `npm test` con 0 tests sale 0 →
   clasificado **`pass`** (`code-runner.ts:303`).
Y los dos gates que lo atraparían están inactivos: Filter B se saltea en code mode
(por diseño) y Filter D (change-coverage) está inerte porque `npm test` no emite
cobertura. **No hay ninguna red de seguridad contra el falso-verde.**
**Fix:** (a) hacer la guarda *runner-aware* — cuando el ecosistema es `node`,
escanear el log por `tests 0` aunque el cmd sea `npm test`; (b) subir la imagen a
Node 22 **o** que el script de test expanda los globs en Node 20; (c) agregar un
test de code-runner con un proyecto `npm test` que emita `tests 0`.

---

## 🟠 ALTOS (6)

| # | Defecto | Evidencia | Por qué importa |
|---|---|---|---|
| H1 | **context.json se inyecta SIN sanitizar** al prompt del agente que escribe tests (+ sin límite de tamaño) | `opencode-client.ts:786-843` `renderArchitectureContext` no pasa por `sanitizeText`; todo otro input sí (diff:331, guidance:933, intent:948) | context.json viene del repo vigilado y lo **commitea el propio sistema** → atacante-influenciable. Un `route.name` malicioso inyecta instrucciones al agente que tiene bash+Playwright. Viola "sanitize data leaving the system" |
| H2 | **Los specs e2e corren con el env COMPLETO** incluido `GITHUB_TOKEN` | `execute.ts:112,124` y `setup.ts:39` usan `{ ...process.env }` | El scrub cerró el agujero en code-mode pero lo dejó abierto en e2e: código que escribe el agente corre in-proc con la credencial de push. Mismo tipo de vuln que el scrub arregló |
| H3 | **Misattribution del keystone**: cobertura *y* estabilidad se atribuyen a **cada** flow | `pipeline.ts:681-687` pasa `run.cases` entero y todos los `changedFiles` a cada flow; `measured.ts:48-66` los suma por flow | El "ground truth" del lazo de valor es **engañoso**: `flakyRuns` inflado ×N, cobertura de archivos que el test no ejercitó. Es la segunda ola que advertí al diferir 8/9 |
| H4 | **El `install` de code-mode no tiene timeout ni AbortSignal** | `code-runner.ts:159-175` spawn sin bound; `pipeline.ts:280` no cancelable | Un `npm ci`/`mvn`/`gradle` colgado **bloquea la cola secuencial para siempre** — justo lo que el timeout de `runTests` quería prevenir (solo se bloundó el test, no el install) |
| H5 | **scrubEnv: bug de ancla** descarta todas las vars de prefijo | `code-runner.ts:31` un solo `$` ancla toda la alternación → `npm_config_*`, `CARGO_*`, `RUSTUP_*`, `LC_*`, `GRADLE_*`, `PIP_*` se **descartan** | Rompe la config de npm/registry y los runtimes que el fix dice soportar; en entorno con proxy/Doppler el `npm ci` puede fallar/colgar. Verificado por mí |
| H6 | **context mode inalcanzable por la API REST** | `api.ts:16` `MODES` omite `"context"` → `POST /api/runs {"mode":"context"}` se degrada **silenciosamente** a `diff` | El productor del mapa solo se dispara por CLI; el operador (TUI/API) no llega y no recibe error |

---

## 🟡 MEDIOS (selección — ~12 confirmados)

| # | Defecto | Evidencia |
|---|---|---|
| M1 | code-mode **commitea `measured.json`** al repo vigilado (no gitignored ahí; no hay `e2e/`). Inerte bajo shadow, activo al poner `shadow:false` | `pipeline.ts:673-691` sin gate `!isCode`; `publish.ts:40` CODE_PATHSPEC no lo excluye |
| M2 | `getCommitsBehind` **sin `assertHexSha`** (rompe la invariante de defensa anti-inyección del propio módulo) | `repo-mirror.ts:123-135` vs `:50,70,99` |
| M3 | **Staleness falla en silencio**: `builtAtSha` inválido (force-push/rebase) → `commitsBehind=0` → "fresco" | `repo-mirror.ts:132-134` catch→0; `context.ts:156` |
| M4 | SIGKILL mata al hijo, **no al árbol de procesos** (npm/mvn forkean nietos) | `code-runner.ts` sin `detached`/`process.kill(-pid)` |
| M5 | Python: imagen instala `python3`/`pip3` pero el detector emite `python`/`pip` → **ENOENT** (falla seguro a infra-error) | `code-runner.ts:104-108` vs `Dockerfile` |
| M6 | `better-sqlite3` (nativo) puede no compilar: la imagen no tiene `build-essential`/`g++` → los self-tests con SQLite **fallan como bug de código** | `Dockerfile:13-20` |
| M7 | **`containsSecrets` sigue con el bug de `lastIndex`** (regex `/g` compartido) → alterna true/false; trampa fail-open | `sanitizer.ts:110-111` |
| M8 | **Doble escritor del manifest**: `qa-generator.md:118-122` aún instruye al LLM a escribir `manifest.json`; el rebuild de corrupto descarta entradas en silencio | `opencode-client.ts:447-453` |
| M9 | `renderArchitectureContext`: filtro por ruta `"/"` matchea todo path → scoping colapsa a "render all" | `opencode-client.ts:796-797` |
| M10 | El gate pre-deploy del maintainer corre código del agente **in-proc** (env scrubeado pero con acceso a `/app/data`); el `npm install` post-swap corre **sin scrub** | `index.ts:393,441` |
| M11 | `JSON.parse` sin try/catch en el productor de context | `pipeline.ts:310` |
| M12 | `timeoutMs` nunca se pasa desde config (campo muerto; solo aplica el default de 10 min) | `pipeline.ts:531,573,631` |

Más LOWs: wiring de measured/staleness/renderArchitectureContext **sin tests**;
`.env.example`/CLAUDE.md aún dicen `SELF_MAINTAINER_AUTOMERGE=true` (el código es
off); muchos commits de ai-pipeline son `docs:`/`test:` → `skip`, limitando el
valor del self-test.

---

## ✅ Lo que SÍ quedó bien (crédito honesto)

- **Run-id colisión**: resuelto (`randomBytes(4)` + try/catch en webhook/API + `unhandledRejection`).
- **Apagado limpio**: SIGTERM *y* SIGINT hacen `cancel()`+`drain()` (no más force-kill con datos huérfanos).
- **Maintainer seguro por defecto**: automerge `=== "true"` (off por defecto), `promote()` ya **no** hace self-merge sin branch protection, `performSwap` escribe el marker **antes** de borrar (ventana no-atómica cerrada), gate pre-deploy con env scrubeado.
- **Secret-removal del scrub**: el *allowlist* sí quita todos los secretos (correcto); el bug es que sobre-filtra (H5).
- **Runtimes**: Go/Rust/Maven/Gradle instalados en la imagen del orquestador.
- **Sanitizer JSON**: credenciales en forma `"key": "val"` ahora se redactan.
- **config fail-loud**: `${VAR}` no resuelta ahora lanza.
- **Continuation anti-coerción**: cap de profundidad (5, recorriendo `parentRunId`), provenance en el PR, `changeRef`/`mode` inmutables.
- **currentRun FIFO**: prioriza `running` (más viejo primero), matchea la cola.
- **Feature context (lado consumidor)**: gate de validación robusto, no crashea ante mapa ausente/inválido (degrada a `undefined`).

---

## Punch-list para que el code-only self-test funcione y dé valor

Mínimo imprescindible (en orden):
1. **C1** — commitear los proveedores de context → `main` compila.
2. **C2** — guarda `ranZeroTests` runner-aware + Node 22 (o globs expandibles) →
   se acaba el falso-verde. Sin esto, "resultados valiosos" es imposible.
3. **H5** — arreglar el ancla del regex de scrubEnv → `npm ci` no se rompe.
4. **H4** — timeout+signal en `install` → la cola no se cuelga.
5. **M6** — `build-essential` en la imagen → `better-sqlite3` compila.
6. **Valor real**: agregar cobertura a `npm test` (`--experimental-test-coverage`
   → lcov) para que **Filter D mida de verdad** en code-mode; sin esto no hay
   gate de valor sobre el self-test.

Seguridad antes de salir de shadow:
7. **H1/H2** — sanitizar+acotar context.json; scrubear el env de los spawns e2e.
8. **M1** — no commitear `measured.json` en code-mode (gate `!isCode` o excluirlo del pathspec).

Calidad del keystone (si se quiere que el "aprendizaje" sea confiable):
9. **H3** — partir `run.cases` por flow y atribuir cobertura solo a archivos
   cubiertos; o persistir a nivel suite. Hoy escribe datos engañosos.
10. **Durabilidad** — `measured.json` vive en el mirror (cache regenerable) → el
    aprendizaje se pierde en cualquier reinicio de volumen. Mover a un store durable.

---

## Diagnóstico del owner — verificado e integrado

| Gap del owner | Veredicto (verificado por mí) |
|---|---|
| G1: code mode saltea classifyCommit | ❌ **Incorrecto**: `pipeline.ts:261` gatea en `mode==="diff"`, no en el target. Code+diff clasifica normal; `style:` se skippea. NO es un bug. |
| G2: `npm test` corre TODA la suite (no atribuible) | ✅ **Correcto, aporta valor** (`package.json:10`). El veredicto code-mode no es atribuible a los tests del agente; un test preexistente roto envenena el run. → **añadido al plan (nuevo H7)**. |
| G3: change-coverage unknown en code | ✅ Ya cubierto (C2/12-B). Comandos de instrumentación integrados (abajo). |
| G4: specMetas, degrade silencioso | ◐ Parcial — cubierto; severidad baja. |
| G5: `npm ci` OK porque `npm_config_*` en allowlist | ❌ **Evaluación incorrecta**: el bug de ancla (H5) descarta `npm_config_*`. Es un break real, no "prob. baja". |
| Crítico #2 (V8) "✅ trade-off" | ◐ Observable, pero no-op real en deploy bundleado. "✅" solo si se acepta DEV-sin-bundles y se documenta. |

### Nuevo hallazgo integrado
**H7 (alto) · El veredicto code-mode no es atribuible** — `npm test` corre toda la
suite del repo, no solo los tests nuevos del agente. Un fallo preexistente no
relacionado → `fail` falso atribuido al cambio; el aporte del test nuevo es
invisible. Compone con C2 (falso-verde) y Gap 3 (sin coverage): la ejecución
code-mode no atribuye ni por tests ni por cobertura. **Fix:** medir cobertura del
cambio (instrumentación, abajo) para atribuir vía change-coverage; documentar que
en code-mode el veredicto es "la suite del repo pasa/falla", no "el test nuevo
cubre el cambio" — hasta que la cobertura esté activa.

### Instrumentación code-mode (cierra Gap 3 / ítem 12-B / crítico #4)
| Ecosistema | Comando con instrumentación | Output que `collectNativeCoverage` ya busca |
|---|---|---|
| Node | `c8 --reporter=lcov <test>` (o `node --test --experimental-test-coverage`) | `coverage/lcov.info` |
| Python | `pytest -q --cov --cov-report=lcov` | `coverage/lcov.info` |
| Go | `go test -coverprofile=... ./...` (+ convertir a lcov) | `coverage/lcov.info` |

---

## PLAN DE ACCIÓN FINAL (orden de implementación)

**Tanda A — desbloquear el self-test code-only (lo que pediste):**
1. C1 — commitear los proveedores de `context` (+ arreglar M9/M11/H6 en ellos) → `main` compila.
2. C2a — `ranZeroTests` runner-aware (node: escanear `tests 0` aunque cmd sea `npm test`).
3. C2b — Node 22 en la imagen (o globs expandibles) → los tests realmente corren.
4. H5 — arreglar el ancla del regex `scrubEnv`.
5. H4 — timeout + AbortSignal en `install` de code-mode.
6. M6 — `build-essential` en la imagen (better-sqlite3).
7. M5 — `python3`/`pip3` (o `python-is-python3`).
8. Instrumentación code-mode + atribución (Gap 2/H7/Gap 3).

**Tanda B — seguridad antes de `shadow:false`:**
9. H1 — sanitizar + acotar `context.json` antes de inyectarlo.
10. H2 — scrubear el env de los spawns e2e (`execute.ts`, `setup.ts`).
11. M1 — no commitear `measured.json` en code-mode.
12. M2 — `assertHexSha` en `getCommitsBehind`. M10 — scrub post-swap install.

**Tanda C — calidad del keystone + robustez:**
13. H3 — partir `run.cases` por flow; atribuir cobertura solo a archivos cubiertos.
14. M7 — `containsSecrets` lastIndex. M8 — quitar doble-escritor del manifest. M3 — staleness fail-loud. M4 — kill del árbol de procesos. M12 — plumbing de `timeoutMs`.
15. Durabilidad de `measured.json` (decisión de diseño).

**Tanda D — re-certificación:** re-auditar las Fases 0/1 sobre el código refactorizado (lo que esta revisión NO cubrió).

---

## ESTADO DE CIERRE (re-certificado)

**Gate:** 344/344 tests, typecheck limpio, árbol commiteado.

**Re-certificación (3 revisores adversariales en paralelo):**
- **Fases 0/1 — INTACTAS** tras el refactor (ejecución fail-closed, keystone V8 anidamiento, commit-classify, validate, generación/review, merge-back, determinismo runId, deploy-gate). Sin regresiones.
- **Self-test code-only — CORRECTO y VALIOSO**: corre los 344 tests reales, clasifica por exit-code honesto, sin falso-verde/falso-rojo, sin crash/hang, sin escribir nada bajo shadow.
- **Integración — SÓLIDA**: egress sanitizado, determinismo cross-run, propagación de errores sin swallow, matriz de veredictos exhaustiva.

**Defectos de la re-cert — TODOS arreglados:** D1 (manifest fantasma en code-mode), egress crudo de `/api/runs` (sanitizeRecord), exclusión de `measured.json` del pathspec, CLI deriva target de `app.code` (D3), cleanup de huérfanos en el funnel único, poda de dirs de cobertura, comentarios/código muerto.

**Defectos de la revisión Fase 2/3 — TODOS arreglados:** H1, H2, H3, H5, M1-M11 (ver tabla de plan arriba).

**Única limitación conocida (decisión de producto aceptada):** el keystone de change-coverage es no-op **observable** (WARN) contra deploys bundleados (Vercel/Astro) porque las URLs hasheadas no resuelven a fuente; funciona contra un DEV sin bundlear. Resolverlo requiere source-maps (`v8-to-istanbul`) + spike de deploy en vivo — iniciativa dedicada, no un quick-fix (hand-rollear un decoder en el keystone de valor es la peor fuente de segunda ola). No afecta code-mode (usa lcov) ni el self-test.

**Conclusión:** todos los flujos funcionan con calidad. El proyecto está listo para levantarse y correr en code-only contra sí mismo dando resultados valiosos y verdaderos.
