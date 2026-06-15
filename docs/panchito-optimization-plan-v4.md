# Panchito — Plan de optimización v4 (DEFINITIVO: la arquitectura "Ground Truth")

> Construido tras 5 iteraciones reales contra Spring PetClinic + sondeos en vivo del DOM + 2 rondas
> de revisión adversarial (judgment-day) + auditoría de 3 agentes. **No es una lista de parches: es
> un cambio de arquitectura con UNA tesis.** Toda afirmación está marcada como **[verificado]** (probado
> contra el código o la app viva) o **[riesgo]** (hipótesis honesta).

---

## 1. La causa raíz ÚNICA (la tesis)

**Cada fallo de las 5 iteraciones es la MISMA causa: el agente escribe selectores/rutas/navegación
contra sus SUPOSICIONES sobre la app, y NO existe un gate DETERMINISTA que verifique esas suposiciones
contra la app viva antes de shippear.** El único control es el reviewer (otro LLM), que (a) también
adivina, (b) estaba ciego a tablas.

Evidencia **[verificado]** — todos los fallos son "el spec referencia algo que no existe":

| Fallo observado | Lo que el agente asumió | La realidad (sondeada en vivo) |
|---|---|---|
| `getByRole('columnheader',{name:'Name'})` timeout | `<th>` ⇒ rol columnheader | la tabla Bootstrap NO expone columnheader |
| `getByRole('heading',{name:'Owners'})` timeout × 7 | se llega a Owners por un nav "Owners" | el nav real es "FIND OWNERS" / "REGISTER OWNER" — no hay link "Owners" |
| strict-mode: 2-3 elementos | el nombre es único | "radiology"/"Add Visit" aparecen N veces |
| "Missing DEV_TEST_USER/PASS" | la app tiene login | PetClinic es pública, sin auth |

## 2. Por qué venimos en círculos (y por qué esto es distinto)

Las 5 iteraciones intentaron **darle MEJOR INFORMACIÓN al agente** (nudge de prompt, DOM al reviewer,
modelo `pro`, DOM a la regeneración). **No funcionó, y no va a funcionar, por una razón comprobada
[verificado]:** el agente **YA TIENE el DOM** (saca su propio `browser_snapshot` con su Playwright MCP)
**y aun así escribe `columnheader`** — confía en su intuición de HTML por encima de la verdad que tiene
enfrente. **No se puede arreglar un problema de criterio-de-LLM con más información ni con un modelo
más caro.** (Prueba: `pro` falló igual que `flash`, solo que costó 30% de la cuota mensual en un día.)

**La única solución durable: SACAR el criterio de donde el determinismo es posible.** Es la filosofía
del propio repo (CLAUDE.md: "src/ determinista DECIDE; el agente PROPONE") aplicada al punto que falta.

## 3. La pieza clave (keystone): un gate DETERMINISTA de "realidad de selectores"

Hoy la cadena de calidad es **circular** (un LLM escribe, otro LLM revisa). Falta un eslabón
determinista — igual que `change-coverage` es el eslabón anti-Goodhart. **El keystone nuevo:**

> Antes de ejecutar, el orquestador —por CÓDIGO, sin LLM— parsea cada localizador del spec
> (`getByRole`, `getByText`, `getByLabel`, `goto`, clicks por nombre) y lo verifica contra un
> **árbol de accesibilidad capturado de la app viva**. Un localizador que matchea **0** (rol/nombre
> inexistente, link de nav inexistente) o que es **ambiguo** (nombre duplicado sin scope) → RECHAZA
> con el mismatch EXACTO → fix-loop. Determinista: **no puede pasar en silencio** un selector
> alucinado, a diferencia del reviewer-LLM.

- **[verificado]** los fallos (columnheader, nav "Owners", duplicados) son detectables como
  "rol+nombre no existe en el árbol capturado" / "nombre aparece N>1 veces". Lo confirmé sondeando.
- **[riesgo]** el parseo es por regex sobre los patrones que los agentes usan (`getByRole("x",{name:"y"})`,
  `goto("...")`, `getByText(...)`). Selectores **dinámicos/computados** (`getByRole(role, {name: variable})`)
  no se pueden chequear estáticamente → se **saltean** (nunca se rechaza por falsa alarma). Honesto: el
  gate cubre el ~80% de los patrones (los que fallan hoy), no el 100%.
- **[riesgo]** *qué ruta aplica a cada localizador.* v1 del gate chequea contra la UNIÓN de árboles de
  todas las rutas capturadas ("¿existe este rol+nombre en ALGUNA página?"). Captura la clase
  "alucinado" (columnheader no existe en ninguna página → rechaza). No captura "selector correcto,
  página equivocada" (más raro) → v2 modela la navegación. Empezamos por v1 (alto valor, factible).

## 4. Las piezas de soporte (alimentan el keystone y reducen los fix-loops)

**P1 — Capturar el "Mapa de Realidad de la App" UNA vez (determinista, orquestador).**
- Por cada ruta: el árbol a11y curado (roles + nombres, **duplicados marcados**) + la **estructura de
  navegación global** (nombres reales de los links del nav → a dónde van). *El nav es parte del
  ground-truth — fue el dato faltante de los 7 fallos de Owners.*
- **[riesgo / decisión]** las URLs navegables (prefijo hash `#!`, params concretos `/owners/1`) las
  provee el **context-builder** (el agente que YA mapea la app) como DATA en `context.json.url` por
  ruta. `src/` solo concatena+navega+captura: **cero app-specific en código.** Para rutas con params,
  el context-builder guarda un ejemplo concreto navegable. Reusa `flattenAccessibilityTree` (ya
  arreglado para tablas) + el subproceso `render`.

**P2 — Alimentar el ground-truth a los AUTORES (planner + workers), no solo al gate.**
- El **planner** (fuerte, corre 1 vez) recibe el Mapa y pre-decide en cada brief: la ruta navegable
  real, los selectores candidatos (del árbol), las advertencias de duplicados, los facts de la app.
- Los **workers** reciben el slice de su flow → **ensamblan** (no exploran, no adivinan).
- **[verificado, audit]** hoy ni el `domSnapshot` ni el `contextMap` llegan a los workers; el planner
  ignora el `contextMap`. (El #2 del audit ya cableó el `contextMap` al planner; falta el DOM/nav.)

**P3 — Facts de la app inyectados** (de engram/context vía el brief): "app pública (sin auth)",
"sin UI de Delete", "X aparece en N filas". Arregla el fallo de `authenticate` en app pública.
- **[verificado]** engram ya tiene estos facts (21 obs), pero huérfanos por el mismatch de scope
  (repo-name vs app-name) — hay que resolver la precedencia del MCP de engram primero (audit #6).

**P4 — Worker = ensamblador barato → revertir a `flash`.**
- **Solo DESPUÉS** de P1-P3 (con la carga de criterio ya quitada). Al revés reabre el fallo de iter 2
  (flash no escribía). Resuelve costo (criterio 3) sin sacrificar calidad.

## 5. Secuenciación (cada fase se valida con UNA corrida real antes de avanzar)

| Fase | Entrega | Se valida con | Métrica de éxito |
|---|---|---|---|
| **0** ✅ | static-repair loop (hecho) | iter 4 | cruzó el gate estático |
| **1** | P1: Mapa de Realidad (a11y + nav, capturado 1 vez) | inspección del artefacto | captura `/vets`, `/owners`, nav real |
| **2** | **KEYSTONE: gate determinista de selectores** | corrida: ¿rechaza columnheader/nav ANTES de ejecutar? | los fallos conocidos se atajan pre-ejecución, con el mismatch exacto |
| **3** | P2: ground-truth a planner + workers | corrida | specs nacen con selectores reales; menos fix-loops |
| **4** | P3: facts de la app (+ fix scope engram) | corrida | desaparece el fallo de auth |
| **5** | P4: revertir workers a flash | corrida | misma calidad, costo ↓↓ |

**Regla de oro contra los círculos:** no se avanza de fase sin una corrida que **mida** la mejora
(specs que PASAN ejecución, no escritos; costo por corrida). Si una fase no mueve la métrica, se
revisa la hipótesis ANTES de seguir — no se apila otro parche encima.

## 6. Honestidad: qué NO promete este plan

- **[riesgo]** el gate determinista cubre selectores estáticos (~80% de los patrones), no dinámicos.
- **[riesgo]** la captura del Mapa depende de que el context-builder provea URLs navegables; si las
  da mal, el gate captura la página equivocada (degradación, no falso-rechazo).
- **[riesgo]** P4 (revertir a flash) es la apuesta de costo; si tras P1-P3 flash aún falla, se queda
  en un tier medio (no `pro`), no se vuelve a `pro`.
- Esto **no** vuelve la generación 100% determinista — el agente sigue escribiendo aserciones con
  criterio. Pero **mueve la corrección de selectores/navegación de "criterio de LLM" a "gate de
  código"**, que es exactamente la clase de fallo que hace que "la app sea una basura" hoy.

## 7. Costo (criterio 3, que se ignoró hasta ahora)

- **Causa del gasto:** N workers `pro` × exploración con browser × fix-loops. **El plan ataca las 3.**
- **Ahorro esperado:** P1 captura el DOM 1 vez (no N browsers de workers) · P2/keystone ataja errores
  pre-ejecución (menos fix-loops caros) · P4 baja el modelo de los workers. La corrida pasa de
  "13 `pro` adivinando + reintentando" a "1 captura + 13 `flash` ensamblando + 1 gate de código".
- **Mientras tanto:** corridas exhaustive `pro` PARADAS hasta tener P1+P2. No se quema más cuota
  validando una arquitectura que sabemos que falla.

## 8. Respeto al trabajo ajeno (criterio 4)

Todo en `src/` (pipeline, dom-snapshot, validate, un nuevo `selector-gate`), `agents/` (prompts,
opencode.json), `config/`. El agente paralelo trabaja `client/` (Go) + `src/server/auth.*`. Único
archivo compartido: `agents/opencode.json` (coordinar el merge del cambio de modelo de workers).
