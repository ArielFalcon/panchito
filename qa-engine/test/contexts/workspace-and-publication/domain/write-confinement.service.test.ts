import { test } from "node:test";
import assert from "node:assert/strict";
import { WriteConfinementService } from "@contexts/workspace-and-publication/domain/write-confinement.service.ts";

const svc = new WriteConfinementService();

test("parseStatusOutput handles rename lines and quoted paths", () => {
  const parsed = svc.parseStatusOutput('R  old.ts -> new.ts\n?? "spa ced.ts"\n M e2e/a.spec.ts');
  assert.deepEqual(parsed.map((p) => p.path), ["new.ts", "spa ced.ts", "e2e/a.spec.ts"]);
});

test("isE2eStray flags anything outside e2e/", () => {
  assert.equal(svc.isE2eStray("src/x.ts"), true);
  assert.equal(svc.isE2eStray("e2e/a.spec.ts"), false);
  assert.equal(svc.isE2eStray("e2e"), false);
});

test("isCodeDenied flags the denylist (.env, Dockerfile, .github/, docker-compose*)", () => {
  assert.equal(svc.isCodeDenied(".env"), true);
  assert.equal(svc.isCodeDenied(".env.local"), true);
  assert.equal(svc.isCodeDenied("docker-compose.yml"), true);
  assert.equal(svc.isCodeDenied("src/app.ts"), false);
});

test("isDangerousPath flags secret files regardless of target", () => {
  assert.equal(svc.isDangerousPath(".env"), true);
  assert.equal(svc.isDangerousPath("secrets.env"), true);
  assert.equal(svc.isDangerousPath("e2e/a.spec.ts"), false);
});
