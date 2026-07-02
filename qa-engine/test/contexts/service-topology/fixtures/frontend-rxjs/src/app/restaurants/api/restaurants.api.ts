// Fixture for L2 tree-sitter test: methods with RxJS chains and nested calls.
// The backward-scan heuristic picks up 'catchError', 'switchMap', 'toString'
// from inside pipe() / template expressions — tree-sitter must walk up to the
// correct enclosing method name instead.
const BASE = 'name-restaurants-api';

const restaurantsApi = {
  // Method 1: pipe() with switchMap + catchError operators.
  // from.symbol must be 'getAllRestaurants', NOT 'catchError' or 'switchMap'.
  getAllRestaurants() {
    return this.rest.get(`${BASE}/restaurants`).pipe(
      switchMap((res: unknown) => res),
      catchError((err: unknown) => { throw err; }),
    );
  },

  // Method 2: template path with a nested call (encodeURIComponent / toString).
  // The resolved path still uses the const (no {p} — encodeURIComponent only applies at runtime).
  // from.symbol must be 'createNewDailyMenu', NOT 'toString'.
  createNewDailyMenu(body: unknown) {
    const id = (123).toString();
    return this.rest.post(`${BASE}/menus`, body);
  },

  // Method 3: another method to verify each method gets its own name.
  findNearbyPlaces() {
    return this.rest.get(`${BASE}/places`).pipe(
      catchError((err: unknown) => { throw err; }),
    );
  },

  rest: null as unknown as {
    get(p: string): { pipe(...ops: unknown[]): unknown };
    post(p: string, b: unknown): unknown;
  },
};

// Re-export required to avoid unused import TS errors in strict fixtures.
export default restaurantsApi;
declare function switchMap(fn: unknown): unknown;
declare function catchError(fn: unknown): unknown;
