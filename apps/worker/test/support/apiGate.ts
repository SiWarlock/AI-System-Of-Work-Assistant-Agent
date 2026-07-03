// The live-API integration-test gate for @sow/worker (mirrors `temporalGate.ts`).
// The DEFAULT suite must NEVER open a socket; the live loopback HTTP+WS transport
// test is gated on this flag and skipped unless the operator opts in with SOW_API=1.
//
// Convention:
//   import { SOW_API } from "./support/apiGate";
//   describe.skipIf(!SOW_API)("live API …", () => { … });

/** True IFF the operator opted into the live loopback-transport (socket-opening) suite. */
export const SOW_API: boolean = process.env.SOW_API === "1";
