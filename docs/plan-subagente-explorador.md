# Plan — Subagente explorador con destilado aislado

> Estado: **propuesta de diseño** (no implementado). Tema #4 del análisis de higiene de
> contexto. Dual-runtime (OpenCode + Codex) por construcción.

## 1. El problema

Hoy, en el **path single-agent de `diff`** (el default y el fallback de `<2` objetivos),
el generador hace dos cosas en la **misma ventana de contexto**: explora (cuerpos de
símbolos vía Serena, snapshots de DOM, requests de red, contratos OpenAPI) **y** escribe
el test. Todo lo que devuelve la exploración se acumula y compite por el espacio que el
modelo necesita para razonar sobre el spec. Contexto sucio = menos tokens para la tarea
real, y la exploración no es reutilizable ni cacheable.

La tesis de #4: **la exploración read-heavy va en una sesión aislada que devuelve la
conclusión destilada, no el volcado.** Quien escribe el test recibe el destilado limpio.
Mejora calidad por dos vías: ventana limpia para razonar, y un brief reutilizable.

## 2. Qué ya existe (no reinventar)

El patrón ya está construido **a medias** en el path de fan-out
([`runOpencodeParallel`](../src/integrations/opencode-client.ts)):

- **Fase 1 (PLAN):** un `qa-generator` fuerte explora el repo y devuelve objetivos
  estructurados, cada uno con `symbols` (blast radius).
- **Fase 2 (FAN-OUT):** cada objetivo va a un `qa-worker` con ventana limpia para UN spec.

El transcript del planner **no** contamina a los workers. **Dos gaps** frente a #4:

1. **Solo aplica en fan-out.** El path single-agent de `diff` (el más común) explora y
   escribe en la misma ventana.
2. **El destilado es superficial.** El planner pasa **nombres de símbolos**; el worker
   después **re-lee los cuerpos** y **re-navega el DOM**. El trabajo caro se repite por
   worker en vez de destilarse-una-vez.

Conclusión: #4 no es "agregar el mecanismo" — es **profundizar el destilado** y
**extenderlo al path single-agent**.

## 3. Diseño propuesto

### 3.1 El explorador es un ROL read-only en el abstraction layer

No es un subagente OpenCode-específico: es un **rol nuevo** en
[`AgentRole`](../src/agent-runtime/types.ts), análogo al `reflector` que ya existe. Así
**ambos runtimes** lo obtienen vía el strategy pattern, sin lógica duplicada.

| Pieza | OpenCode | Codex |
|---|---|---|
| Capacidad | `tools.write: false` en `opencode.json` | `--sandbox read-only` (automático: el rol entra en `READ_ONLY_ROLES`) |
| Prompt | `agents/agent/qa-explorer.md` + registro en `agents/opencode.json` | `agent/roles/qa-explorer.md` (vía `withCodexRolePreamble`) |
| Mapeo de rol | `ROLE_TO_OPENCODE_AGENT.explorer = "qa-explorer"` | `rolePromptName(explorer) → "qa-explorer"` |

Read-only sale **gratis** del modelo de capacidades existente
([`capabilitiesForRole`](../src/agent-runtime/types.ts)): agregar `"explorer"` a
`READ_ONLY_ROLES` ya fuerza sandbox read-only en Codex y `tools.write=false` en OpenCode.
Consistente con la frontera de seguridad: el explorador es **read-only sobre el repo
vigilado**, el orchestrator sigue siendo el único que escribe git.

### 3.2 El contrato del destilado (`ExplorationBrief`)

Devuelto en la **respuesta final bloqueante** (contrato provider-neutral; los eventos en
vivo son observabilidad). Validado y bounded igual que `context.json` y el manifest.

```ts
interface ExplorationBrief {
  builtForSha: string;            // provenance / señal de staleness
  objective: string;             // el flujo/objetivo que sirve este brief
  blastRadius: BlastNode[];      // código tocado + 1 línea de rol c/u (NO cuerpos enteros)
  feBe: FeBeFact[];              // joins FE→BE resueltos, relevantes al objetivo
  contracts: ContractFact[];     // campos/enums/errores OpenAPI relevantes a aserciones
  routes: RouteRecon[];          // rutas de entrada candidatas + DOM landmarks (HINTS)
  risks: string[];               // fragilidades, gotchas, qué conviene asertar
  notes?: string;
}
interface BlastNode  { symbol: string; file: string; role: string }      // role = qué hace, 1 línea
interface RouteRecon { path: string; component?: string; domLandmarks?: string[]; verified: boolean }
```

Funciones nuevas (puras, 100% unit-testables, patrón DI del repo):
`buildExplorerPrompt`, `parseExplorationBrief`, `validateExplorationBrief`,
`renderExplorationBrief` (lo que ve el escritor) — espejando
`buildPlanPrompt`/`parsePlan`/`validateContext`/`renderArchitectureContext`.

### 3.3 El invariante crítico — fidelidad de selectores

`AGENTS.md` es enfático: los selectores se verifican contra el **DOM vivo, nunca desde el
código**. Si el explorador destila selectores y el escritor confía sin re-chequear,
reintroducimos el modo de falla prohibido.

**Frontera de destilado:**
- El explorador destila **código** de forma autoritativa (símbolos, `feBe`, contratos).
- Para el **DOM**, `domLandmarks` son **pistas** (`verified` marca si el explorador
  realmente navegó). El escritor **siempre** re-verifica selectores contra el DOM vivo.
- **v1: el explorador NO toca el browser** (solo código) → preserva el invariante con
  riesgo cero. DOM-recon es opt-in de v2.

## 4. Orquestación — dónde corre

### 4.1 Path de fan-out (complete/exhaustive/diff paralelo) — *enriquecer lo que ya hay*

El planner **ya es** un explorador amplio. No agregamos sesiones: hacemos que emita el
**`ExplorationBrief` por objetivo** en vez de solo nombres de símbolos. Los workers
reciben el brief y **dejan de re-explorar el código** (siguen re-verificando DOM).

### 4.2 Path single-agent de `diff` (el default) — *el gap real*

Una pasada de explorador **antes** del generador: sesión aislada read-only → `brief` →
se inyecta vía `renderExplorationBrief` en el prompt del generador. El generador ya no
explora inline; razona sobre el destilado y escribe.

### 4.3 Reúso / caché

El brief se cachea por `builtForSha` + `objective`. Las pasadas de re-generación
(fix/review/coverage) — hoy single-agent que **re-exploran** — reusan el brief en vez de
empezar de cero.

## 5. Economía

- **Costo:** una sesión extra (single-agent) o tokens de planner más ricos (fan-out).
- **Ganancia:** ventana del escritor limpia (más tokens para razonar el test) + brief
  reutilizable/cacheable + workers que no repiten lectura de cuerpos.
- **Modelo:** el explorador es lectura+resumen → candidato a modelo **barato**
  (deepseek-flash / gpt-5.4-mini). El destilado lo consume el modelo fuerte.

## 6. Plan incremental

| Fase | Alcance | Riesgo | Test |
|---|---|---|---|
| **0** | Schema + `parse`/`validate`/`render`/`build` (puros) | Nulo | Unit puro |
| **1** | Rol `explorer` en el strategy (ambos runtimes) + prompts | Bajo | Wiring de rol/capacidades |
| **2** | Enriquecer planner→worker: brief por objetivo | Bajo (ya es fan-out) | Orquestación con stubs |
| **3** | Explorador en el path single-agent de `diff` | Medio (orquestación) | Orquestación con stubs |

Detrás de un flag (`qa.explorer: true` o env), shadow-safe, estrenar en `portfolio`.

## 7. Decisiones tomadas

- **A. Forma → rol nuevo `explorer`** en el `AgentRuntimeStrategy` (read-only de primera
  clase, como `reflector`). Ambos runtimes lo heredan; read-only sale de `capabilitiesForRole`.
- **D. DOM → solo-código en v1.** El explorador destila código (símbolos, `feBe`,
  contratos); los selectores los sigue verificando el escritor contra el DOM vivo.
  DOM-recon (landmarks como pistas) queda para v2.
- **E. Primer incremento → Fase 2** (enriquecer el planner del path de fan-out).
- **B. Granularidad** (default): brief por objetivo en fan-out, brief global en single-agent.
- **C. Modelo** (default): explorador en modelo barato (lectura+resumen); el destilado lo
  consume el modelo fuerte.

### Secuencia concreta del primer incremento

Ordenada por valor/riesgo. Nota de honestidad: en el path de fan-out el planner **ya es**
el `qa-generator` fuerte, así que Fase 2 **no requiere el rol nuevo todavía** — solo
enriquece el contrato planner→worker. El rol `explorer` (decisión A) se materializa en
Fase 3, donde realmente gana su lugar (el path single-agent).

1. **Fase 0 — núcleo puro** ✅ **HECHA** ([`src/qa/exploration-brief.ts`](../src/qa/exploration-brief.ts)
   + [tests](../src/qa/exploration-brief.test.ts), 20 tests, TDD): `ExplorationBrief`
   + `validateExplorationBrief` (forma, espejo de `validateContext`)
   + `parseExplorationBrief` (tolerante, espejo de `parsePlan`, firma = array `blastRadius`)
   + `renderExplorationBrief` (sanitizado + bounded a 20k, lidera con el guard de fidelidad
   de selectores: `domLandmarks` son PISTAS, gana el código/DOM). Sin integración.
2. **Fase 2 — enriquecer planner→worker** ✅ **HECHA** (TDD): `PlanObjective`/`ParallelWorkerInput`
   ganan `brief?` (opcional → back-compat); `parsePlan` adjunta el brief por objetivo (vía
   `coerceExplorationBrief`) y **deriva `symbols` de `brief.blastRadius`** cuando no vienen
   explícitos; `buildPlanPrompt` (diff + complete) pide el brief con ejemplo JSON; `buildWorkerPrompt`
   inyecta `renderExplorationBrief(brief)` y le dice al worker *"no re-explores el código — verificá
   selectores contra el DOM vivo"*. Degradación elegante: sin brief, el comportamiento es el actual.
3. **Fase 1 — rol `explorer` read-only** ✅ **HECHA** (TDD): `"explorer"` en `AgentRole`
   + `READ_ONLY_ROLES` (read-only sale gratis en ambos runtimes vía `capabilitiesForRole`:
   OpenCode `tools.write:false`, Codex `--sandbox read-only`); `qa-explorer.md` en
   `agents/agent/` (OpenCode vivo) y `agent/roles/` (Codex); registro read-only en
   `agents/opencode.json` (modelo flash, serena+engram, **sin Playwright** = solo-código v1);
   mapeos `ROLE_TO_OPENCODE_AGENT.explorer`, `roleForLegacyAgent`, `rolePromptName`.
4. **Fase 3 — pasada de explorador en el path single-agent de `diff`** ✅ **HECHA** (TDD):
   `buildExplorerPrompt` (prompts.ts) + `maybeExplore` en `runOpencode` corre el `qa-explorer`
   read-only ANTES del generador y le pasa el brief vía `input.contextBrief`; `buildPrompt` lo
   inyecta con `renderExplorationBrief` + *"no re-leas ese código; verificá selectores contra el
   DOM"*. Gateado por flag `qa.explorer` (schema + pipeline + example.yaml), default OFF.
   **Best-effort**: si el explorador falla o no devuelve brief parseable, degrada al generador
   explorando inline (nunca rompe el run). Acotado a: `diff` + `e2e` + primera pasada (no fix/review/coverage).

**Estado: plan completo (Fases 0→2→1→3).** El explorador aislado funciona en ambos paths: fan-out
(planner enriquecido, Fase 2) y single-agent diff (Fase 3, opt-in). Pendiente sólo el rollout
(activar `qa.explorer` en un app real y medir) y, si se quiere, DOM-recon en v2 (decisión D dejó v1 solo-código).

> **Nota de topología (jun 2026):** el árbol `opencode/` fue migrado a `agents/` (config viva de
> OpenCode, montada como `/root/.config/opencode`) y `agent/` (prompts neutrales de Codex). `opencode/`
> ya no existe. Todo prompt nuevo va a `agents/` + `agent/`.

## 8. Invariantes que NO se tocan

- El explorador es **read-only** sobre el repo vigilado (capabilities, no confianza en el prompt).
- App-specificity solo en `config/`; agentes/modelos solo en `opencode/`+`agent/`; nada app-specific en `src/`.
- Cola secuencial: el explorador corre dentro del mismo run, no agrega concurrencia contra DEV.
- El brief pasa por el `sanitizer` igual que el diff y el `context.json` (entrada attacker-influenceable).
- Verdicts autoritativos en la respuesta final bloqueante; eventos en vivo solo observabilidad.
