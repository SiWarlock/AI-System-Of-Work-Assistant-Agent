// @sow/domain — pure rules, state machines, validators.
// Imports nothing app- or adapter-side (§2.5 import-direction rule).
//
// Package barrel: re-exports the full domain surface authored in Phase 1 —
// the validators (schema gate, universal rules, no-inference), the canonical-key
// / idempotency-key builders, and the transition core + the 6 state machines.
// `export *` is safe under verbatimModuleSyntax. No symbol collides across these
// modules (verified at wiring time).

// --- validation ---
export * from "./validation/schema-gate";
export * from "./validation/universal-rules";
export * from "./validation/no-inference";

// --- keys ---
export * from "./keys/canonical-key";
export * from "./keys/idempotency-key";

// --- state (transition core + the 6 machines) ---
export * from "./state/transition";
export * from "./state/agent-job";
export * from "./state/approval";
export * from "./state/knowledge-mutation";
export * from "./state/meeting-closeout";
export * from "./state/proposed-action";
export * from "./state/source";
