# Panchito — Plan de optimización v2 (determinismo, calidad y performance)

> Derivado de **evidencia empírica directa**: 3+ corridas `exhaustive` contra Spring PetClinic
> Microservices + sondeo en vivo del DOM + inspección de la base de engram + cross-check con el
> análisis del agente paralelo (`aipipelineoptimizationplan.docx`).
>
> Objetivo (criterios del usuario, en orden): **(1)** corre de principio a fin sin fallos;
> **(2)** calidad óptima (sin outcomes mediocres/corruptos); **(3)** rápido y liviano sin sacrificar
> resultados; **(4)** no romper trabajo de otros agentes (el cliente Go / server-auth en paralelo).

---

## 0. Contexto: qué ya se arregló (para los revisores)

Estos NO son parte del plan a revisar — son el punto de partida ya consolidado (gate verde, 1030+ tests):

| Fix | Archivo | Efecto verificado |
|---|---|---|
| `e2e/flows/` garantizado antes del fan-out | `src/qa/setup.ts` | Los workers no podían escribir (0 specs); ahora el dir existe siempre |
| Oráculo corre en modos whole-suite (no solo diff) | `src/pipeline.ts:482` | Exhaustive/complete ahora puntúan el subset que pasa |
| `valueOracle: signal` en PetClinic | `config/apps/petclinic.yaml` | El oráculo realmente fluye |
| Reporte de valor: "off in shadow" → "enabled · no ground-truth" | `value-report.ts`, `cli.ts` | El reporte ya no contradice la config |
| Workers `flash` → `deepseek-v4-pro` + guía a11y inline | `agents/opencode.json`, `prompts.ts` | Reliability: 0-1 specs → 4-7 specs (validándose) |

---

## Marco de análisis (cómo elijo cada solución)

Tres filtros, aplicados a cada problema, en este orden:

1. **¿Es un problema real o un falso positivo?** — verificado contra el código y/o reproducido en vivo.
2. **¿La solución ataca la causa raíz o el síntoma?** — y ¿es determinista o depende del *compliance* del modelo?
3. **¿Respeta los 4 criterios?** — en particular, ¿NO regresa performance (criterio 3) ni rompe trabajo ajeno (criterio 4)?

Principio rector del repo (CLAUDE.md): **la infra determinista (`src/`) decide; el agente no-determinista (`agents/`) propone.** Toda mejora debe correr la frontera hacia el lado determinista, NO agregar otro proxy-LLM.

---

## PROBLEMA 1 — Calidad de selectores: el agente autorea "a ciegas" sobre la semántica HTML, no sobre el a11y tree real

### Evidencia (real, reproducido en vivo)
El spec generado `vets-list.spec.ts` falló en ejecución: `getByRole("columnheader", { name: /name/i })` → **timeout**. Sondeé la página viva con Playwright:
- Navegación OK (`#!/vets`), `h2 "Veterinarians"`, tabla con datos, **2 elementos `<th>`** presentes.
- **`getByRole("columnheader")` → 0 matches.** La tabla Bootstrap **no expone** el `<th>` como rol `columnheader` en el árbol de accesibilidad.
- El fix-loop single-agent (`pro`, **con** Playwright MCP) reescribió **el mismo selector** → no re-snapshoteó, parchó desde el texto del error.

### Causa raíz
Los agentes infieren roles ARIA del **tag HTML** (`<th>` ⇒ columnheader), pero el rol solo existe si está en el **accessibility tree vivo** — que CSS/Bootstrap/`display` alteran. El grounding de DOM existe **solo para el reviewer** (`pipeline.ts:991`), **no para el generador/workers**. Resultado: se escriben selectores plausibles-pero-falsos, el reviewer (que tampoco ve la página correcta por capturar solo rutas de `page.goto`) aprueba, y la ejecución falla.

### Solución: **grounding determinista de a11y, inyectado a TODOS los agentes de autoría**
1. Extender `RouteEntry` (context.json) con un campo `url` = la **URL navegable real** que el agente del context-mode ya determinó (ej. `/#!/vets`). *La especificidad de la app (prefijo hash, no la ruta Angular con params) vive en la DATA construida por el agente, NO en `src/`.*
2. El **orquestador** (determinista, Playwright) renderiza `baseUrl + route.url` para las rutas del objetivo, captura el **a11y snapshot** (reusa `dom-snapshot.ts` / `flattenAccessibilityTree`) y lo inyecta al prompt del generator **y de los workers**.
3. El prompt cambia de "explorá la página" a "acá está el a11y tree real; usá SOLO roles/nombres que aparecen acá".

### Por qué esta solución (proceso de análisis)
- **Determinista**: la captura la hace el orquestador con Playwright, no un modelo. El rol "columnheader=0" queda visible como hecho, no como inferencia.
- **Arregla calidad Y reliability Y determinismo de una**: el worker deja de gastar steps explorando (sink #1, ~20 steps) y escribe selectores correctos.
- **App-agnóstico en `src/`**: la URL navegable vive en el context.json (data del agente). El código solo hace `baseUrl + url`.
- **Descarté** "subir el step budget / mejor prompt de exploración": son palancas débiles (el `pro` con Playwright YA falló re-snapshoteando) — dependen del compliance, no resuelven la raíz.

### Riesgo / regresión
- Captura previa a la generación añade latencia, pero **reemplaza** N exploraciones de workers (más barato neto). Captura desktop-only, 1 browser, cap de rutas (`MAX_ROUTES`).
- Si el a11y snapshot falla (DEV caído) → degradar a exploración inline (comportamiento actual), nunca romper la corrida.

---

## PROBLEMA 2 — Engram: conocimiento de oro huérfano (scope mismatch + workers ciegos + step-burn)

### Evidencia (real, inspeccionado en `/data/engram.db`)
Engram **NO está vacío**: 21 observaciones de PetClinic de altísimo valor — `e2e/vet-list-radiology` (*"radiology aparece en MÚLTIPLES filas → selector ambiguo"* — **literalmente el gotcha que rompió mi spec**), `e2e/owner-form-validation` (*"required HTML5 impide submit vacío"*), `e2e/cleanup-strategy` (*"NO hay UI de Delete"*). Pero:
1. **Scope mismatch**: las 21 están bajo `project="spring-petclinic-microservices"` (repo-name auto-detectado del git remote), mientras la app es `petclinic` y el pipeline pasa `appName="petclinic"`. **0 observaciones bajo `petclinic`.** Ledger y context usan `petclinic`; engram usa el repo-name → no reconcilian.
2. **Workers sin engram**: `qa-worker` tiene `mcp=[serena, playwright]` SIN engram → en fan-out **nadie lee** esas lecciones.
3. **Step-burn**: en single-agent, el generator gastó ~15 steps en engram (búsquedas que floundearon en una app entonces vacía → retry → goal drift).

### Causa raíz
El conocimiento se ACUMULA pero no se CONSUME donde hace falta, por tres razones independientes (scope, ausencia de engram en workers, indisciplina en single-agent).

### Solución: **retrieval amortizado por el planner (fan-out) + disciplina inline (single-agent) + fix de scope**
- **Fan-out**: el **planner** (`qa-generator` Fase 1, que YA corre y YA tiene engram) hace **una** query semántica focalizada y **siembra los facts relevantes en el brief de cada objetivo**. 1 retrieval → 13 workers. Los workers reciben los facts en el prompt (no necesitan engram).
- **Single-agent (manual/diff)**: NO sesión nueva. Solo **disciplina inline** — presupuesto a la query (`máx 2-3 búsquedas focalizadas`, no 15).
- **Scope**: unificar el `project` key (app-name) para engram, ledger y context. El planner corre en el cwd correcto; pasar el `appName` explícito a engram.

### Por qué esta solución (proceso de análisis — incluye una autocorrección)
- Primero propuse "estructurar los facts en context.json (tag por ruta) y que el orquestador haga match determinista". **Lo descarté**: castra el valor de engram (lo reduce a una columna SQLite). El valor de engram es *un agente usando su criterio semántico sobre todo el contexto*.
- Después consideré "una sub-sesión de retrieval". **Riesgo identificado**: si hace las mismas 15 llamadas, **no optimizás — falseás la métrica de steps** (relocás el costo + agregás overhead de system prompt).
- **Conclusión**: separar ≠ optimizar. Lo que optimiza es **amortización** (1 retrieval para N consumidores) **+ disciplina** (query focalizada). La amortización solo existe en fan-out, y ahí **no hace falta sesión nueva**: el planner ya corre. En single-agent (1 consumidor) no hay a quién amortizar → solo disciplina.
- Las "15 llamadas" no son inherentes a engram — eran floundering en app vacía. Con engram rico + query focalizada son 2-3.

### Riesgo / regresión
- Si se le saca engram al generator (ver Problema 4), hay que reasignar el **guardado** explícitamente (no al `qa-reflector`, que es tool-less). Sin dueño del write, el volante deja de cargarse.
- El fix de scope debe ser retro-compatible con las 21 obs ya guardadas (migrar o aliasar el project key).

---

## PROBLEMA 3 — Solapamiento de responsabilidades Ledger vs Engram

### Evidencia
Ambos guardan "lecciones de corridas pasadas". `e2e/cleanup-strategy` (engram) y una regla `E-NO-CLEANUP` (ledger) cubren lo mismo, con scopes distintos. `retrieval.ts` confirma que el ledger es independiente de engram (lee `listLearningRules` de SQLite, sin imports de engram).

### Solución: **separación de responsabilidad explícita**
- **Ledger** = reglas de **CALIDAD gobernadas** (qué hace bueno/malo un test; promovidas por oráculo/prevención). Determinista. Ya llega a todos vía `learnedRules`.
- **Engram** = **FACTS de cómo manejar la app** (rutas, auth, "radiology en 2 filas", "sin Delete UI"). Memoria semántica de operación, no reglas de calidad.
- Mismo `project` key, mismo patrón retrieval→inject, ambos llegando a workers.

### Por qué (análisis)
La duplicación genera ruido, scopes divergentes y doble mantenimiento. La línea natural es **calidad (gobernada, determinista) vs operación (facts, semántica)**. No se elimina engram; se le da un rol nítido.

### Riesgo
Bajo — es clarificación de responsabilidad, no borrado. Cuidar no romper el flujo de distillación del ledger.

---

## PROBLEMA 4 — Tool-gating + disciplina del generator (anti goal-drift)

### Evidencia
`qa-generator`: `mcp=[serena, engram, playwright]`, `steps:50`, procedimiento de 7 pasos donde escribir es el Paso 3 pero engram (Paso 1 + 7) y exploración (Paso 2, "MANDATORY", sin límite) consumen el presupuesto antes. El agente paralelo observó 50 steps → 0 specs.

### Solución
- Con el grounding (P1) + facts sembrados por el planner (P2), **sacar engram del `qa-generator`** (tool-gating estructural) **y** reasignar el guardado a un dueño explícito.
- Reformular Paso 2 con límites cuantitativos (ya hecho parcialmente en el worker prompt).

### Por qué (análisis)
Tool-gating es *harness-level enforcement* (Anthropic/OpenAI best practice): es físicamente imposible gastar steps en una herramienta que no tenés. Más fiable que pedirle al modelo "usá engram con moderación". Pero **solo es válido si el read (facts) y el write (guardado) se cubren en otro lado** — por eso depende de P1+P2.

### Riesgo
**Alto si se hace aislado** — perdés el guardado de engram (el doc del agente paralelo cae en esto: delega al reflector que es tool-less). Hacer SOLO junto con P2 (dueño del write definido).

---

## PROBLEMA 5 — Performance: context map + analysis se reconstruyen cada corrida (~195s)

### Evidencia
Cada corrida: context bootstrap ~195s (agente reconstruye el mapa) porque el mirror se hace `git clean` y borra `e2e/.qa/context.json`. En shadow nunca se publica → se reconstruye siempre. Corridas totales ~20 min.

### Solución: **cache persistente del context map (y analysis) en `qa-data`, keyed por app + sha**
- Tras construir un mapa válido, cachearlo en el volumen persistente `qa-data`.
- Antes del bootstrap: si el cache existe y **no está stale** (`isContextStale`, sha dentro del umbral), restaurarlo al mirror → saltear el rebuild del agente.

### Por qué (análisis)
- Determinista, unit-testeable (lógica de cache + staleness), fail-safe (si el cache está mal, el validador lo detecta y reconstruye).
- Sirve criterio 3 directamente y **acelera cada iteración futura** (~195s/corrida).
- **Descarté** las propuestas del doc paralelo de subir `steps 50→75` y `compaction 16K→24K`: **REGRESAN** performance (más steps permitidos = más lento; más contexto preservado = más tokens/step). Además `75 steps × 7.8s ≈ 585s` roza el timeout de 600s → nuevo modo de falla.

### Riesgo
Bajo — cache con invalidación por staleness; degradación segura a rebuild.

---

## PROBLEMA 6 — Determinismo / failsafe de harness

### Evidencia
El límite de `steps` es global, no por fase; funciona como corta-loops pero no como guía. Sin checkpoint intermedio, un agente atascado gasta todo el presupuesto.

### Solución
- **Watchdog SSE**: el `ActivityRouter` ya recibe eventos en tiempo real. Agregar un watchdog que, si no detecta evento `file` en N min, advierta/aborte (harness-level, no depende del compliance).
- **Habilitar el explorer existente en modo manual** (`maybeExplore:505`, ~5 líneas): aísla la exploración en el `flash` barato sin reescribir `runOpencode`.

### Por qué (análisis)
Son las únicas dos ideas del doc paralelo que son *harness-level* (no prompt-level) y de bajo costo. El watchdog es defensa en profundidad real. El explorer-en-manual reusa un patrón que YA existe.

### Riesgo
Bajo. El watchdog debe distinguir "lento legítimo" de "atascado" (umbral conservador, primero warn antes de abort).

---

## Lo que EXPLÍCITAMENTE rechazo (y por qué)

| Propuesta (del doc paralelo o mía inicial) | Por qué se rechaza |
|---|---|
| Subir `steps 50→75` (manual) | Más lento (criterio 3) + roza el timeout de 600s → nuevo modo de falla |
| `compaction 16K→24K` | Más tokens/step (criterio 3); el efecto "destructivo" que justifica subirlo es especulativo, sin evidencia en la corrida |
| Salida A: facts estructurados (tag por ruta) en context.json para match determinista | Castra el valor de engram (lo reduce a columna SQLite); pierde el criterio semántico del agente |
| Sub-sesión de engram en single-agent | Metric-gaming: relocás 15 steps + agregás overhead, sin amortizar (1 solo consumidor) |
| Opción A completa (reescribir `runOpencode` en 3 sesiones) | Alto riesgo/complejidad; en exhaustive la arquitectura YA es multi-sesión. Último recurso, solo si P1-P6 no bastan (gate: drift >30% en 5-10 corridas) |

---

## Secuenciación recomendada (por ROI y dependencias)

| Fase | Cambios | Criterio que ataca | Riesgo |
|---|---|---|---|
| **A — Calidad (raíz)** | P1 grounding a11y determinista | 1, 2 | Medio |
| **B — Conocimiento** | P2 (planner siembra facts + fix scope) → habilita P4 (tool-gate engram con dueño del write) + P3 (separación de roles) | 2 | Medio (P4 solo junto a P2) |
| **C — Performance** | P5 cache de context/analysis | 3 | Bajo |
| **D — Failsafe** | P6 watchdog SSE + explorer en manual | 1, 3 | Bajo |
| **E — Último recurso** | Opción A multi-sesión completa | 1, 2 | Alto — solo si A-D no bastan |

**Validación entre fases**: tras cada fase, gate verde (`npm test` + `typecheck`) **y** una corrida `exhaustive` contra PetClinic, comparando: specs escritos, specs que pasan ejecución, valueScore del oráculo, y tiempo total. No avanzar de fase sin una corrida que confirme la mejora.

**Criterio 4 (trabajo ajeno)**: todos los cambios viven en `src/` (pipeline, dom-snapshot, setup), `agents/` (opencode.json, prompts) y `config/`. El agente paralelo trabaja `client/` (Go) + `src/server/auth.*`. Cero solapamiento de archivos salvo `agents/opencode.json` — coordinar el merge ahí.
