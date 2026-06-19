# Reestructuración del pipeline de generación: análisis de raíz + plan de implementación (verificado)

> **Estado:** la tesis de acoplamiento fue confirmada por dos revisores ciegos independientes (0
> CRITICALs). Este documento (a) corrige las imprecisiones que esa revisión encontró y (b) define el
> plan de implementación **verificado línea por línea contra el código** — alcance real, firmas reales,
> tests reales, sin regresiones. Toda afirmación tiene su `file:line`.
>
> **IMPLEMENTADO (2026-06-19):** F1+F3 (un cambio), F2 (timeout-only — ver la sección F2 para el desvío
> verificado vs el plan original) y F4 (B1 pin + B3 wipe-at-boot) están aplicados. `npm test` (1531) +
> `npm run typecheck` verdes.
>
> **REVISADO (judgment-day, 2 rondas):** dos jueces ciegos en paralelo. Ronda 1: 0 CRITICALs, varios
> WARNINGs reales (todos en torno a F1 serializando el fan-out al strong-agent bajo fallo de captura).
> Endurecimiento aplicado — **render con timeout escalado por nº de rutas** (no all-or-nothing),
> `MAX_ROUTES_UNION` 16→12 **con warning al truncar**, guard soft-404 por **regla de mayoría** (`count≥2 &&
> count > rutas/2`, evita falsos positivos y nunca dropea una ruta única), **fallback al strong-agent
> ACOTADO** (`MAX_STRONG_FALLBACK=3`; el excedente va a workers paralelos a ciegas, no serializa el run),
> `PLANNER_TIMEOUT_MS` 120→**240s por modo** (diff/manual, no por brief) y en el `Math.max` del dispatcher,
> `verified` marcado deprecado, e higiene del prompt (rutas no capturadas → unverified). Ronda 2: ambos
> jueces **RESUELTO todo, 0 CRITICALs, 0 WARNINGs reales** → **APROBADO**. **Pendiente:** el run de
> validación sobre petclinic (rebuild del contenedor `agents` para F4 + restart del `orchestrator` para
> F1/F3/F2; `tsx` no hot-reload).

## El problema de raíz

El pipeline de generación diff/manual mezcla **cuatro responsabilidades** comunicadas por **conectores
compartidos y ambiguos**:

- **R1** entender el cambio · **R2** planificar objetivos · **R3** verificar/capturar el DOM · **R4** generar.

El núcleo del acoplamiento: **R3 está partida entre el planner (navega → setea `verified`) y el
orchestrator (captura), comunicada por un flag (`verified`) que cada lado interpreta distinto, sobre un
rol (`qa-generator`) con tools fijos** que le permiten al planner invadir R1 (re-widen) y R3 (navegar).
Por eso tocar el planner toca el grounding del fan-out, los prompts de dos modos, los tools del generador,
el timeout de cuatro modos y varios tests.

## Mapa de acoplamientos (corregido y verificado)

| Conector | Qué acopla | Evidencia verificada | Corrección vs análisis previo |
|---|---|---|---|
| **C1 — rol `qa-generator` compartido** | planner = generador = fallback | [opencode-client.ts:1137](src/integrations/opencode-client.ts:1137) (planner), `:639`, `:1187`; tools en [opencode.json:18-26](agents/opencode.json:18) | — (correcto) |
| **C2 — flag `verified`** | el planner lo setea (navega), el fan-out lo filtra, el single-agent lo ignora | filtra [opencode-client.ts:1222](src/integrations/opencode-client.ts:1222) + split `:1255`; ignora [context-pack.ts:214](src/qa/context-pack.ts:214); **el explorer (productor real del brief en prod) lo deja SIEMPRE false** ([exploration-brief.ts:42](src/qa/exploration-brief.ts:42)) | El explorer nunca setea `verified`; solo el planner al navegar (diff/manual) |
| **C3 — `workerDom` blob** | un solo string inyectado **idéntico** a todos los workers | `let workerDom: string` [opencode-client.ts:1216](src/integrations/opencode-client.ts:1216); asignado igual a todos `:1282`; campo per-worker `domSnapshot?` ya existe `:1035` | — (correcto) |
| **C4 — `agentTimeout(mode)` único + override global** | un timeout para planner/generador/workers; **`OPENCODE_TIMEOUT_MS=900000` pisa la tabla per-modo** | [opencode-client.ts:1134](src/integrations/opencode-client.ts:1134), `:1380`; [.env.example:13](.env.example:13) | El override global hace la tabla per-modo muerta; un `PLANNER_TIMEOUT_MS` necesita **precedencia** sobre el global |
| **C5 — prompt del planner monolítico** | route-verification **duplicada** en diff y manual | [prompts.ts:244](src/integrations/prompts.ts:244) (diff) y `:321` (manual) | — (correcto; ambos bloques) |
| **C6 — captura DOM** | **una sola** implementación (`render`), **tres** callers que difieren en selección de rutas y consumo | `render` per-ruta [dom-snapshot.ts:37](src/qa/dom-snapshot.ts:37); callers: single-agent `buildContextPack` ([context-pack.ts:244](src/qa/context-pack.ts:244)), fan-out `captureRoutesDom` ([opencode-client.ts:1222](src/integrations/opencode-client.ts:1222)), reviewer `captureDom` ([pipeline.ts:392](src/pipeline.ts:392)) | **No "dos implementaciones"** — una impl, tres callers; solo el fan-out cambia en F1 |
| **C7 — tests que fijan el comportamiento** | Phase-5(d) (split por `verified`) y 3.11(c) (Lever-3 en el prompt diff) | split [opencode-client.test.ts:2637/2713]; Lever-3 [test:1908] (diff lo tiene) vs [test:1917] (complete no) | `960` NO se rompe (testea `buildWorkerPrompt`, que F1 no cambia) |

Downstream **NO acoplado** a `verified`/`workerDom`/route-shape (verificado): el manifest (`upsertManifest`
keya en flow/objective/symbols, [opencode-client.ts:1331](src/integrations/opencode-client.ts:1331)),
change-coverage (consume el reporte V8/lcov), y el reviewer (extrae rutas de los specs, no del brief). **F1
es seguro respecto a esos.**

## Plan de implementación (verificado, por fragmento)

### F1 — captura DOM **per-objetivo** (la costura habilitante)

**Archivos:** `src/qa/dom-snapshot.ts` (aditivo) · `src/integrations/opencode-client.ts` (fan-out) · tests.

**Cambios:**
1. `dom-snapshot.ts`: añadir `captureDomByRoute(routes, input, deps): Promise<Map<string,string>>` que reusa
   el `render` existente (que **ya** devuelve `RouteSnapshot[]`, [:37](src/qa/dom-snapshot.ts:37)) y formatea
   **por ruta** en vez de colapsar. Las funciones actuales (`captureDom`, `captureDomForRoutes`,
   `formatDomSnapshot`) quedan **intactas** → `buildContextPack` y el reviewer no se tocan. **Aditivo.**
2. `runOpencodeParallel` ([:1216-1284](src/integrations/opencode-client.ts:1216)):
   - Capturar **por objetivo** las rutas de `o.brief.routes` (todas, **sin** filtro `verified`), cada objetivo
     con su propio cap `MAX_ROUTES` ([dom-snapshot.ts:40](src/qa/dom-snapshot.ts:40)) — **no** la unión (evita el drop silencioso).
   - Asignar `w.domSnapshot` = el DOM de **las rutas de ESE objetivo** (no el blob compartido de `:1282`).
   - Re-key del split grounded/ungrounded ([:1248-1265](src/integrations/opencode-client.ts:1248)): "grounded" = el objetivo
     **obtuvo nodos (no error) para sus rutas**; si la captura de todas sus rutas falló → ungrounded → strong agent (sin cambios en esa rama, [:1300](src/integrations/opencode-client.ts:1300)).

**Por qué sin regresión:**
- El `render` no cambia (ya per-ruta); `buildContextPack` (single-agent) y `captureDom` (reviewer) siguen con sus funciones string.
- El cap se aplica per-objetivo → ninguna ruta se dropea por unión.
- El planner **sigue** seteando `verified` (inocuo: ya no se filtra) → **comportamiento del planner intacto en F1** (se simplifica en F3).
- **complete/exhaustive**: hoy reciben `workerDom` vacío (sus rutas son `verified:false` porque su procedimiento no tiene Lever-3, [prompts.ts:353-372]). Con F1 reciben DOM de sus rutas de brief → **cambio de comportamiento (mejor grounding) + costo**, NO solo costo. Validar.
- **Riesgo soft-404** (SPA hash devuelve 200 a cualquier ruta → DOM del shell): mitigado porque las rutas vienen del **brief code-derived** (rutas reales del router), no inventadas por navegación. Mitigación adicional dentro de F1: descartar un snapshot cuyo set de nodos sea idéntico al del app-shell (sanity-check barato). **Parte de F1, no diferido.**

**Tests:** reescribir Phase-5(d) `:2637`/`:2713` (el split re-key, mismo commit) + añadir test del cómputo per-objetivo. `960` no se toca.

### F2 — timeout propio del planner (IMPLEMENTADO como timeout-only — el rol dedicado se descartó)

**Hallazgo que cambió F2 (verificado contra código):** en producción el `AgentDeps` que recibe
`runOpencodeParallel` es el del **facade** (`index.ts:125/136` → `agentRuntime.facade().deps()`), cuyo
`open(agent)` hace `roleForLegacyAgent(agent) ?? "primary"` ([facades.ts:25](src/agent-runtime/facades.ts:25),
[types.ts:115](src/agent-runtime/types.ts:115)). Un nombre de agente nuevo `qa-planner` **no está** en
`LEGACY_AGENT_TO_ROLE` → cae a `"primary"` → `ROLE_TO_OPENCODE_AGENT["primary"]` = `qa-generator`. Es
decir: el rol `qa-planner` sería **inerte en producción** salvo que se toque el core provider-agnóstico
**y Codex**: la unión `AgentRole`, `ROLE_TO_OPENCODE_AGENT`, `LEGACY_AGENT_TO_ROLE`, las `assignments`
por rol y el `roleToAgent`/`sandbox` de Codex. El plan **no había dimensionado** ese blast radius —
es justo el cambio transversal que arriesga regresiones en el path dual, prohibido por la consigna.

**Lo implementado (timeout-only, sin riesgo de provider):**
1. `PLANNER_TIMEOUT_MS` (junto a [:837](src/integrations/opencode-client.ts:837)): default 120s vía
   `OPENCODE_PLANNER_TIMEOUT_MS`, con **lectura propia** (no `OPENCODE_TIMEOUT_MS || default`) → tiene
   **precedencia sobre el override global** (un planner colgado ya no consume la ventana del generador
   — la causa del hang→0 specs). Queda **< `EXPLORER_TIMEOUT_MS`** (240s) → el `Math.max` del dispatcher
   ([:1426](src/integrations/opencode-client.ts:1426)) ya lo cubre, sin tocarlo.
2. Call-site del planner ([opencode-client.ts:1137](src/integrations/opencode-client.ts:1137)): el
   `timeoutMs` se vuelve **brief-aware** — `input.contextBrief ? PLANNER_TIMEOUT_MS : agentTimeout(mode)`.
   El **rol sigue siendo `qa-generator`** (lo que el facade resuelve correctamente y tiene modelo
   asignado en single y dual). complete/exhaustive (sin brief) quedan **idénticos**.

**Lo descartado y por qué:** quitarle Playwright al planner (capacidad) exigía el rol dedicado +
plumbing transversal. Su valor (que el planner no pueda navegar) ya lo da **F3** (instrucción "do NOT
navigate or open a browser" en el prompt) y lo **acota** el timeout. La remoción de capacidad era
defensa-en-profundidad, no esencial; se cambió por cero riesgo de regresión en el core provider/Codex.
`roleWindowBytes`/`qa-planner.md`/`opencode.json` **no se tocan** (no hay rol nuevo).

**Tests:** dos tests nuevos en `opencode-client.test.ts` — planner con brief usa 120s; sin brief
mantiene `agentTimeout(mode)`.

### F3 — quitar la route-verification de diff **y** manual

**Archivos:** `src/integrations/prompts.ts` (244-249 diff, 321-325 manual; y el JSON-ejemplo `:200`/`:207`) · test `3.11(c)`.

**Cambios:** eliminar el bloque Lever-3 de **ambos** modos. El prompt de `qa-planner` (F2) nace sin él.
- **El localhost se resuelve aquí, sin tocar `playwright.config.ts`**: el `localhost:8080` del brief venía del planner haciendo `browser_navigate` sin baseUrl en su prompt. Sin navegación (Lever-3 fuera + `qa-planner` sin playwright) → no hay localhost. `config/e2e/playwright.config.ts:14` es para la **ejecución de specs** y recibe `PW_BASE_URL` del orchestrator ([:28](config/e2e/playwright.config.ts:28)) — **no se toca**.

**Por qué sin regresión:** depende de F1 (el grounding ya no depende de `verified`). El JSON-ejemplo con `"verified":true` ([:200/:207](src/integrations/prompts.ts:200)) es compartido por los 4 modos — es solo formato, no comportamiento; se actualiza por limpieza.

**Tests:** invertir el diff-half de `3.11(c)` ([:1908]) (ya no contiene Lever-3); el complete-half ([:1917]) se mantiene. **F1 y F3 viajan en el mismo commit** (split + prompt + tests juntos → nunca rojo a mitad).

### F4 — saneamiento de opencode.db (ortogonal)

**Archivos:** `agents/Dockerfile` · `agents/agent-supervisor.mjs`.
- **B1:** pinear `opencode-ai@<exacta>` **y** `@playwright/mcp@<exacta>` ([Dockerfile:29-30](agents/Dockerfile:29)) — invariante CLAUDE.md.
- **B3:** wipe one-shot al boot del supervisor (path `/root/.local/share/opencode/opencode.db*`, glob incluye `-wal`/`-shm`), antes del primer `ensureDesired()` ([:181](agents/agent-supervisor.mjs:181)), con flag module-level. **NO** en `startProvider` ([:98](agents/agent-supervisor.mjs:98), re-corre en crash-restart `:127`). Guard de container-restart: como los runs son secuenciales y un restart del container agents mid-run ya falla ese run, el wipe-at-boot es aceptable (documentar).
- **B2:** medir si la DB crece pese a `dispose`→`session.delete` ([:1616](src/integrations/opencode-client.ts:1616)); si crece, `VACUUM` (no delete-all); `cleanupOrphans` by-id ya existe ([:1626](src/integrations/opencode-client.ts:1626)).

## Orden de implementación

```
[ F1 + F3 ]  (un commit: captura per-objetivo + quitar route-verification + sus tests)  ← costura habilitante
      │
      ▼
[ F2 ]       (qa-planner + timeout; puede ir en el mismo commit que F3 o el siguiente)
      
[ F4 ]       (opencode.db; ortogonal, cualquier momento)
```

Cada commit deja `npm test` + `npm run typecheck` verdes. Tras F1+F3+F2: **run de validación sobre petclinic** — el planner debe resolverse rápido (sin navegar/re-explorar), el generador recibe el budget, y el fan-out debe groundear per-objetivo. Recién ahí la raíz está cerrada.

## Correcciones aplicadas vs el análisis anterior (trazabilidad)

- C6 reescrito: **una** impl (`render`), tres callers; solo el fan-out cambia (no "dos implementaciones").
- F1 acotado: el `render` **ya es per-ruta**; F1 es aditivo en `dom-snapshot.ts`, no un cambio de firma con 3 callers rotos.
- Costura β: `find_referencing_symbols` **no es toggle** → no-widen por prompt; solo Playwright se dropea por config.
- F1 en complete/exhaustive: reclasificado a **cambio de comportamiento + costo** (no solo costo); soft-404 mitigado dentro de F1.
- Localhost: **no** se arregla en `playwright.config.ts` (recibe `PW_BASE_URL`); se resuelve con F3 (planner deja de navegar).
- F2 desacoplado de F1 (lo habilita F3, no F1); `PLANNER_TIMEOUT_MS` necesita precedencia sobre el override global.
- C7: inventario de tests verificado (Phase-5(d), 3.11(c) diff-half; `960` no se rompe).
