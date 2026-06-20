# Plan de Producción v2 — Modos Manual y Diff

> **v2** — Revisado contra el código real tras *judgment-day* (2 jueces ciegos en
> paralelo) + verificación de premisas. Diferencias respecto de v1:
> - Cada cambio está **anclado a un símbolo real** del repo.
> - Las 5 decisiones de diseño que v1 dejaba abiertas están **resueltas**.
> - Se **elimina** el trabajo que ya existe (casi la mitad del Change #5 de v1).
> - `objectiveCoverage` se reposiciona: **detector de tests huecos en `signal`**,
>   nunca keystone ni `enforce`.
>
> Idioma: español neutro para la prosa; identificadores, rutas y símbolos en inglés.

---

## 0. Correcciones de premisas (v1 → v2)

v1 describía una línea de base parcialmente equivocada. Antes de planificar, se
corrige contra el código:

| Premisa de v1 | Realidad verificada | Consecuencia para v2 |
|---|---|---|
| "limpieza de `opencode.db` al boot" | **EXISTE** — `agents/agent-supervisor.mjs:199` (`wipeOpencodeDbOnce`), llamado al boot, idempotente. Pero vive en `agents/`, **no** en `src/`; no hay métrica de tamaño en `src/`. | El cleanup ya está. Lo nuevo es sólo la **métrica** observable desde `src/`. |
| "namespace por `runId` y por intento (`-r1`,`-r2`)" como trabajo a hacer | **YA EXISTE** end-to-end — `src/qa/test-data.ts` (`testDataNamespace` + `runToken`), `src/pipeline.ts:2133` (`retryNs = ${ns}-r${retry+1}`). | **Se elimina** del plan. No se reimplementa. |
| "detección de retry sin progreso" como trabajo a hacer | **YA EXISTE** — `src/qa/progress-gate.ts` (`decideProgress`, señales A/B/C) + `src/qa/nav-gate.ts` (flail por re-navegación). | **Se reusa**. v2 sólo conecta evidencia adicional. |
| "extender `fixtures.ts` con captura fetch/xhr" (como base existente) | El **primitivo** existe (`_faultInject` hace `page.route("**")` sobre xhr/fetch) pero captura para **corromper** respuestas, no para registrar evidencia. La captura de `{method,url,status}` **no existe**. | La captura de evidencia **es trabajo nuevo**, pero **reusa** el patrón `page.route` ya presente. |
| (implícito) "falta que el agente entienda la relación entre clases" | **FALSO** — ya se resuelve en **generación** vía Serena: `qa-explorer` (`find_referencing_symbols`/`get_symbols_overview`) → `ExplorationBrief` (`blastRadius` = `{symbol,file,role}`, `feBe` = `route→operationId→cliente`) → `context-pack.ts:165` lo empuja al prompt antes de la primera escritura. | v2 **no** agrega comprensión de clases. `objectiveCoverage` sólo **verifica** traversal, no aporta entendimiento. |

---

## 1. Principio rector (lo que v1 no separaba)

Hay **dos capas distintas** y v1 las mezclaba:

- **Generación (lo que el agente SABE al escribir el test).** Serena le da el
  blast-radius + el join FE↔BE + los contratos OpenAPI. **Esto ya funciona** y es
  sólido. No se toca.
- **Verificación (probar que el test escrito REALMENTE recorrió ese camino).**
  Aquí está el gap. Y aquí es donde un *network-hit* (`200 en /api/orders`) es una
  señal **débil**: no prueba que se ejecutó la línea del backend que cambió el diff.

Regla dura derivada: **no apilar proxies *gameables* sobre el keystone.**
`change-coverage` (V8 + source maps) es la única señal que el generador **no puede
fingir** (no controla qué líneas se ejecutan) y por eso es el único gate de
`enforce`. `objectiveCoverage` (que el agente **sí** controla: elige a qué URL
pegar) se queda en `signal` como **detector de tests huecos**, nunca como keystone.

---

## 2. Cambios clave (v2)

### 2.1 Contrato de objetivo para `manual` — **MANTENER (idea más valiosa)**

`manual` hoy no tiene **ninguna** señal determinista (change-coverage necesita un
diff). El valor del contrato **no es alimentar un gate**: es ser **input de
generación** que obliga a que exista un objetivo testeable *antes* de generar.

- Añadir `ManualObjectiveContract` (genérico, app-agnóstico — ver §3.3 sobre el
  invariante): `{ flow, routeOrScreen, primaryAction, expectedOutcome, criticalData }`,
  todos strings libres. Sin vocabulario de app hardcodeado → no viola
  "app-specificity sólo en `config/`".
- Guardarlo en el run record y pasarlo al `planner`/`generator`/`reviewer` por el
  canal de prompt que ya usa `guidance`.
- **Rechazo + retrocompatibilidad: resuelto en §3.1.**

### 2.2 `objective-coverage` — **MANTENER, DEGRADADO a `signal` (hollow detector)**

Gate puro posterior a `execute`. Por spec verifica: ruta visitada, backend
ejercitado (network observado), assertion de outcome presente, metadata coherente.

- **Sólo `signal`.** Marca el test que el agente entendía pero escribió hueco (no
  tocó el flujo que decía tocar). **Nunca `enforce`** — ver §3.2.
- En `diff` **complementa** change-coverage como diagnóstico; **no** lo reemplaza.
- En `manual` es la **única** señal determinista disponible, con su límite explícito:
  detecta huecos, no profundidad.
- **Captura de red: resuelto en §3.4** (qué se captura y qué NO).
- **Upgrade path de repos ya onboarded: resuelto en §3.5.**

### 2.3 Adjudicador de fallos — **EXTENDER lo existente, NO crear módulo paralelo**

v1 proponía un módulo nuevo. Riesgo confirmado por ambos jueces: **un segundo
camino de código** que diverge del que ya funciona (`classifyFailure`,
`isLikelyRealBug`, `decideProgress`).

v2: un único `adjudicate(evidence) → verdict` **puro** que **consume** los
primitivos existentes y se invoca en el **único punto de decisión que ya existe**
(donde hoy se llama `isLikelyRealBug`, `pipeline.ts:~2019-2053`), reemplazándolo sin
duplicar la lógica:

```
adjudicate(evidence): "app_defect" | "generated_test_defect"
                    | "runner_infra" | "dev_infra" | "flaky" | "objective_gap"
  consume: classifyFailure() + failureDom + selector-check (Lever-2)
         + devHealthy() + decideProgress() + reviewer corrections
```

Con la **asimetría de seguridad resuelta en §3.6** (la pieza que v1 no tenía y que
ataca directamente el objetivo 2: *no pelear contra un test que falla porque cumple
su objetivo*).

### 2.4 Ejecución óptima — **MANTENER observabilidad + AÑADIR la palanca que falta**

- **Mantener:** persistir `phaseTimings` por subfase (hoy el intra-run es caja
  negra). Conectar la detección de no-progreso a `decideProgress`/`nav-gate`
  **existentes** (no reimplementar).
- **Añadir (verificado, alto impacto, §4):** filtrar el **re-execute de los retries
  a sólo los specs que fallaron**. Hoy `pipeline.ts:2136` re-corre la **suite
  entera**, en serie (`workers:1`). Es la optimización intra-run más barata y no
  toca ningún invariante.
- **Budgets: resueltos en §3.7** (qué hace el sistema cuando se exceden — con la
  regla asimétrica de no descartar trabajo verde).

### 2.5 Limpieza de recursos — **RECORTAR a los gaps reales**

Tras quitar lo que ya existe (namespace por run/intento), los gaps reales son
chicos:

- `.qa/fault-injection/<ns>/` no se limpia explícitamente (orphan que se acumula).
- `.qa/network/<ns>/` — limpieza nueva, porque el artefacto es nuevo.
- **Métrica de salud** observable desde `src/`: sesiones OpenCode vivas, tamaño de
  `opencode.db`, conteo de artefactos `.qa` por repo. (El *cleanup* de `opencode.db`
  ya existe; falta sólo **medirlo**.)
- Reusar el cleanup de `previousNamespace` que **ya existe** (`pipeline.ts:1177`,
  `runner.ts:71`) para runs interrumpidos.

---

## 3. Decisiones de diseño resueltas (lo que v1 difería a "los implementadores")

### 3.1 Rechazo del contrato manual + retrocompatibilidad

- API (`src/server/api.ts`): `mode=manual` sin contrato válido → **HTTP 422**
  (Unprocessable Entity, no 400: el request está bien formado, el objetivo es
  insuficiente) con un body estructurado que lista los campos faltantes + el
  template.
- **Retrocompat:** se acepta `guidance` libre **o** contrato estructurado. Si llega
  sólo `guidance`, un validador puro determinista chequea que nombre al menos
  *{ruta/pantalla, acción, outcome esperado}*. Guidance descriptiva ("login con
  password incorrecto muestra error") **pasa**; guidance vacua ("probar la app")
  **se rechaza** con el template. Migración documentada: los manual con guidance
  pobre ahora exigen los 5 campos.
- Mismo validador en el TUI (`client/internal/ui/launcher.go`) para fallar temprano
  antes de encolar.

### 3.2 `enforce` de `objectiveCoverage`: **no existe en v2**

La pregunta "¿qué hace determinista a la evidencia?" se **disuelve**: como
`objectiveCoverage` es un proxy *gameable*, **no se promueve a `enforce`, punto**.
El único gate de `enforce` sigue siendo `change-coverage`. Esto evita el problema
sin resolver de normalización de URLs (query params, GraphQL endpoint único, BFF).
*Si* en el futuro alguien quiere `enforce` sobre red, primero debe resolver
normalización **y** probar la tasa de falsos positivos — **fuera del alcance de v2.**

### 3.3 Invariante "app-specificity sólo en `config/`"

El `ManualObjectiveContract` guarda **formas genéricas** (strings libres), no
vocabulario de app. La *forma* es agnóstica; el *contenido* es dato por-run, no
config por-app. No viola el invariante.

### 3.4 Sanitización de los traces de red

La captura escribe en `.qa/network/<ns>/` **únicamente** `{ method, url, status }`,
y:
- **Nunca** headers, **nunca** bodies (cierra la fuga de `Authorization`/tokens/PII
  de raíz).
- Query string reducido a **claves**, sin valores.
- La salida del parser pasa por `src/orchestrator/sanitizer.ts` antes de tocar
  cualquier prompt o Issue.

### 3.5 Upgrade path de `fixtures.ts` para repos ya onboarded

Sin esto, `objectiveCoverage = unknown` para **todos** los repos existentes (no-op
en producción durante todo el rollout inicial). v2 sigue el patrón **ya existente**:
el bloque de captura se añade como **bloque self-contained append-only** (igual que
`qa-failure-capture`, ver `config/e2e/fixtures.ts:206`), y el orquestrador lo
inyecta/actualiza en el `fixtures.ts` de los repos ya onboarded en `setup`.

### 3.6 Asimetría del adjudicador (objetivo 2)

El costo de los dos errores es **asimétrico**:
- Falso `app_defect` (abrir Issue por un bug del test) → ruidoso, recuperable.
- Falso `generated_test_defect` (regenerar y **matar un fallo real**) → **peligroso**:
  se pierde el bug. Es exactamente "pelear contra un test que cumple su objetivo".

Reglas:
1. `app_defect` → Issue, **sin retry**, **sólo con evidencia determinista**
   (value-mismatch sobre un campo que el diff cambió + selectores únicos presentes).
   Mantiene la precisión del `isLikelyRealBug` actual.
2. **No-progreso** entre retries (`decideProgress` dice "estancado"),
   independientemente de la clase de fallo → **FRENAR y mostrar** ("needs human"),
   en vez de quemar ciclos peleando. (Esto es lo nuevo: convierte "seguir peleando"
   en "surface".)
3. `generated_test_defect` con evidencia clara (selector ausente en el failure DOM,
   corregible) → retry focalizado, **acotado**.
4. `runner_infra`/`dev_infra` (`devHealthy()` false, error del runner) → `infra-error`,
   **no culpar al repo**.

### 3.7 Semántica de budgets excedidos (objetivo 3)

- **Budgets blandos (default): advisory.** explorer, planner, pack, generator,
  reviewer → exceder **loguea + telemetría**, nunca mata. Razón: no degradar un gate
  de calidad en silencio (degradar al reviewer rompería el objetivo 2).
- **Backstop duro (ya existe): se mantiene.** El `MAX_CYCLES`/`deriveCycleBackstop`
  (`pipeline.ts:730-768`) sigue siendo el techo real de ciclos LLM.
- **`execute` nunca se aborta a mitad** (regla asimétrica: no tirar un run 80% verde).
  Si el wall-clock total supera un techo duro nuevo, se **deja terminar el execute en
  curso**, se **detienen los retries siguientes** y se conserva el mejor run vía el
  *regression guard* que ya existe (`pipeline.ts:2159`).

---

## 4. Optimización intra-run verificada (objetivo 3)

El cuello no es la cola secuencial (cross-run, invariante que protege DEV). Es
**dentro del run**. Verificado:

1. **Ejecución serial:** `config/e2e/playwright.config.ts:19-20` → `workers:1`,
   `fullyParallel:false`. N specs = N sesiones en serie. **Tradeoff deliberado** (no
   martillar DEV, datos deterministas); v2 **no lo rompe**, lo nombra.
2. **Hasta ~5 corridas completas del suite por run**, todas seriales: inicial
   (`:1902`) + cada retry re-corre **todo** (`:2136`) + value oracle re-corre con
   fault-injection (`fault-injection-e2e.ts:4`) + coverage `enforce` re-corre
   (`:2218`).
3. **Rebuild de contexto ~195s** en cache-miss (`context-cache.ts:4`).

**Palanca de v2 (la que falta):** filtrar el re-execute de los retries a **sólo los
specs que fallaron** (`:2136` hoy no filtra). Corta minutos por run, sin tocar
invariantes. Los `phaseTimings` exponen cuál de los 3 costos domina en cada app
antes de optimizar más.

---

## 5. Bug confirmado y CORREGIDO — coverage namespace misalignment

> Estado: **confirmado con test y arreglado** (TDD: rojo → fix → verde →
> `npm test` 1595 ✓, `typecheck` ✓). **Reemplaza** el bug que propuso Judge A (que se
> verificó **inexistente**: el static-fix loop no ejecuta contra DEV).

**Mecanismo real (corregido respecto de la hipótesis inicial).** Al verificar saltó
que `clearBrowserCoverage` **ignora su argumento de namespace** y borra el árbol
`.qa/coverage/` **entero** en cada llamada (`change-coverage.ts:436`). Entonces, cuando
un run de `diff` llega a verde **sólo en un retry**:
1. el retry borra TODO el árbol y ejecuta bajo `retryNs` → dumps sólo en `<retryNs>`;
2. `collectCoverage` lee `<ns>` base, que quedó **vacío** → `null` → **`unknown`**.

Como `unknown` **nunca bloquea**, el keystone (change-coverage) se **perdía
silenciosamente** justo en los runs más frágiles (los que necesitaron un retry). Es
**peor** que la hipótesis original: no era "mide el intento equivocado", era **"no mide
nada"**.

**Fix aplicado.** Se trackea `coverageNs` = namespace del run que realmente quedó verde
(el loop sale apenas un retry pasa — `pipeline.ts:1926` `run.verdict === "fail"` en la
condición —, así que el verde es siempre el último execute y ningún wipe posterior lo
pisa). La colección lee de `coverageNs`; el path de `enforce` lo re-alinea a `ns` tras
su re-ejecución. **Cinco ediciones quirúrgicas** en `src/pipeline.ts` + test de
regresión en `src/pipeline.test.ts` ("a run green only on a retry is measured from the
retry namespace"). No es de 1 línea (como estimaba la hipótesis) pero es **un solo
cambio lógico**.

---

## 6. Lista de recorte (no reimplementar — ya existe)

- Namespace por `runId` y por intento → `test-data.ts`, `pipeline.ts:2133`.
- Detección de retry sin progreso → `progress-gate.ts:decideProgress`, `nav-gate.ts`.
- Cleanup de `previousNamespace` para runs interrumpidos → `pipeline.ts:1177`,
  `runner.ts:71`.
- Intercepción base de fetch/xhr → patrón `page.route` de `_faultInject` (reusar).
- Comprensión de relación entre clases → Serena en `qa-explorer` + `context-pack.ts`.
- Cleanup de `opencode.db` al boot → `agent-supervisor.mjs:199` (sólo falta la
  métrica).

---

## 7. Interfaces y contratos (corregidos)

- `RunOptions.guidance` en `manual` → exige contrato válido (§3.1); diff lo ignora.
- Nuevos en `RunOutcome.gateSignals`: `objectiveCoverage` (signal-only),
  `failureAdjudication`, `phaseTimings`, `resourceHealth`.
- Nuevo artefacto runtime no versionado: `.qa/network/<namespace>/*.json` con
  **sólo** `{method,url,status}` (§3.4).
- Nuevo config opcional por app: `qa.objectiveCoverage.mode: "off" | "signal"`
  (default `"signal"`; **sin `enforce`** en v2). Parseo en
  `src/orchestrator/schemas.ts` junto a `changeCoverage`.
- `changeCoverage` sigue siendo el **único keystone de `enforce`**.

---

## 8. Orden de implementación (re-secuenciado: barato y de alto valor primero)

1. ~~**Bug candidato §5**~~ — ✓ **HECHO**: confirmado + arreglado (ver §5). Gate verde.
2. ~~**Retry filtrado a fallos §4**~~ — ✓ **HECHO**: keystone-safe (filtra el retry a los specs fallidos SOLO cuando change-coverage no se mide en ese run), `file` en `QaCase`, allowlist en el spawn, merge por archivo no-recorrido. Gate verde (1627/0).
3. **Manual contract §2.1 + §3.1** — el mayor valor de producto; validadores puros
   + tests (API/TUI).
4. **Adjudicador §2.3 + §3.6** — extraer a `adjudicate` puro **consumiendo** lo
   existente; reconectar el único punto de decisión; tests de asimetría.
5. **phaseTimings + budgets §2.4 + §3.7** — observabilidad + backstop blando.
6. **Network evidence §2.2 + §3.4 + §3.5** — fixture append-only + parser sanitizado
   + upgrade path; lo más invasivo, va último.
7. **Resource health + cleanup §2.5** — métrica + limpieza de orphans.

---

## 9. Test plan

- Unit: validador del contrato manual (vacío / genérico / válido); `adjudicate`
  (cada una de las 6 clases + asimetría: no-progreso → surface, no retry); parser de
  `.qa/network` (por-namespace, sin fuga entre runs, sin headers/bodies, sanitizado);
  budgets (blando loguea, execute no se aborta).
- Pipeline (stubs):
  - manual sin objetivo útil → **422** temprano;
  - manual con objetivo válido → genera y mide `objectiveCoverage` en `signal`;
  - diff verde con backend no ejercitado → `objectiveCoverage` marca hueco en
    `signal` (no bloquea);
  - fallo por bug real determinista → Issue **sin retry**;
  - fallo por selector malo → retry focalizado **acotado**;
  - fallos sin progreso → **frena y surface**, no regenera infinito;
  - **verde-en-retry → coverage colectado del namespace ganador** (test del §5).
- Validación completa: `npm run typecheck`, `npm test`, run real manual en app
  compleja, run real diff chico, run real diff multi-flow.

---

## 10. Supuestos y rollout

- `objectiveCoverage`: **siempre `signal`** en v2 (no hay `enforce`).
- `changeCoverage`: sigue su rollout `signal → enforce` por app a medida que gana
  confianza (es el único keystone).
- No se optimizan `complete`/`exhaustive`; sólo regression tests porque comparten
  piezas.
- Los agentes siguen **sin** llamar APIs directamente; la evidencia backend viene de
  navegación UI + red observada (con su límite explícito: detecta traversal, no
  profundidad de clases).
- Producción requiere DEV con source maps para que `changeCoverage` sea fuerte en
  frontend.

---

## 11. Decisiones abiertas para el usuario

1. **Wall-clock duro por run (§3.7):** ¿valor por defecto? (sugerido: derivar de
   `iterationBudget` existente, no un número mágico nuevo).
2. **Retry filtrado (§4):** ¿aplicar también al re-run del value oracle, o sólo al
   fix-loop? (el oracle ya está optimizado a un project).
3. ~~**Bug §5:** ¿lo confirmo/arreglo ahora?~~ → **RESUELTO**: confirmado y arreglado
   (ver §5). Quedan abiertas (1) y (2).
