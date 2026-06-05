import { test } from "node:test";
import assert from "node:assert/strict";
import { validateContext, ArchitectureContext } from "./context";

const valid: ArchitectureContext = {
  builtAtSha: "abc123",
  routes: [
    { path: "/checkout", name: "Checkout", component: "CheckoutPageComponent" },
    { path: "/orders", name: "Orders" },
  ],
  api: [
    { operationId: "createOrder", method: "POST", path: "/orders", service: "orders" },
    { operationId: "listOrders", method: "GET", path: "/orders" },
  ],
  feBe: [
    { route: "/checkout", operationId: "createOrder", via: "OrdersClient.create" },
    { route: "/orders", operationId: "listOrders" },
  ],
  flows: [{ id: "checkout", routes: ["/checkout"], operations: ["createOrder"] }],
};

test("a well-formed context with resolving links is valid", () => {
  const v = validateContext(valid);
  assert.equal(v.ok, true);
  assert.equal(v.errors.length, 0);
});

test("empty sections are valid (repo with no backend / not yet mapped)", () => {
  const v = validateContext({ builtAtSha: "abc123", routes: [], api: [], feBe: [] });
  assert.equal(v.ok, true);
});

test("a non-object (or array) is rejected", () => {
  assert.equal(validateContext([]).ok, false);
  assert.equal(validateContext("nope").ok, false);
  assert.match(validateContext(null).errors[0]!, /must be an object/);
});

test("missing provenance (builtAtSha) is an error", () => {
  const { builtAtSha, ...rest } = valid;
  const v = validateContext(rest);
  assert.equal(v.ok, false);
  assert.match(v.errors.join("\n"), /builtAtSha/);
});

test("duplicate route path and duplicate operationId are errors", () => {
  const dupRoute = validateContext({ ...valid, routes: [{ path: "/x" }, { path: "/x" }], feBe: [] });
  assert.match(dupRoute.errors.join("\n"), /duplicate path '\/x'/);
  const dupOp = validateContext({
    ...valid,
    api: [
      { operationId: "dup", method: "GET", path: "/a" },
      { operationId: "dup", method: "POST", path: "/b" },
    ],
    feBe: [],
  });
  assert.match(dupOp.errors.join("\n"), /duplicate operationId 'dup'/);
});

test("an FE↔BE link must resolve to a known route AND a known operation", () => {
  const danglingRoute = validateContext({ ...valid, feBe: [{ route: "/ghost", operationId: "createOrder" }] });
  assert.match(danglingRoute.errors.join("\n"), /route '\/ghost' is not declared in 'routes'/);
  const danglingOp = validateContext({ ...valid, feBe: [{ route: "/checkout", operationId: "ghostOp" }] });
  assert.match(danglingOp.errors.join("\n"), /operationId 'ghostOp' is not declared in 'api'/);
});

test("an api operation needs method and path", () => {
  const v = validateContext({ ...valid, api: [{ operationId: "x" } as never], feBe: [] });
  assert.match(v.errors.join("\n"), /api 'x': missing 'method'/);
  assert.match(v.errors.join("\n"), /api 'x': missing 'path'/);
});

test("a flow must carry at least one route", () => {
  const v = validateContext({ ...valid, flows: [{ id: "empty", routes: [] }] });
  assert.equal(v.ok, false);
  assert.match(v.errors.join("\n"), /flows 'empty': empty 'routes'/);
});
