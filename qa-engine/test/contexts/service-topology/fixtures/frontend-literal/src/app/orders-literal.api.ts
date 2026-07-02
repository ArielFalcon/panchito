// Fixture for Fix 3: two calls that exercise the literal-vs-param disambiguation.
// /orders/active → should hit getActiveOrders (literal wins over {id} param).
// /orders/abc123 → should hit getOrderById (no literal match, param matches).
const BASE = 'name-orders-api';

const ordersLiteralApi = {
  getActive() {
    return this.rest.get(`${BASE}/orders/active`);
  },
  getById() {
    return this.rest.get(`${BASE}/orders/abc123`);
  },
  rest: null as unknown as { get(p: string): unknown },
};
export default ordersLiteralApi;
