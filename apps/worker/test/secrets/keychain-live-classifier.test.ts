// @sow/worker — the MEASURED pin for the `security(1)` fault classifier (SOW_KEYCHAIN-gated;
// the default suite never spawns a real process).
//
// WHY THIS EXISTS. `keychain-backend.ts`'s `classifyFault` carries an explicit standing
// warning: "⚠ GO-LIVE VERIFY: the exact real exit codes, the stderr STRINGS ... must all be
// checked against the live `security` binary ... the mocked tests pin this CLASSIFIER, not
// the real codes/strings." `keychain-boot.ts` says the same of its real `execFile` wrapper:
// "no test spawns a real process." So the whole Keychain path's contract with macOS rested
// on an ASSUMPTION, and `§ARM-17`'s inventory row records the smoke test as PENDING.
//
// This closes the half of that gap that needs NO owner crossing. `not_found` is not an
// obscure corner — it is the path the shipped system takes TODAY for every unprovisioned
// ref, and the one the owner will hit first if a `service`/`account` is typed wrong at
// provisioning time. Its exit code (44 = errSecItemNotFound) is the single hardcoded
// numeric constant in the classifier.
//
// ⛔ WHAT THIS DELIBERATELY DOES NOT DO. It never provisions (`add-generic-password`),
// never deletes, and never reads a real secret — it looks up a pair that does not exist.
// Provisioning IS the `§ARM-17` crossing and belongs to the owner.
//
// ⛔⛔ CORRECTED 2026-08-28 — THIS FILE'S OWN REASON FOR NOT MEASURING `locked` WAS FALSE.
// It said `locked` "stays UNMEASURED: reaching it means locking the operator's login keychain
// … which a test must not do to someone's machine." ⭐ A THROWAWAY keychain at a temp path,
// never added to the search list, measures it WITHOUT touching the operator's login keychain.
// The impossibility was ASSUMED, not tested — and it sat on the branch this suite's own last
// test calls "the dangerous direction".
// MEASURED (Darwin 25.5.0): a locked keychain exits **128 with EMPTY stdout AND stderr**, which
// tripped none of the stderr patterns and fell to `backend_error` ⇒ reported to the operator as
// `"missing"`. Now classified `locked`; pinned at the unit level in `keychain-backend.test.ts`
// ("a LOCKED keychain — exit 128, EMPTY stderr").
//
// ⚠ WHY THE `locked` PIN IS A UNIT TEST AND NOT A LIVE ONE HERE: every `security` CLI path against
// a locked keychain BLOCKS ON A MODAL UNLOCK DIALOG (`show-keychain-info` hangs too — verified,
// killed at 8s). A live test would pop a system dialog on whoever runs the suite and then hang
// until the exec timeout. The measurement is recorded; the pin is at the layer that can hold it.
//
// `denied` REMAINS UNMEASURED — it needs a real ACL denial. Stated rather than papered over.
//
// MEASURED 2026-08-28, macOS Darwin 25.5.0:
//   exit 44, stderr "security: SecKeychainSearchCopyNext: The specified item could not be
//   found in the keychain."
import { describe, it, expect } from "vitest";
import { isErr, isOk } from "@sow/contracts";
import type { SecretRef } from "@sow/knowledge";
import { SOW_KEYCHAIN } from "../support/keychainGate";
import { buildKeychainSecrets } from "../../src/secrets/keychain-boot";
import { createSecurityCliKeychainBackend, SECURITY_BIN } from "../../src/secrets/keychain-backend";
import type { KeychainExec } from "../../src/secrets/keychain-backend";

/** A bounded, shell-free exec mirroring production's `createRealExecFile` (which is module-private).
 *  Used ONLY to observe the BACKEND layer directly; the port-level test below drives the real
 *  production wrapper itself. */
function realExec(binOverride?: string): KeychainExec {
  return async (file, args) => {
    const { execFile } = await import("node:child_process");
    return new Promise((resolve) => {
      execFile(
        binOverride ?? file,
        [...args],
        { timeout: 5_000, maxBuffer: 64 * 1024, encoding: "buffer", shell: false },
        (error: (Error & { code?: unknown }) | null, stdout, stderr) =>
          resolve({
            code: error === null ? 0 : typeof error.code === "number" ? error.code : -1,
            stdout: stdout instanceof Uint8Array ? stdout : new TextEncoder().encode(String(stdout ?? "")),
            stderr: Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? ""),
          }),
      );
    });
  };
}

// A pair that cannot exist. Charset-safe for the adapter's ref guard (no leading `-`).
const ABSENT_SERVICE = "sow-live-probe-absent-service-do-not-create";
const ABSENT_ACCOUNT = "sow-live-probe-absent-account-do-not-create";
const ABSENT_REF = `keychain://${ABSENT_SERVICE}/${ABSENT_ACCOUNT}` as SecretRef;

describe.skipIf(!SOW_KEYCHAIN)("live security(1) — the not_found classification, measured", () => {
  it("BACKEND layer: the live exit code classifies as `not_found` — the classifier's one hardcoded number (44)", async () => {
    // This is the assumption the standing GO-LIVE VERIFY warning is about. `classifyFault`
    // hardcodes `code === 44` (errSecItemNotFound); every mocked test FEEDS it a 44 rather
    // than obtaining one. Here macOS supplies it.
    const backend = createSecurityCliKeychainBackend({ exec: realExec() });
    const res = await backend.read(ABSENT_SERVICE, ABSENT_ACCOUNT);

    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.kind).toBe("not_found");
  });

  it("PORT layer: the same probe through the REAL production path surfaces as `missing`", async () => {
    // The gate is `{}` — no injected execFile — so this builds the REAL bounded
    // `createRealExecFile` wrapper and spawns the REAL `/usr/bin/security`. That wrapper
    // and `mapExecResult` had never been exercised against a live process before.
    //
    // ⚠ `missing`, not `not_found`: the adapter's `REASON_FOR_KIND` deliberately renames
    // the backend kind into the port's fixed vocabulary. Pinned here BECAUSE the two layers
    // use different words for one condition — the first draft of this test asserted
    // `not_found` at this layer and failed, which is exactly the confusion worth freezing.
    const built = buildKeychainSecrets({});
    expect(built).toBeDefined();

    const res = await built!.secrets.resolveSigningKey(ABSENT_REF);

    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.reason).toBe("missing");
    // Rule 7: the failure carries the ref and a fixed class token — never key material,
    // never raw stderr.
    expect(JSON.stringify(res.error)).not.toContain("SecKeychainSearchCopyNext");
  });

  it("the getSecret facade degrades the same probe to `missing` without throwing", async () => {
    // The provider-facing surface. `missing` is what makes an unprovisioned provider
    // degrade rather than fail loudly — the shipped default posture today.
    const built = buildKeychainSecrets({});
    const res = await built!.getSecret.getSecret(ABSENT_REF);
    expect(isOk(res)).toBe(false);
    if (isOk(res)) return;
    expect(res.error.reason).toBe("missing");
  });

  it("NON-VACUITY: the spawn actually happened — a missing binary classifies DIFFERENTLY", async () => {
    // Without this, the pins above would pass just as well if `/usr/bin/security` were
    // absent and everything folded to one generic fault. Point the same wrapper at a binary
    // that does not exist: the ENOENT must reach `backend_error`, proving `not_found` above
    // came from macOS ANSWERING, not from the seam failing in a convenient direction.
    const backend = createSecurityCliKeychainBackend({ exec: realExec("/usr/bin/sow-no-such-binary") });
    const res = await backend.read(ABSENT_SERVICE, ABSENT_ACCOUNT);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.kind).toBe("backend_error");
    expect(res.error.kind).not.toBe("not_found");
  });

  it("the probe targets the absolute binary the backend declares — no PATH lookup", () => {
    expect(SECURITY_BIN).toBe("/usr/bin/security");
  });

  it("the real not_found stderr trips NONE of the locked/denied patterns — a reordered classifier degrades safely", async () => {
    // The classifier returns on `code === 44` FIRST, so the stderr patterns are never
    // consulted for this case. That makes the ordering load-bearing and invisible: if the
    // 44 branch were ever removed or moved, what would this string fall through to?
    //
    // Measured answer: `backend_error` — an honest "something else went wrong" — and NOT a
    // confidently wrong `locked` or `denied`. Pinned against the real bytes because the
    // classifier's own comment names exactly this hazard (the `locked` word-boundary vs
    // `blocked`), and a `locked` misclassification is the dangerous direction: gateway.ts
    // treats `locked` as RETRYABLE, so a permanently absent credential would retry forever
    // instead of telling the owner to provision it.
    const stderr =
      "security: SecKeychainSearchCopyNext: The specified item could not be found in the keychain.";
    const s = stderr.toLowerCase();
    expect(s.includes("interaction not allowed")).toBe(false);
    expect(/\blocked\b/.test(s)).toBe(false);
    expect(s.includes("denied")).toBe(false);
    expect(s.includes("not authorized")).toBe(false);
    expect(s.includes("auth failed")).toBe(false);

    // Positive control for the word-boundary regex itself — it must still MATCH a real
    // lock message, or the assertion above would pass for the wrong reason (a regex that
    // matches nothing).
    expect(/\blocked\b/.test("the user interaction is not allowed; keychain is locked")).toBe(true);
    expect(/\blocked\b/.test("the request was blocked")).toBe(false);
  });
});
