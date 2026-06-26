// test/contexts/generation/infrastructure/context-assembler.adapter.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { ContextAssemblerAdapter } from "@contexts/generation/infrastructure/context-assembler.adapter.ts";

test("assemble delegates to the injected assemble fn and returns its AssembledPrompt", () => {
  let seenSections: unknown = null;
  const adapter = new ContextAssemblerAdapter(
    (sections, opts) => { seenSections = sections; return { text: "ASM", sectionSizes: { task: 3 } } as never; },
    (heading, band, body, opts) => ({ heading, band, body, ...opts }) as never,
  );
  const s = adapter.section("task", "task", "do x", { priority: 1 });
  const out = adapter.assemble([s], { budgetBytes: 1000 });
  assert.ok(seenSections, "assemble must be called");
  assert.equal(out.text, "ASM");
});

test("section delegates to the injected section fn and returns its Section", () => {
  let seenId = "";
  const adapter = new ContextAssemblerAdapter(
    (sections, opts) => ({ text: "X", sectionSizes: {} }) as never,
    (id, role, content, opts) => { seenId = id; return { id, role, content, ...opts } as never; },
  );
  const s = adapter.section("my-section", "semi-stable", "content here", { priority: 5 });
  assert.equal(seenId, "my-section");
  assert.equal((s as unknown as { id: string }).id, "my-section");
});

test("sectionSizes are forwarded from the assembled result for telemetry", () => {
  const adapter = new ContextAssemblerAdapter(
    (_sections, _opts) => ({ text: "RESULT", sectionSizes: { task: 7, diff: 42 } }) as never,
    (_id, _role, content) => ({ content }) as never,
  );
  const s = adapter.section("task", "task", "do y");
  const out = adapter.assemble([s], { budgetBytes: 500 });
  assert.deepEqual(out.sectionSizes, { task: 7, diff: 42 });
});

test("assemble is called with the budgetBytes passed in (opts forwarded)", () => {
  let seenOpts: unknown = null;
  const adapter = new ContextAssemblerAdapter(
    (_sections, opts) => { seenOpts = opts; return { text: "", sectionSizes: {} }; },
    (_id, _role, content) => ({ content }) as never,
  );
  adapter.assemble([], { budgetBytes: 9999 });
  assert.deepEqual(seenOpts, { budgetBytes: 9999 });
});
