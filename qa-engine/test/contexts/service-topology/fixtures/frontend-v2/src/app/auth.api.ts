// Fixture for L1.2: SERVICE_PREFIX_RE digits test.
// The service slug has a digit: auth-v2 — the regex must accept [a-z0-9-] not just [a-z-].
const authApi = {
  login() {
    return this.rest.post('name-auth-v2-api/login', {});
  },
  rest: null as unknown as { post(p: string, b: unknown): unknown },
};
export default authApi;
