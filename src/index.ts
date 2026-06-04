// Arranque del SERVICIO permanente. En M2 aquí se levanta el webhook server
// (src/server/webhook.ts) que recibe { repo, sha } tras el deploy a DEV y
// encola un run. En M0 el disparo es manual:
//
//   npm run qa -- --app <app> --sha <sha>

console.log(
  "ai-pipeline — servicio (M2, webhook). Para M0 usa: npm run qa -- --app <app> --sha <sha>",
);
