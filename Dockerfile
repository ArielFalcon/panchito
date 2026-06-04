# Contenedor `orchestrator`: nuestra infra Node (webhook, gate, espejo,
# ejecución E2E, reporte). La generación agéntica la hace el contenedor
# `opencode` aparte (ver docker-compose.yml + opencode/Dockerfile).
#
# Base = imagen oficial de Playwright (Node + navegadores ya instalados): aquí
# se EJECUTAN los E2E que el agente generó, contra DEV.
FROM mcr.microsoft.com/playwright:v1.50.0-jammy

# git: para clonar/posicionar los espejos de los repos vigilados.
RUN apt-get update && apt-get install -y --no-install-recommends git \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev || npm install

COPY . .

# El tooling e2e (Playwright runner + eslint + tsc) NO se instala aquí: vive en
# `e2e/` de cada repo y el orchestrator hace `npm ci` ahí por run (qa/setup.ts).
# La imagen ya trae los navegadores de Playwright (base mcr...playwright).

# Arranque del servicio: webhook + cola secuencial.
CMD ["npm", "run", "start"]
