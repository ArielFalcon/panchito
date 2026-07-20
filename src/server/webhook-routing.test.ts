// sdd/migration-wiring-phase-2 Slice 1 (D-A, task 1.1): pins resolveWebhookDispatch's output as
// BYTE-IDENTICAL to the legacy loadAppConfigsByRepo-driven dispatch it replaces at
// src/index.ts:699-705 — single-app, multi-app A-primary/B-service, unwatched-repo, and
// malformed-config-skip scenarios. Exercises the REAL production adapter (YamlAppConfigAdapter)
// wired with the REAL shell loaders (loadAppConfig/listAppConfigs) over a temp config root, so this
// is a genuine integration pin, not a hand-rolled fake standing in for the adapter.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAppConfig, loadAppConfigsByRepo, listAppConfigs, type RepoMatch } from "../orchestrator/config-loader";
import { YamlAppConfigAdapter } from "../../qa-engine/src/contexts/app-catalog/infrastructure/yaml-app-config.adapter";
import { resolveWebhookDispatch, type WebhookDispatch } from "./webhook-routing";

function makeRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "webhook-routing-"));
  mkdirSync(join(root, "config", "apps"), { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(root, "config", "apps", name), content);
  }
  return root;
}

const SHOP = `
name: "shop"
repo: "org/shop-front"
dev:
  baseUrl: "https://dev.shop.io"
services:
  - repo: "org/orders-svc"
qa:
  needsReview: true
  testDataPrefix: "qa-shop"
report:
  onFailure: "github-issue"
`;

const ORDERS_CODE = `
name: "orders"
repo: "org/orders-svc"
code: true
qa:
  needsReview: false
  testDataPrefix: "qa-orders"
report:
  onFailure: "github-issue"
`;

// Mirrors src/index.ts:699-705's PRE-swap dispatch derivation exactly (the legacy oracle this
// slice's GREEN step replaces) — the acceptance bar resolveWebhookDispatch must clear.
function legacyDispatch(matches: RepoMatch[], repo: string, opts: { mode: string; guidance?: string; baseSha?: string }): WebhookDispatch[] {
  return matches
    .map((m): WebhookDispatch =>
      m.role === "primary"
        ? {
            app: m.app.name,
            target: m.app.code ? "code" : "e2e",
            mode: opts.mode as WebhookDispatch["mode"],
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
    )
    .sort((a, b) => a.app.localeCompare(b.app));
}

function sorted(dispatch: WebhookDispatch[]): WebhookDispatch[] {
  return [...dispatch].sort((a, b) => a.app.localeCompare(b.app));
}

test("resolveWebhookDispatch: single-app primary-repo webhook — identical to the legacy dispatch", async () => {
  const root = makeRoot({ "shop.yaml": SHOP });
  try {
    const adapter = new YamlAppConfigAdapter({ load: (name) => loadAppConfig(name, root), list: () => listAppConfigs(root) });
    const opts = { mode: "diff" as const, guidance: "test the checkout flow", baseSha: "base123" };

    const actual = await resolveWebhookDispatch(adapter, "org/shop-front", opts);
    const expected = legacyDispatch(loadAppConfigsByRepo("org/shop-front", root), "org/shop-front", opts);

    assert.deepEqual(sorted(actual), expected);
    assert.deepEqual(sorted(actual), [{ app: "shop", target: "e2e", mode: "diff", guidance: "test the checkout flow", baseSha: "base123" }]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("resolveWebhookDispatch: multi-app repo (primary of A, service of B) — identical fan-out to the legacy dispatch", async () => {
  const root = makeRoot({ "shop.yaml": SHOP, "orders.yaml": ORDERS_CODE });
  try {
    const adapter = new YamlAppConfigAdapter({ load: (name) => loadAppConfig(name, root), list: () => listAppConfigs(root) });
    const opts = { mode: "diff" as const };

    const actual = await resolveWebhookDispatch(adapter, "org/orders-svc", opts);
    const expected = legacyDispatch(loadAppConfigsByRepo("org/orders-svc", root), "org/orders-svc", opts);

    assert.deepEqual(sorted(actual), expected);
    assert.deepEqual(sorted(actual), [
      { app: "orders", target: "code", mode: "diff" },
      { app: "shop", target: "e2e", mode: "diff", triggerRepo: "org/orders-svc" },
    ]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("resolveWebhookDispatch: unwatched repo — zero matches, zero dispatch entries", async () => {
  const root = makeRoot({ "shop.yaml": SHOP });
  try {
    const adapter = new YamlAppConfigAdapter({ load: (name) => loadAppConfig(name, root), list: () => listAppConfigs(root) });

    const actual = await resolveWebhookDispatch(adapter, "org/nobody", { mode: "diff" });

    assert.deepEqual(actual, []);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("resolveWebhookDispatch: a malformed config is skipped — the healthy app still resolves on its own (per-file fault isolation survives the swap)", async () => {
  const root = makeRoot({ "shop.yaml": SHOP, "broken.yaml": "name: [unclosed" });
  try {
    const adapter = new YamlAppConfigAdapter({ load: (name) => loadAppConfig(name, root), list: () => listAppConfigs(root) });
    const opts = { mode: "diff" as const };

    const actual = await resolveWebhookDispatch(adapter, "org/shop-front", opts);
    const expected = legacyDispatch(loadAppConfigsByRepo("org/shop-front", root), "org/shop-front", opts);

    assert.deepEqual(sorted(actual), expected);
    assert.equal(actual.length, 1, "the malformed file must be skipped, never hiding the healthy app");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
