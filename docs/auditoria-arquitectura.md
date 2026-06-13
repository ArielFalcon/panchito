# Auditoría de arquitectura y calidad — `ai-pipeline`

> Auditoría profunda del producto completo (motor de QA E2E autónomo). Fecha: 2026-06-13.
> Método: lectura exhaustiva por subsistemas + análisis de concerns transversales, con
> **verificación adversaria** de cada hallazgo crítico/alto contra el código real (42 hallazgos
> verificados, **0 refutados**, 24 confirmados, 18 parciales con severidad corregida).
> Alcance: se excluye deliberadamente la TUI legacy en Ink (`src/tui/**`), que será eliminada.

---

## 1. Resumen ejecutivo

### Estado general

`ai-pipeline` tiene un **esqueleto determinista genuinamente bien construido** envuelto en una
**capa de "valor/aprendizaje" que es, en gran medida, teatro** en la configuración que realmente se
ejecuta. Esa es la tensión central del producto, y coincide exactamente con la hipótesis de la auditoría.

Lo que está bien hecho es real y no debe minimizarse: la inyección de dependencias es uniforme y los
seams son testeables; la máquina de verdictos (`pass|fail|flaky|invalid|infra-error|skipped`) es
exhaustiva y mutuamente excluyente; el reviewer *fail-closed* es correcto; la cola secuencial serializa
de verdad; el *boot recovery* finaliza runs zombie antes de aceptar tráfico; el scrubbing de entorno y
los process-tree kills son defensa real. El núcleo (gate → classify → setup → generate+review → static
gate → execute → decide) es de calidad de producción.

El problema es que **el producto se vende por su capa diferenciadora —"un motor que aprende y mide
valor objetivo para escapar del bucle circular LLM-juzga-LLM"— y esa capa no se ejecuta en ninguna
configuración shipping para apps e2e.** El propio CLAUDE.md identifica este riesgo (Goodhart) como el
problema #1 del proyecto, por encima de las features. La auditoría confirma que el riesgo ya se
materializó: de las 4 capas de gate de calidad, **solo 2 bloquean realmente, y ambas son dos LLMs
calificándose mutuamente.**

### Madurez por subsistema

| Subsistema | Madurez | Veredicto en una línea |
|---|---|---|
| Núcleo determinista (gate/classify/execute/decide) | **MVP fuerte** | Producción en su esqueleto; lastrado por la cola de aprendizaje interleaved |
| Boundary del agente (`opencode-client.ts`) | **MVP** | God-module de 1726 líneas con split-brain de modelo y circuit breaker global |
| **Value Oracle + change-coverage (el "keystone")** | **Prototipo** | Inerte en el 100 % de las apps e2e configuradas |
| Learning ledger | **MVP** | Bucle central real, pero exemplars/reflexión/curriculum huecos o gameables |
| Ejecución + static gate | **MVP** | Clasificación rigurosa; falsos verdes en 3 de 6 ecosistemas code-mode |
| Servidor / API / cola / historial | **MVP** | Sólido; un bug de cancel real + god entrypoint |
| Auto-mantenimiento + merge safety | **MVP** | Defensa en capas con bypasses concretos en cada garantía clave |
| Integraciones / publish / git / sanitizer | **MVP** | El módulo más crítico; el scrubber de secretos tiene fugas confirmadas |
| Capa de prompts del agente | **MVP** | El loop básico funciona; la "sofisticación" encima no se consume |
| Observabilidad | **MVP** | No puedes reconstruir *por qué* un verdict ocurrió desde datos durables |

### Principales riesgos (en orden)

1. **CRÍTICO — La propuesta de valor anti-Goodhart no se ejecuta.** El keystone (change-coverage) es
   permanentemente `unknown` en toda app e2e configurada; el Oracle está off/inaplicable en e2e. El
   sistema auto-mergea suites "verdes" aprobadas por un LLM sin ningún contrapeso de ground-truth, y el
   ledger de aprendizaje se entrena en parte con etiquetas fabricadas. (§3-C1)
2. **ALTO — La confianza es irreconstruible.** Cuando el reviewer aprueba (la decisión más
   consecuente del sistema), no se persiste ningún razonamiento; un auto-merge equivocado no es
   auditable. El logging estructurado cubre el 10 % equivocado del output. (§3 OBS-01/OBS-04)
3. **ALTO — Honestidad de fallos rota en los seams.** Un `catch` global convierte *cualquier* excepción
   en `infra-error`, borrando verdicts reales y silenciando Issues; un push de publish rechazado
   descarta un pase verde. (§3 ERR-01/ERR-02)
4. **ALTO — Superficie de auto-modificación y código no confiable.** El agente de code-mode ejecuta
   código arbitrario como root sin sandbox; el "immutable recovery net" del auto-maintainer no protege
   ni la orquestación ni la suite de tests que lo gatea. (§3 SEC-01/SELF-01)
5. **ALTO — "Determinismo" y "sofisticación" son parcialmente aspiracionales.** El mismo SHA no
   reproduce el mismo prompt; varias features avanzadas (exemplar lifecycle, dual-perspective review,
   scorecard, trace-id) están *produced-but-never-consumed*.

### Principales oportunidades

El sistema está **a una distancia sorprendentemente corta de ser bueno**, porque sus huesos son
buenos. Las mayores palancas no son "más prompt tuning" (lo que el propio CLAUDE.md advierte), sino:
(a) hacer que **una** señal de ground-truth funcione de verdad en al menos una app e2e representativa;
(b) **borrar el teatro** (features huecas que inflan complejidad sin entregar valor) o **conectarlo**;
(c) cerrar la honestidad de fallos en los seams; (d) hacer la decisión del reviewer **durable y
auditable**. Esto convierte un producto "pretencioso sobre el papel" en uno honesto y defendible.

---

## 2. Mapa del sistema

### Arquitectura (dos servicios, una frontera HTTP)

```
                         ┌───────────────────────────────────────────────────────────┐
   GitHub webhook  ─────►│  ORQUESTADOR (src/, Node/TS, determinista)                 │
   CLI / API control ───►│                                                            │
                         │  index.ts (god entrypoint: HTTP+auth+queue+maintainer)     │
                         │     │                                                       │
                         │     ▼  enqueueTrackedRun ──► JobQueue (secuencial, 1 a la vez)
                         │  runPipeline (pipeline.ts, ~1000 líneas)                   │
                         │     gate → classify → setup → [GENERATE+REVIEW] → static   │
                         │     gate → execute(DEV) → change-coverage → ORACLE → decide │
                         │        │                         │                          │
                         │        │ HTTP (opencode-client)  │ git push / PR / Issue    │
                         └────────┼─────────────────────────┼──────────────────────────┘
                                  ▼                         ▼
                  ┌───────────────────────────┐   ┌──────────────────────┐
                  │  AGENTE (opencode/, no-det)│   │ GitHub  (publish.ts) │
                  │  qa-generator / qa-reviewer│   │  PR auto-merge / Issue│
                  │  qa-maintainer / Serena/MCP│   └──────────────────────┘
                  └───────────────────────────┘
                         shared volume: mirrors (working copies)
   Persistencia: SQLite (history.ts: runs, run_outcomes, learning_rules, scorecard, curriculum)
                 engram (memoria del agente)  ·  e2e/.qa/manifest.json (en el repo vigilado)
```

### Bounded contexts

| Contexto | Módulos | Responsabilidad |
|---|---|---|
| **Orquestación** | `pipeline.ts`, `server/runner.ts`, `server/queue.ts` | Máquina de estados del run, verdicts, cola |
| **Boundary del agente** | `integrations/opencode-client.ts`, `agent-runtime/*` | HTTP a OpenCode, buildTask, parsing de verdict, manifest |
| **Gate de calidad** | `qa/validate.ts`, `qa/execute.ts`, `qa/change-coverage.ts`, `qa/learning/{mutation-code,fault-injection-e2e}.ts` | 4 capas: estático, reviewer, change-coverage, Oracle |
| **Learning ledger** | `qa/learning/*`, persistencia en `server/history.ts` | label → reflect → distill → store → retrieve → inject → fold |
| **Clasificación / setup** | `qa/commit-classify.ts`, `qa/setup.ts`, `qa/code-runner.ts` | skip/regression/generate; bootstrap; ecosistema code-mode |
| **Servicio HTTP** | `index.ts`, `server/api.ts`, `server/history.ts`, `server/event-bus.ts`, `server/webhook.ts` | API, auth, SSE, historial SQLite, ingesta |
| **Auto-mantenimiento** | `index.ts` (maintainer), `server/{merge-guard,self-update,maintainer}.ts`, `boot-guard.mjs` | Self-fix + gates + canary hot-swap + rollback |
| **Egress / seguridad** | `integrations/{github,publish,repo-mirror}.ts`, `orchestrator/{sanitizer,config-loader}.ts`, `util/redact.ts` | git writes, PRs/Issues, scrubbing de datos que salen |
| **Capa de prompts** | `opencode/AGENTS.md`, `opencode/agent/*.md`, `opencode/skill/**`, `opencode.json` | Donde nace o se pierde el *valor* del test |

### Flujos críticos (reconstruidos)

1. **diff-mode e2e (webhook, el flujo de oro):** webhook → `enqueueTrackedRun` (embudo único) →
   `runPipeline` → gate (saltado si no hay `versionUrl`) → `prepare` (clone+diff) → `classifyCommit`
   (skip/regression/generate, cross-check del diff) → setup (`npm ci`) → **generate+review**
   (≤2 rondas, fail-closed) → static gate (`tsc`+eslint+`playwright --list`+manifest) → health
   pre-flight → **execute contra DEV** (pass/fail/flaky, 1 retry) → change-coverage (solo diff+pass) →
   Oracle (solo no-shadow+signal) → **decide** (PR auto-merge / Issue / cuarentena) → persist + fold
   learning.
2. **code-mode:** sin web ni Playwright; corre la suite propia del repo, clasifica por exit code,
   mutation testing (Stryker) incluido, `publishCode` commitea en cualquier parte del repo.
3. **cross-repo (microservicios):** webhook de un service-repo → diff del service mirror, suite del
   primary mirror; Issues al service, PR al primary; change-coverage siempre `unknown`.
4. **learning loop:** run → `labeler` (errorClass determinista) → `reflector`/`distiller` (reglas) →
   `history` (persist) → `retrieval` (inject al prompt) → `fold` (Oracle fuerte | prevention débil).
5. **auto-maintenance:** incidente → `qa-maintainer` diagnostica → PR → 5 gates → canary hot-swap →
   boot-guard rollback. Auto-merge **off por defecto**.

### Estado real configurado (clave para todo lo que sigue)

| App | Modo | shadow | Oracle | versionUrl | Gates que de hecho bloquean |
|---|---|---|---|---|---|
| **portfolio** (Astro estático, Vercel) | e2e | `true` | `off` | ausente → gate saltado | **Solo static gate + reviewer LLM** (coverage = `unknown`) |
| **panchito** (code-mode) | code | `false` | `signal` (efectivo) | n/a | static + reviewer + **mutation Oracle real** |
| example | (plantilla) | — | — | — | — |

> **El hecho central de la auditoría:** la única app e2e que existe corre con **coverage permanentemente
> `unknown` y Oracle off**. La app que sí ejercita el Oracle es code-mode (`panchito`). Por tanto, para
> el caso de uso estrella —E2E contra DEV— el contrapeso anti-Goodhart **no existe en producción**.

---

## 3. Hallazgos (ordenados por severidad)

> Severidades **corregidas tras verificación adversaria**. Cada hallazgo: problema → por qué →
> riesgo → recomendación. Las referencias son `archivo:línea` verificadas contra el código.

### 🔴 CRÍTICO

#### C1 · El keystone anti-Goodhart está inerte en toda configuración e2e shipping
*(ORACLE-03 + VALUE-ALL, confirmados)*
**Archivos:** `src/qa/change-coverage.ts:149-151,276-298`, `src/pipeline.ts:1099-1156,1185-1192,1323`,
`src/qa/code-runner.ts:175-189`, `src/qa/learning/taxonomy.ts:76-79`, `config/apps/portfolio.yaml`.

- **Qué ocurre.** change-coverage —que el propio código llama "THE VALUE KEYSTONE … the first
  ground-truth signal that breaks the circular LLM-judges-LLM loop"— mapea URLs de scripts V8 a archivos
  fuente por *sufijo de path* (`resolveUrlToRepoFile`). Un sitio Astro/Vercel sirve bundles hasheados
  (`/assets/index-abc123.js`) que no son sufijo de ningún `src/*.astro` → `collectBrowserCoverage`
  retorna `null` → `decideCoverage` retorna `unknown`, que **nunca bloquea**. En code-mode, el runner
  no inyecta ningún flag de cobertura, así que `lcov.info`/`coverage-final.json` casi nunca existen →
  también `unknown`. El default de la política es `signal` (solo registra) y ninguna app fija `enforce`.
  El Oracle es signal-only y "never gates" por construcción, y está `off` en shadow y en `portfolio`.
- **Por qué es crítico.** De las 4 capas de gate, **solo las capas 1 (static) y 2 (reviewer LLM)
  bloquean publish**. La capa 2 es un segundo LLM. No queda ningún ground-truth objetivo: el sistema
  optimiza el proxy "verde + un LLM lo aprueba", que es *exactamente* la deriva de Goodhart que el
  CLAUDE.md prioriza evitar por encima de las features.
- **Defecto puntual que empeora el daño (verificado):** en un no-match, `computeChangeCoverage(changed,
  new Map())` produce `ratio = 0` con `measured:false`, y `pipeline.ts:1323` persiste
  `ccForPersistence?.overall.ratio ?? null` **sin guardar contra `cc.measured`** → persiste `0`, no
  `null`. Ese `0` llega al labeler y se etiqueta `E-COVERAGE-GAP` (`taxonomy.ts:78`). Es decir: un run
  verde genuinamente *no medido* se etiqueta como "gap de cobertura" → **el ledger se entrena con
  etiquetas falsas precisamente en las apps donde la cobertura no es medible.**
- **Riesgo.** Auto-merge de suites verdes-pero-vacías; la suite no atrapa regresiones; el ledger
  entrenado con etiquetas fabricadas; el "backstop" del README inerte para cualquier frontend con
  bundling. El dashboard dice `unknown`/`measured`, lo que se lee como benigno en vez de "el keystone
  no hace nada".
- **Recomendación.** (1) Para code-mode, inyectar cobertura en el comando (`c8`, `vitest --coverage`,
  `pytest --cov`). (2) Para e2e, resolver URL→fuente por **source maps**, no por sufijo (un match por
  sufijo contra bundles hasheados *no puede* funcionar). (3) Arreglar el persist: `cc.measured ?
  cc.overall.ratio : null`. (4) Embarcar al menos **una app e2e representativa con Oracle activo** o
  degradar el lenguaje de "keystone" en la documentación hasta que una ruta sea real.

---

### 🟠 ALTO

> 22 hallazgos altos distintos. Agrupados por tema. Todos verificados contra el código.

#### Confianza / valor (el núcleo del producto)

**A1 · Split-brain del modelo reviewer** *(BND-01 + PROMPT-03, confirmados)* —
`src/agent-runtime/config.ts:27` y 4 archivos + la UI de help dicen que el reviewer es
`qwen3.7-max`, pero `opencode/opencode.json:31` (el archivo que **realmente** corre el reviewer en la
ruta e2e) declara `minimax-m3`, y la ruta de review no pasa override. Consecuencias: (a)
`validateAssignedModels` **lanza** en cualquier reconfiguración runtime ("reviewer model qwen3.7-max is
not available"); (b) la independencia de dos modelos —la justificación de todo el loop de calidad— no
está pinneada ni testeada, así que un edit futuro podría igualar generador y reviewer sin que ningún
test falle. Hoy siguen siendo familias distintas (deepseek vs minimax), así que no está colapsada
*todavía*, pero la documentación y la UI **desinforman activamente**. → Una sola fuente de verdad
(derivar de `opencode.json`) + test que asegure `generador ≠ reviewer`.

**A2 · El reviewer juzga selectores a ciegas** *(PROMPT-02, confirmado)* —
`opencode/agent/qa-reviewer.md:5` le dice al modelo que recibe "the generator's page exploration notes"
y le encarga detectar "selectors match code but not actual DOM" (`:44`), pero `reviewIndependently`
(`opencode-client.ts:642-668`) **nunca** pasa snapshot de DOM ni notas — solo el diff y el texto de los
specs. El prompt incluso se contradice ("you have NO access to the generator's thought process"). La
perspectiva de robustez del reviewer queda neutralizada para la clase de defecto más importante (verdes
sin sentido / selectores frágiles). → O persistir el snapshot DOM del generador como artefacto e
inyectarlo, o borrar la mentira del prompt.

**A3 · La taxonomía de aprendizaje clasifica con regex que el reviewer nunca emite** *(PROMPT-05,
confirmado)* — `taxonomy.ts:33-46` bucketiza rechazos por keywords ("fragile selector", "does not test
the change"…), pero el prompt del reviewer y la skill nunca le piden usar ese vocabulario; sus ejemplos
("replace page.getByText(Pay) with…") no matchean ninguna keyword. Ejecutando los regex reales sobre
los ejemplos: **todos caen al catch-all `E-REVIEWER-REJECTED`.** El único puente entre la prosa del
reviewer y el ledger de fine-grained es no-funcional → el ledger registra ruido casi plano. → Contrato
de productor: el reviewer emite un token de clase cerrado por corrección.

**A4 · El "lifecycle" de skill-exemplar es teatro sobre una tabla congelada** *(LEARN-01, confirmado)* —
`SkillExemplar` lleva `status`/`valueScore`/`usageCount` y `listExemplars(status)` filtra por ellos,
pero `BUILT_IN_EXEMPLARS` es un array hardcodeado (todos `candidate`, `valueScore:null`) que **nunca se
persiste ni muta**; `matchExemplars` ignora esos campos y selecciona solo por forma del diff;
`listExemplars` **no tiene ningún caller** (no existe `skill-exemplar.test.ts`). Un lookup estático
disfrazado de aprendizaje promovible. → O degradarlo a catálogo estático honesto (quitar los campos de
learning), o persistirlo y plegar `valueScore` de verdad.

**A5 · El curriculum sin Oracle acredita "tests rotos en DEV" como "bugs reales"** *(LEARN-03,
confirmado)* — `pipeline.ts:1265`: si no hay `valueScore`, se acredita un arquetipo como `caughtRealBug
= true` cuando `verdict === "fail"` y el reviewer aprobó. Pero un `fail` (`execute.ts:88-91`) es
*cualquier* assertion/locator/timeout fallido — no distingue "detectó una regresión real" de "el test
está mal contra DEV". El curriculum se llena de arquetipos *propensos a fallar* (más Issues), no de los
que atrapan defectos — el agujero de Goodhart en la única señal que el código enmarca como
ground-truth. → Acreditar solo con `valueScore>0` (Oracle) o con bug confirmado por fix posterior.

**A6 · code-runner da falso-verde en Rust/Maven/Gradle con cero tests** *(QACODE-03, confirmado)* —
`ranZeroTests` (`code-runner.ts:281-305`) solo cubre python/go/node/jest/mocha. Cargo/Maven/Gradle
salen `exit 0` cuando compilan pero no recolectan tests → `verdict: "pass"` → PR con auto-merge que
commitea tests que **no ejecutan nada**. Java/Spring es el caso de uso estrella de code-mode. → Añadir
ramas (`running 0 tests`, `Tests run: 0`, `NO-SOURCE`) o tratar exit-0-sin-conteo como `infra-error`.

**A7 · El scorecard "proof-of-improvement" es write-only** *(DATA-01 value-trust, confirmado)* —
`loadScorecard` solo tiene como caller a `saveScorecardEntry` (read-modify-write); ninguna ruta HTTP,
TUI, reviewer ni decisión lee `avgValueScore`/`lastValueScore`. El sistema anuncia "mejora medible
run-over-run" mediante un registro que nadie renderiza; único efecto: crecimiento de disco. → Exponerlo
en `/api` + TUI, o borrarlo (la señal por-run en `chat.ts:49` ya basta).

**A8 · El razonamiento de aprobación del reviewer no se persiste nunca** *(OBS-04, confirmado)* — al
aprobar, el reviewer retorna `corrections:[]`; `reviewerCorrections` queda vacío y no hay campo para su
razonamiento positivo. La decisión más consecuente del sistema (aprobar → auto-merge a un repo
vigilado) **no deja rastro estructurado**: cuando apruebe mal un test sin sentido que luego no atrape
una regresión, auditar "¿por qué lo bendijo?" devuelve vacío. El ledger tampoco aprende de
aprobaciones, solo de rechazos. → El reviewer emite un `rationale` corto en aprobar y rechazar; se
persiste en `RunOutcome.gateSignals`.

#### Resiliencia / honestidad de fallos

**A9 · El catch-all de `runner.ts` lava todo error en `infra-error`** *(ERR-01, confirmado)* —
`runner.ts:181-199` envuelve todo `runPipeline` en un try/catch que fija `verdict:"infra-error"` ante
*cualquier* throw, con la única discriminación de un substring `"run cancelled"`/`DeployTimeoutError`
que ni cambia el verdict. Un 500 de OpenCode, un circuit-breaker abierto, un `JSON.parse` que lanza, un
push de git rechazado → todos se reportan como "infraestructura, ignorar". `infra-error` es el único
verdict que **no abre Issue** y se excluye del flywheel. Viola directamente el invariante "surface
integration errors loudly". → `runPipeline` retorna un verdict tipado; clasificar infra por **tipo de
error** (clase sellada `InfraError`), no por substring; los errores desconocidos abren Issue.

**A10 · Un run verde cuyo push de publish falla se registra como `infra-error` y el pase se pierde**
*(ERR-02, parcial)* — `publishChanges` no envuelve el `push` (`publish.ts:89-95`); un rechazo
(force-with-lease conflict, blip de red) lanza fuera de `runPipeline`, el catch-all lo sobrescribe a
`infra-error`, no abre Issue, y como el stack se desenrolla, `persistOutcome`/`foldRunLearning`
**nunca corren** → el outcome verde ni siquiera se guarda. → Envolver el side-effect de publish para
que un fallo de push preserve el verdict `pass` (como ya hace el fallback de auto-merge).

**A11 · Circuit breaker global compartido entre apps/SSE y no reseteado en restart** *(BND-02,
confirmado)* — `circuitFailures/circuitOpen` son globals de módulo; tras 5 fallos consecutivos el
circuito abre 60s para **todo el proceso** (todas las apps, el reviewer, los workers, el reconnect
SSE). `disposeSharedClient()` (que llama `restart()`) **no resetea el circuito**, así que la acción de
recuperación del operador (rotar API key + restart) queda bloqueada por el estado obsoleto que venía a
limpiar. → Resetear el circuito en `dispose`/`restart`; scope por provider/baseUrl; excluir el SSE
advisory.

**A12 · Colisión de publish con el mismo SHA** *(PUB-01, confirmado)* — las ramas de publish usan solo
el short SHA (`qa/e2e-<short>`) mientras el namespace de datos sí es per-run. En un re-trigger del mismo
SHA (redelivery, retry, continuation) el branch se fuerza-pushea (OK) y luego `createPullRequest` da
422 ("a pull request already exists") **después** del push, lanza, y el run se marca `infra-error`
**y registra un incidente elegible para el maintainer** — pudiendo disparar self-repair por lo que es
un gap de idempotencia. → Branch per-run, o detectar/reusar el PR abierto existente.

#### Seguridad

**A13 · Code-mode ejecuta código no confiable como root sin sandbox** *(SEC-01 code-mode, parcial;
crítico→alto)* — los specs del agente y el `install`/`test` del repo vigilado corren con `spawn(…,
{env: scrubEnv(), detached:true})` (`code-runner.ts:228,419`; `execute.ts:267,341`) dentro del
contenedor orquestador, que corre **como root** (Dockerfile sin `USER`), sin `cap_drop`/`read_only`/
`security_opt`, con egress total y el volumen `mirrors` (todos los repos) montado. `scrubEnv` controla
solo env, no FS ni red. Impacto real: exfiltración del código de todos los repos y de credenciales
`DEV_*` (mantenidas a propósito). *Mitigado:* `GITHUB_TOKEN`/keys están en `BLOCKED_ENV_PREFIX` y el
contenedor del agente no los recibe → no es robo del token de push. → Sandboxear los spawns (gVisor/
contenedor efímero, sin red salvo DEV, `--ignore-scripts`), credenciales DEV efímeras.

**A14 · El "immutable recovery net" del auto-maintainer excluye la orquestación, el boundary de
secretos y la suite de tests** *(SELF-01, parcial; crítico→alto)* — `PROTECTED_PATHS` solo cubre
módulos hoja; **no** incluye `src/index.ts` (que contiene toda la orquestación de gates + `promote()`),
`src/qa/code-runner.ts` (`scrubEnv`, el boundary de secretos), ni `**/*.test.ts` (la suite que el
self-test gate corre). Un fix que (2) debilite `scrubEnv` exfiltra `GITHUB_TOKEN` en el `install`
post-swap; (3) edite `*.test.ts` para que `npm test` pase trivialmente **derrota tanto el self-test
como el `ci` externo**, que corren el mismo `npm test`. El guard externo (CI en main) sigue siendo un
backstop, por eso no es "irrecuperable" → alto, no crítico. → Añadir esos paths a `PROTECTED_PATHS`;
mejor, invertir a allowlist deny-by-default; política para `*.test.ts` (solo adiciones / piso de
cobertura).

**A15 · El canary "health check" es `/api/health` que retorna `{ok:true}` incondicional** *(SELF-02,
confirmado)* — `canaryHealthy()` hace dos GET a un handler estático que solo prueba que el listener
HTTP bindeó. Un fix que rompe el pipeline/git/DB/webhook pero deja el puerto arriba pasa el canary y es
promovido a main. El único check real es la suite pre-deploy, que (A14) el agente puede editar. (El CI
en main sigue siendo backstop). → `/api/ready` profundo (DB, queue, agent runtime, config) como sonda
del canary.

**A16 · El sanitizer (diff→modelo, logs→Issue) no redacta keys `sk-`/`xox-` ni passwords de
connection-string** *(SAN-01, confirmado)* — `sanitizer.ts` es el único redactor en ambos boundaries de
egress, pero no tiene patrón para keys estilo OpenAI/Slack ni `protocol://user:pass@host`; `redact.ts`
**sí** los tiene pero no se aplica en esas rutas. Verificado empíricamente: `sk-proj-…` y
`postgres://admin:s3cr3tP4ss@10.0.0.5/app` pasan sin redactar. Un secreto commiteado por error en un
repo vigilado se manda al LLM de terceros y puede publicarse en un Issue público. → Unificar patrones:
`sanitizeText` delega en `redactSecrets`; test de regresión por cada forma.

#### Concurrencia / datos / observabilidad / arquitectura

**A17 · `cancelRun` aborta el run equivocado** *(API-01 + LIFE-01, confirmados)* — la rama "running"
llama `queue.cancel()` **sin argumento** (`index.ts:856`) aunque existe `queue.cancel(runId)` diseñado
para esto. Con skew de timing (operador cancela A desde una vista stale mientras B ya corre), aborta el
Playwright **de B** contra DEV en vuelo, mientras el historial marca A como "cancelled" y B muere como
infra-error. *Corrección de diagnóstico:* el `runId` tampoco está cableado en `enqueue` (`runner.ts:84`
no lo pasa), así que el fix requiere threadearlo en ambos extremos. → Cablear `runId` en enqueue y
cancel; gatear sobre `queue.current === id`.

**A18 · `passed`/`failed` se escriben dos veces desde dos fuentes de verdad** *(DATA-01 data,
confirmado)* — `addCase()` recomputa con `GROUP BY` sobre `cases`, y el `updateRecord` terminal del
runner los sobrescribe contando el array en memoria. Dos escritores para un valor derivado → pueden
divergir (el TUI y la lógica de continue-failed-cases leen fuentes distintas). → Una sola fuente:
`recalcCounts(id)` desde la tabla `cases`.

**A19 · Los eventos live del run viven solo en memoria** *(OBS-01 events, confirmado)* — el
`RunEventStore` está capado a 200 runs / 500 eventos en memoria, sin persistencia. Un restart (que el
propio canary swap hace con `process.exit(0)`) o el run #201 borran el timeline estructurado
(`step.changed`, `reviewer.verdict`, `coverage.computed`). La observabilidad se degrada justo cuando
pasó algo interesante (un restart). → Persistir eventos terminales a una tabla `run_events`, o
documentarlo como best-effort y caer al proyectado-desde-DB.

**A20 · Dos sistemas de logging; el estructurado cubre casi nada** *(OBS-01 logging, confirmado)* —
`logJson` (el stream JSON para Loki/CloudWatch) se usa en 3 archivos (~20 call-sites, casi todos en la
ruta de auto-maintenance). Toda la lógica de verdict (clasificación, reviewer, coverage, publish,
verdict final) loguea por `console.log` + un blob SQLite volátil (`pipeline.ts:328`, `runner.ts:104`).
Un log shipper ve JSON estructurado para "API request" y texto interleaved para los datos que deciden
outcomes. A las 3am no puedes grepear el razonamiento de un verdict. → Routear `deps.log` por `logJson`
con `{runId, app, sha, step}`; convertir los call-sites de mayor valor a estructurados.

**A21 · `index.ts` es un god entrypoint de 1029 líneas** *(ARCH-01, parcial)* — fusiona routing+auth,
webhook, construcción de cola + drain por señal, la **máquina de estados completa del maintainer**
(~565 líneas: diagnose→commit→PR→5 gates→canary swap→exit, `promote`/`rollback`/`confirmSwapAfterBoot`),
health poller, métricas Prometheus y backup SQLite. Cero `export`, sin `index.test.ts`: la
orquestación de gates es solo ejercitable arrancando el server entero — lo opuesto a la disciplina
DI-everywhere del propio proyecto. (Los gates atómicos *sí* están extraídos y testeados; lo no testeable
es el *glue* de secuenciación). → Extraer `server/maintainer-runtime.ts` (deps inyectadas) y
`server/http-app.ts`; dejar `index.ts` como composition root delgado.

**A22 · La cobertura de cambio nunca alimenta al reviewer/generador en modo `signal`** *(ORACLE-04,
parcial; high→medium pero relevante aquí por el doc-mismatch)* — el header de `change-coverage.ts:15`
dice "signal records + feeds the reviewer", pero el reviewer corre *antes* de medir cobertura (paso 4/5
vs paso 8) y su input no tiene campo de cobertura; el gap solo llega al generador en modo `enforce`. El
loop de feedback anunciado está abierto en el default. → Reordenar para medir antes del reviewer final
e inyectar el ratio, o corregir el doc.

---

### 🟡 MEDIO (selección — lista completa en el apéndice de findings)

- **PIPE-02 · `runPipeline` god-function (~1000 líneas, 8+ closures con estado mutable compartido).**
  El `result = improved` en la rama enforce (`pipeline.ts:1126`) alimenta la decisión final — un edit
  futuro a una variable capturada puede corromper silenciosamente una decisión posterior. (Algoritmos
  *sí* extraídos; el defecto es orquestación monolítica, no lógica enterrada). → Extraer la cola de
  learning a un hook post-run inyectado.
- **ORACLE-01/02 · El Oracle está off en e2e; el scorecard duplica una señal ya consumida.** Matiz
  importante: `panchito` (code-mode) **sí** corre mutation testing y promueve reglas a "high", así que
  el Oracle no está globalmente muerto — está intencionalmente off para un demo estático y on para la
  app code-mode. La verdadera lágrima es e2e.
- **LEARN-04 · Dedup de reglas por string exacto sobre texto LLM freeform; sin pruning; ventana de
  dedup (200) ≠ ventana de retrieval (50)** → el store crece sin límite y la dedup degrada en silencio
  pasadas 200 filas; los candidatos viejos no-promovidos se congelan sin borrarse.
- **ERR-03 · El timeout del agente nunca aborta el request en vuelo** — `session.prompt` no recibe
  AbortSignal y los timeouts de undici se suben *por encima* del deadline; un turno colgado sigue
  quemando tokens/sesión hasta el orphan-sweep de 30 min. El SDK expone `session.abort` (nunca usado);
  solo se llama `session.delete`. → Cablear `session.abort` en timeout/cancel.
- **PROMPT-01 · El verdict dual-perspective del reviewer (`perspectiveA/B`, `valueIssues`,
  `robustnessIssues`) se produce pero nadie lo consume** — solo se leen `approved`+`corrections`. Los
  issues identificados que el modelo no reitere en `corrections` se pierden. → Aplanar a `corrections`
  o borrar la estructura del contrato.
- **LIFE-02 · "Mismo SHA → mismo resultado" es falso** — el prompt de diff inyecta reglas/curriculum/
  bias por `recentErrorClass` que mutan entre runs. La lógica de flujo *sí* es determinista; el prompt
  LLM no es reproducible. → Persistir `promptSections`/`retrievedRuleIds` en el RunRecord para replay.
- **LIFE-03 · Incidentes + `maintainerStatus` + contador `fails` del health-poller son in-memory** —
  cualquier restart (incluido el del propio swap) los borra; un servicio en crash-loop resetea `fails`
  a 0 cada boot y puede no escalar nunca. → Persistir a SQLite/volumen.
- **OBS-02/03/05 · El `trace-id` se captura una vez y no se propaga (tracing falso); los logs
  estructurados no llevan `runId`; solo 2 gauges Prometheus** (sin contador de verdicts, sin histograma
  de duración, sin error/reviewer-outage). Los datos existen en SQLite — falta exponerlos como
  *alertables*. → `runId` en cada log; counters `runs_total{verdict}` + histogramas.
- **CONC-01 · `currentRun()` (query DB) se trata como autoridad de "el run que corre" pero puede
  divergir de la cabeza real de la cola** (cancel, mirror-prune, agent-runtime-busy confían en ella).
- **DATA-02..06 · SQLite sin `busy_timeout`** (SQLITE_BUSY bajo backup/lector externo); blobs JSON
  (curriculum, scorecard) parseados sin validación zod (una fila mala crashea); `sha256` por spec
  escrito pero nunca verificado; migración ad-hoc additive-only (un `NOT NULL` futuro crashea DBs
  existentes); learning store sin límite de tamaño.
- **SELF-05..08 · El "outer guard" lee un agregado de *todos* los checks, no el `ci` requerido por
  nombre; `bootGuardDecision()` puro y testeado no lo usa la ruta real (lógica duplicada inline); un
  run nuevo puede arrancar en la ventana de swap; el "learning" de fallos del maintainer es solo prosa
  asesora, sin bloqueo estructural de re-intentar un fix en crash-loop.**
- **CFG-01/02 · Expansión `${VAR}` solo UPPERCASE** (un `${myToken}` mal-casado pasa literal); una env
  var faltante **descarta la app entera** del matcher de webhook (caught-and-skipped a nivel warn).
- **SAN-02 / AUD-01 · El patrón base64-secret mutila contenido legítimo del diff** (hashes de lockfile,
  SHAs de git) enviado al modelo; el mapa `SECRET_AUDIT` se escribe en cada run y no se lee nunca (leak
  de memoria + métrica "fail-closed" muerta).
- **BND-04..08 · Dos routers de activity con reglas divergentes** (vistas live y persistida en
  desacuerdo); `extractText` descarta partes no-text (un verdict emitido como tool-part se pierde →
  fail-closed); extracción de mensaje final de Codex adivina el campo JSONL.
- **PUB-02 · El auto-merge e2e no depende de ningún check** para un repo sin branch protection; el
  comentario "merges once required checks pass" exagera la seguridad.
- **QACLS-04 / QAGATE-05/06 · commit-classify ignora cambios en config-as-code** (`.json`/`.yaml`/
  Dockerfile bajo `chore`/`build` no escala a `generate`); la regla de lint que protege la cobertura es
  trivialmente evitable; el static gate esconde fallos reales de `tsc`/`eslint` tras un path de
  infra-error tragado.

### 🟢 BAJO (selección)

PIPE-07 (`flaky → quarantine` es solo un log line; los specs se descartan en silencio, sin lista de
cuarentena ni aislamiento) · BND-03 (manifest escrito desde el self-report del agente sin reconciliar
contra disco — entradas fantasma; latente hasta que existan consumidores id-keyed) · QAGATE-01 (el
static gate nunca liga manifest↔specs en disco — gap de defensa-en-profundidad latente) · QAEXEC-02
(la config seed corre cada spec en 2 viewports; cobertura solo Chromium; el feed live double-cuenta —
mayormente cosmético; el verdict **sí** es determinista, refutada la corrupción) · ORACLE-05
(fault-injection: la tesis de "corrompe la DB de DEV" es **refutada** — solo muta respuestas, no
requests; queda un confound real de señal: un "kill" por flujo roto se confunde con assert fuerte) ·
PIPE-08 (el schema documenta default `off` pero el pipeline default-ea `signal`) · LEARN-06 (`usageCount`
write-only) · MIR-01 (remoción incondicional de `index.lock` asume que todo lock es stale pese a
compartir el volumen con el agente) · CFG dead code (`mergeNow()` huérfano en `promote()`).

---

## 4. Bugs potenciales (con explicación)

| # | Bug | Disparador | Efecto | Ref |
|---|---|---|---|---|
| B1 | Persist de `coverageRatio = 0` en run no medido | Frontend con bundling (toda app e2e real) | Etiqueta `E-COVERAGE-GAP` falsa entrena el ledger | `pipeline.ts:1323`, `taxonomy.ts:78` |
| B2 | Cancel aborta el run equivocado | Skew de timing operador↔cola | Mata Playwright en vuelo de otro run; audit trail falso | `index.ts:856` |
| B3 | Run verde con push fallido → `infra-error`, outcome no persistido | Rechazo de push (conflict/red) | Suite que pasó se pierde; ledger sub-cuenta éxitos | `publish.ts:95`, `runner.ts:185` |
| B4 | Falso-verde code-mode (Rust/Maven/Gradle, 0 tests) | Repo compila pero no recolecta tests | PR auto-merge de tests que no ejecutan nada | `code-runner.ts:304` |
| B5 | Colisión publish mismo-SHA → 422 tras force-push | Redelivery/retry/continuation | Pase no publicado + incidente espurio al maintainer | `publish.ts:122`, `github.ts:89` |
| B6 | Circuit breaker abierto sobrevive al restart | Rotar key + restart tras 5 fallos | La recuperación del operador queda bloqueada 60s | `opencode-client.ts:146` |
| B7 | `*.test.ts` editable por el auto-maintainer | Fix que gut-ea la suite | Derrota self-test gate **y** CI externo | `merge-guard.ts:26` |
| B8 | `sk-`/`xox-`/DB-pass sin redactar | Secreto commiteado en repo vigilado | Fuga al LLM de terceros / Issue público | `sanitizer.ts:21` |
| B9 | Turno de agente colgado no se aborta | Loop de tool infinito | Sesión + gasto LLM hasta orphan-sweep (30 min) | `opencode-client.ts:1658` |
| B10 | Health-poller con thresholds `===` | Tick saltado bajo carga (>60s) | El incidente "likely crashed" nunca se registra | `index.ts:526` |
| B11 | `verdict=flaky` por viewport | Spec flaky en mobile, limpio en desktop | Cuarentena de un run que está bien en desktop (conservador, pero opaco) | `playwright-report.ts:88` |
| B12 | SQLite sin `busy_timeout` | Backup online de 24h + lector externo | `SQLITE_BUSY` lanzado al escritor | `history.ts` |
| B13 | App descartada del matcher por env faltante | `${VAR}` no resoluble en YAML | Webhooks de esa app ignorados en silencio (warn) | `config-loader.ts` |

---

## 5. Deuda técnica (impacto relativo)

| Deuda | Impacto | Esfuerzo | Notas |
|---|---|---|---|
| **Capa de valor inerte / teatro** (C1, A4, A7, PROMPT-01, ORACLE-02, LEARN-06) | 🔴🔴🔴 | Alto | Es *el* riesgo del producto. Conectar o borrar. |
| **God-modules** (`index.ts` 1029, `pipeline.ts` ~1000, `opencode-client.ts` 1726) | 🔴🔴 | Alto | Top-3 en churn; cada cambio arriesga features no relacionadas |
| **Honestidad de fallos en seams** (ERR-01/02/03, runner catch-all) | 🔴🔴 | Medio | Viola el invariante #1; mina la confianza directamente |
| **Observabilidad de la decisión** (OBS-01/03/04/05) | 🔴🔴 | Medio | No puedes auditar un auto-merge equivocado |
| **Persistencia frágil** (DATA-02..06: sin migraciones, sin validación de blobs, sin busy_timeout, sin pruning) | 🟠 | Medio | Bomba de tiempo a medida que crece el historial |
| **Split-brain de config** (A1, PROMPT-04: model ids placeholder sin assert) | 🟠 | Bajo | Una fuente de verdad + un test |
| **Estado global de módulo** (circuit breaker, `consecutiveReviewerFailures`, curriculum cache, incidents) | 🟠 | Medio | Cross-app, restart-volátil; rompe aislamiento y determinismo |
| **Doc-vs-código** (varios headers anuncian comportamiento que el código no tiene) | 🟠 | Bajo | Erosiona confianza del que mantiene; corregir o implementar |
| **Sandbox de code-mode** (SEC-01) | 🟠 | Alto | Aceptable bajo "repo semi-confiable", pero es RCE-as-root |

---

## 6. Plan de transformación (priorizado)

> Principio rector (del propio CLAUDE.md): **estable, confiable, determinista — por encima de
> features.** La estrategia es *primero honestidad, luego valor real, luego escala.* No "más prompt
> tuning".

### Fase 0 — Quick wins (días; bajo riesgo, alto retorno en confianza)

1. **Decir la verdad en config y docs.** Una sola fuente de verdad para los model ids (derivar de
   `opencode.json`); borrar/corregir los headers que anuncian comportamiento inexistente
   (`change-coverage` "feeds the reviewer", reviewer "exploration notes", exemplar "lifecycle"). Test
   que asegura `generador ≠ reviewer`. *(A1, A2, A22, PROMPT-04)*
2. **Arreglar el persist de cobertura:** `cc.measured ? cc.overall.ratio : null` — deja de envenenar el
   ledger con `E-COVERAGE-GAP` falsos. *(C1 puntual / B1)*
3. **Cablear `runId` en `enqueue` + `cancel`** y gatear sobre `queue.current === id`. *(A17 / B2)*
4. **Envolver el side-effect de publish** para preservar el `pass` cuando el push falla; persistir el
   outcome antes de publicar. *(A10 / B3)*
5. **Cerrar el sanitizer:** `sanitizeText` delega en `redactSecrets`; tests de regresión por
   `sk-`/`xox-`/`://user:pass@`. *(A16 / B8)*
6. **`ranZeroTests` para cargo/maven/gradle** (o tratar exit-0-sin-conteo como infra-error). *(A6 / B4)*
7. **Resetear el circuit breaker en `dispose`/`restart`.** *(A11 / B6)*
8. **`busy_timeout` + WAL** en la apertura de SQLite; validación zod al leer blobs persistidos. *(DATA)*
9. **Borrar el teatro de bajo coste:** `usageCount` write-only, `SECRET_AUDIT` muerto, `mergeNow()`
   huérfano, los campos `perspectiveA/B` no consumidos (o aplanarlos a `corrections`). *(PROMPT-01, AUD-01)*

### Fase 1 — Mejoras estructurales (semanas; cierran la honestidad de fallos y la auditabilidad)

10. **Refactor del catch-all de `runner.ts`:** `runPipeline` retorna un verdict tipado; clasificar
    infra por **clase de error sellada**, no por substring; errores desconocidos → Issue, no
    `infra-error`. *(A9)*
11. **Persistir la decisión:** `rationale` del reviewer (aprobar y rechazar) en `RunOutcome`; eventos
    terminales del run en una tabla `run_events`; `runId` en cada log estructurado; counters/histogramas
    Prometheus para verdict/duración/error/reviewer-outage. *(A8, A19, A20, OBS-03/05)*
12. **Una sola fuente para `passed`/`failed`** (`recalcCounts` desde `cases`). *(A18)*
13. **Persistir el estado del maintainer y los incidentes** (SQLite/volumen) para que la escalada
    consecutiva sobreviva a restarts. *(LIFE-03, SELF-03/04)*
14. **Pruning + normalización del rule store** (key normalizada; GC de candidatos demotidos/viejos;
    alinear ventanas dedup/retrieval). *(LEARN-04)*
15. **`session.abort` en timeout/cancel** para no fugar sesiones/cómputo. *(ERR-03 / B9)*

### Fase 2 — Refactors mayores (descomponer los god-modules)

16. **`opencode-client.ts` → 5 módulos:** circuit-breaker, lifecycle de cliente, stream/activity,
    prompt-assembly (buildTask), verdict/plan parsing + manifest. *(BND-08)*
17. **Extraer la cola de learning de `runPipeline`** a un único colaborador post-run inyectado, dejando
    el archivo como máquina de estados determinista + decisión publish/issue; eliminar la mutación de
    `result`/`run` por closures compartidos. *(PIPE-02)*
18. **`index.ts` → `server/maintainer-runtime.ts` + `server/http-app.ts`**, `index.ts` como composition
    root delgado; tests unitarios de la secuenciación de gates. *(A21)*

### Fase 3 — Cambios arquitectónicos (lo que de verdad rompe el círculo de Goodhart)

19. **Hacer real *una* señal de ground-truth en e2e.** Resolución URL→fuente por **source maps** (no
    sufijo) para change-coverage, y/o embarcar una app e2e con backend JSON donde fault-injection sea
    significativo. Sin esto, todo lo demás del "value/trust" es ceremonia. *(C1)*
20. **Promover `enforce` como default operativo una vez que la cobertura sea medible** — que la capa 3
    bloquee de verdad, no solo registre.
21. **Sandbox de code-mode** (contenedor efímero sin red salvo DEV, `--ignore-scripts`, FS de solo
    lectura salvo el working copy, credenciales DEV efímeras). *(A13)*
22. **Endurecer el auto-maintainer:** `PROTECTED_PATHS` invertido a allowlist deny-by-default
    (incluyendo `index.ts`, `code-runner.ts`, `*.test.ts`); canary como sonda profunda
    (`/api/ready`); outer guard ligado al check `ci` por nombre. *(A14, A15, SELF-05..08)*

---

## 7. Visión objetivo

El `ai-pipeline` *después* de la transformación es el mismo producto, pero **honesto y con un
contrapeso de valor que funciona** — no una superficie pulida sobre maquinaria inerte.

- **El esqueleto determinista permanece** (es bueno) pero queda **aislado**: `runPipeline` es una
  máquina de estados legible cuyo único trabajo es gate→classify→generate→validate→execute→decide; la
  cola de aprendizaje es un hook post-run inyectado, testeable y borrable sin tocar el verdict. Los tres
  god-modules se descomponen en colaboradores con una sola responsabilidad.
- **La capa de valor o entrega valor o no existe.** Hay **al menos una señal de ground-truth que
  realmente corre** en la configuración shipping (change-coverage por source-map en e2e, o mutation en
  un code-repo representativo), gateando publish en `enforce`. Toda feature de "learning" que no se
  consume se conecta o se borra; el dashboard distingue confianza basada en ground-truth de confianza
  basada en proxy, y nunca presenta `unknown`/proxy como "measured". El círculo de Goodhart está roto
  porque hay un eje objetivo, no porque haya dos LLMs.
- **Cada verdict es reconstruible.** El razonamiento del reviewer, las reglas inyectadas, el score del
  Oracle, la razón del flaky y el timeline del run son durables y correlacionados por `runId` en una
  superficie consultable. Un auto-merge equivocado se audita en minutos, no se adivina. Hay métricas
  alertables para los tres pasos más frágiles (turno de agente, ejecución, publish).
- **Los fallos son honestos en los seams.** `infra-error` se reserva para infraestructura clasificada
  por tipo; un fallo de integración o un pase verde no publicado nunca se disfraza de "ignorar"; nada
  se traga en un resultado benigno.
- **Las fronteras de confianza son reales.** El código no confiable corre sandboxeado; el
  auto-maintainer no puede editar la orquestación, el boundary de secretos ni la suite que lo gatea; el
  canary prueba función, no solo que el puerto bindeó.

El resultado es un sistema que un equipo puede creer: cuando dice "esta suite verde cubre tu cambio y
atrapa regresiones", lo respalda con una señal objetiva y un rastro auditable — que es exactamente la
promesa que hoy hace sobre el papel pero no cumple en ejecución.

---

### Apéndice — Metodología

15 auditores en paralelo (9 por subsistema + 6 transversales) leyeron el código en profundidad y
emitieron 120 hallazgos estructurados; 42 hallazgos críticos/altos pasaron por verificación adversaria
independiente contra el código (24 confirmados, 18 parciales con severidad corregida, **0 refutados**).
Las severidades de este informe son las *corregidas tras verificación*. Detalle por hallazgo con
evidencia `archivo:línea` disponible en la corrida de auditoría.
