// One-way credential provisioning (owner-authorized 2026-09-03). The value goes IN and never comes
// back out — these tests exist mostly to pin THAT, because it is the single property the whole
// design rests on.
import { describe, it, expect, vi } from "vitest";
import {
  provisionCredential,
  parseCredentialRef,
  type CredentialExec,
} from "../../main/credential-provision";

const REF = "keychain://connector-write.personal-business/linear";
const SECRET = "lin_api_SUPERSECRET_VALUE_1234567890";
const okExec = (): CredentialExec => async () => ({ code: 0 });

describe("provisionCredential — writes to the Keychain, discretely and idempotently", () => {
  it("invokes `security add-generic-password -U` with DISCRETE argv and the parsed service/account", async () => {
    const exec = vi.fn<CredentialExec>(async () => ({ code: 0 }));
    const res = await provisionCredential(REF, SECRET, exec);
    expect(res.ok).toBe(true);
    // Discrete argv, never a shell string — a service/account/value can never be read as a command.
    expect(exec).toHaveBeenCalledWith([
      "add-generic-password",
      "-U",
      "-s",
      "connector-write.personal-business",
      "-a",
      "linear",
      "-w",
      SECRET,
    ]);
  });

  it("`-U` is present — re-provisioning REPLACES, so a corrected typo leaves no stale item behind", async () => {
    // Without -U, `security` creates a SECOND item with the same service/account. A later read can
    // then return whichever it finds first, so a user who fixed a typo would still authenticate with
    // the wrong credential — and nothing would look broken.
    const exec = vi.fn<CredentialExec>(async () => ({ code: 0 }));
    await provisionCredential(REF, SECRET, exec);
    expect(exec.mock.calls[0]?.[0]).toContain("-U");
  });
});

describe("⛔ RULE 7 — the value NEVER leaves this module in any direction but the Keychain", () => {
  it("appears in NEITHER branch of the result, nor in any reason", async () => {
    // The whole design rests on this being one-way. If a future edit starts returning the stored
    // value "so the caller can confirm it", this goes red.
    const good = await provisionCredential(REF, SECRET, okExec());
    const failed = await provisionCredential(REF, SECRET, async () => ({ code: 44 }));
    const invalid = await provisionCredential("keychain://a/b/c", SECRET, okExec());
    for (const r of [good, failed, invalid]) {
      expect(JSON.stringify(r)).not.toContain(SECRET);
      expect(JSON.stringify(r)).not.toContain("SUPERSECRET");
    }
    // Positive control: the secret IS reaching the exec seam, so the absences above are the module
    // withholding it rather than the test never supplying it (`contracts L90`).
    const exec = vi.fn<CredentialExec>(async () => ({ code: 0 }));
    await provisionCredential(REF, SECRET, exec);
    expect(JSON.stringify(exec.mock.calls[0])).toContain(SECRET);
  });

  it("a THROWING exec seam degrades to a typed failure and leaks nothing from the throw", async () => {
    // A throw here would surface in the renderer as an unhandled rejection carrying a stack — which
    // is exactly where a credential-adjacent message must never go (§16 + rule 7).
    const res = await provisionCredential(REF, SECRET, async () => {
      throw new Error(`keychain exploded while storing ${SECRET}`);
    });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("keychain_write_failed");
    expect(JSON.stringify(res)).not.toContain(SECRET);
    expect(JSON.stringify(res)).not.toContain("exploded");
  });
});

describe("fail-closed input validation — nothing reaches `security` unless the ref is clean", () => {
  it("a malformed ref makes ZERO exec calls (ref-injection defense)", async () => {
    // "rejected" alone would still pass if the process had already been spawned. Assert the spy is
    // UNCALLED, which is the property that matters.
    const exec = vi.fn<CredentialExec>(async () => ({ code: 0 }));
    for (const bad of [
      "keychain://a/b/c", // three segments
      "keychain://only-one",
      "keychain:///empty",
      "keychain://a/..",
      "keychain://-leading/dash", // would reach `security` as a CLI OPTION
      "keychain://a b/c", // whitespace
      "keychain://a;rm -rf //c", // shell metacharacters
      "keychain://a/*", // outside the segment charset
      "https://evil/x", // wrong scheme
      `keychain://${"x".repeat(600)}/y`, // over the length bound
    ]) {
      const res = await provisionCredential(bad, SECRET, exec);
      expect(res.ok, bad).toBe(false);
      expect(res.reason, bad).toBe("invalid_ref");
    }
    expect(exec).not.toHaveBeenCalled();
    // Positive control: the SAME spy does fire for a well-formed ref, so "not called" measures the
    // guard and not a dead spy.
    await provisionCredential(REF, SECRET, exec);
    expect(exec).toHaveBeenCalledTimes(1);
  });

  it("an empty or whitespace-only value is refused BEFORE any exec call", async () => {
    // A blank credential would otherwise be stored happily and fail much later at a vendor call,
    // with a message that points nowhere near the field the user actually left empty.
    const exec = vi.fn<CredentialExec>(async () => ({ code: 0 }));
    for (const blank of ["", "   ", "\t\n"]) {
      const res = await provisionCredential(REF, blank, exec);
      expect(res.ok).toBe(false);
      expect(res.reason).toBe("empty_value");
    }
    expect(exec).not.toHaveBeenCalled();
  });

  it("a non-zero `security` exit is a typed failure, never a false success", async () => {
    const res = await provisionCredential(REF, SECRET, async () => ({ code: 44 }));
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("keychain_write_failed");
  });
});

describe("parseCredentialRef — the mirrored two-segment parser", () => {
  it("splits a well-formed ref into service and account", () => {
    expect(parseCredentialRef(REF)).toEqual({
      service: "connector-write.personal-business",
      account: "linear",
    });
  });
});
