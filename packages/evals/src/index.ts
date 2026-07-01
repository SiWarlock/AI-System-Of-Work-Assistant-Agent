// @sow/evals — EVAL-1 · conformance · leakage harness (§12). Phase-5 task 5.10
// lands the conformance harness: the provider/runtime conformance runners, the
// shared assessment core, and the matrix-eligibility + meeting.close DoD gates.
// Pure over injected ports/gates; real provider/runtime runs are key-gated.
export * from "./conformance/conformance-core";
export * from "./conformance/provider-conformance";
export * from "./conformance/runtime-conformance";
export * from "./conformance/matrix-eligibility";
