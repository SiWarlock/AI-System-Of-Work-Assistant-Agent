// @sow/policy — governed §5 policy layer: workspace / egress / tool / approval /
// provider-matrix predicates + session-auth. PURE (no clock, no network, no
// Math.random — node:crypto in session-auth only). Every cross-subsystem fn
// returns a typed PolicyDecision with enumerable failure variants; never throws
// across a boundary (§16). Fail-closed: malformed input ⇒ DENY.
//
// FULL public barrel (Synthesis stage). Re-exports the public surface of every
// §5 module. No colliding symbol names across modules — a flat `export *` fan-out
// is safe.

// Shared decision / denial / audit contract (Task 3.1).
export * from "./decision";
export * from "./denials";
export * from "./audit-signal";

// Workspace policy resolution + visibility lattice / cross-workspace hard denial.
export * from "./workspace-policy";
export * from "./visibility";

// Provider-matrix route resolution + route→processor identity + egress veto.
export * from "./provider-matrix";
export * from "./processors";
export * from "./egress";

// Tool-policy mutation assessment + ING-7 / candidate-data admission gate.
export * from "./tool-policy";
export * from "./admission";
// Phase-C: the Copilot tool catalog + the mutating-tool classifier that closes the ING-7 arch_gap.
export * from "./copilot-tool-catalog";
// §13.10 gate (a) SC1: the WS-8 workspace-scope core (attributeSlug / attributeHit / decideHitScope).
export * from "./copilot-workspace-scope";

// Approval-required predicate + renderer↔worker session-auth primitive.
export * from "./approval-policy";
export * from "./session-auth";
