# Panchito — Plan de optimización v3 (DEFINITIVO, post-juicio adversarial)

> v3 corrige v2 con los hallazgos confirmados de la revisión adversarial (2 jueces ciegos +
> verificación propia contra el código). Cambios de fondo vs v2 marcados con **[Δv3]**.
>
> Orden de criterios del usuario: **(1)** corre sin fallos; **(2)** calidad óptima; **(3)** rápido/liviano;
> **(4)** no romper trabajo ajeno (cliente Go / server-auth en paralelo).
> Invariante (CLAUDE.md): `src/` determinista DECIDE; `agents/` no-determinista PROPONE; nada app-específico en `src/`.

---

## [Δv3] Corrección de marco: la "mejora de reliability" de v2 NO es una victoria todavía

v2 anotó "0-1 specs → 4-7 specs" como ganado. **Falso a nivel veredicto.** La última corrida terminó
**INVALID / E-STATIC**: los 7 specs **fallaron el gate estático** (`tsc` + eslint + `playwright --list`,
`src/qa/validate.ts:108`) y **nunca ejecutaron**. Implica:
- El blocker real HOY es **compile/lint**, no los selectores a11y.
- La hipótesis de P1 (selectores a11y, E-EXEC-FAIL) sigue **SIN validar** — los specs no llegaron a ejecutar.
- "Escribir más specs" sin que pasen Filter B no aporta valor (criterio 2).

---

## PROBLEMA 0 [Δv3 NUEVO] — Specs fallan el gate estático (E-STATIC)

### Evidencia (corrida real, verdict INVALID)
7 specs escritos, todos rechazados por `validate.ts` (tsc/eslint/playwright --list). `E-STATIC` es clase
reconocida (`taxonomy.ts:14`). Reviewer marcó además: `nav.spec` asume `/#!/welcome$` (el home vivo está en `/`),
`backend-validation` acoplado a `window.alert()`, `vet-list` con dead code.

### Causa raíz
El worker (incluso `pro`) produce TS/imports/aserciones que no pasan el gate estático. No hay **check
estático dentro del presupuesto del worker** — el worker reporta "spec escrito" sin verificar que compile.

### Solución
- El worker corre **`tsc --noEmit` + eslint sobre SU único archivo** antes de reportarlo (ya tiene `bash:false`
  → exponer un check vía el harness, o darle el comando). Si falla, se auto-corrige dentro de su budget.
- Alternativa/complemento determinista: el orquestador hace un **check estático por-spec barato ANTES** del
  execute caro, y devuelve el error al worker/fix-loop con el mensaje exacto.

### Por qué (análisis)
Es la falla **empíricamente bloqueante AHORA**. Atacar selectores (P1, fase de ejecución) antes que compile
(fase estática) invierte el ROI — los selectores son irrelevantes si el spec ni compila. Determinista (tsc/eslint
son deterministas).

### Riesgo
Bajo. Un `tsc` por-archivo es rápido; el gate ya existe, solo se adelanta/per-spec.

---

## PROBLEMA 1 [Δv3 corregido] — Selectores autoreados a ciegas sobre semántica HTML, no sobre el a11y tree

### Evidencia
`getByRole("columnheader")` → 0 matches en vivo sobre `<th>` real (tabla Bootstrap). El grounding de DOM existe
solo para el reviewer (`pipeline.ts:991`), no para generator/workers.

### [Δv3] Solución CORREGIDA
1. **Extender `flattenAccessibilityTree` (dom-snapshot.ts:105)** — su `keep` actual
   `[link,button,heading,textbox,combobox,checkbox,radio,tab,menuitem,option]` **DESCARTA `columnheader,row,cell,
   rowheader,table,grid,list,listitem`** → justo la familia que rompió el spec. **[Δv3: v2 decía "reusar"; era el bug.]**
   Agregar esos roles AND emitir explícitamente "roles esperados AUSENTES" (ej: "table presente pero SIN columnheader →
   no uses getByRole(columnheader)").
2. **Nuevo entry point `captureRoutes(urls[])`** [Δv3] — pre-generación, keyed por `context.json.url`. Reusa SOLO el
   subproceso `render` + `flattenAccessibilityTree` extendido. **NO** `captureDom`/`extractTargetRoutes` (esos son
   spec-driven/post-gen: regexean `page.goto` de specs ya escritos — no sirven antes de generar).
3. El orquestador inyecta ese snapshot al prompt del generator **y workers**: "usá SOLO roles/nombres que aparecen acá".

### [Δv3] Determinismo-boundary (endurecido)
- Extender `RouteEntry` con `url` = URL **completamente resuelta y navegable** (params concretos, ej `/#!/owners/3`,
  NO `/#!/owners/:id`). La especificidad (prefijo hash, id concreto) vive en la DATA del agente.
- **`src/` hace SOLO concatenación `baseUrl + url`, NUNCA sustitución de params.** El orquestador **saltea/marca**
  cualquier `url` que aún contenga `:` o `{}` (no renderea página muerta). [Δv3: cierra el hueco de rutas parametrizadas.]

### Por qué (análisis)
Determinista (captura por Playwright, no por modelo). El `pro` con Playwright YA falló re-snapshoteando → palanca
de prompt es débil; el grounding fuerza el hecho. App-agnóstico en `src/` (concatenación pura).

### Riesgo
Captura previa añade latencia pero reemplaza N exploraciones de workers. Degradar a exploración inline si DEV cae.

---

## PROBLEMA 2 [Δv3 corregido] — Conocimiento de engram huérfano + sin llegar a workers

### Evidencia
21 lecciones de oro bajo `project="spring-petclinic-microservices"`, 0 bajo `petclinic`. Workers sin engram en su MCP.

### [Δv3] Solución CORREGIDA — honesta sobre qué es determinista y qué no
- **Scope (verificar PRIMERO la causa raíz):** [Δv3] `prompts.ts:323` **YA** instruye `project="${appName}"` (=petclinic)
  — pero solo en `buildPrompt` (generación), NO en `buildPlanPrompt`. Y las obs igual cayeron bajo el repo-name →
  el MCP de engram **auto-deriva el project del cwd** (`mem_current_project` / `session_project_directory_mismatch`)
  y **override-ea el param explícito**. **El fix de v2 ("pasar appName") es no-op.** El fix real es engram-MCP-side:
  setear `ENGRAM_PROJECT`/equivalente, o alinear cwd↔app-name, o migrar/aliasar el project key. **Verificar la
  precedencia antes de tocar nada.**
- **Llegar a workers (fan-out):** el planner hace **una** query engram y siembra facts. PERO [Δv3]:
  - `buildPlanPrompt` **no tiene instrucción de engram** → hay que **agregarla** (no existe hoy).
  - `ExplorationBrief` no tiene campo de facts libres dedicado; usar `risks[]`/`notes` (existen) o agregar `facts:string[]`
    + actualizar `coerceExplorationBrief` + el renderer. **No es "tweak", es cambio de schema + prompt.**
  - **[Δv3] Honestidad sobre el determinismo:** el *cableado* planner→worker brief es determinista
    (`runOpencodeParallel` copia `o.brief`→`w.brief`); el *contenido* (que el planner realmente consulte engram y
    embeba facts) es **dependiente del modelo, sin enforcement**. Re-etiquetar como **"plumbing determinista sobre
    contenido producido por el modelo"**, no "inyección determinista".

### Por qué (análisis — con autocorrección de v2)
- Descarté "estructurar facts en context.json con match por tag determinista" (castra el valor semántico de engram).
- Descarté "sub-sesión de retrieval en single-agent" (metric-gaming: relocás steps + overhead sin amortizar).
- En fan-out hay amortización real (1 retrieval → N workers) reusando el planner que ya corre — pero [Δv3] **cuesta un
  cambio de schema+prompt, no es gratis**, y su garantía es "el modelo coopera", no estructural.

### [Δv3] Riesgo / dependencia corregida
- El fix de scope puede no aterrizar si no se verifica la precedencia del MCP primero.
- **Dueño del write SIN definir** (ver P4): P2 entrega *read* (facts→briefs); NO garantiza el *write*. La dependencia
  "P4 solo con P2" de v2 es insuficiente.

---

## PROBLEMA 3 — Solapamiento Ledger vs Engram (sin cambios respecto a v2)
Ledger = reglas de CALIDAD gobernadas (ya llega a todos). Engram = FACTS de operación de la app. Mismo project key,
mismo patrón retrieval→inject. Bajo riesgo (clarificación, no borrado). Verificado: ledger independiente de engram
(`retrieval.ts`→SQLite, sin imports).

---

## PROBLEMA 4 [Δv3 corregido] — Tool-gating engram del generator

### [Δv3] Solución con dueño del write EXPLÍCITO (no TODO)
- Sacar engram del `qa-generator` **solo si** existe un **dueño del write nombrado**. Opciones concretas:
  (a) mantener `mem_save` en el **planner** (que conserva engram), o (b) un **paso post-run dedicado con MCP engram**
  (NO el `qa-reflector`, que es tool-less — confirmado). **[Δv3: v2 dejaba esto como riesgo; ahora es criterio de
  aceptación de la Fase B, gateado antes de des-herramientar el generator.]**
- Gatear P4 sobre **fact-presence observado en briefs en varias corridas**, no sobre "el mecanismo existe".

### Por qué
Tool-gating es enforcement de harness (fiable), PERO solo válido si read (P1+P2) y **write (dueño nombrado)** están
cubiertos. Sin dueño → el volante de engram deja de cargarse en silencio.

---

## PROBLEMA 5 [Δv3 corregido] — Performance: rebuild del context map (~195s/corrida)

### [Δv3] Solución con cache key corregida
Cachear el context map válido en `qa-data`, **keyed por `app`** (NO `app+sha`) [Δv3], restaurándolo **si
`isContextStale` lo da fresco** (tolera N commits atrás). Key por sha exacto fallaría en cada commit nuevo → el cache
solo serviría para re-runs del mismo sha (raro fuera del loop de validación shadow).

### Por qué
Determinista, unit-testeable, fail-safe (cache malo → el validador reconstruye). Acelera cada iteración futura.
Rechazos de v2 (steps 50→75, compaction 16→24K) se mantienen.

---

## PROBLEMA 6 [Δv3 corregido] — Failsafe de harness

### [Δv3] explorer-en-manual: DEGRADADO/quitado
v2 lo listaba como fix. **[Δv3] Es ORTOGONAL**: las corridas que fallan son `exhaustive`, que tiene su propio planner
y **nunca llama `maybeExplore`** (gateado a `mode==="diff"`, opencode-client.ts:505). No compra nada para la evidencia.
→ **Quitar del plan** (o etiquetar como hardening no-relacionado, no como fix de PetClinic).

### Watchdog SSE (se mantiene)
`ActivityRouter` ya recibe eventos. Watchdog: sin evento `file` en N min → warn→abort. Harness-level, no depende del
compliance. Umbral conservador (warn antes de abort).

---

## [Δv3] Rechazos (corregidos)

| Propuesta | Por qué se rechaza [Δv3 = razonamiento corregido] |
|---|---|
| Steps 50→75 | Palanca débil. **[Δv3]** El "roza 600s" de v2 era **mode-confuso**: 600s es solo `manual`; las corridas que fallan son `exhaustive` (1500s) y los **workers tienen `steps:30`**, no 50→75. La conclusión (no subir steps) se mantiene; el razonamiento se corrige. |
| compaction 16K→24K | Más tokens/step (criterio 3); efecto "destructivo" especulativo. (Confirmado `preserve_recent_tokens:16000`.) |
| Salida A (facts tag-eados en context.json) | Castra el valor semántico de engram. |
| Sub-sesión engram en single-agent | Metric-gaming sin amortización. |
| Opción A completa (3 sesiones) | Alto riesgo; exhaustive ya es multi-sesión. Último recurso (gate: drift >30% en 5-10 corridas). |

---

## [Δv3] Secuenciación DEFINITIVA (reordenada por ROI empírico)

| Fase | Cambios | Ataca | Por qué este orden |
|---|---|---|---|
| **0 — Estático** | P0: check `tsc`/eslint por-spec dentro del budget del worker | criterio 1 | **Es el blocker AHORA** (E-STATIC). Sin esto, nada ejecuta. |
| **A — Calidad** | P1 grounding a11y (con `flattenAccessibilityTree` extendido + `captureRoutes` nuevo + urls resueltas) | 1, 2 | Recién acá importan los selectores (post-estático). |
| **B — Conocimiento** | P2 (verificar precedencia de scope del MCP → fix engram-side; schema brief + prompt planner) → P4 (tool-gate **con dueño del write nombrado**) + P3 | 2 | P4 gateado por read(P2)+write(dueño). |
| **C — Performance** | P5 cache de context (key por `app`+staleness) | 3 | Independiente; acelera iteraciones. |
| **D — Failsafe** | P6 watchdog SSE (explorer-en-manual QUITADO) | 1, 3 | Bajo riesgo. |
| **E — Último recurso** | Opción A multi-sesión | 1, 2 | Solo si 0-D no bastan. |

**Validación entre fases (corregida):** gate verde (`npm test`+`typecheck`) **y** corrida `exhaustive` contra PetClinic
que **cruce Filter B (estático) y EJECUTE**, comparando: specs que **pasan ejecución** (no solo escritos), valueScore del
oráculo, tiempo total. **[Δv3] Checklist concreto de regresión** (de los bugs que marcó el reviewer): nav no asume
`/#!/welcome`; sin acople a `window.alert()`; sin dead code.

**Criterio 4:** cambios en `src/` (pipeline, dom-snapshot, setup, validate), `agents/` (opencode.json, prompts), `config/`.
El agente paralelo trabaja `client/` (Go) + `src/server/auth.*`. Único archivo compartido: `agents/opencode.json` → coordinar merge.

**[Δv3] Pendiente de verificar antes de implementar (no asumido):**
1. ¿El MCP de engram override-ea `project` desde el cwd? (decide si el fix de scope es engram-side).
2. ¿`buildPlanPrompt` puede llevar la instrucción de engram sin inflar/confundir el plan?
3. Reconciliar nombre del reviewer (CLAUDE.md `qwen3.7-max` vs `opencode.json` `minimax-m3`).
