import { test } from "node:test";
import assert from "node:assert/strict";
import { Objective, Flow } from "@kernel/objective.ts";

test("Flow: is a non-empty named user flow", () => {
  assert.equal(Flow.of("login").name, "login");
  assert.throws(() => Flow.of("  "), /Flow/);
});

test("Objective: binds a Flow to an acceptance criterion + targets", () => {
  const o = Objective.of({ flow: "login", objective: "user can sign in", targets: ["/login", "AuthForm"] });
  assert.equal(o.flow.name, "login");
  assert.equal(o.objective, "user can sign in");
  assert.deepEqual(o.targets, ["/login", "AuthForm"]);
});

test("Objective: rejects an empty objective and freezes targets", () => {
  assert.throws(() => Objective.of({ flow: "login", objective: "", targets: [] }), /Objective/);
  const o = Objective.of({ flow: "login", objective: "x", targets: ["a"] });
  assert.throws(() => { (o.targets as string[]).push("b"); });
});
