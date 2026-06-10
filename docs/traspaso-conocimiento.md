# panchito — Motor de QA E2E autónomo y agnóstico

> **En una oración:** un servicio centralizado que observa los repositorios de tu equipo, genera tests de extremo a extremo para cada cambio desplegado, los ejecuta contra el entorno de desarrollo y, cuando son válidos, los integra de vuelta al repositorio de la aplicación como una suite que crece y aprende con cada despliegue.

## Quick path

1. Un commit se despliega en DEV → el motor recibe el evento, clona el repo, lee el diff y el mensaje de commit, y decide si el cambio merece tests nuevos.
2. Un agente de IA lee el código afectado, escribe tests Playwright, y un segundo agente (modelo distinto) los revisa por calidad. Luego se ejecutan contra la URL de DEV.
3. Si todo es verde, los tests se commitean en el repo de la app via PR con auto-merge. Si algo falla, se abre un Issue con los logs saneados. El sistema aprende de cada fallo para no repetir errores en el futuro.

---

## ¿Qué es y qué no es?

| Sí es | No es |
|-------|-------|
| Un motor de QA que **observa** repos y **actúa** sobre commits desplegados | Un reemplazo de tu suite de tests existente; la complementa con cobertura E2E |
| Agnóstico de aplicación: cualquier repo se integra con un archivo YAML de configuración | Un framework que exige cambiar código de la app; cero intrusión |
| Un generador de tests que aprende de fallos pasados y acumula reglas reutilizables | Un sistema de prompts estáticos que repite los mismos errores en cada run |
| Un orquestador determinista que coordina agentes de IA, cola secuencial, gates de calidad y publicación | Un agente de IA suelto que tiene acceso directo a git o a GitHub |

---

## Arquitectura de alto nivel

El sistema se divide en dos capas separadas por una sola frontera HTTP:

| Capa | Naturaleza | Responsabilidad |
|------|------------|-----------------|
| **Orquestador** | Determinista, infraestructura en Node.js | Webhook, cola secuencial, gate de despliegue, working copy, ejecución de tests, publicación de PRs/Issues, ledger de aprendizaje |
| **Agente de IA** | No determinista, motor de IA vía OpenCode | Genera tests, navega código con LSP (Serena), revisa calidad, escribe specs, persiste memoria en Engram |

Ambas capas comparten un volumen de trabajo para los repositorios (working copies). El orquestador nunca deja que el agente escriba directamente en el repo vigilado: el agente escribe en el working copy, y el orquestador (solo él) hace git push, abre PRs y mergea.

---

## Features principales

### 1. Pipeline de QA por commit

| Etapa | Qué hace | Por qué importa |
|-------|----------|-----------------|
| **Gate de despliegue** | Espera a que DEV sirva el SHA correcto y responda healthy | Evita ejecutar tests contra un despliegue que aún no está listo |
| **Clasificación** | Lee el mensaje de commit (Conventional Commits) y el diff. Commits de estilo o docs sin lógica nueva se saltan sin gastar un token | Evita ruido y costo innecesario |
| **Recuperación** | Carga reglas aprendidas de runs previos y las inyecta en el prompt del agente | El mismo error no se comete dos veces |
| **Generación** | El agente lee el radio de explosión del cambio usando navegación semántica de código (LSP) y escribe tests Playwright | Los tests están enfocados en lo que realmente cambió |
| **Revisión independiente** | Un segundo modelo (distinto al generador) revisa los tests por calidad: rechaza aserciones triviales, selectores frágiles o tests que no verifican el cambio | Evita que el generador se auto-apruebe |
| **Gate estático** | Compilación TypeScript, lint, lista de tests de Playwright y validación del manifest deben pasar | Tests inválidos nunca llegan a ejecutarse |
| **Ejecución** | Corre los tests contra la URL de DEV en vivo | La verificación es real, no teórica |
| **Oracle** | Para repos de código (no web), corre mutation testing con Stryker para medir cuántos bugs inyectados los tests realmente detectan | Mide la calidad objetiva, no solo el verde |
| **Reflexión** | En runs fallidos, un agente analiza el error y produce una regla preventiva estructurada | Cada fallo se convierte en conocimiento reutilizable |
| **Decisión** | Verde + aprobado → PR con auto-merge. Fallo → Issue. Flaky → cuarentena. DEV caído → error de infraestructura | El outcome es siempre actionable y claro |

### 2. Aprendizaje acumulativo

El sistema mantiene un ledger de aprendizaje con cinco componentes:

- **Labeler:** clasifica cada run en una clase de error (estático, ejecución, falso positivo…) sin usar LLM.
- **Oracle:** mide calidad objetiva (mutation testing).
- **Reflector:** produce reflexiones estructuradas en fallos.
- **Distiller:** convierte reflexiones en reglas reutilizables, deduplicadas y con decay.
- **Curriculum:** rastrea qué arquetipos de escenario han demostrado atrapar bugs reales; solo los probados se inyectan en futuros prompts.

### 3. Multi-app, motor único

Un solo servicio centralizado observa múltiples repositorios. Cada app se onboarda con un solo archivo YAML (`config/apps/<nombre>.yaml`). No hay código específico de app en el motor.

### 4. Shadow mode

Al onboardar un repo, se puede activar `shadow: true`. El pipeline completo corre (generación, ejecución, revisión), pero no abre PRs ni Issues. Es ideal para validar el motor sin tocar el repo de producción. Cuando el equipo está listo, se desactiva shadow.

---

## Flujo de ejecución óptima

### Modo recomendado por defecto: `diff` (webhook)

El escenario de oro es el flujo por webhook:

1. Un commit se mergea en la rama principal y se despliega en DEV.
2. GitHub envía un webhook al orquestador.
3. El orquestador enquea el run en una **cola secuencial** (nunca se ejecutan dos runs concurrentes contra DEV).
4. El gate de despliegue espera a que DEV sirva el SHA correcto.
5. El sistema clasifica el commit. Si es solo estilo/docs, retorna `skipped` sin consumir tokens.
6. El agente genera tests enfocados en el diff.
7. El reviewer los valida.
8. Se ejecutan contra DEV.
9. El outcome se publica: PR con auto-merge (verde), Issue (fallo), o cuarentena (flaky).

### Modos de ejecución disponibles

| Modo | Cuándo usarlo | Qué hace |
|------|---------------|----------|
| **`diff`** (default) | Webhook por commit | Tests solo el radio de explosión del commit actual |
| **`complete`** | Quieres rellenar huecos de cobertura | Analiza todo el repo y genera tests para flujos importantes no cubiertos |
| **`exhaustive`** | Auditoría completa | Re-evalúa cada test existente y regenera la suite entera |
| **`manual`** | Quieres forzar un enfoque | Generación guiada por un prompt natural del operador |
| **`code`** (target) | Backend/librería sin web | Corre la suite de tests propia del repo (pytest, go test, cargo test…) y mide con mutation testing |

### Gate de calidad (la confianza se gana en capas)

El sistema tiene cuatro capas de gate para que un test llegue al repo de la app:

1. **Análisis estático:** ¿compila? ¿pasa lint? ¿la lista de tests de Playwright es válida? ¿el manifest tiene metadatos correctos?
2. **Reviewer IA:** ¿el test tiene valor real? ¿asevera algo? ¿usa selectores robustos? ¿verifica el cambio real?
3. **Change-coverage:** ¿el test pasa pero **ejecuta** las líneas que el commit cambió? Un verde que no toca el cambio es un falso positivo.
4. **Mutation testing:** ¿el test detecta bugs inyectados? Mide la calidad más profunda posible.

### Determinismo y reproducibilidad

El sistema está diseñado para que **dos runs consecutivos del mismo SHA produzcan el mismo resultado**. Para lograrlo:

- La cola es secuencial: un solo run a la vez.
- El namespace de datos de prueba incluye un identificador único de run (no solo el SHA), para que datos de corridas previas no contaminen la medición.
- Los tests de regresión se escriben con cada fix para garantizar que el gate sigue siendo confiable.

---

## Estados de un run y outcomes posibles

| Estado | Significado | Acción del sistema |
|--------|-------------|-------------------|
| `pass` | Tests ejecutados, verdes, reviewer aprobó | Abre PR con auto-merge para commitear los tests en la app |
| `fail` | Al menos un test falló | Abre Issue en el repo de la app con logs saneados |
| `flaky` | Tests inestables (fallan intermitentemente) | Cuarentena: no se abre Issue, se marca para revisión humana |
| `invalid` | Falló el gate estático (no compila, lint, etc.) | Issue indicando que los tests generados no son válidos |
| `infra-error` | DEV caído, timeout, o fallo del runner | No se abre Issue en la app; se loguea como error de infraestructura |
| `skipped` | Commit clasificado como no-testeable (style, docs…) | No se gasta un token; se loguea como skip válido |

---

## Consideraciones operativas para ejecución óptima

### Requisitos previos

- **Node.js 22+** para el orquestador.
- **Docker** para despliegue en producción (dos servicios: orquestador + agente IA).
- **OpenCode API key** (una sola key cubre ambos modelos: generador y reviewer).
- **GitHub Token** para abrir PRs e Issues.
- **Webhook Secret** para validar webhooks en producción.

### Onboarding de una app

1. Crear `config/apps/<nombre>.yaml` copiando el ejemplo.
2. Rellenar: repo, rama base, URL de DEV, y si se quiere shadow mode inicial.
3. Opcional: añadir `versionUrl` si DEV expone un endpoint de health check por SHA.
4. Arrancar el servicio y validar con `npm test` + `npm run typecheck`.

### Configuración de modelos

- El generador usa un modelo principal (por ejemplo, `deepseek-v4-pro`).
- El reviewer **debe usar un modelo diferente** (por ejemplo, `qwen3.7-max`) para garantizar independencia real.
- Si un modelo no está disponible, se puede sustituir editando la configuración del agente.

### Seguridad y fronteras

- El agente de IA es **solo lectura** sobre los repos vigilados. Solo el orquestador (código determinista) hace git push.
- Los tests de código (mode `code`) corren el comando de test del repo propio. Esto se hace con un entorno **scrubbed** (lista blanca de variables) para no exponer secretos del orquestador.
- El auto-merge del maintainer está **desactivado por defecto** y requiere activación explícita.

### Métricas y observabilidad

- **OpenTelemetry tracing:** distribuido en todo el pipeline.
- **Prometheus metrics:** disponibles en `/metrics` (profundidad de cola, sesiones abiertas de OpenCode, etc.).
- **Health poller:** cada 60 segundos verifica que el servicio responde, profundidad de cola, y limpieza de sesiones huérfanas.
- **Limpieza de mirrors:** cada 6 horas se eliminan working copies antiguos (>7 días) o huérfanos (app ya no configurada), preservando el más reciente por repo y nunca tocando uno en uso.

### Recuperación ante caídas

- Si el proceso se reinicia durante un run, al arrancar se detectan los runs interrumpidos (`running` o `enqueued`) y se marcan como `infra-error`, registrando un incidente para trazabilidad.
- La base de datos de historial es SQLite (persistente), no in-memory; los runs sobreviven a reinicios.
- El gate de despliegue se salta si la app no tiene `versionUrl`, pero es recomendable configurarlo para no ejecutar contra un despliegue desfasado.

---

## Resumen: la promesa de valor

El sistema transforma cada despliegue en un checkpoint de QA automático. La suite de tests crece orgánicamente con cada commit, aprende de sus errores, y se mantiene enfocada en lo que realmente cambia. No reemplaza los tests existentes: los complementa con una capa de cobertura E2E que se auto-mantiene, se auto-mejora y se auto-integra en el repo de cada aplicación.

> **El objetivo final:** que un equipo pueda desplegar con confianza sabiendo que cada commit fue probado por una suite que entiende qué cambió, por qué cambió, y qué podría romperse.
