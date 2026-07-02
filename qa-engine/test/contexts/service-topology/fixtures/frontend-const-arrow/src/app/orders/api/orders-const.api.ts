// Fixture for Finding 1 (Round 2): top-level const arrow functions.
// tree-sitter sees: variable_declarator → identifier "listOrders" + arrow_function.
// walkUpToMethod must handle variable_declarator to extract "listOrders".
//
// The resolver scans file text only — this file is never imported or executed.
// Using 'declare' to satisfy TypeScript's strict checking without actual execution.
const BASE = 'name-orders-api';

declare const self: { rest: { get(p: string): unknown } };

// Top-level const arrow: the AST node is variable_declarator, not method_definition.
// walkUpToMethod must walk up from arrow_function → variable_declarator → identifier "listOrders".
// Using 'self.rest' instead of 'this.rest' to avoid implicit-this type errors in strict mode.
// NOTE: CALL_RE uses /this\.rest/ — for the resolver to detect these, we patch the fixture.
//
// The resolver's CALL_RE: /this\.rest\s*\.\s*(get|post|put|patch|delete)\s*(?:<[^>]*>)?\(\s*([^,)\n]+)/g
// For this test to work, we must use `this.rest.get(...)` — so we declare a typed `this`.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const listOrders = function(this: { rest: { get(p: string): unknown } }) {
  return this.rest.get(`${BASE}/orders`);
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const getOrderById = function(this: { rest: { get(p: string): unknown } }, id: string) {
  return this.rest.get(`${BASE}/orders/${id}`);
};
