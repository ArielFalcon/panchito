# ai-pipeline

QA E2E **centralizado y asistido por IA**. Replica lo que harías con OpenCode en
tu máquina, pero como un servicio que **observa todos los repos** del equipo y
**prueba sobre DEV**: cuando un commit se despliega a DEV, un agente genera tests
E2E sobre el blast radius del cambio, los ejecuta contra DEV y abre un **GitHub
Issue** si algo falla.

Es un **template**: no trae ninguna app acoplada. Cada app vigilada se conecta
solo por `config/apps/<app>.yaml`. Los secretos los inyecta **Doppler** en
runtime (no se commitea nada).

## Arquitectura

Dos servicios de larga vida (ver `docker-compose.yml`):

```
   GitHub (push → deploy DEV)
            │  webhook { repo, sha }
            ▼
 ┌─────────────────────┐        HTTP        ┌──────────────────────────┐
 │   orchestrator      │  ───────────────▶  │   opencode  (serve)      │
 │  (este repo, Node)  │   sesión + prompt  │  agente qa-generator     │
 │                     │ ◀───────────────   │   └─ subagente qa-reviewer│
 │  webhook + cola     │   specs escritos   │  MCP: serena, engram     │
 │  gate · espejo      │   en el espejo     └──────────────────────────┘
 │  ejecución · reporte│         ▲  cwd = espejo (volumen compartido)
 └─────────────────────┘─────────┘
```

- **`orchestrator`** (este repo): la **infra determinística** — recibe el
  webhook, encola un run, espera el deploy (gate por SHA), prepara una **copia de
  trabajo del repo** (solo para que el agente LEA código y para versionar los
  tests en `e2e/`; **nunca se construye ni se levanta la app**), **dispara
  OpenCode**, ejecuta los E2E con Playwright **contra DEV** y publica/abre Issue.
  Todo con dependencias inyectables → verificable por tests unitarios.
- **`opencode`**: el **motor agéntico**. `opencode serve` corre los agentes
  definidos en `opencode/opencode.json` y los MCP: **`serena`** (navegación
  semántica de código vía LSP — blast radius con `find_referencing_symbols` y
  lectura por firmas, no por ficheros enteros) y `engram` (memoria episódica).
  El agente escribe los `.spec.ts` en el espejo (volumen compartido) y nosotros
  los recogemos.

### Agentes (opencode/)

| Agente | Modelo | Rol |
|---|---|---|
| `qa-generator` (primary) | **DeepSeek V4 Pro** | genera los E2E, invoca al revisor, itera |
| `qa-reviewer` (subagent) | **Qwen 3.7 Max** | juez independiente de calidad; emite veredicto |

El loop primario↔revisor vive **dentro** de OpenCode. Modelos distintos para
garantizar independencia del juicio. Instrucciones en `opencode/agent/*.md` y
reglas compartidas en `opencode/AGENTS.md`.

> **Credenciales del modelo:** una **única** key — la de tu suscripción
> **OpenCode Go** (o Zen) — en `OPENCODE_API_KEY`. OpenCode da acceso a sus
> modelos por nombre con el prefijo `opencode/` (no hay keys por proveedor).
> Los IDs (`opencode/deepseek-v4-pro`, `opencode/qwen3.7-max`) están en
> `opencode/opencode.json`; verifícalos con `opencode models` y cámbialos en una
> línea si tu plan expone otros slugs.

## Flujo de un run (`src/pipeline.ts`)

1. **Gate** — espera a que DEV corra ese SHA y esté healthy (`/version`).
2. **Espejo** — clone/fetch + checkout del SHA; extrae el diff del commit.
3. **Generar** — abre una sesión OpenCode con cwd = espejo; el agente escribe/
   mejora los tests en la carpeta **`e2e/` del repo** (fuente de verdad en git)
   y los revisa. Si el repo no tiene `e2e/`, se siembra desde el seed
   (`config/e2e/`).
4. **Validar (Filtro B)** — `npm ci` en `e2e/` + gate estático: typecheck + lint
   (`eslint-plugin-playwright`) + `playwright --list`. Si no pasan, el run es
   `invalid` y no se ejecuta.
5. **Ejecutar (Filtro C)** — corre los specs con Playwright contra DEV, con
   datos namespaced `qa-bot-<sha>`, y clasifica `pass`/`fail`/`flaky` (retries
   como señal de inestabilidad). El output se **sanitiza** antes de reusarse.
6. **Decisión** — antes de ejecutar se re-chequea la **salud de DEV**; si está
   caído, el run es `infra-error` (no se reporta como bug). En verde **y con el
   revisor aprobando**, el agente comitea `e2e/` y se abre un **PR con
   auto-merge**; así la suite mejora sola, versionada. Verde pero **revisor no
   aprueba** → Issue (no se publica). `fail`/`invalid` → Issue; fallo con DEV
   caído → `infra-error` (sin Issue); `flaky` → cuarentena; verde sin cambios →
   ni PR ni ruido.

> **Modo sombra** (`qa.shadow: true`): corre todo el flujo pero **no publica PRs
> ni abre Issues**, solo loguea qué haría. Pensado para el rodaje inicial al
> conectar un repo, sin ensuciar nada.

### Harness de E2E (calidad y consistencia)

- **Capa A — estandarización**: el seed `config/e2e/` (config base de Playwright,
  fixtures compartidas — login, `namespace`, `ns()` — y reglas de lint) se siembra
  en `e2e/` del repo la primera vez. A partir de ahí **el repo es su dueño** y el
  agente lo mantiene/mejora; el login real se implementa una vez en el fixture
  `authenticate`. (App única con microservicios estandarizados → una sola
  librería de fixtures compartida, no por-repo.)
- **Capa B — gate estático** (`src/qa/validate.ts`): valida los specs sin gastar
  navegador (compilan, lint, cargan).
- **Capa C — gate de flakiness** (`src/qa/execute.ts` + `playwright-report.ts`):
  un test que solo pasa tras reintento se marca `flaky` → cuarentena, no se da
  por bueno ni rompe como fallo real.

### Persistencia (dónde vive cada cosa al reiniciar)

- **Suite E2E (specs + fixtures)** → **git**, en `e2e/` del repo de la app. Es la
  fuente de verdad: versionada, revisable, sobrevive a la pérdida del host. El
  agente la mejora vía PR (auto-merge si pasa el harness).
- **engram** (memoria episódica) → volumen `engram-data`. **No es regenerable**:
  es lo único que conviene respaldar. Sobrevive a reinicios de contenedor.
- **Índice de Serena y espejos** → volúmenes (`serena-cache`, `mirrors`). Cachés
  **regenerables**: si se pierden, se reconstruyen/re-clonan.

> Los volúmenes con nombre sobreviven a `restart`/`down`+`up`; se pierden con
> `down -v` o si se destruye el host. Por eso la fuente de verdad está en git.

## Sanitización (con Doppler)

Como Doppler inyecta los secretos en runtime, el **código del repo ya viene
limpio**. El sanitizer (`src/orchestrator/sanitizer.ts`) cubre el residual:
redacta secretos/PII/hosts internos en (a) el **diff** antes de mandarlo a
OpenCode y (b) el **output de ejecución** antes de citarlo en un Issue —que es
donde podrían aparecer datos de DEV. Los datos de test son sintéticos y
namespaced.

## Uso

```bash
npm install
npm test          # tests unitarios de la infra (red/OpenCode/Playwright stubbeados)
npm run typecheck

# Acopla una app:
cp config/apps/example.yaml config/apps/mi-app.yaml   # edita repo, dev, flujos

# Disparo manual del run (corre el MISMO pipeline que el webhook):
npm run qa -- --app mi-app --sha <commit-sha>
```

### Despliegue (Docker)

```bash
# Con Doppler inyectando los secretos:
doppler run -- docker compose up --build
# (o copia .env.example → .env para correr en local sin Doppler)
```

- `orchestrator`: imagen basada en Playwright (Node + navegadores) + git. El
  tooling e2e (Filtros B/C) se instala por run en `e2e/` del repo (`npm ci`).
- `opencode`: imagen oficial de OpenCode + `uv` y los runtimes de lenguaje que
  use Serena (JDK para Java, etc.) + `engram` (ver `opencode/Dockerfile`).
- Volúmenes: `mirrors` (compartido entre ambos; Serena cachea en `<repo>/.serena`),
  `serena-cache` (caché de uv/Serena), `engram-data` (memoria). La suite E2E NO
  usa volumen: vive en git.

## Principios

1. Infra determinística (gate, espejo, ejecución, reporte) separada del motor
   agéntico (OpenCode).
2. Especificidad de la app solo en `config/`; agentes y modelos solo en
   `opencode/`. Nada de esto en `src/`.
3. Sanitización en los datos que salen del sistema (diff → modelo, logs → Issue).
4. Revisor independiente (modelo distinto al primario), condicional por app.
5. Cola **secuencial**: un run a la vez, sin QA concurrente pisándose en DEV.
