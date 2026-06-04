# Servicio permanente (se usa de verdad en M2). En M0 el disparo es por CLI.
FROM node:22-slim

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm install --omit=dev || npm install

COPY . .

# Arranque del servicio (webhook + scheduler llegan en M2).
CMD ["npm", "run", "start"]
