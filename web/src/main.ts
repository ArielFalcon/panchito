// Placeholder entry for the operator/value dashboard. The UI itself is delegated; this file
// only proves the SDK wiring compiles end-to-end. Replace it with the dashboard app.
//
// The dashboard is served same-origin by the orchestrator at /app, so baseUrl is "" and the
// browser carries the operator's existing credentials to /api/v1/*.
import { createClient, type SignalsView, type RunEvent } from "@ai-pipeline/sdk";

export function makeClient() {
  return createClient({ baseUrl: "" });
}

export async function loadFleetSignals(): Promise<SignalsView> {
  return makeClient().getSignals();
}

export async function tailRun(runId: string, onEvent: (event: RunEvent) => void): Promise<void> {
  for await (const event of makeClient().streamRunEvents(runId)) {
    onEvent(event);
  }
}
