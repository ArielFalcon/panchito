// qa-engine/test/contexts/ports-compile.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";

// Importing every port barrel forces tsc (via the npm run typecheck gate) to prove the interfaces
// compile against the kernel and nothing external. Port modules export only interfaces — no runtime
// side effects — but the binding exists at runtime so the namespace reference in the assertion below
// is valid. `import * as X` (NOT `import type * as X`) is required: `import type` is fully erased
// at runtime, so referencing the namespace would throw ReferenceError.
import * as Core from "@contexts/qa-run-orchestration/application/ports/index.ts";
import * as Analysis from "@contexts/change-analysis/application/ports/index.ts";
import * as Generation from "@contexts/generation/application/ports/index.ts";
import * as Runtime from "@contexts/agent-runtime/application/ports/index.ts";
import * as Execution from "@contexts/test-execution/application/ports/index.ts";
import * as Signal from "@contexts/objective-signal/application/ports/index.ts";
import * as Learning from "@contexts/cross-run-learning/application/ports/index.ts";
import * as Workspace from "@contexts/workspace-and-publication/application/ports/index.ts";
import * as Catalog from "@contexts/app-catalog/application/ports/index.ts";

test("every bounded-context port barrel compiles and is importable", () => {
  // Reference the namespaces so the imports are not elided. Port modules export interfaces only —
  // no runtime side effects — so importing them is safe. The count assertion confirms all 9 resolved.
  const names = [Core, Analysis, Generation, Runtime, Execution, Signal, Learning, Workspace, Catalog];
  assert.equal(names.length, 9);
});
