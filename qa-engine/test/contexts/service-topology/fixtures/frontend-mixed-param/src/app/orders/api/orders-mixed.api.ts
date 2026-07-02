// Fixture for L1.1: mixed-param template confidence test.
// BASE is a const (fully resolved literal), methodParam is a method argument (unresolved → {p}).
// `${BASE}/orders/${methodParam}` → resolves to "name-orders-api/orders/{p}"
// The {p} segment matches the contract's {id} param → structural match succeeds
// but SHOULD yield confidence < 1.0 (not a pure literal match).
// Also has a fully-literal call (no {p}) → should yield confidence 1.0.
const BASE = 'name-orders-api';

const ordersMixedApi = {
  // Mixed: BASE const (resolved) + methodParam arg (unresolved → {p})
  // This IS a valid match against /orders/{id} but NOT a pure-literal match
  getOrderDynamic(methodParam: string) {
    return this.rest.get(`${BASE}/orders/${methodParam}`);
  },

  // Fully-literal: BASE const + literal "orders" segment — pure literal, confidence 1.0
  listOrders() {
    return this.rest.get(`${BASE}/orders`);
  },

  rest: null as unknown as { get(p: string): unknown },
};
export default ordersMixedApi;
