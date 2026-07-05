// Fixture: a normal src call-site, to prove the walk() skip-set guard only excludes
// vendor/build directories and still extracts real application code.
const BASE_PATH = 'name-orders-api';

const ordersApi = {
  listOrders() {
    return this.rest.get(`${BASE_PATH}/orders`);
  },

  rest: null as unknown as { get(p: string): unknown },
};

export default ordersApi;
