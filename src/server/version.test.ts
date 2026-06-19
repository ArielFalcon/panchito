import { test } from "node:test";
import assert from "node:assert/strict";
import { handshake, versionGte, SERVER_VERSION, MIN_CLIENT_VERSION, WIRE_API_VERSION, CAPABILITIES } from "./version";

test("handshake reports the server version, wire API and capabilities", () => {
  const info = handshake("0.1.0");
  assert.equal(info.serverVersion, SERVER_VERSION);
  assert.equal(info.serverVersion, "0.1.0"); // from package.json
  assert.equal(info.apiVersion, WIRE_API_VERSION);
  assert.equal(info.minClientVersion, MIN_CLIENT_VERSION);
  assert.deepEqual(info.capabilities, [...CAPABILITIES]);
});

test("handshake is compatible for a new-enough client and omits a message", () => {
  const info = handshake("0.1.0");
  assert.equal(info.compatible, true);
  assert.equal(info.message, undefined);
});

test("handshake flags an old client and explains how to fix it", () => {
  const info = handshake("0.0.9");
  assert.equal(info.compatible, false);
  assert.match(info.message ?? "", /Update panchito/);
});

test("handshake without a client version assumes compatible (cannot judge)", () => {
  assert.equal(handshake().compatible, true);
});

test("handshake advertises the GitHub OAuth client id when configured, omits it otherwise", () => {
  assert.equal(handshake("0.1.0", "Ov23xyz").githubClientId, "Ov23xyz");
  assert.equal(handshake("0.1.0").githubClientId, undefined);
  assert.equal(handshake("0.1.0", "").githubClientId, undefined); // empty env var ⇒ not advertised
});

test("versionGte compares major.minor.patch numerically and tolerates a v prefix / pre-release", () => {
  assert.equal(versionGte("1.0.0", "0.9.9"), true);
  assert.equal(versionGte("0.1.0", "0.1.0"), true);
  assert.equal(versionGte("0.2.0", "0.10.0"), false);
  assert.equal(versionGte("v1.2.3-rc1", "1.2.3"), true);
});
