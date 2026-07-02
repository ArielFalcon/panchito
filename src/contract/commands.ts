// src/contract/commands.ts
// COEXISTENCE SHIM (Plan 7.3): the canonical definitions moved to
// qa-engine/src/shared-kernel/contract/commands.ts, which now owns the
// command-side DTOs + shared wire entities as the single source of truth. This
// file re-exports it so every existing src/ importer of "./contract/commands"
// keeps resolving unchanged until Plan 7.6 deletes src/ and this shim goes
// with it.
//
// See qa-engine/src/shared-kernel/contract/commands.ts for the full contract
// and its documentation (command DTOs, agent runtime DTOs, intelligence/trends
// views).

export * from "../../qa-engine/src/shared-kernel/contract/commands";
