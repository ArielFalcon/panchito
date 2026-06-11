import { test } from "node:test";
import assert from "node:assert/strict";
import { TypedEventBus } from "./event-bus";

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A representative event map: distinct keys carry distinct payload shapes, so the
// type parameter is what catches a wrong-payload emit at compile time. A `type`
// alias (not `interface`) is required to satisfy the `Record<string, unknown>`
// constraint — interfaces lack an implicit index signature.
type Events = {
  step: { step: string };
  test: { name: string; passed: boolean };
};

test("on/emit delivers the typed payload and unsubscribe stops delivery", () => {
  const bus = new TypedEventBus<Events>();
  const seen: string[] = [];
  const off = bus.on("step", (p) => seen.push(p.step));

  bus.emit("step", { step: "generate" });
  bus.emit("step", { step: "validate" });
  off();
  bus.emit("step", { step: "execute" }); // ignored after unsubscribe

  assert.deepEqual(seen, ["generate", "validate"]);
});

test("a payload only reaches subscribers of its own key", () => {
  const bus = new TypedEventBus<Events>();
  let steps = 0;
  let tests = 0;
  bus.on("step", () => { steps++; });
  bus.on("test", () => { tests++; });

  bus.emit("test", { name: "login", passed: true });

  assert.equal(steps, 0);
  assert.equal(tests, 1);
});

test("emitting with no listeners is a no-op (never throws)", () => {
  const bus = new TypedEventBus<Events>();
  assert.doesNotThrow(() => bus.emit("step", { step: "gate" }));
});

test("next() resolves with the next payload", async () => {
  const bus = new TypedEventBus<Events>();
  const p = bus.next("test");
  bus.emit("test", { name: "nav", passed: false });
  assert.deepEqual(await p, { name: "nav", passed: false });
});

test("next() rejects when the signal aborts first", async () => {
  const bus = new TypedEventBus<Events>();
  const ac = new AbortController();
  const p = bus.next("step", ac.signal);
  ac.abort();
  await assert.rejects(p);
});

test("stream() yields events in order and ends cleanly on abort", async () => {
  const bus = new TypedEventBus<Events>();
  const ac = new AbortController();
  const got: string[] = [];

  const consumed = (async () => {
    for await (const p of bus.stream("step", ac.signal)) got.push(p.step);
  })();

  await tick(5); // let the iterator attach its listener
  bus.emit("step", { step: "gate" });
  bus.emit("step", { step: "generate" });
  await tick(5);
  ac.abort();

  await consumed; // resolves (does not reject) because abort ends the generator
  assert.deepEqual(got, ["gate", "generate"]);
});
