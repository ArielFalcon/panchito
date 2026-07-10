// sdd/migration-wiring-phase-2 Slice 1 (D-A): the webhook's cross-repo routing/dispatch decision,
// extracted from src/index.ts's inline req.on("end") handler so it is independently testable — that
// module runs side effects at import time (HTTP server creation, API-token file writes) and has
// never had test coverage for exactly that reason (mirrors webhook.ts's own extraction precedent:
// handleWebhook/parseWebhook were pulled out of index.ts for the same testability reason).
//
// Routes through the qa-engine app-catalog context's AppRepositoryPort.resolveByRepo
// (YamlAppConfigAdapter, composed once at index.ts module scope) instead of the legacy
// config-loader.ts loadAppConfigsByRepo — config-loader.ts's loadAppConfig/listAppConfigs remain the
// shell raw loader the adapter is injected with (unchanged, still the ONLY code that reads
// config/apps/*.yaml off disk). Output is byte-identical to the pre-swap dispatch this function
// replaces (src/index.ts:699-705, prior to this change) — see this file's own test for the pinned
// equivalence.
import type { AppRepositoryPort } from "../../qa-engine/src/contexts/app-catalog/application/ports/index";
import type { RunMode } from "../types";

export interface WebhookDispatch {
  app: string;
  target: "code" | "e2e";
  mode: RunMode;
  guidance?: string;
  triggerRepo?: string;
  baseSha?: string;
}

// Mirrors the legacy loadAppConfigsByRepo-driven dispatch EXACTLY: role:"primary" dispatches with
// the event payload's own mode/guidance/baseSha, target derived from app.code; role:"service" always
// forces target:"e2e", mode:"diff", triggerRepo:<the event's repo> (a service-repo deploy always
// triggers a diff-mode e2e run of the OWNING app, never the service's own mode/baseSha).
export async function resolveWebhookDispatch(
  catalog: AppRepositoryPort,
  repo: string,
  opts: { mode: RunMode; guidance?: string; baseSha?: string },
): Promise<WebhookDispatch[]> {
  const matches = await catalog.resolveByRepo(repo);
  return matches.map((m): WebhookDispatch =>
    m.role === "primary"
      ? {
          app: m.app.name,
          target: m.app.code ? "code" : "e2e",
          mode: opts.mode,
          ...(opts.guidance !== undefined ? { guidance: opts.guidance } : {}),
          ...(opts.baseSha !== undefined ? { baseSha: opts.baseSha } : {}),
        }
      : {
          app: m.app.name,
          target: "e2e",
          mode: "diff",
          ...(opts.guidance !== undefined ? { guidance: opts.guidance } : {}),
          triggerRepo: repo,
        },
  );
}
