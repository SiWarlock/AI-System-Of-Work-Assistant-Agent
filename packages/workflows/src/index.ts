// @sow/workflows — §9 Temporal Workflows & Automation (the durable integration spine).
//
// Two-layer design:
//   • src/runtime/       PURE, deterministic lifecycle logic (single-active lease
//                        decision, durable-schedule catch-up, clock-jump-safe
//                        bookkeeping, WorkflowRun idempotency, in-flight resume +
//                        §8 external-write-envelope reuse). No @temporalio, no
//                        node:crypto, no I/O — Vitest-unit-tested with fakes.
//   • src/orchestration/ PURE per-workflow control drivers over the Phase-1
//                        DOMAIN_MODEL state machines + injected activity ports —
//                        where each workflow's decision logic lives + is tested.
//   • src/ports/         activity port interfaces the workflows call.
//   • src/activities/    activity implementations (call the real gateway /
//                        KnowledgeWriter / Broker adapters; do the I/O).
//   • src/workflows/     THIN @temporalio/workflow definitions wiring
//                        proxyActivities to the orchestration drivers. Workflow
//                        code is sandbox-safe (deterministic; no node:crypto — keys
//                        /hashes are computed in activities). Covered by the
//                        SOW_TEMPORAL-gated integration tests.
//
// Synthesis-finalized barrel: a flat `export *` over every runtime/ + activities/ +
// ports/ + workflows/ module authored so far (NOT test/support). Every module-level
// symbol name is unique across the package (no collision rename was required at
// synthesis), so the flat re-export is unambiguous. Deep subpath imports
// (`@sow/workflows/ports/operational`, `@sow/workflows/runtime/taskQueue`) remain
// available via the package `exports` map ("./*") and are used by @sow/worker.

// --- src/ports/ — the shared operational port surface -----------------------
export * from "./ports/operational";

// --- src/runtime/ — the PURE, deterministic lifecycle logic -----------------
export * from "./runtime/taskQueue";
export * from "./runtime/clock";
export * from "./runtime/schedule";
export * from "./runtime/catchUpWindow";
export * from "./runtime/workflowRun";
export * from "./runtime/idempotency";
export * from "./runtime/resume";
export * from "./runtime/wakeHooks";

// --- src/activities/ — activity implementations (worker-side I/O) ------------
export * from "./activities/healthItem";
export * from "./activities/envelopeReuse";

// --- src/workflows/ — orchestration drivers / (later) thin Temporal defs -----
export * from "./workflows/systemHealthSurfacing";
