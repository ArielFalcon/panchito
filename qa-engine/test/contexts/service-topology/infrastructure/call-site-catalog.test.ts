// test/contexts/service-topology/infrastructure/call-site-catalog.test.ts
// TDD (strict): the catalog is the ONLY place a call-site shape lives.
// Config supplies the receiver (e.g. "this.rest"); the core never hardcodes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { CallSiteCatalog, type CallSiteExtractor } from "@contexts/service-topology/infrastructure/call-site-catalog.ts";

/** Look up a catalog entry, asserting it is registered (noUncheckedIndexedAccess narrowing). */
function getExtractor(kind: string): CallSiteExtractor {
  const extractor = CallSiteCatalog[kind];
  assert.ok(extractor, `expected '${kind}' to be registered in the catalog`);
  return extractor;
}

test("CallSiteCatalog: receiver-verb-call extracts verb + rawArg for a configured receiver", () => {
  const extractor = getExtractor("receiver-verb-call");
  const text = "this.rest.get('/name-orders-api/orders')";
  const sites = extractor(text, { kind: "receiver-verb-call", receiver: "this.rest" });
  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.verb, "get");
  assert.equal(sites[0]?.rawArg, "'/name-orders-api/orders'");
  assert.equal(sites[0]?.index, text.indexOf("this.rest"));
});

test("CallSiteCatalog: receiver-verb-call works with a DIFFERENT receiver from config (no nname literal)", () => {
  const extractor = getExtractor("receiver-verb-call");
  const text = "this.http.post('/x-service/y', body)";
  const sites = extractor(text, { kind: "receiver-verb-call", receiver: "this.http" });
  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.verb, "post");
  assert.equal(sites[0]?.rawArg, "'/x-service/y'");
});

test("CallSiteCatalog: receiver-verb-call does NOT match a different, unconfigured receiver", () => {
  const extractor = getExtractor("receiver-verb-call");
  const text = "this.rest.get('/name-orders-api/orders')";
  // Configured receiver is this.http — text uses this.rest — must not match.
  const sites = extractor(text, { kind: "receiver-verb-call", receiver: "this.http" });
  assert.equal(sites.length, 0);
});

test("CallSiteCatalog: receiver-verb-call escapes regex metacharacters in the receiver", () => {
  const extractor = getExtractor("receiver-verb-call");
  // A receiver containing a regex metachar ('$') must be treated literally, not as a regex token.
  const text = "this.$rest.get('/name-orders-api/orders')";
  const sites = extractor(text, { kind: "receiver-verb-call", receiver: "this.$rest" });
  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.verb, "get");
});

test("CallSiteCatalog: receiver-verb-call returns [] cleanly when receiver is missing", () => {
  const extractor = getExtractor("receiver-verb-call");
  const text = "this.rest.get('/name-orders-api/orders')";
  const sites = extractor(text, { kind: "receiver-verb-call" });
  assert.deepEqual(sites, []);
});

test("CallSiteCatalog: receiver-verb-call supports multiline chained calls (this.rest\\n  .get(...))", () => {
  const extractor = getExtractor("receiver-verb-call");
  const text = "this.rest\n  .get('/name-orders-api/orders/abc123')";
  const sites = extractor(text, { kind: "receiver-verb-call", receiver: "this.rest" });
  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.verb, "get");
});

test("CallSiteCatalog: receiver-verb-call supports generic type args (get<T>(...))", () => {
  const extractor = getExtractor("receiver-verb-call");
  const text = "this.rest.get<Order[]>('/name-orders-api/orders')";
  const sites = extractor(text, { kind: "receiver-verb-call", receiver: "this.rest" });
  assert.equal(sites.length, 1);
  assert.equal(sites[0]?.rawArg, "'/name-orders-api/orders'");
});
