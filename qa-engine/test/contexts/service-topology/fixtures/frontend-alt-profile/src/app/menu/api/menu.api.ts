// Fixture: SECOND, DIFFERENT boundary profile — proves the core carries zero app-specific
// literal (Invariant #1). Compared to the nname fixtures this uses:
//   - a different receiver: this.http (nname uses this.rest)
//   - a different service-prefix template: "{service}-service" (nname uses "name-{service}-api")
// If the resolver still hardcoded nname's patterns, this fixture would resolve nothing.

const BASE_PATH = 'menu-service';

const menuApi = {
  // Matched: GET /menu-service/menu → listMenuItems
  listMenuItems() {
    return this.http.get(`${BASE_PATH}/menu`);
  },

  // Matched: GET /menu-service/menu/{id} → getMenuItemById
  getMenuItemById() {
    return this.http.get(`${BASE_PATH}/menu/abc123`);
  },

  http: null as unknown as { get(p: string): unknown },
};

export default menuApi;
