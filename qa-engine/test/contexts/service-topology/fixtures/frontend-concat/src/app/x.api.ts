// Fixture for L1.5: string concatenation path that is a partial literal.
// 'name-x-api/' + v + '/p' is a concatenation — not a template literal, not a quoted string.
// This is a bare expression, not a string literal or const ref, so resolveArg returns null.
// The call-site should land in unresolved (dynamic), NOT drift.
const concatApi = {
  getWithConcat(v: string) {
    return this.rest.get('name-x-api/' + v + '/p');
  },
  rest: null as unknown as { get(p: string): unknown },
};
export default concatApi;
