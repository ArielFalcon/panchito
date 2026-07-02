// test/contexts/service-topology/domain/service-link.test.ts
// RED: domain VO structural contract tests — written before the VOs exist.
import { test } from "node:test";
import assert from "node:assert/strict";
import type { ServiceLink, ServiceSymbolRef, RepoRef, ContractDrift } from "@contexts/service-topology/domain/index.ts";

// ---- ServiceSymbolRef ----
test("ServiceSymbolRef has repo, file, and symbol fields", () => {
  const ref: ServiceSymbolRef = { repo: "ArielFalcon/name-webapp", file: "src/app/order/api/order.api.ts", symbol: "getOrder" };
  assert.equal(ref.repo, "ArielFalcon/name-webapp");
  assert.equal(ref.file, "src/app/order/api/order.api.ts");
  assert.equal(ref.symbol, "getOrder");
});

// ---- RepoRef ----
test("RepoRef has repo and mirrorDir fields", () => {
  const ref: RepoRef = { repo: "ArielFalcon/ms-name-orders", mirrorDir: "/mirrors/ms-name-orders" };
  assert.equal(ref.repo, "ArielFalcon/ms-name-orders");
  assert.equal(ref.mirrorDir, "/mirrors/ms-name-orders");
});

// ---- ServiceLink ----
test("ServiceLink carries from, to, transport, confidence, and source", () => {
  const from: ServiceSymbolRef = { repo: "ArielFalcon/name-webapp", file: "src/app/order/api/order.api.ts", symbol: "getOrder" };
  const to: ServiceSymbolRef = { repo: "ArielFalcon/ms-name-orders", file: "src/main/resources/openapi/api-definition.yaml", symbol: "getOrder" };
  const link: ServiceLink = { from, to, transport: "http", contractRef: "getOrder", confidence: 1.0, source: "openapi-http" };
  assert.equal(link.transport, "http");
  assert.equal(link.contractRef, "getOrder");
  assert.equal(link.confidence, 1.0);
  assert.equal(link.source, "openapi-http");
});

test("ServiceLink contractRef is optional", () => {
  const ref: ServiceSymbolRef = { repo: "r", file: "f", symbol: "s" };
  const link: ServiceLink = { from: ref, to: ref, transport: "http", confidence: 0.5, source: "openapi-http" };
  assert.equal(link.contractRef, undefined);
});

test("ServiceLink transport is open-union: http, event, rpc are valid", () => {
  const ref: ServiceSymbolRef = { repo: "r", file: "f", symbol: "s" };
  const http: ServiceLink = { from: ref, to: ref, transport: "http", confidence: 1, source: "s" };
  const event: ServiceLink = { from: ref, to: ref, transport: "event", confidence: 1, source: "s" };
  const rpc: ServiceLink = { from: ref, to: ref, transport: "rpc", confidence: 1, source: "s" };
  assert.equal(http.transport, "http");
  assert.equal(event.transport, "event");
  assert.equal(rpc.transport, "rpc");
});

// ---- ContractDrift ----
test("ContractDrift carries from, verb, and path", () => {
  const from: ServiceSymbolRef = { repo: "ArielFalcon/name-webapp", file: "src/app/order/api/order.api.ts", symbol: "unknown" };
  const drift: ContractDrift = { from, verb: "GET", path: "/name-orders-api/v2/orders" };
  assert.equal(drift.verb, "GET");
  assert.equal(drift.path, "/name-orders-api/v2/orders");
  assert.equal(drift.from.repo, "ArielFalcon/name-webapp");
});

// ---- ServiceLink with transport: "event" ----
test("ServiceLink can represent an event link: transport=event, contractRef=event/topic name", () => {
  const from: ServiceSymbolRef = { repo: "ArielFalcon/ms-name-orders", file: "src/main/java/.../OrderCreatedPublisherNats.java", symbol: "OrderCreatedPublisherNats" };
  const to: ServiceSymbolRef = { repo: "ArielFalcon/ms-name-notifications", file: "src/main/java/.../OrderCreatedListenerNats.java", symbol: "OrderCreatedListenerNats" };
  const link: ServiceLink = { from, to, transport: "event", contractRef: "OrderCreatedEvent", confidence: 1.0, source: "event-topic" };
  assert.equal(link.transport, "event");
  assert.equal(link.contractRef, "OrderCreatedEvent");
  assert.equal(link.source, "event-topic");
});
