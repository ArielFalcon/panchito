# Diseño: comparación A/B por experimento controlado

**Fecha:** 2026-06-14
**Estado:** diseño aprobado — **implementación EN PAUSA** (ver precondición abajo).
**Objetivo:** medir y comparar dos configuraciones del agente (ej. cambiar una
herramienta/modelo) sobre una base idéntica, para saber si una mejora o empeora
el producto en **calidad, velocidad y consumo de recursos** — vía un endpoint
read-only que un agente (o el cliente Go) pueda consultar.

> ## ⚠ Precondición antes de implementar
>
> Al momento de escribir este spec, el working tree tenía **trabajo concurrente
> activo** (una "foundation upgrade" + migración del TUI React/Ink → cliente Go:
> ~129 archivos sin commitear, con ediciones en vivo). **10 de los 11 archivos
> hub** que esta implementación toca están en flujo, y `src/server/trends-view.ts`
> —cuyos helpers de agregación este diseño reusa— estaba *untracked* (ni
> commiteado). **No implementar sobre ese estado.** Antes de arrancar:
> 1. Esperar a que la foundation upgrade **aterrice** (commit/merge).
> 2. **Re-anclar este spec** contra el estado asentado (las referencias a
>    `types.ts` / `history.ts` / `api.ts` / `trends-view.ts` asumen el estado
>    commiteado de 2026-06-14 y van a cambiar).
> 3. Implementar en un **git worktree aislado** sobre base limpia, con footprint
>    mínimo en los archivos hub. Si `trends-view.ts` no quedó commiteado, escribir
>    helpers de agregación propios en vez de depender de él.

---

## 1. Contexto y problema

Hoy el pipeline mide bien la **calidad** por run (verdict, change-coverage,
value-oracle, reviewer, error-class, flaky) y **parcialmente la velocidad**
(`durationMs` por caso, `step_started_at` por fase). Pero:

1. **No captura recursos.** El SDK de OpenCode ya devuelve `cost` (USD),
   `tokens` (input/output/reasoning/cache) y `modelID` en cada mensaje del
   asistente (`node_modules/@opencode-ai/sdk/dist/gen/types.gen.d.ts`), pero se
   descartan en el parseo de [opencode-client.ts](../../../src/integrations/opencode-client.ts).
2. **No registra qué config produjo cada run.** El `AgentRuntimeConfig` (mode +
   provider+model por rol) se resuelve de env vars al iniciar el proceso
   ([config.ts](../../../src/agent-runtime/config.ts)) y es global, no por-run.
   Ni `RunRecord` ni `RunOutcome` ([types.ts](../../../src/types.ts)) guardan la
   config. Sin esa atribución, un A/B es **imposible de definir**: tras cambiar
   una herramienta y reiniciar, los runs anteriores y posteriores son
   indistinguibles en los datos.
3. **No existe comparación run-vs-run ni cohorte-vs-cohorte.** Sí existe
   comparación período-vs-período en [trends-view.ts](../../../src/server/trends-view.ts),
   pero está casada con ventanas temporales, no con variantes.

## 2. Decisiones tomadas

| # | Decisión | Elección |
|---|---|---|
| 1 | Unidad de comparación | **Cohortes por variante** (N runs por lado, medianas + dispersión; aguanta el no-determinismo del LLM) |
| 2 | Equidad / comparabilidad | **Experimento controlado**: fija app + modo + target + set de SHAs; las variantes corren contra esa misma base |
| 3 | Ejecución | **Read-only (medir y comparar)**: las corridas se disparan externamente con tags; el sistema valida el fingerprint, no orquesta el cambio de config |
| 4 | Salida | **Cruda**: agregados + deltas + n + dispersión, sin veredicto embebido (el agente juzga) |
| 5 | Arquitectura de almacenamiento | **Enfoque 1**: tablas dedicadas `experiments` + `experiment_variants`, reusando los helpers de agregación de `trends-view` |

## 3. Alcance

**Incluye:**
- Captura de recursos (cost/tokens/wall-clock/agent-time/models) en `RunOutcome`.
- Captura del fingerprint de config por run (en *todo* run, no solo de experimento).
- Registro de experimentos (CRUD) + tagging de runs con `experimentId`+`variant`.
- Validación de fingerprint y de comparabilidad (exclusión + warnings).
- Endpoint de comparación read-only con agregados, deltas y **breakdown por SHA**.
- Exposición en el contrato OpenAPI y en el cliente Go (el "SDK").

**No incluye (fase 2 / fuera):**
- Orquestar la ejecución de las variantes (aplicar config A → correr → aplicar B
  → correr). Requiere config por-run en vez de env-global y toca el path sensible
  de aplicar config; se deja para una fase posterior.
- Significancia estadística formal (Mann-Whitney / bootstrap / p-values). Con n
  chico engaña más que ayuda; se entrega dispersión + warnings de n bajo.
- Dashboards externos (Grafana/Prometheus, Langfuse). Opcionales y ortogonales.

## 4. Modelo de datos

### 4.1 Tablas nuevas (en [history.ts](../../../src/server/history.ts), mismo patrón SQLite + migraciones idempotentes)

```sql
CREATE TABLE IF NOT EXISTS experiments (
  id         TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  app        TEXT NOT NULL,
  mode       TEXT NOT NULL,           -- RunMode
  target     TEXT NOT NULL,           -- 'e2e' | 'code'
  shas       TEXT NOT NULL,           -- JSON string[] : la base fija
  status     TEXT NOT NULL DEFAULT 'open',  -- 'open' | 'closed'
  note       TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS experiment_variants (
  experiment_id TEXT NOT NULL,
  variant       TEXT NOT NULL,        -- label libre, ej. 'baseline' / 'candidate'
  config        TEXT NOT NULL,        -- JSON: AgentRuntimeConfig declarado
  note          TEXT,
  PRIMARY KEY (experiment_id, variant)
);
```

### 4.2 Columnas nuevas en `run_outcomes`

```sql
ALTER TABLE run_outcomes ADD COLUMN experiment_id      TEXT;     -- nullable
ALTER TABLE run_outcomes ADD COLUMN variant            TEXT;     -- nullable
ALTER TABLE run_outcomes ADD COLUMN config_fingerprint TEXT;     -- JSON, SIEMPRE
ALTER TABLE run_outcomes ADD COLUMN variant_mismatch   INTEGER DEFAULT 0;
ALTER TABLE run_outcomes ADD COLUMN resources          TEXT NOT NULL DEFAULT '{}';
```

### 4.3 Wall-clock en `runs`

```sql
ALTER TABLE runs ADD COLUMN started_at  TEXT;   -- enqueued → running
ALTER TABLE runs ADD COLUMN finished_at TEXT;   -- → done
```

### 4.4 Tipos TypeScript

```ts
// Recursos acumulados de un run. Campo null = no disponible (NUNCA 0 fabricado).
export interface RunResources {
  costUsd: number | null;          // suma de message.cost sobre todas las sesiones
  tokensIn: number | null;
  tokensOut: number | null;
  tokensReasoning: number | null;
  tokensCacheRead: number | null;
  tokensCacheWrite: number | null;
  wallClockMs: number | null;      // started_at → finished_at
  agentMs: number | null;          // suma de duración de prompts del agente
  models: string[];                // modelIDs que efectivamente corrieron
}

// El fingerprint que se valida contra la config declarada de la variante.
export interface ConfigFingerprint {
  mode: AgentMode;                 // 'single' | 'dual'
  assignments: Record<"primary" | "reviewer" | "chat",
    { provider: AgentProvider; model: string }>;
}

export interface Experiment {
  id: string;
  name: string;
  app: string;
  mode: RunMode;
  target: TestTarget;
  shas: string[];
  status: "open" | "closed";
  note?: string;
  createdAt: string;
  variants: Array<{ variant: string; config: ConfigFingerprint; note?: string }>;
}
```

`RunOptions` suma `experimentId?: string` y `variant?: string`; `RunOutcome`
suma `resources: RunResources`, `configFingerprint: ConfigFingerprint`,
`experimentId?`, `variant?`, `variantMismatch: boolean`.

## 5. Captura

Respeta la DI: cada strategy del agent-runtime devuelve el `usage` junto al
resultado; `runPipeline` lo **acumula**. La llamada real al SDK sigue siendo el
borde deliberadamente no cubierto; la lógica de acumulación sí se testea.

- **Recursos (OpenCode):** en [opencode-client.ts](../../../src/integrations/opencode-client.ts),
  donde hoy se descarta todo menos el verdict, capturar `cost` + `tokens` +
  `modelID` del/los mensaje(s) del asistente y devolverlos por el facade. El
  pipeline suma sobre todas las sesiones del run (generación + rondas de review +
  regeneración por coverage).
- **Recursos (Codex):** capturar el uso de tokens de los eventos de `codex exec`.
  `costUsd` degrada a `null` si Codex no lo reporta.
- **Wall-clock:** stamp `started_at` en la transición enqueued→running y
  `finished_at` en →done.
- **Fingerprint:** al arrancar el run, serializar el `AgentRuntimeConfig`
  resuelto a `config_fingerprint`. Es la clave de atribución y lo que se valida.

## 6. Validación de fingerprint y comparabilidad

Cuando un run llega taggeado con `experimentId` + `variant`:

1. **Mismatch de config:** si `config_fingerprint` ≠ config declarada de esa
   variante (comparación normalizada de mode + provider+model por rol) →
   `variant_mismatch = true`.
2. **Fuera de base:** si `app` / `mode` / `target` / `sha` del run ∉ base
   declarada del experimento → marcado como fuera de base.

Los runs con mismatch o fuera de base **se guardan igual** pero el compare los
**excluye de los agregados** y los reporta en `cohorts[x].excluded` + `warnings`.
Nunca se cuela silenciosamente un run con la config equivocada. (Determinismo y
confiabilidad sobre celo.)

## 7. Módulo de comparación (`src/server/experiment-compare.ts`)

Función pura `compareExperiment(experiment, outcomes, a, b) -> ComparisonView`.
Reusa los helpers de mediana/dispersión de
[trends-view.ts](../../../src/server/trends-view.ts) (no su forma de ventana
temporal). Unit-testeable con stubs.

**Identidad A/B:** explícita por query param. `a` y `b` nombran dos labels de
variante del experimento. `A = la variante que pasás como a`. Sin ambigüedad, y
un experimento puede tener >2 variantes.

```ts
interface MetricDelta {
  a: number | null;
  b: number | null;
  deltaAbs: number | null;     // b - a
  deltaPct: number | null;     // (b - a) / a
  spread: { a: number | null; b: number | null };  // IQR por cohorte
}

interface ComparisonView {
  experiment: { id: string; name: string; app: string; mode: RunMode; target: TestTarget; shas: string[] };
  variants: { a: string; b: string };
  cohorts: {
    a: { n: number; excluded: number; runIds: string[] };
    b: { n: number; excluded: number; runIds: string[] };
  };
  metrics: {
    quality: {
      passRate: MetricDelta;            // pass / completados
      coverageRatio: MetricDelta;       // change-coverage
      valueScore: MetricDelta;          // mutation kill — señal fuerte de regresión
      reviewerApprovalRate: MetricDelta;
      flakyRate: MetricDelta;
      invalidRate: MetricDelta;
    };
    speed: {
      wallClockMs: MetricDelta;
      suiteDurationMs: MetricDelta;     // suma de durationMs de casos
      agentMs: MetricDelta;
    };
    resources: {
      costUsd: MetricDelta & { sum: { a: number | null; b: number | null } };
      tokensIn: MetricDelta;
      tokensOut: MetricDelta;
      tokensReasoning: MetricDelta;
    };
  };
  // Lo que las medianas de cohorte esconden: una regresión en UN commit puntual.
  perSha: Array<{
    sha: string;
    passRate: { a: number | null; b: number | null };
    valueScore: { a: number | null; b: number | null };
    coverageRatio: { a: number | null; b: number | null };
    regressed: boolean;   // true si B cae respecto de A en este SHA por encima del umbral
  }>;
  warnings: string[];     // n bajo, desbalance, runs excluidos por mismatch/fuera-de-base
}
```

**Agregación:** mediana (+ IQR como `spread`) por cohorte; recursos también
exponen `sum` para costo total. Runs `skipped` / `infra-error` se excluyen de los
agregados de calidad (no son señal de calidad del código) pero se cuentan. Una
métrica sin datos reporta `null`, no `0`.

**`regressed` por SHA:** `true` cuando, para ese SHA, B baja respecto de A en
`valueScore` o `passRate` por encima de un umbral de regresión (default `0.05`).
Esto convierte "¿introduce regresiones?" en una bandera por commit en vez de un
cálculo manual.

## 8. Endpoints (control-plane; el handler matchea `/api/...`, el contrato declara `/api/v1/...`)

| Método | Path | Qué hace |
|---|---|---|
| POST | `/api/experiments` | crea experimento + variantes (con config declarada) |
| GET | `/api/experiments?app=` | lista experimentos de una app |
| GET | `/api/experiments/:id` | un experimento (defs de variante + conteo de runs) |
| GET | `/api/experiments/:id/compare?a=&b=` | **la comparación** (read-only, determinística) |
| POST | `/api/experiments/:id/close` | deja de aceptar runs (opcional) |

`POST /api/runs` y el CLI (`--experiment`, `--variant`) suman el tagging.
Handlers nuevos en [api.ts](../../../src/server/api.ts) siguiendo el patrón de
match por método+path existente.

## 9. SDK

"SDK" = el cliente Go en [client/](../../../client/internal/api/client.go) + el
contrato OpenAPI (fuente de verdad).

- **Contrato:** agregar paths + schemas (`Experiment`, `ExperimentVariant`,
  `CreateExperimentInput`, `ComparisonView`, `RunResources`) en
  [openapi.ts](../../../src/contract/openapi.ts). El guard `openapi.test.ts`
  mantiene contrato ↔ handlers en sync.
- **Cliente Go:** métodos tipados en [client.go](../../../client/internal/api/client.go):
  `CreateExperiment`, `ListExperiments`, `GetExperiment`,
  `CompareExperiment(ctx, id, a, b) (contract.ComparisonView, error)`, y los
  tipos correspondientes en
  [types.gen.go](../../../client/internal/contract/types.gen.go). Esto es lo que
  "un agente consulta": llama `CompareExperiment` y recibe los deltas + el
  `perSha` crudos.

## 10. Manejo de errores y guardas

- Experimento / variante inexistente → `404`.
- Variante fuera del experimento, o `a == b` → `400`.
- Cohorte con `n == 0` → vista con cohorte vacía + warning (no error: determinismo).
- `n` por debajo de `minSamples` (default `3`) → devuelve números + warning
  `low-confidence` (no bloquea; la salida es cruda).
- Desbalance entre cohortes o por-SHA → warning con la composición.
- Recursos `null` (ej. Codex sin cost) → la métrica reporta `null`, no `0`.

## 11. Testing (patrón DI)

- `experiment-compare.test.ts` — math de agregación/deltas/IQR, exclusión por
  mismatch y fuera-de-base, `perSha.regressed`, warnings de n bajo, recursos null.
- adds en `history.test.ts` — CRUD de experimento, tagging y persistencia de
  fingerprint/recursos, validación de mismatch.
- adds en `api.test.ts` — routing de los endpoints nuevos, casos 404/400.
- `openapi.test.ts` — paridad contrato ↔ handler para las nuevas operaciones.
- acumulación de recursos en el pipeline con una strategy stub que devuelve
  `usage` falso (la llamada real al SDK queda como borde no cubierto).

## 12. Flujo de uso end-to-end (escenario "probar obscura")

Pedido: *"probar obscura para ver si optimiza las ejecuciones sin perder calidad
ni introducir regresiones."*

1. **Crear experimento** fijando app/modo/target + un set de commits
   representativos, declarando dos variantes: `baseline` (config actual) y
   `candidate` (idéntica pero con obscura en el rol bajo prueba).
2. **Correr ambas cohortes** (read-only): aplicar la config de A vía
   [`PUT /api/v1/agent/config`](../../../src/server/api.ts) +
   [`POST /api/v1/agent/restart`](../../../src/server/api.ts), disparar los runs
   de `baseline` (tag `experimentId`+`variant`), repitiendo cada SHA ~3× para
   tener cohorte; luego aplicar la config de B y disparar los de `candidate`. Si
   se olvida flipear la config, el fingerprint no coincide → esos runs se marcan
   `variant_mismatch` y el compare los excluye y avisa.
3. **Consultar** `GET /api/v1/experiments/:id/compare?a=baseline&b=candidate`
   (o `client.CompareExperiment`).
4. **Interpretar** (el endpoint da números crudos; el juicio lo pone el agente):
   - *optimiza ejecuciones* → `speed` + `resources` (wallClock, costUsd, tokens).
   - *sin perder calidad* → `passRate`, `coverageRatio`, `reviewerApprovalRate`
     dentro del `spread`.
   - *sin regresiones* → `valueScore` y `flakyRate` a nivel cohorte **+ `perSha`
     con `regressed`** para cazar la rotura en un commit puntual que la mediana
     esconde.
   - Regla de oro: no cantar ganador si el delta cae dentro del `spread` o si `n`
     es bajo (warning `low-confidence`).

## 13. Resumen de archivos afectados

- `src/types.ts` — `RunResources`, `ConfigFingerprint`, `Experiment`, campos en
  `RunOptions` / `RunOutcome`.
- `src/server/history.ts` — tablas + columnas + CRUD + tagging + lectura.
- `src/server/experiment-compare.ts` *(nuevo)* — el módulo de comparación.
- `src/integrations/opencode-client.ts` + `src/agent-runtime/*` — captura de usage.
- `src/pipeline.ts` — acumulación de recursos, wall-clock, fingerprint, tagging.
- `src/server/api.ts` — handlers de los endpoints nuevos.
- `src/contract/openapi.ts` — paths + schemas.
- `src/cli.ts` — flags `--experiment` / `--variant`.
- `client/internal/api/client.go` + `client/internal/contract/types.gen.go` — SDK Go.
- Tests colocados `*.test.ts` por módulo.
