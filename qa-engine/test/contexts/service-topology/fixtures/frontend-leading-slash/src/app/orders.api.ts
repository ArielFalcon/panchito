// Fixture for L1.2: SERVICE_PREFIX_RE leading slash test.
// Path has a leading slash: /name-orders-api/orders — regex must handle optional leading slash.
const ordersApi = {
  listOrders() {
    return this.rest.get('/name-orders-api/orders');
  },
  rest: null as unknown as { get(p: string): unknown },
};
export default ordersApi;
