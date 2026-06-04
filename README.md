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
 │  webhook + cola     │   specs escritos   │  MCP: codegraph, engram  │
 │  gate · espejo      │   en el espejo     └──────────────────────────┘
 │  ejecución · reporte│         ▲  cwd = espejo (volumen compartido)
 └─────────────────────┘─────────┘
```

- **`orchestrator`** (este repo): la **infra determinística** — recibe el
  webhook, encola un run, espera el deploy (gate por SHA), prepara el espejo del
  repo, **dispara OpenCode**, ejecuta los E2E con Playwright contra DEV y abre el
  Issue si falla. Todo con dependencias inyectables → verificable por tests
  unitarios.
- **`opencode`**: el **motor agéntico**. `opencode serve` corre los agentes
  definidos en `opencode/opencode.json` y los MCP (`codegraph` para el blast
  radius, `engram` para la memoria episódica). El agente escribe los `.spec.ts`
  en el espejo (volumen compartido) y nosotros los recogemos.

### Agentes (opencode/)

| Agente | Modelo | Rol |
|---|---|---|
| `qa-generator` (primary) | **DeepSeek V4 Pro** | genera los E2E, invoca al revisor, itera |
| `qa-reviewer` (subagent) | **Qwen 3.7 Max** | juez independiente de calidad; emite veredicto |

El loop primario↔revisor vive **dentro** de OpenCode. Modelos distintos para
garantizar independencia del juicio. Instrucciones en `opencode/agent/*.md` y
reglas compartidas en `opencode/AGENTS.md`.

## Flujo de un run (`src/pipeline.ts`)

1. **Gate** — espera a que DEV corra ese SHA y esté healthy (`/version`).
2. **Espejo** — clone/fetch + checkout del SHA; extrae el diff del commit.
3. **Generar** — abre una sesión OpenCode con cwd = espejo, le pasa el diff +
   namespace + dir de salida; el agente escribe los specs y los revisa.
4. **Ejecutar** — corre los specs con Playwright contra DEV, con datos
   namespaced `qa-bot-<sha>`. El output se **sanitiza** antes de reusarse.
5. **Reportar** — Issue accionable solo si falla; en verde, sin ruido.

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

- `orchestrator`: imagen basada en Playwright (Node + navegadores) + git.
- `opencode`: imagen oficial de OpenCode + los binarios MCP (ver
  `opencode/Dockerfile`, donde se instalan `codegraph-mcp` y `engram-mcp`).
- Volúmenes: `mirrors` (compartido entre ambos), `qa-store` (suite de
  regresión), `engram-data` (memoria), `codegraph-data` (índice del grafo).

## Principios

1. Infra determinística (gate, espejo, ejecución, reporte) separada del motor
   agéntico (OpenCode).
2. Especificidad de la app solo en `config/`; agentes y modelos solo en
   `opencode/`. Nada de esto en `src/`.
3. Sanitización en los datos que salen del sistema (diff → modelo, logs → Issue).
4. Revisor independiente (modelo distinto al primario), condicional por app.
5. Cola **secuencial**: un run a la vez, sin QA concurrente pisándose en DEV.
