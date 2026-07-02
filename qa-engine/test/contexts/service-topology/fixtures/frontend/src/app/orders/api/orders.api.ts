// Fixture: minimal *.api.ts for resolver tests. No real Angular/RxJS imports needed —
// the resolver only reads file text, it does NOT import this file.
// We use plain object syntax to avoid missing-module TS errors while keeping the
// this.rest.{verb}(path) call patterns the resolver scans for.

const BASE_PATH = 'name-orders-api';

// (a) Matched: GET /orders → listOrders
// (e) Multiline-chained matched: GET /orders/{id} → getOrderById
// (b) Drift: POST /orders (not in the backend contract)
// (c) External: call to a service not in the repo set
// (d) Unresolved: dynamic arg (method parameter — cannot resolve statically)

const ordersApi = {
  // (a) Matched: GET /name-orders-api/orders → listOrders operationId
  listOrders() {
    return this.rest.get(`${BASE_PATH}/orders`);
  },

  // (e) Multiline-chained matched: GET /name-orders-api/orders/{id} → getOrderById
  // Front passes hardcoded literal "abc123" where contract has {id} — structural match still works.
  getOrderById() {
    return this.rest
      .get(`${BASE_PATH}/orders/abc123`);
  },

  // (b) Drift: POST /name-orders-api/orders — NOT declared in the backend OpenAPI contract
  createOrder(body: unknown) {
    return this.rest.post(`${BASE_PATH}/orders`, body);
  },

  // (c) External: targets a service not present in the indexed repo set
  getFromUnknown() {
    return this.rest.get(`name-unknown-api/items`);
  },

  // (d) Unresolved: bare identifier = method parameter = cannot be resolved statically
  getDynamic(id: string) {
    return this.rest.get(id);
  },

  rest: null as unknown as { get(p: string): unknown; post(p: string, b: unknown): unknown },
};

export default ordersApi;
