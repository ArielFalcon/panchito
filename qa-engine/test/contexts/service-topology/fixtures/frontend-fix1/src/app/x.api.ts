// Fixture for Fix 1: quoted path arg followed by an options object.
// CALL_RE stops at the first comma, so the captured group is `'name-x-api/p'`.
// resolveArg must use indexOf(q, 1) so `slice(1, indexOf)` correctly extracts "name-x-api/p".
const xApi = {
  getP() {
    return this.rest.get('name-x-api/p', { auth: 'client' });
  },
  rest: null as unknown as { get(p: string, opts?: unknown): unknown },
};
export default xApi;
