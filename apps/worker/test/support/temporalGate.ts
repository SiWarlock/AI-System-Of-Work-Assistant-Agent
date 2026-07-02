// The Temporal integration-test gate for @sow/worker (mirrors the @sow/workflows
// foundation gate — test/support is package-private so it cannot be imported
// cross-package). The DEFAULT suite must NEVER need a live Temporal server; any
// live-connect / time-skipping test is gated on this flag and skipped unless the
// operator opts in with SOW_TEMPORAL=1.
//
// Convention:
//   import { SOW_TEMPORAL } from "./support/temporalGate";
//   describe.skipIf(!SOW_TEMPORAL)("live Temporal …", () => { … });

/** True IFF the operator opted into the live-Temporal / time-skipping suite. */
export const SOW_TEMPORAL: boolean = process.env.SOW_TEMPORAL === "1";
