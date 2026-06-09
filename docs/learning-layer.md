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
| Backend del Learning Ledger (etapa [4]) | **SQLite + modelo temporal** | Extiende la tabla `learning_rules` que ya existe con las semánticas de gobierno (success_rate estadístico, promoción/histéresis, supersede reversible vía `valid_until`+linaje). Cero infra nueva. |
| Graphiti | **Diferido** | El hueco real era el *gobierno* (barato en SQLite), no el *motor*. Graphiti completo (servicio Python + graph DB) sólo si el grafo de reglas crece hasta justificar traversal/extracción. |
| Oráculo de valor `e2e` | **Fault-injection de respuestas (nivel 1)** | Re-correr la suite verde corrompiendo las respuestas de red con Playwright `route()`, contra el DEV único. Agnóstico, sin redeploy, per-run. Nivel 2 (mutar el bundle de cliente) condicional. Redeploy-benchmark sólo como add-on opcional para apps con preview gratis. |
| Oráculo de valor `code` | **Mutation real (Stryker), scopeada al diff** | Tiene la fuente y corre la suite del repo; sin problema de deploy. |
| Secuencia de construcción | **Oráculo primero** (Fase 0+1 antes del Ledger) | Hacer el aprendizaje medible antes de construir la memoria. |
| Robustez de producción | **Fail-open, aditiva, off-path** | La capa de learning nunca bloquea ni gatea; el pipeline pasa su suite con la capa entera stubbeada. |
| Bloqueo por valor | **`valueScore` sólo en modo `signal`** | El oráculo de valor registra y enseña, pero NUNCA bloquea el publish; sólo los gates deterministas bloquean. |

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

- **Aditiva:** el único toque en el camino crítico (tiempo T1) es el *retrieval* —
  una lectura que inyecta reglas o no. Sin reglas (o con el Ledger inaccesible), el
  agente se comporta exactamente como hoy.
- **Off-path:** Labeler, Reflector, Distiller, atribución y benchmark corren en
  T2/T3/T4, **fuera del camino determinista**. Ninguno bloquea un run.
- **Fail-open:** cualquier error de la capa (el Ledger no responde, el oráculo
  falla, el Reflector no parsea) se loguea y se sigue — nunca tumba el pipeline.
  Mismo principio que el reviewer hoy.
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
    valueScore: number | null;               // Fase 1: mutation (code) / fault-injection de respuestas (e2e)
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
   │              [5] EVAL HARNESS       [3] DISTILLER     [4] LEARNING LEDGER (SQLite)       │  │
   │              ├ mutation (code)      (Gen-Agents       · confidence estadística          │  │
   │              ├ fault-inject (e2e)    reflection-tree,   (no overwrite)                  │  │
   │              └ scorecard            disparado por     · invalidación temporal           │  │
   │                     │ versionado    umbral)            (valid_until + linaje)           │◄─┘
   │                     ▼                     │           · retrieval por successRate ──────►│──► (al agente)
   │              [meta] DSPy ◄── trainset ────┘             (Graphiti = futuro si escala)    │
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

### [4] Learning Ledger — **SQLite + modelo temporal** (`learning_rules`)
El sistema de récord. Vive en la misma SQLite que `history.ts` (cero infra nueva).
El hueco real nunca fue el *motor* sino el *gobierno*; estas semánticas se modelan
con un par de columnas y funciones puras unit-testeables:

- **Anti memory-poisoning (#7):** una regla nueva que contradice a una vieja **no la
  sobrescribe** — marca la vieja `superseded` con `valid_until` y preserva linaje
  (`supersedes`). Una regla degradada por un fluke se puede resucitar.
- **Confianza GANADA, no auto-asignada:** `successRate` es un **estadístico corrido**
  (Welford/Beta con conteo), **nunca un overwrite** por evento único. Promoción
  `candidate→active` tras K éxitos; degradación tras K fallos (histéresis asimétrica).
- **Políticas, no recuerdos (#1):** reglas como filas `{ trigger, action, errorClass,
  confidence, usageCount, successRate, lastVerified, source, status, valid_until }`.

**La confianza la escribe el orquestador** (ver [5]), nunca el agente. **El retrieval
rankea por `successRate`** (la señal de atribución, no `usageCount`): las reglas `active`
van primero (exploit) y las `candidate` llenan el resto como **cola de exploración acotada**
para que acumulen los outcomes que ganan —o deniegan— la promoción. `deprecated`/`superseded`
no se inyectan nunca. (Estricto-solo-`active` haría *deadlock* —las candidatas nunca se
exercitan→ nunca se promueven— hasta que exista el benchmark offline como canal de validación.)

> **Graphiti = futuro condicional.** Si el grafo de reglas crece hasta que el
> traversal regla↔regla o la extracción por LLM se ganen su costo, se migra a
> Graphiti (servicio Python + graph DB, vía MCP) conservando el mismo modelo
> temporal. Hoy no se justifica. engram queda relegado a episódico crudo o se retira.

### [4.b] Reviewer rejections as a rule source

When the independent reviewer rejects a generation, each correction is distilled
into a candidate `LearningRule` (`distillReviewerCorrections` in
`src/qa/learning/distiller.ts`): the correction text is the rule's `action`,
classified by the anti-pattern catalog (`errorClassFromCorrections`) with
`E-REVIEWER-REJECTED` as fallback when no anti-pattern keyword matches. Candidates
follow the SAME governance as oracle-born rules — they must EARN promotion through
measured outcomes and are deduped against ALL statuses, so a rejected-and-demoted
pattern cannot respawn. Off-path: the wiring lives in `runPipeline` right before
the final `persistOutcome` and is wrapped in try/catch; a distillation failure
logs a warning and never affects the verdict.

### [5] Evaluation Harness — el oráculo de verdad
Lo que convierte "acumular" en "aprender". Tres piezas:

1. **OpenEvals (TS, opcional)** — `npm i openevals`, corre standalone. Normaliza las señales
   *soft* a `{key, score, comment}`: `CODE_CORRECTNESS`, `JSON match`, TypeScript
   type-checker, E2B sandbox execution. **Cuidado:** su LLM-as-judge es
   no-determinista → se usa sólo para señales soft. **El oráculo duro sigue siendo
   determinista** (mutation/coverage), para no reintroducir el lazo circular.

2. **El oráculo de valor (depende del target):**
   - **`code`**: **mutation testing** directo (Stryker para JS/TS, mutmut/cosmic-ray
     para Python, PIT para Java…), **scopeado al diff** (mutar sólo los archivos/líneas
     cambiados, no todo el repo): mutar la fuente, correr la suite del repo, el test
     **debe** ponerse rojo. `valueScore` = % de mutantes atrapados.
   - **`e2e`**: **NO se redespliega** una segunda versión (inviable en productos con
     microservicios). En su lugar, **fault-injection contra el DEV único**: se re-corre
     la suite verde interceptando las respuestas de red con Playwright (`route()`) y
     corrompiéndolas (flip valores, null campos, 200→500, truncar arrays). Si el test
     **sigue verde** → oráculo débil (`E-VALUE-SURVIVED`). Corrupción genérica y ciega
     → **agnóstica al stack**, per-run, sin infra. `valueScore` = % de corrupciones
     detectadas (etiquetado **"response-oracle catch-rate"**, no "valor total").

   > **Alcance del oráculo `e2e` (honesto).** El nivel 1 (respuestas) atrapa la
   > naivety **más común** (el test que confía en la respuesta) pero **no** los bugs de
   > lógica de cliente (KDBush) ni los flujos sin red. Esa clase queda en señal blanda
   > (reviewer + heurísticas) y, sobre todo, la cubre **otro eje**: el currículo de
   > escenarios. El **nivel 2** (mutar el bundle de cliente vía interceptación —
   > buildear sólo el front, sin redeploy) se suma **sólo si** los misses reales
   > muestran que la clase cliente-computado es un punto ciego recurrente. El
   > redeploy-benchmark de pares `(sha_bueno, sha_malo)` queda como **add-on opcional**
   > para apps que ya generan preview-deploy por commit gratis — nunca un requisito.

3. **Scorecard versionado** — el `valueScore` agregado por target → un **scorecard**
   tagueado con el hash de (prompts + ruleset activo). Es lo que demuestra `v1→62%`,
   `v2→68%`… y hace falsable el miedo a "acumular sin aportar". Dos ejes **separados**:
   **fuerza de oráculo** (mutation/fault-injection) y **cobertura de escenarios**
   (currículo) — no dejar que un eje se disfrace del total.

4. **Atribución de outcomes** — cuando una regla aparece en `rulesRetrieved`, el
   `valueScore` del run escribe en su `successRate`. Las reglas que correlacionan
   con buenos resultados se promueven; las que no, decaen y expiran. **Esto es lo
   que lo hace aprender.**

> **El `valueScore` nunca bloquea.** Vive en modo `signal`: registra, enseña,
> alimenta el scorecard y la atribución — pero **sólo los gates deterministas
> (B/C/D en `enforce`) bloquean el publish**. Así una señal no-determinista jamás
> entra al camino crítico.

### [6] Retrieval jerárquico — al agente, honrando el context budget
Inyecta: catálogo global ∩ reglas de app ∩ reglas de flow ∩ reglas del
`errorClass` previsto — `active` primero (rankeadas por `successRate`), con una cola acotada
de `candidate` para exploración. Reusa el mismo canal de prompt que
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
2. **Un mutante** que define "incorrecto" por contraejemplo (mutation de la fuente en
   `code`; fault-injection de respuestas contra el DEV único en `e2e`).
3. **Relaciones metamórficas agnósticas** — "el valor que envié debe aparecer
   transformado en la respuesta/UI".

Sin una de estas, la profundidad no tiene ancla — es un límite teórico, no de
implementación.

### 3. La bondad de una regla se mide, no se juzga
Una regla como *"en flujos con endpoint, afirmar que la respuesta coincide con lo
enviado, no sólo el 200"* es **buena si y sólo si** los runs que la usaron
atraparon más mutantes que los que no — medible en el benchmark. Ahí se promueve;
si no aporta, decae.

> **Límite honesto:** el fault-injection da un oráculo per-run para `e2e`, pero
> **parcial** — cubre la clase "el test confía en la respuesta", no la lógica de
> cliente (KDBush) ni los flujos sin red, que quedan en señal blanda + currículo. El
> sistema **no es zero-shot** sobre clases nuevas; es **monótonamente mejor** en las
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
5. **Nada se sobrescribe — se supersede, reversible.** El modelo temporal del Ledger
   (SQLite: `valid_until` + `supersedes`) preserva linaje; una regla degradada por un
   fluke se **resucita** con evidencia posterior.
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
| **SQLite (`learning_rules`)** | ✅ Ledger (elegido) | [4][6] | El record vive en la SQLite existente, con modelo temporal (`valid_until`+supersede) y confianza estadística. Cero infra nueva. |
| **OpenEvals** | 🟡 Opcional | [5] | Paquete TS, standalone, vive en `src/`. **Conveniencia, no indispensable**: el reviewer ya hace LLM-judging. Adoptar sólo si ahorra trabajo real; si no, hand-roll los 3-4 evaluadores que se usen. Sólo señales soft. |
| **Graphiti** | 🟡 Diferido | [4][6] | El hueco era el gobierno (barato en SQLite), no el motor. Migrar sólo si el grafo de reglas crece hasta justificar traversal/extracción. |
| **DSPy** | 🟡 Fase 3 | [meta] | Offline. Requiere el benchmark primero. Emite prompts versionados. |
| **Mem0** | ⬜ Descartada | — | Alternativa a Graphiti; innecesaria con el Ledger en SQLite. |
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
| **0 — Marcador** | `RunOutcome` append-only + Labeler + taxonomía (enum). Arregla el purge-30d. | — (TS puro) | ✅ hecho (ver review) |
| **1 — Oráculo** | Mutation (`code`, scopeada al diff) + fault-injection de respuestas (`e2e`) + scorecard versionado. | Stryker, Playwright `route()` | ✅ oráculos hechos (commit `1439b12`); scorecard: pendiente persistir |
| **2 — Lazo cerrado** | Reflexión + Ledger SQLite con gobierno: `successRate` estadístico, promoción/histéresis, deprecate-reversible, retrieval por `successRate` (active-first + exploración de candidatas). | SQLite | ✅ gobierno hecho (commit `b10da65`); Reflector ya existía |
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

1. ✅ **Gate a verde** — `Dashboard` vuelto a vista pura (commit `defc3cd`); módulos
   `src/qa/learning/*` ya commiteados; `npm test` 460/460 y sale limpio.
2. ✅ **Lazo de gobierno cerrado** (commit `b10da65`) — `successRate` estadístico (no
   overwrite), promoción/histéresis, deprecate-reversible, retrieval por `successRate`.
3. ✅ **Oráculo `e2e`** — fault-injection de respuestas (seed `_faultInject` + `runFaultInjectionOracle`),
   opt-in `qa.valueOracle: signal`, signal-only. **Limitaciones honestas**: cubre sólo aserciones
   dependientes de la respuesta (no estado-cliente puro); sobre-corrompe (todas las respuestas); el
   comportamiento real con Playwright contra DEV es **boundary sin test**; y los repos ya onboardeados
   necesitan **sincronizar su `e2e/fixtures.ts`** para tener `_faultInject` (mismo problema de
   evolución del seed que `_coverage`).
4. ✅ **Mutation scopeada al diff** en `code` (`selectMutateTargets`).
5. **Lo que falta para que el lazo gire de verdad**: (a) persistir el **scorecard** versionado
   (`updateScorecard` ya existe, falta el sink); (b) validar el oráculo `e2e` contra un DEV real;
   (c) decidir si `code` mutation corre por defecto (hoy sí) dado su costo. Sin `valueScore` real
   fluyendo, el gobierno (ya listo) no promueve nada.
