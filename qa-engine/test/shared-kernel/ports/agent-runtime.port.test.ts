// test/shared-kernel/ports/agent-runtime.port.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import type { AgentRuntimePort } from "@kernel/ports/agent-runtime.port.ts";
test("AgentRuntimePort is importable from the kernel (generation depends on it FROM here, §5.2)", () => {
  const _typecheck: AgentRuntimePort | null = null; // compile-time guard; tsc is the real assertion
  assert.equal(_typecheck, null);
});
