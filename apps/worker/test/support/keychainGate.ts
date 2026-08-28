// The LIVE-`security`-binary gate for @sow/worker (mirrors `temporalGate.ts`). The
// DEFAULT suite must NEVER shell out to the real macOS Keychain CLI; any live probe
// is gated on this flag and skipped unless the operator opts in with SOW_KEYCHAIN=1.
//
// Convention:
//   import { SOW_KEYCHAIN } from "./support/keychainGate";
//   describe.skipIf(!SOW_KEYCHAIN)("live security(1) …", () => { … });
//
// ⛔ SCOPE — what a SOW_KEYCHAIN=1 run is allowed to do. It may READ a service/account
// pair that does not exist, which is a pure lookup: it creates nothing, reads no
// secret, and needs no owner crossing. It must NOT provision (`add-generic-password`),
// delete, or read a real secret — provisioning IS the `§ARM-17` crossing and belongs to
// the owner, not to a test.

/** True IFF the operator opted into the live `/usr/bin/security` probe suite. */
export const SOW_KEYCHAIN: boolean = process.env.SOW_KEYCHAIN === "1";
