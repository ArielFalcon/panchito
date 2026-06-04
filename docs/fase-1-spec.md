# ai-pipeline — Especificación revisada · Fase 1

> **Nota (pivote a agente):** el sistema migró de un loop primario↔revisor
> hecho a mano + clientes MCP propios a delegar la **generación agéntica en
> OpenCode** (`opencode serve`), con los agentes y MCP definidos en
> `opencode/`. `src/` conserva solo la infra determinística (gate, espejo,
> ejecución, reporte). Ver el `README.md` para la arquitectura vigente; las
> secciones de abajo describen el diseño previo y se mantienen como contexto
> histórico de las decisiones que siguen vigentes (config/ vs src/,
> sanitización, revisor independiente, cola secuencial).

> Esta especificación **reemplaza** el alcance original de la guía
> (`ai-brain — Especificación de implementación`) en los puntos donde nuestras
> decisiones de diseño cambiaron el rumbo. Conserva la filosofía (núcleo
> agnóstico, `config/` vs `src/`, sanitización obligatoria, revisor
> independiente) y reescribe lo que ya no aplica (modelo efímero en Actions,
> flujo diff→comentario, LangGraph).

---

## 0. Qué cambió respecto a la guía original

| Tema | Guía original | Decisión actual |
|------|---------------|-----------------|
| **Propósito de Fase 1** | Analizar una PR y publicar un **comentario** | Generar y ejecutar **tests E2E** sobre el cambio, contra DEV |
| **Modelo de ejecución** | Contenedor **efímero** en GitHub Actions | **Servicio hospedado** permanente (PC del equipo → luego servidor) |
| **Disparo** | Evento `pull_request` dentro de Actions | **Webhook** al servicio tras merge a `main` + deploy a DEV |
| **Entorno de prueba** | — (solo análisis estático del diff) | **DEV siempre-encendido**, tras *gate* de deploy por SHA |
| **Salida** | Comentario en la PR | **GitHub Issue** al detectar fallos |
| **Orquestación** | LangGraph (no compila como está) | **Loop a mano**, dos agentes secuenciales |
| **Primario** | "OpenCode/DeepSeek V4" (no era proveedor válido) | **OpenCode Go** (modelo hosteado en US, OpenAI-compatible) |
| **Revisor** | "Gemini paid" (sin variante) | **Gemini 2.5 Flash** (plan pago, sin entrenamiento) |
| **Memoria** | Engram SQLite (se borraba en cada run efímero) | Engram SQLite **persistido en volumen** del servicio |
| **Artefactos E2E** | Sin destino definido | **Persistidos en el volumen** del servicio (repo de tests, después) |

---

## 1. Decisiones cerradas (fuente de verdad)

1. **Servicio hospedado, no efímero.** El cerebro corre como proceso permanente
   (Docker en la PC del equipo primero, luego un servidor). Esto resuelve de
   raíz la persistencia de memoria, el bootstrap de MCP y el acceso multi-repo.
2. **El repo vigilado no ejecuta nuestro código.** Tras mergear a `main` y
   desplegar a DEV, **dispara un webhook** al servicio con `{ repo, sha }`.
3. **Gate de deploy obligatorio.** El servicio no prueba hasta confirmar que DEV
   corre exactamente ese `sha` y está *healthy* (polling con timeout).
4. **QA E2E contra DEV.** Datos reales de DEV + *namespacing* `qa-bot-<sha>` y
   limpieza. Sin base de datos efímera (overhead injustificado a esta escala).
5. **Dos agentes secuenciales, loop a mano.** Primario (genera E2E) → revisor
   estricto (valida). Tope de iteraciones, corte anti-estancamiento,
   realimentación solo del *delta*. Sin LangGraph.
6. **Sanitización en el punto de ensamblaje del mensaje**, no solo del diff.
   Cubre diff, código de codegraph, memoria, **output de tests y logs de DEV** y
   las correcciones del revisor. El primario es externo (US) → PII estricta.
7. **Reporte por GitHub Issue** al fallar. En verde, sin ruido.
8. **Núcleo agnóstico.** Toda la especificidad de la app vigilada vive en
   `config/<app>.yaml`. `src/` no conoce ninguna app concreta.

---

## 2. Arquitectura de ejecución

```
Merge a main (repo vigilado)
        │
        ▼
Deploy automático a DEV  ──────────────┐
        │                              │ (en paralelo, DEV tarda unos min
        ▼                              │  en quedar estable en el nuevo SHA)
Webhook → ai-pipeline (servicio)       │
        │                              │
        ▼                              ▼
[1] deployGate: poll DEV/version hasta sha-match + healthy (timeout)
        │
        ▼
[2] sanitize + codegraph.getImpactRadius(repo, sha)  → blast radius
        │
        ▼
[3] runAgent()  ── loop a mano ──┐
        ├── primario (OpenCode Go): genera E2E del blast radius
        └── revisor (Gemini Flash): valida; si rechaza → itera (máx 2)
        │
        ▼
[4] execute: corre los E2E contra DEV (datos qa-bot-<sha>) + cleanup
        │
        ▼
[5] persiste los E2E en el volumen + (si falla) abre GitHub Issue
```

El servicio es **siempre-encendido**; los MCP (codegraph, engram) corren como
*sidecars* de larga vida en el mismo `docker-compose`, con conexiones
persistentes. El servicio mantiene **espejos locales** de los repos vigilados
(clona/actualiza al SHA) para que codegraph pueda calcular impacto, incluido
cross-repo.

---

## 3. Estructura del repositorio (revisada)

```
ai-pipeline/
├── docker-compose.yml            # servicio + MCP sidecars + volúmenes
├── Dockerfile
├── package.json
├── tsconfig.json
├── .env.example
│
├── config/                       # ESPECÍFICO de la(s) app(s) vigilada(s)
│   ├── apps/
│   │   └── <app>.yaml            # DEV url, /version, flujos críticos, creds refs
│   ├── prompts/
│   │   ├── system/
│   │   │   ├── base.md
│   │   │   ├── primary-agent.md  # genera E2E
│   │   │   └── reviewer-agent.md # valida E2E (juez estricto)
│   │   └── triggers/
│   │       └── post-deploy.md
│   └── context/
│       └── .aiignore             # patrones que NUNCA llegan al LLM
│
├── src/                          # AGNÓSTICO al proyecto
│   ├── index.ts                  # arranque del servicio (HTTP + scheduler futuro)
│   ├── server/
│   │   └── webhook.ts            # recibe { repo, sha } y encola un run
│   ├── orchestrator/
│   │   ├── agent-core.ts         # runAgent() — núcleo
│   │   ├── loop.ts               # coordinación primario↔revisor (a mano)
│   │   ├── sanitizer.ts          # sanitiza TODA fracción antes del LLM
│   │   ├── prompt-builder.ts     # ensambla system + user-message
│   │   └── config-loader.ts
│   ├── providers/
│   │   ├── opencode.ts           # primario (OpenCode Go, OpenAI-compatible)
│   │   └── gemini.ts             # revisor (Gemini 2.5 Flash, JSON)
│   ├── env/
│   │   └── deploy-gate.ts        # poll DEV/version hasta sha-match + healthy
│   ├── qa/
│   │   ├── generate.ts           # invoca runAgent para producir los E2E
│   │   ├── execute.ts            # corre los E2E contra DEV, recoge resultados
│   │   ├── test-data.ts          # namespacing qa-bot-<sha> + cleanup
│   │   └── store.ts              # persiste E2E en el volumen
│   ├── integrations/
│   │   ├── github.ts             # abre Issues
│   │   ├── codegraph.ts          # MCP: impact radius
│   │   ├── engram.ts             # MCP: memoria episódica (volumen)
│   │   └── repo-mirror.ts        # clona/actualiza espejos de repos vigilados
│   └── types.ts
│
└── docs/
    └── fase-1-spec.md            # este documento
```

---

## 4. Contratos base (`types.ts`)

```typescript
export type TriggerSource = "webhook" | "manual" | "cron" | "chat";

// Entrada única del núcleo. Cualquier disparador construye uno de estos.
export interface AgentContext {
  source: TriggerSource;
  task: string;                 // instrucción de alto nivel (desde config)
  repo?: string;
  sha?: string;                 // commit a verificar (clave para el gate)
  diff?: string;
  userId?: string;
  metadata?: Record<string, unknown>;
}

// Resultado del grafo de agentes (el E2E generado + veredicto del revisor).
export interface AgentResult {
  output: string;
  artifacts: Artifact[];        // los tests E2E generados
  reviewed: boolean;
  approved: boolean;            // veredicto del revisor (true si no se revisó)
}

export interface Artifact {
  path: string;
  content: string;
  kind: "e2e" | "doc" | "other";
}

// Resultado de EJECUTAR los E2E contra DEV.
export interface QaRunResult {
  sha: string;
  passed: boolean;
  cases: Array<{ name: string; status: "pass" | "fail"; detail?: string }>;
  logs: string;                 // sanitizado antes de cualquier reuso por LLM
}
```

---

## 5. El núcleo: `runAgent()`

```typescript
// src/orchestrator/agent-core.ts
export async function runAgent(ctx: AgentContext): Promise<AgentResult> {
  // 1. Sanitizar el contexto de entrada (diff). El resto de fracciones se
  //    sanitizan en el ensamblaje del mensaje (ver §7) — ninguna ruta lo evita.
  const clean = sanitize(ctx);

  // 2. Blast radius: solo el subgrafo afectado, no el repo entero.
  const codeContext = clean.diff
    ? await codegraph.getImpactRadius(clean.repo!, clean.diff)
    : null;

  // 3. Memoria episódica relevante (persistida en el volumen del servicio).
  const memory = await engram.getContext(clean.repo);

  // 4. Loop de agentes a mano (sin framework de grafos).
  return runLoop(clean, codeContext, memory);
}
```

## 6. La coordinación a mano (`loop.ts`)

Reemplaza el grafo LangGraph. **Dos agentes secuenciales, un único `state`,
salidas garantizadas.** No hay concurrencia → no hay desincronización.

```typescript
// src/orchestrator/loop.ts
const MAX_ITERATIONS = 2;

export async function runLoop(ctx, codeContext, memory): Promise<AgentResult> {
  const needsReview = ctx.metadata?.needsReview ?? true; // QA: siempre revisa
  let messages = [buildUserMessage(ctx, codeContext, memory)]; // §7
  let proposal = "";
  let prevCorrections = "";

  for (let iteration = 0; ; iteration++) {
    // --- Primario: genera/corrige los E2E ---
    proposal = await opencode.complete({
      model: process.env.OPENCODE_MODEL!,
      system: buildSystemPrompt("primary-agent"),
      messages,
    });

    if (!needsReview) return adapt(proposal, { reviewed: false, approved: true });

    // --- Revisor: juez independiente, determinístico, JSON ---
    const verdict = await gemini.completeJson({
      system: buildSystemPrompt("reviewer-agent"),
      messages: [{ role: "user", content: sanitizeText(proposal) }],
      temperature: 0,
    }); // -> { approved: boolean, corrections: string[] }

    if (verdict.approved)
      return adapt(proposal, { reviewed: true, approved: true });

    // --- Cortes de seguridad: el bucle SIEMPRE termina ---
    if (iteration + 1 >= MAX_ITERATIONS)
      return adapt(proposal, { reviewed: true, approved: false,
        note: "no convergió en MAX iteraciones" });

    const corrections = verdict.corrections.join("\n");
    if (corrections === prevCorrections)
      return adapt(proposal, { reviewed: true, approved: false,
        note: "sin progreso entre iteraciones" });
    prevCorrections = corrections;

    // Realimenta SOLO el delta (propuesta + correcciones), no el historial.
    messages = [
      { role: "assistant", content: proposal },
      { role: "user", content: sanitizeText(corrections) },
    ];
  }
}
```

**Garantías:**
- **Termina siempre** — cuatro salidas definidas: aprobó / no-revisa / agotó
  iteraciones / no-progresa. Ninguna rama queda sin `return`.
- **Sin bucle infinito** — `MAX_ITERATIONS` es techo físico.
- **Sin desync** — ejecución secuencial, un solo `state`, sin estado global.
- **Eficiente en tokens** — realimenta el delta, no el transcript; el revisor
  recibe solo la propuesta, no el `codeContext`.
- **Determinístico en el control** — el flujo es código nuestro; la variabilidad
  del modelo se acota (revisor a `temperature: 0`, salida JSON con esquema).

## 7. Sanitización (rediseño — corrige el agujero 🔴)

El `sanitize()` original solo limpiaba `ctx.diff`. **Toda** fracción que llega al
LLM pasa ahora por el sanitizer en el punto de ensamblaje:

- `buildUserMessage()` sanitiza **cada** fragmento: diff, `codeContext` (código
  real del repo), `memory`, y `task`.
- `sanitizeText()` se aplica a la **propuesta** y a las **correcciones** que se
  realimentan, y al **output/logs de ejecución de tests** antes de cualquier
  reuso por el LLM.
- Patrones: secretos (api keys, tokens, JWT, claves privadas), hosts/IPs
  internos, y **PII** (relevante porque DEV tiene datos cuasi-reales y el
  primario es externo en US).

Principio sellado: *ninguna ruta al LLM evita el sanitizer.*

## 8. Gate de deploy (`deploy-gate.ts`)

```typescript
// Espera a que DEV corra el SHA esperado y esté healthy, con timeout.
export async function waitForDeploy(app: AppConfig, sha: string): Promise<void> {
  const deadline = Date.now() + app.deployTimeoutMs;
  while (Date.now() < deadline) {
    const v = await fetch(app.versionUrl).then(r => r.json()).catch(() => null);
    if (v?.sha === sha && v?.healthy === true) return;
    await sleep(app.pollIntervalMs);
  }
  throw new DeployTimeout(app.name, sha); // → Issue: "no pude verificar deploy"
}
```

Requiere que DEV exponga su SHA (p. ej. `/version → { sha, healthy }`). Si la app
aún no lo expone, es un cambio chico en la app (o, peor caso, healthcheck + espera
fija configurada en `config/apps/<app>.yaml`).

## 9. Configuración de la app (`config/apps/<app>.yaml`)

```yaml
name: "mi-app"
repo: "ArielFalcon/mi-app"

dev:
  baseUrl: "https://dev.mi-app.interno"
  versionUrl: "https://dev.mi-app.interno/version"  # -> { sha, healthy }
  pollIntervalMs: 10000
  deployTimeoutMs: 600000        # 10 min para estabilizar

qa:
  needsReview: true
  testDataPrefix: "qa-bot"       # entidades namespaced por SHA
  criticalFlows:                 # pistas de qué priorizar (el codegraph afina)
    - "login"
    - "checkout"
  credentials:                   # referencias a secrets, NO valores
    testUser: "${DEV_TEST_USER}"
    testPass: "${DEV_TEST_PASS}"

report:
  onFailure: "github-issue"
```

---

## 10. Milestones

### M0 — Esqueleto andante (disparo manual)
Demuestra el **lazo completo** sin inteligencia todavía.
- CLI: `npm run qa -- --app <app> --sha <sha>` (disparo manual).
- `config/apps/<app>.yaml` de ejemplo real.
- `deploy-gate` **real** contra DEV.
- **Un** E2E trivial (hardcoded) ejecutado contra DEV con datos `qa-bot-<sha>`.
- `runAgent`/`runLoop` cableado (con un primario que devuelve el E2E trivial).
- Stub de GitHub Issue al fallar.

**Cierre M0:** un comando manual con `{app, sha}` espera el deploy, corre un E2E
contra DEV y, si falla, abre un Issue. El lazo end-to-end vive.

### M1 — Generación real ✅ (cableado + verificado por tests unitarios)
- Cliente MCP (JSON-RPC, transporte inyectable) y `codegraph.getImpactRadius`
  vía MCP; `engram` (memoria) vía MCP. Construidos desde
  `config/tools/mcp-servers.yaml`; degradan a impl. nula si no hay servidor.
- `repo-mirror`: clone/fetch + checkout del SHA y diff del commit → blast radius.
- Runner E2E (Playwright, reporter JSON → casos) con runner inyectable.
- Sanitización del output de ejecución (`qa/execute.ts`) antes de reportar.
- Persistencia de los E2E en el volumen (`qa/store.ts`).

**Cierre M1:** el lazo genera E2E (primario) revisados (revisor), los ejecuta vía
runner Playwright contra DEV, sanitiza el output y persiste los artefactos. Las
piezas de red/MCP/runner son inyectables y están cubiertas por tests unitarios;
la ejecución real se activa al acoplar una app + sidecars MCP + Playwright.

### M2 — Disparo automático ✅ (cableado + verificado por tests unitarios)
- `pipeline.ts`: lazo completo extraído y compartido por CLI y webhook (deps
  inyectables; orquestación, orden y rama "fallo → Issue" cubiertos por tests).
- `server/webhook.ts`: recibe `{ repo, sha }` (forma simple o evento push de
  GitHub), verifica firma HMAC `x-hub-signature-256`, encola el run.
- `server/queue.ts`: cola secuencial (un run a la vez; un fallo no la detiene).
- `repo-mirror` mantiene espejos actualizados (M1).
- Reporte de Issue (`report/reporter.ts`): SHA, casos fallidos, logs sanitizados,
  nota del revisor.
- `docker-compose` con servicio (puerto + volúmenes) y sidecars MCP listos.

**Cierre M2:** mergear a `main` dispara todo solo; el equipo recibe Issues sin
intervención. Adaptar a otra app = solo `config/apps/<app>.yaml`. La ejecución
real se activa al acoplar app + sidecars MCP + Playwright; el runner y la red son
inyectables y están cubiertos por tests unitarios.

---

## 11. Apéndice — Cómo se cierra cada error diagnosticado

**Bugs de cableado (se corrigen en implementación):**
- **B1** Input vacío al LLM → `buildUserMessage()` ensambla el user-message (§6, §7).
- **B2** Correcciones no realimentadas → el loop reinyecta el *delta* (§6).
- **B3** `producesArtifacts` sin setear → se deriva de `needsReview` del config (§6).
- **B4** Sin adaptador final → `adapt()` mapea a `AgentResult` (§6).
- **B5** API LangGraph rota → **eliminada**; loop a mano (§6).
- **B6** Bootstrap MCP ausente → MCP como sidecars del servicio (§2).

**Huecos de diseño:**
- **D1 🔴** Sanitización parcial → sanitización en el ensamblaje, cubre todo (§7).
- **D2 🔴** Memoria efímera → engram persistido en volumen del servicio (§2).
- **D3 🔴** Despliegue indefinido → servicio hospedado + webhook (§1, §2).
- **D4** Post vs pre-merge → post-merge + gate de DEV (§2); pre-merge es futuro.
- **D5** Identificadores → OpenCode Go (primario) + Gemini 2.5 Flash (revisor) (§1).
- **D6** Artefactos sin destino → persistidos en volumen; repo de tests después (§9, M1).
- **D7** Multi-repo en Actions → espejos locales en el servicio (§2).

---

## 12. Principios no negociables (heredados)

1. `runAgent()` agnóstico al disparador.
2. Especificidad de la app solo en `config/`, nunca en `src/`.
3. Sanitización obligatoria — ninguna ruta al LLM la evita.
4. `config/` se configura; `src/` se desarrolla.
5. Revisor independiente y condicional (modelo distinto al primario).
6. Autonomía gradual — los E2E pasan por el revisor antes de ejecutarse.
