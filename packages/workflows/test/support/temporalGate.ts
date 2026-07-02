// FOUNDATION — the Temporal integration-test gate (shared by every 7.1–7.5 slice).
//
// The DEFAULT test suite must NEVER download a Temporal server or need one
// running: the bulk of coverage is the PURE runtime/orchestration + activities
// exercised with injected fakes (plain Vitest, no server). Any test that needs a
// LIVE Temporal server or the @temporalio/testing time-skipping env is GATED on
// this flag so it is SKIPPED unless the operator explicitly opts in with
// `SOW_TEMPORAL=1`.
//
// Convention (use verbatim in gated specs):
//   import { SOW_TEMPORAL } from "../support/temporalGate";
//   describe.skipIf(!SOW_TEMPORAL)("live Temporal …", () => { … });
//   // or, per-test:
//   it.skipIf(!SOW_TEMPORAL)("time-skips …", async () => { … });
//
// `describe.skipIf(cond)` skips the block when `cond` is truthy — so we pass
// `!SOW_TEMPORAL` (skip when the flag is OFF).

/** True IFF the operator opted into the live-Temporal / time-skipping suite. */
export const SOW_TEMPORAL: boolean = process.env.SOW_TEMPORAL === "1";
