// Fixture for L1.3: second front file calling the same undeclared endpoint.
// Same endpoint as alpha.api.ts (POST name-orders-api/orders) but different file.
// With from.file in the dedup key, both entries should survive.
const BASE = 'name-orders-api';

const betaApi = {
  createOrder() {
    return this.rest.post(`${BASE}/orders`, {});
  },
  rest: null as unknown as { post(p: string, b: unknown): unknown },
};
export default betaApi;
