// @sow/evals — EVAL-1 · conformance · leakage harness (§12). Phase-5 task 5.10
// lands the conformance harness: the provider/runtime conformance runners, the
// shared assessment core, and the matrix-eligibility + meeting.close DoD gates.
// Pure over injected ports/gates; real provider/runtime runs are key-gated.
export * from "./conformance/conformance-core";
export * from "./conformance/provider-conformance";
export * from "./conformance/runtime-conformance";
export * from "./conformance/matrix-eligibility";

// EVAL-1 harness core (§12/§20.1, task 12.1): the criteria registry (§20.1 1:1
// map), the scoring runner (threshold + DoD-honesty), and the versioned corpus
// loader. `EVALUATION_CRITERIA.md` (package root) is the human mirror.
export * from "./harness/criteria-registry";
export * from "./harness/runner";
export * from "./harness/corpus-loader";
export * from "./harness/corpus-schemas";
