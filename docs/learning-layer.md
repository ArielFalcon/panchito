# Capa de aprendizaje — ai-pipeline

> El plan de integración para que el harness **aprenda de verdad** corrida tras
> corrida, sin acumular memoria indefinidamente. Es el sucesor natural del
> [blueprint de arquitectura](blueprint-arquitectura.md) y del keystone de valor
> ([change-coverage](change-coverage.md)).
>
> **Objetivo:** entrenar el *harness*, no el modelo. El modelo es externo; lo que
> mejora corrida tras corrida es el andamiaje determinista que lo rodea —
> medición, gobierno de conocimiento y retrieval.

---

## La tesis (leer antes que nada)

**No se puede tener una capa de aprendizaje antes de tener una capa de
evaluación.** El riesgo de un lazo de calidad circular (un LLM genera, otro
revisa) es que el sistema optimice un proxy y derive en una suite enorme que no
atrapa nada (Goodhart). El único antídoto es **medir**: el marcador antes que los
jugadores.

De ahí la regla de secuencia, ya **decidida**:

> **Métrica antes que memoria.** Primero el oráculo (Fase 0+1); recién después el
> Learning Ledger (Fase 2).

## Decisiones fijadas (2026-06-08)

| Decisión | Elección | Implicancia |
|---|---|---|
| Backend del Learning Ledger (etapa [4]) | **Graphiti** (grafo temporal) | Sidecar con graph DB (Neo4j/FalkorDB), accedido por el agente vía MCP y escrito por el orquestador. engram pasa a memoria episódica cruda o se retira. |
| Secuencia de construcción | **Oráculo primero** (Fase 0+1 antes del Ledger) | Hacer el aprendizaje medible antes de construir la memoria. |
| Robustez de producción | **Fail-open, aditiva, off-path** | La capa de learning nunca bloquea ni gatea; el pipeline pasa su suite con la capa entera stubbeada. |
| Bloqueo por valor | **`valueScore` sólo en modo `signal`** | El oráculo de valor registra y enseña, pero NUNCA bloquea el publish; sólo los gates deterministas bloquean. |
| Alcance de Graphiti | **Stack completo (no SQLite-first)** | Se asume el costo de infra (servicio Python + graph DB) por el gobierno temporal y el retrieval híbrido nativos. |

---

## La regla de oro: el límite determinista

Todo lo nuevo cae de un lado del invariante fundacional, **nunca encima de él**:

- **Lado determinista (`src/`, TS):** medición, gobierno, decisión. Unit-testeable,
  sin LLM en el camino crítico.
- **Lado agéntico (`opencode/`, vía MCP):** generación, reflexión, retrieval.

**Corolario de gobierno:** el agente **LEE** el Ledger (retrieval), pero el
orquestador **ESCRIBE** la confianza de las reglas (derivada de resultados
objetivos). El gobierno del conocimiento jamás queda en manos del LLM — igual que
todo lo valioso de este codebase.

Esto descarta por diseño (no por calidad) dos herramientas evaluadas:

- **LangGraph** ❌ — duplica el orquestador determinista (`pipeline.ts` + `queue.ts`
  + `runner.ts` + recovery en `history.ts`) y forzaría orquestación en Python.
- **Aider** ❌ — CLI que hace sus propios git commits → viola el invariante "el
  agente es read-only; sólo el orquestador escribe git". Solapa OpenCode.

---

## La garantía de robustez: fail-open, aditiva, off-path

La capa de learning sólo se justifica si **no puede empeorar producción**. Por eso
se diseña como un superset estricto que **degrada al sistema actual ante cualquier
fallo**:

- **Aditiva:** el único toque en el camino crítico (T1) es el *retrieval* — una
  lectura que inyecta reglas o no. Sin reglas (o con Graphiti caído), el agente se
  comporta exactamente como hoy.
- **Off-path:** Labeler, Reflector, Distiller, atribución y benchmark corren en
  T2/T3/T4, **fuera del camino determinista**. Ninguno bloquea un run.
- **Fail-open:** cualquier error de la capa (Graphiti no responde, OpenEvals falla,
  el Reflector no parsea) se loguea y se sigue — nunca tumba el pipeline. Mismo
  principio que el reviewer hoy.
- **Nunca bloquea por señal blanda ni por valor:** sólo los gates deterministas ya
  entendidos (B/C/D en `enforce`) pueden bloquear el publish. El `valueScore`
  (mutation/benchmark) se queda en modo **`signal`**: registra y enseña, jamás
  bloquea.

**El test que lo garantiza:** el pipeline debe pasar **toda su suite con la capa de
learning entera stubbeada**. Si eso se cumple, la complejidad añadida no puede
volver impredecible la producción — sólo puede no mejorarla.

(Los cuatro tiempos: **T1** sincrónico dentro del run · **T2** al cerrar el run ·
**T3** periódico/por umbral · **T4** on-demand/agendado, nunca en producción.)

---

## El objeto canónico: `RunOutcome`

El antídoto a "herramientas aisladas que duplican procesos" es que **todas las
etapas y herramientas consuman/produzcan el mismo objeto**. El `RunOutcome` es la
*episode* de Graphiti, el *trial* de Reflexion, el *training example* de DSPy y la
*memory* de Generative Agents — **el mismo dato**.

```ts
// src/qa/learning/run-outcome.ts — append-only, NUNCA se purga
// (a diferencia de history.ts, que auto-purga a 30 días y borra la serie de aprendizaje)
interface RunOutcome {
  runId: string; app: string; sha: string; mode: RunMode; target: TestTarget;
  verdict: RunVerdict;                       // ya existe en types.ts
  errorClass: ErrorClass | null;             // [1] Labeler — determinista, sin LLM
  gateSignals: {                             // la verdad objetiva del run
    static: boolean;                         // Filter B (validate.ts)
    coverageRatio: number | null;            // Filter D (change-coverage.ts) — ya existe
    valueScore: number | null;               // Fase 1: mutation score / benchmark-replay (el oráculo)
    reviewerCorrections: string[];           // del qa-reviewer (HOY se descarta)
    flaky: boolean; retries: number;
  };
  rulesRetrieved: string[];                   // qué reglas del Ledger se inyectaron → atribución [5]
  reflection?: StructuredReflection;          // [2] — sólo si el run quedó bajo la barra
}
```

Una sola tabla append-only en el orquestador determinista. Esa es la cañería que
conecta todo.

---

## Taxonomía de errores (auto-etiquetable, cero LLM)

No hace falta un LLM para clasificar: el veredicto + el anti-patrón del reviewer
**ya son la etiqueta**. Derivada de los gates que ya existen:

| `ErrorClass` | Se deriva de | Señal |
|---|---|---|
| `E-STATIC` | Filter B (`validate.ts`) | no compila / lintea / lista |
| `E-EXEC-FAIL` | Filter C (`execute.ts`) | falla consistente contra DEV |
| `E-FLAKY` | Filter C | pasa sólo en retry |
| `E-COVERAGE-GAP` | Filter D (`change-coverage.ts`) | ratio < minRatio |
| `E-FALSE-POSITIVE` | reviewer AP #1/#3/#11 | oráculo débil (verde con feature rota) |
| `E-WRONG-OBJECTIVE` | reviewer AP #2/#9 | assert no atado al cambio |
| `E-FRAGILE-SELECTOR` | reviewer AP #6/#7 | selector/regex ambiguo |
| `E-NO-CLEANUP` | reviewer AP #8 | ensucia DEV |
| `E-VALUE-SURVIVED` | Fase 1 (oráculo) | coverage OK pero el mutante/regresión sobrevive — el FP más profundo |
| `E-INFRA` | `infra-error` | **se EXCLUYE del aprendizaje** (no es fallo de calidad) |

Para el lazo de auto-mantenimiento (path B) la taxonomía ya existe:
`FixFailureReason` en [`maintainer-memory.ts`](../src/server/maintainer-memory.ts).

---

## La arquitectura unificada

```
                    ┌──────────────── opencode/ (no-determinista, vía MCP) ────────────────┐
                    │  qa-generator / reviewer / maintainer / worker                       │
                    │     ▲ retrieval                                  ▲ reflexión          │
   ┌────────────────┼─────┼────────────────────────────────────────── ┼────────────────────┼──┐
   │  src/ (DETERMINISTA — gobierno, medición, decisión)               │                    │  │
   │                │     │                                            │                    │  │
   │  pipeline.ts ──┴─► [1] LABELER ─► RunOutcome ─► [2] REFLECTOR ────┘                    │  │
   │  (TU orquestador,        (TS)        (objeto         (Reflexion + Self-Refine,          │  │
   │   NO LangGraph)                       canónico)       schema fijo, anclado a artefactos)│  │
   │                                          │                                              │  │
   │                          ┌───────────────┼───────────────┐                             │  │
   │                          ▼               ▼               ▼                             │  │
   │              [5] EVAL HARNESS      [3] DISTILLER     [4] LEARNING LEDGER                │  │
   │              ├ OpenEvals (TS)      (Gen-Agents       = Graphiti (grafo temporal)        │  │
   │              ├ MUTATION / replay    reflection-tree,  · confidence GANADA de outcomes   │  │
   │              └ BENCHMARK congelado   disparado por     · invalidación temporal (anti    │  │
   │                     │ scorecard      umbral)           ─poisoning) con linaje           │◄─┘
   │                     ▼                     │            · retrieval híbrido (sem+BM25+    │
   │              [meta] DSPy ◄── trainset ────┘              traversal) ──────────────────► │──► (al agente)
   │              (Fase 3, offline)   = RunOutcomes del benchmark                            │
   └─────────────────────────────────────────────────────────────────────────────────────────┘
```

---

## Las etapas en detalle

### [1] Labeler — `src/qa/learning/labeler.ts` (determinista)
Auto-etiqueta el `errorClass` desde `verdict` + correcciones del reviewer. Sin
LLM. Emite el `RunOutcome` y lo persiste append-only.

### [2] Reflector — LLM acotado, schema fijo
Sólo corre en runs por debajo de la barra. Llena un JSON fijo, **anclado a
artefactos** para que no sea reflexión alucinada:

```ts
interface StructuredReflection {
  goal: string; decision: string; assumption: string;
  errorClass: ErrorClass;        // del Labeler, no lo inventa el LLM
  gateSignal: string;            // el ratio / la corrección / el exit code reales
  evidence: string;              // el assert que falló, las líneas no cubiertas
  rootCause: string;             // la CLASE se deriva del gate; el detalle lo llena el LLM
  preventiveRule: { trigger: string; action: string };  // debe ser RECUPERABLE
}
```

Generaliza el patrón que ya existe en la `justification` del
[`qa-maintainer`](../opencode/agent/qa-maintainer.md)
(`rootCause`/`whyNecessary`/`whyMinimal`).

### [3] Distiller — `incidente → patrón → regla` (periódico)
No corre por cron fijo: se **dispara por umbral de importancia acumulada**
(mecanismo de reflexión de Generative Agents). Deduplica `preventiveRule` contra
reglas existentes → **upsert, no append**. Una regla nace
`confidence=low, status=candidate, source=runId`.

### [4] Learning Ledger — **Graphiti** (grafo temporal)
El sistema de récord. Graphiti resuelve nativamente el gobierno que de otro modo
habría que construir a mano:

- **Anti memory-poisoning (#7):** cuando una regla nueva contradice una vieja,
  Graphiti **invalida la vieja con una ventana de validez temporal** en vez de
  borrarla — preserva linaje, no recomputa el grafo entero.
- **Políticas, no recuerdos (#1):** reglas como entidades/aristas (trigger→action),
  no transcripciones.
- **Retrieval jerárquico (#8):** búsqueda híbrida (semántica + BM25 + traversal)
  con reranking por distancia de grafo, gratis.

Cada regla lleva: `{ trigger, action, errorClass, confidence, usageCount,
successRate, lastVerified, source, status }`. **La confianza la escribe el
orquestador** (ver [5]), nunca el agente.

Integración: Graphiti corre como **sidecar** (Python + graph DB), expuesto al
agente como **MCP server** (retrieval) y al orquestador vía HTTP (escritura de
outcomes). engram queda relegado a memoria episódica cruda o se retira.

### [5] Evaluation Harness — el oráculo de verdad
Lo que convierte "acumular" en "aprender". Tres piezas:

1. **OpenEvals (TS, opcional)** — `npm i openevals`, corre standalone. Normaliza las señales
   *soft* a `{key, score, comment}`: `CODE_CORRECTNESS`, `JSON match`, TypeScript
   type-checker, E2B sandbox execution. **Cuidado:** su LLM-as-judge es
   no-determinista → se usa sólo para señales soft. **El oráculo duro sigue siendo
   determinista** (mutation/coverage), para no reintroducir el lazo circular.

2. **El oráculo de valor (depende del target):**
   - **`code`**: **mutation testing** directo (Stryker para JS/TS, mutmut/cosmic-ray
     para Python, PIT para Java…): mutar la fuente, correr la suite del repo, el
     test **debe** ponerse rojo. `valueScore` = % de mutantes atrapados.
   - **`e2e`**: mutation testing es difícil (la app está *desplegada*, no se
     construye acá). El "mutante" es un **commit con regresión real conocida**: el
     benchmark congelado es un set de pares `(sha_bueno, sha_malo)`; la métrica =
     ¿la suite generada para `sha_bueno` se pone roja contra el deploy de
     `sha_malo`? Es la versión operativa de "100 bugs históricos".

3. **Benchmark congelado** — replay de N commits pinneados → **scorecard
   versionado** (mutation-catch-rate, FP-rate, flaky-rate, coverage). Es lo que
   demuestra `v1→62%`, `v2→68%`… y lo que hace falsable el miedo a "acumular sin
   aportar".

4. **Atribución de outcomes** — cuando una regla aparece en `rulesRetrieved`, el
   `valueScore` del run escribe en su `successRate`. Las reglas que correlacionan
   con buenos resultados se promueven; las que no, decaen y expiran. **Esto es lo
   que lo hace aprender.**

> **El `valueScore` nunca bloquea.** Vive en modo `signal`: registra, enseña,
> alimenta el scorecard y la atribución — pero **sólo los gates deterministas
> (B/C/D en `enforce`) bloquean el publish**. Así una señal no-determinista jamás
> entra al camino crítico.

### [6] Retrieval jerárquico — al agente, honrando el context budget
Inyecta sólo: catálogo global ∩ reglas de app ∩ reglas de flow ∩ reglas del
`errorClass` previsto, `status=active`. Reusa el mismo canal de prompt que
`reviewCorrections`/`coverageGap` en
[`opencode-client.ts`](../src/integrations/opencode-client.ts). Scoring ponderado
(recencia × importancia × relevancia, à la Generative Agents), no cap crudo.

### [meta] Optimizer — **DSPy** (Fase 3, offline)
El "entrenar el harness" literal. Compila los prompts (`opencode/agent/*.md`) y
los few-shot contra el **benchmark** (métrica = `valueScore`). Emite versiones
optimizadas, **versionadas en git y gateadas por el benchmark + review humano**
(los prompts son la política del agente). **Inútil sin el benchmark de Fase 1.**

---

## Cómo se detecta un test naive que pasa (el problema de la profundidad)

Un test puede **pasar, tener coverage e integrar varias capas** y aun así ser
mediocre: hace click, ve un 200, ve que algo cambia en la UI, y da por bueno — sin
verificar que la respuesta *coincide* con lo enviado ni que la UI muestra el valor
*correcto*. La cobertura es ciega a esto (mide ejecución, no detección). El sistema
lo ataca en tres frentes:

### 1. El oráculo de valor ES el detector de tests naive
La diferencia entre el test naive y el profundo se revela al inyectar un fallo
semántico (un valor incorrecto con status 200):

| Mutación inyectada | Test naive (200 + algo cambia) | Test profundo (respuesta = input, UI = valor correcto) |
|---|---|---|
| endpoint devuelve valor mal, 200 | sigue verde ❌ (mutante sobrevive → `E-VALUE-SURVIVED`) | se pone rojo ✅ (mutante muere) |

El test naive deja sobrevivir mutantes → el `valueScore` baja → el sistema **sabe
objetivamente** que produce tests pobres para esa clase. No es opinión.

### 2. La profundidad necesita una fuente de verdad sobre "qué es correcto"
"Profundidad" = **fuerza del oráculo**, y eso requiere una fuente de corrección. El
sistema tiene exactamente tres, y las reglas del Ledger empujan a usarlas:

1. **El contrato OpenAPI** (ya se lee) — afirmar que la respuesta cumple
   forma/constraints, no sólo que hubo 200.
2. **Un mutante/regresión** que define "incorrecto" por contraejemplo (mutation en
   `code`, par `(sha_bueno, sha_malo)` en `e2e`).
3. **Relaciones metamórficas agnósticas** — "el valor que envié debe aparecer
   transformado en la respuesta/UI".

Sin una de estas, la profundidad no tiene ancla — es un límite teórico, no de
implementación.

### 3. La bondad de una regla se mide, no se juzga
Una regla como *"en flujos con endpoint, afirmar que la respuesta coincide con lo
enviado, no sólo el 200"* es **buena si y sólo si** los runs que la usaron
atraparon más mutantes que los que no — medible en el benchmark. Ahí se promueve;
si no aporta, decae.

> **Límite honesto:** para un commit `e2e` nuevo no hay mutante en el momento → no
> hay oráculo duro per-run; se depende del reviewer + heurísticas de
> fuerza-de-oráculo + reglas ya aprendidas, y la verdad dura llega *después* en el
> benchmark. El sistema **no es zero-shot**; es **monótonamente mejor** en las
> clases donde ya se quemó.

---

## El diferenciador: comprender el flujo completo, agnóstico a la tecnología

El valor del producto es entender *todo* el flujo (no "revisá que la búsqueda
anda"), incluidos los procesos intermedios — p.ej. un KD-tree cacheado de un
GeoJSON que muta por un camino aparte y queda obsoleto al re-consultar tras moverse
25km. Eso no es un oráculo débil: es un **caso de prueba que ni se generó**
(cobertura de *escenarios*, no de líneas).

### La mitad delantera ya está: comprensión estructural
Serena (`find_referencing_symbols`) deja ver que el flujo depende de una estructura
construida una vez desde una fuente con un camino de escritura separado — la
**pista estructural** de que la obsolescencia es posible. Eso es lo que diferencia
del prompt genérico.

### Lo que aporta la capa de learning: arquetipos, no recuerdos
El sistema **no aprende "KDBush"; aprende la forma de la trampa.** La regla se
indexa por **precondición estructural**, no por tecnología:

```
errorClass: E-MISSING-STATEFUL-SCENARIO
trigger:    "el blast radius muestra una estructura derivada de una fuente con
             camino de escritura independiente"   ← estructural, no tecnológico
action:     "testear la secuencia re-consulta-tras-mutación, no sólo la consulta única"
```

El mismo arquetipo dispara para KDBush, un selector memoizado, un caché Redis o una
vista materializada. **Así se evita el sesgo por stack: las reglas se indexan por
estructura.**

### El currículo de escenarios (Voyager), gateado por valor
Por flujo, el sistema mantiene un catálogo de arquetipos a considerar (happy,
empty, boundary, re-consulta-tras-mutación, update-concurrente, permiso-denegado…).
Un arquetipo entra **sólo si alguna vez atrapó un fallo real en el benchmark**. El
agente recibe los relevantes al patrón estructural detectado — así pasa de "el
botón anda" a "qué casos reales importan".

### La realidad como currículo
La fuente más fuerte de "qué importa" son los **bugs reales** (Issues que el
sistema abre, historial de la app). Un miss que se escapó a producción es una
**entrada del benchmark** → el sistema aprende el arquetipo de un fallo real,
agnóstico por construcción.

> **Promesa realista:** mejora monótona sobre arquetipos recurrentes; **no**
> descubrimiento zero-shot de bugs novedosos.

---

## Aprendizaje escéptico: defensa contra falsos positivos

El riesgo: un evento externo desconocido (glitch de infra, race de deploy,
flakiness sutil) corrompe un run, el sistema lo atribuye al proceso interno y
"ajusta" mal — degradando o sobrescribiendo una regla buena. Principio rector:

> **El canal ruidoso (runs de producción) sólo PROPONE; el canal estable
> (benchmark determinista) DISPONE.** Una corrida ruidosa puede crear una candidata
> o empujar un poco la confianza, pero **no puede promover** nada — eso lo hace
> sólo la mejora consistente del benchmark.

Seis defensas:

1. **Infra excluida.** `E-INFRA` no enseña. El gate ya distingue "fallo con DEV
   caído → infra-error".
2. **Reproducibilidad como puerta.** Sólo fallos **deterministas y reproducibles**
   alimentan al Reflector. Un evento de una vez no reproduce → flaky/quarantine →
   no enseña (extiende la lógica flaky actual).
3. **Confianza = estadístico, no interruptor.** `successRate` es una estimación
   corrida (tipo Beta con prior) sobre *muchos* outcomes; un fallo anómalo casi no
   mueve una regla de alta confianza. Es el margen de tolerancia.
4. **Histéresis asimétrica.** Promoción tras K éxitos; degradación tras K fallos,
   con K mayor para reglas viejas y confiables. Un evento nunca voltea un estado.
5. **Nada se sobrescribe — se supersede, reversible.** El modelo temporal de
   Graphiti marca `valid_until` y preserva linaje; una regla degradada por un fluke
   se **resucita** con evidencia posterior.
6. **Humano para alto blast-radius.** Reglas que afectan muchos runs, que deprecan
   una regla de alta confianza, o cambios de prompt de DSPy → pasan por review
   (primitivas HITL ya existen en la TUI).

> **Trade-off aceptado:** el sistema aprende **lento y conservador** — un insight
> genuino de una sola vez se ignora por no reproducir. Es el precio correcto para
> "estable, confiable, determinista".

---

## Herramientas: veredicto

| Herramienta | Veredicto | Etapa | Notas de integración |
|---|---|---|---|
| **OpenEvals** | 🟡 Opcional | [5] | Paquete TS, standalone, vive en `src/`. **Conveniencia, no indispensable**: el reviewer ya hace LLM-judging. Adoptar sólo si ahorra trabajo real; si no, hand-roll los 3-4 evaluadores que se usen. Sólo señales soft. |
| **Graphiti** | ✅ Adoptar (Ledger) | [4][6] | Sidecar Python + graph DB, MCP al agente, HTTP al orquestador. |
| **DSPy** | 🟡 Fase 3 | [meta] | Offline. Requiere el benchmark primero. Emite prompts versionados. |
| **Mem0** | ⬜ Descartada | — | Alternativa más liviana a Graphiti; no se adopta tras elegir Graphiti. |
| **LangGraph** | ❌ Rechazar | — | Duplica el orquestador determinista; fuerza Python. |
| **Aider** | ❌ Rechazar | — | Viola read-only + orquestador-dueño-del-git; solapa OpenCode. |

## Papers → mecanismos

| Paper | Mecanismo robado | Aterriza en | Matiz |
|---|---|---|---|
| Self-Refine (2303.17651) | generar→auto-critica→refina intra-run | [2] | Tu reviewer independiente ya lo SUPERA; úsalo sólo para pulido barato. |
| Reflexion (2303.11366) | Actor+Evaluator+Self-Reflection → buffer episódico → reinyección | [2][4] | Es tu `maintainer-memory.ts`; generalizar a QA. El Evaluator son los gates. |
| Voyager (2305.16291) | skill library añadida sólo tras verificación + currículo automático | [5]→skills, modos complete/exhaustive | "Skill" acá = exemplar parametrizado (read-only), no código ejecutable. |
| Generative Agents (2304.03442) | retrieval = recencia×importancia×relevancia + reflexión por umbral | [3][6] | Reemplaza el cap crudo `keep=20` por scoring ponderado. |

---

## Roadmap por fases

| Fase | Qué construís | Herramientas | Estado |
|---|---|---|---|
| **0 — Marcador** | `RunOutcome` append-only + Labeler + taxonomía (enum). Arregla el purge-30d. | — (TS puro) | siguiente |
| **1 — Oráculo** | Mutation testing (`code`) + benchmark-replay (`e2e`) + scorecard versionado (OpenEvals opcional). | Stryker (OpenEvals opcional) | — |
| **2 — Lazo cerrado** | Reflexión estructurada + Learning Ledger (Graphiti) + atribución de outcomes + retrieval jerárquico. | Graphiti | — |
| **3 — Skills + meta** | Skill library gateado por valor + DSPy contra el benchmark + currículo automático. | DSPy | — |

---

## Invariantes que se preservan

- El agente sigue **read-only** sobre repos vigilados; el Ledger lo escribe el
  orquestador.
- Toda señal *dura* (coverage, mutation, benchmark) es **determinista y
  unit-testeable**; los LLM-judge (OpenEvals, reviewer) son señal *soft*.
- App-specificity sólo en `config/`; agentes/modelos sólo en `opencode/`; el
  gobierno del aprendizaje en `src/`.
- Errores de infra (`E-INFRA`) se excluyen del aprendizaje.
- La capa de learning es **fail-open, aditiva y off-path**: el pipeline pasa su
  suite con ella entera stubbeada.
- El `valueScore` **nunca bloquea** el publish (modo `signal`); sólo los gates
  deterministas bloquean.
- El canal ruidoso (producción) **propone**; el canal estable (benchmark)
  **dispone**. Nada se sobrescribe: se supersede reversiblemente.
- Sólo fallos **reproducibles** enseñan; la confianza es un **estadístico** sobre
  muchos outcomes, nunca un interruptor por evento único.

## Próximos pasos

1. **Fase 0:** diseñar el esquema `RunOutcome` + tabla append-only + Labeler, y
   enganchar la persistencia en `runner.ts`/`pipeline.ts` sin tocar el flujo.
2. **Fase 1:** prototipar mutation testing en una app `code` y el benchmark-replay
   en `portfolio` (e2e), con el primer scorecard.
