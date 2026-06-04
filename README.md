# ai-pipeline

Motor **agnóstico** de QA E2E asistido por IA. Vigila una app: cuando un commit
llega a `main` y se despliega a DEV, genera tests E2E sobre el blast radius del
cambio, los ejecuta contra DEV y abre un **GitHub Issue** si algo falla.

Este repositorio es un **template**: no trae ninguna app acoplada. La app
vigilada se conecta solo por `config/apps/<app>.yaml` + `.env` (ambos con tus
valores; nunca se commitean credenciales).

> Diseño completo y decisiones: [`docs/fase-1-spec.md`](docs/fase-1-spec.md).

## Estado: M0 + M1 (motor completo, verificado por tests unitarios)

El motor agnóstico está cableado y **verificado por tests unitarios** (providers,
MCP y red inyectables/stubbeados — no toca servicios reales):

**M0 — núcleo**
- `runAgent()` + loop primario↔revisor **a mano** (sin LangGraph): secuencial,
  tope de iteraciones configurable, corte anti-estancamiento, delta-feedback.
- Sanitización en el ensamblaje del mensaje (diff, contexto de código, memoria,
  propuesta y correcciones).
- Gate de deploy por SHA (`/version` → `{ sha, healthy }`) con timeout.
- Namespacing de datos de test `qa-bot-<sha>`.

**M1 — integración real (bordes inyectables)**
- Cliente **MCP** (JSON-RPC) + integraciones `codegraph` (blast radius) y
  `engram` (memoria), construidas desde `config/tools/mcp-servers.yaml`. Si un
  servidor no está habilitado, se usa la implementación nula (degradación limpia).
- **Espejos de repo** (`repo-mirror`): clone/fetch + checkout del SHA y extracción
  del diff del commit que alimenta el blast radius.
- **Runner E2E** con Playwright (reporter JSON → casos pass/fail) y
  **sanitización del output de ejecución** antes de reportar.

Pendiente (M2): disparo automático por webhook + sidecars MCP en docker-compose.
El runner por defecto requiere Playwright disponible en el entorno (no es
dependencia del template para no arrastrar navegadores).

## Uso

```bash
npm install
cp .env.example .env        # rellena con tus valores (gitignored)
cp config/apps/example.yaml config/apps/mi-app.yaml   # acopla tu app

npm test                    # tests unitarios del motor
npm run typecheck           # chequeo de tipos

# Disparo manual del lazo (M0):
npm run qa -- --app mi-app --sha <commit-sha>
```

## Principios

1. `runAgent()` agnóstico al disparador.
2. Especificidad de la app solo en `config/`, nunca en `src/`.
3. Sanitización obligatoria — ninguna ruta al LLM la evita.
4. Revisor independiente (modelo distinto al primario), condicional.
