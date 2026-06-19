# @ai-pipeline/web — operator/value dashboard (slot)

The web dashboard for ai-pipeline. **The UI implementation is delegated**; this package is
the prepared slot and its integration contract.

## How it fits

- Lives in this monorepo as a workspace; consumes [`@ai-pipeline/sdk`](../packages/sdk) for
  all backend access (typed, generated from the contract — no hand-written request glue).
- Built to **`web/dist`** and served **same-origin** by the orchestrator at **`/app`** (see
  `src/server/static.ts`). No CORS; the browser carries the operator's credentials.
- Talks only to `/api/v1/*` and the SSE live feed through the SDK — never to SQLite or the
  orchestrator internals directly.

## Contract for the dashboard build

- Output a static SPA build into `web/dist` (including `index.html`).
- Import the SDK: `import { createClient } from "@ai-pipeline/sdk"`, called with
  `{ baseUrl: "" }` (same-origin).
- Client-side routes under `/app/*` are fine — the orchestrator falls back to `index.html`.

`src/main.ts` is a placeholder that only proves the SDK wiring compiles. Replace it.
