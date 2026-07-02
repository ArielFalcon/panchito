// Fixture for L1.3: two different front files calling the same undeclared endpoint.
// Both call POST name-orders-api/orders (not in the backend contract).
// The drift dedup key should include from.file, so both produce separate drift entries.
const BASE = 'name-orders-api';

const alphaApi = {
  createOrder() {
    return this.rest.post(`${BASE}/orders`, {});
  },
  rest: null as unknown as { post(p: string, b: unknown): unknown },
};
export default alphaApi;
