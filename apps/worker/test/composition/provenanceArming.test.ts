// @sow/worker — `resolveProvenanceArming`: PROVISIONING IS THE ARMING ACT (task 20.1 wiring half).
//
// ⛔ THE DEFECT THIS EXISTS TO PREVENT, and it is the reason this resolver is not just
// `keychainSecrets: {}` at the host. `bootWorker` binds the signing dep on CONSTRUCTION:
//
//     const signing = provenanceBundle === undefined || resolvedSigningSecrets === undefined
//       ? undefined : { … }
//
// ⇒ passing a Keychain gate and a bundle makes `signing !== undefined` **whether or not the key
// exists**. `gateProposeArming` then reads precondition (3) as `signingKeyResolved: signing !==
// undefined` — a field NAMED for resolution that measures CONSTRUCTION. ⭐⭐ So the naive wiring
// would arm propose with a signing key that does not resolve, and the first thing anyone would
// learn about it is a stamp failing at commit time.
//
// ⇒ THIS RESOLVER ACTUALLY RESOLVES THE KEY BEFORE REPORTING ARMED. That makes the precondition's
// NAME true, and it makes the owner's provisioning act — and nothing else — the thing that arms.
//
// ⛔ RULE 7: the resolved key is proof-of-resolution ONLY. Its bytes are never returned, never
// logged, never stored on the outcome. `resolveSigningKey` is called for its Result, and the value
// is discarded at the point of check.
//
// ⭐ WHY A REASON RATHER THAN A BARE `undefined` (`worker L79`): four distinct states are
// individually recoverable and an operator must be able to tell them apart — no Keychain gate, no
// pin file, an unparseable pin, and a key that does not resolve. Collapsing them would tell the
// owner "not armed" and leave them to guess which of four things to fix.
import { describe, it, expect } from "vitest";
import type { SecretRef, SecretsPort } from "@sow/knowledge";
import { ok, err } from "@sow/contracts";
import { resolveProvenanceArming } from "../../src/composition/provenanceArming";

const REF = "keychain://sow/kw-signing" as SecretRef;

/** A pin file that parses. Mirrors the shape of the repo's own `config/gbrain.pin`. */
const VALID_PIN_TEXT = [
  "gbrain_sha = 3933eb6a7915cb5495b8057b75567e2b1588b5ac",
  "gbrain_tag = 0.35.1.0",
  "gbrain_repo = https://github.com/garrytan/gbrain.git",
  "index_schema_ver = 2",
  "validated_on = PENDING_PHASE12",
  "validation_ref = docs/design/gbrain-write-through-divergence.md",
  "write_through_enabled = false",
].join("\n");

const secretsThatResolve = (): SecretsPort => ({
  resolveSigningKey: () => Promise.resolve(ok(new Uint8Array([1, 2, 3, 4]))),
});
const secretsThatFail = (): SecretsPort => ({
  resolveSigningKey: () =>
    Promise.resolve(err({ code: "secret_unresolved", ref: REF } as never)),
});

describe("resolveProvenanceArming — provisioning is the arming act (20.1)", () => {
  it("ARMS only when the pin parses AND the signing key actually RESOLVES", async () => {
    const r = await resolveProvenanceArming({
      readPinText: () => Promise.resolve(VALID_PIN_TEXT),
      secrets: secretsThatResolve(),
      signingKeyRef: REF,
    });
    expect(r.armed).toBe(true);
    if (!r.armed) return;
    expect(r.bundle.signingKeyRef).toBe(REF);
    expect(r.bundle.pin.gbrainTag).toBe("0.35.1.0");
  });

  it("⛔ does NOT arm when the key fails to resolve — the defect the naive wiring would ship", async () => {
    // THE CENTRAL CASE. Everything else is present: a Keychain gate is bound and the pin parses.
    // Only the item is missing from the Keychain. Naive wiring (`keychainSecrets: {}` + a bundle)
    // would still bind `signing` and report `signingKeyResolved: true`.
    const r = await resolveProvenanceArming({
      readPinText: () => Promise.resolve(VALID_PIN_TEXT),
      secrets: secretsThatFail(),
      signingKeyRef: REF,
    });
    expect(r.armed).toBe(false);
    if (r.armed) return;
    expect(r.reason).toBe("signing_key_unresolved");
  });

  it("distinguishes all four not-armed states — an operator must know WHICH to fix", async () => {
    const noGate = await resolveProvenanceArming({
      readPinText: () => Promise.resolve(VALID_PIN_TEXT),
      secrets: undefined,
      signingKeyRef: REF,
    });
    expect(noGate.armed === false && noGate.reason).toBe("no_secrets_gate");

    const noPin = await resolveProvenanceArming({
      readPinText: () => Promise.resolve(undefined),
      secrets: secretsThatResolve(),
      signingKeyRef: REF,
    });
    expect(noPin.armed === false && noPin.reason).toBe("no_pin_file");

    const badPin = await resolveProvenanceArming({
      readPinText: () => Promise.resolve("this is not a pin file"),
      secrets: secretsThatResolve(),
      signingKeyRef: REF,
    });
    expect(badPin.armed === false && badPin.reason).toBe("pin_invalid");
  });

  it("NEVER THROWS — a reader fault or a throwing SecretsPort degrades, it does not crash boot (§16)", async () => {
    // The host calls this during startup. A throw here takes the whole worker down, which is
    // strictly worse than not arming.
    const readerThrows = await resolveProvenanceArming({
      readPinText: () => Promise.reject(new Error("EACCES")),
      secrets: secretsThatResolve(),
      signingKeyRef: REF,
    });
    expect(readerThrows.armed).toBe(false);

    const portThrows = await resolveProvenanceArming({
      readPinText: () => Promise.resolve(VALID_PIN_TEXT),
      secrets: { resolveSigningKey: () => Promise.reject(new Error("boom")) } as SecretsPort,
      signingKeyRef: REF,
    });
    expect(portThrows.armed).toBe(false);
    if (portThrows.armed) return;
    expect(portThrows.reason).toBe("signing_key_unresolved");
  });

  it("⛔ RULE 7 — the outcome carries NO key material, on either branch", async () => {
    // The resolved key is proof-of-resolution and nothing else. If a future edit starts returning
    // it "so the caller doesn't have to resolve twice", this goes red.
    const armed = await resolveProvenanceArming({
      readPinText: () => Promise.resolve(VALID_PIN_TEXT),
      secrets: secretsThatResolve(),
      signingKeyRef: REF,
    });
    const serialized = JSON.stringify(armed);
    expect(serialized).not.toContain("1,2,3,4");
    // The bundle carries the REF (an opaque pointer) and the port — never bytes.
    expect(Object.keys(armed.armed ? armed.bundle : {})).not.toContain("key");
    expect(Object.keys(armed.armed ? armed.bundle : {})).not.toContain("signingKey");
  });
});
