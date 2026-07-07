# @panchito/sdk

Typed TypeScript client for the panchito orchestrator control API.

- **Types are generated** from `contract/openapi.json` (the same artifact panchito's Go
  client consumes) via `npm run sdk:gen` → `src/types.gen.ts`. They never drift from the
  server — `tsc` fails if a wire shape changes.
- **Only the transport is hand-written**: `transport.ts` (fetch + Bearer + error
  normalization) and `sse.ts` (fetch-based SSE with reconnect + Last-Event-ID, mirroring
  the Go client). Write it once here; every TS client imports it instead of re-gluing.

## Usage

```ts
import { createClient } from "@panchito/sdk";

// Same-origin (served by the orchestrator at /app): baseUrl "" carries the operator's creds.
const client = createClient({ baseUrl: "", token });

const signals = await client.getSignals();
const runs = await client.listRuns("portfolio");

for await (const event of client.streamRunEvents(runId)) {
  if (event.body.type === "run.verdict") break;
}
```

## Regenerating types

```bash
npm run contract:gen   # zod schemas → contract/openapi.json
npm run sdk:gen        # contract/openapi.json → packages/sdk/src/types.gen.ts
```

`src/types.gen.ts` is generated and should be regenerated (not hand-edited) whenever the
contract changes.
