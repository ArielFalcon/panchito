// qa-engine/src/shared-kernel/process-sandbox/process-kill.port.ts
// The seam over the consolidated killTree (4 identical definitions today: execute.ts, code-runner.ts,
// static-signal/exec.ts, learning/mutation-code.ts). The interface lives in the kernel; the concrete
// child_process adapter lives in shared-infrastructure (a process-group kill is infra, not pure
// domain). Extracting this breaks the execute ⇄ dom-snapshot runtime cycle in later plans.

import type { ChildProcess } from "node:child_process";

export interface ProcessKillPort {
  // Kills a spawned process AND its descendants (process-group kill for detached children), falling
  // back to a direct kill if the group send fails.
  killTree(child: ChildProcess): void;
}
