// src/contract/events.ts
// COEXISTENCE SHIM (Plan 7.3): the canonical definitions moved to
// qa-engine/src/shared-kernel/contract/events.ts, which now owns the RunEvent
// domain model as the single source of truth. This file re-exports it so every
// existing src/ importer of "./contract/events" keeps resolving unchanged until
// Plan 7.6 deletes src/ and this shim goes with it.
//
// See qa-engine/src/shared-kernel/contract/events.ts for the full contract and
// its documentation (event model, wire enums, discriminated union).

export * from "../../qa-engine/src/shared-kernel/contract/events";
