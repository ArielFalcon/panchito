# ai-pipeline

Motor **agnóstico** de QA E2E asistido por IA. Vigila una app: cuando un commit
llega a `main` y se despliega a DEV, genera tests E2E sobre el blast radius del
cambio, los ejecuta contra DEV y abre un **GitHub Issue** si algo falla.

Este repositorio es un **template**: no trae ninguna app acoplada. La app
vigilada se conecta solo por `config/apps/<app>.yaml` + `.env` (ambos con tus
valores; nunca se commitean credenciales).

> Diseño completo y decisiones: [`docs/fase-1-spec.md`](docs/fase-1-spec.md).

## Estado: M0 (esqueleto andante)

El motor agnóstico está cableado y **verificado por tests unitarios** (providers
y red inyectables/stubbeados — no toca servicios reales):

- Núcleo `runAgent()` + loop primario↔revisor **a mano** (sin LangGraph):
  secuencial, tope de iteraciones, corte anti-estancamiento, realimentación solo
  del delta.
- Sanitización en el punto de ensamblaje del mensaje (cubre diff, contexto de
  código, memoria, propuesta y correcciones).
- Gate de deploy por SHA (`/version` → `{ sha, healthy }`) con timeout.
- Namespacing de datos de test `qa-bot-<sha>`.
- Persistencia de los E2E generados + apertura de Issue al fallar.

Pendiente (M1): generación real con codegraph + ejecución E2E con runner real.
Pendiente (M2): disparo automático por webhook + sidecars MCP.

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
