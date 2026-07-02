// Fixture for Finding 2 (Round 2): repeated const reference in a template literal.
// `${API}/${API}` — both references to API must resolve to their const value.
// Bug: the first ${API} adds 'API' to the `seen` Set; the second ${API} sees it already in `seen`
// and substitutes {p} instead of the const value.
const API = 'name-orders-api';

export function getList(this: { rest: { get(p: string): unknown } }) {
  // Uses API twice — both should resolve to 'name-orders-api'.
  // Resolved path: 'name-orders-api/name-orders-api' (unusual but valid for the dedup test).
  return this.rest.get(`${API}/${API}`);
}
