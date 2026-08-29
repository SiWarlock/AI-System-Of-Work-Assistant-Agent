// Task 11.4 Slice 2 — the REAL macOS `security`-CLI Keychain backend behind the Slice-1 `KeychainBackend` seam,
// over an INJECTED execFile-shaped `exec` (args-array, NEVER a shell string). NO real Keychain I/O — every test
// drives a FAKE `exec` returning synthetic {code, stdout, stderr}. SAFETY-CRITICAL (rule 7): the `-w` stdout IS
// the secret — it is returned ONLY in the ok Uint8Array, NEVER logged and NEVER in `detail`; a fault's `detail`
// is a bounded, secret-scrubbed stderr+code summary. Never throws.
import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import {
  createSecurityCliKeychainBackend,
  SECURITY_BIN,
  type KeychainExec,
} from "../../src/secrets/keychain-backend";

const SVC = "sow";
const ACCT = "kw-signing";

/** A fake execFile-shaped exec; records each (file, args) call. `{throws:true}` rejects (spawn failure). */
function fakeExec(
  result: { code: number; stdout?: Uint8Array | string; stderr?: string } | { throws: true },
): { exec: KeychainExec; calls: () => { file: string; args: readonly string[] }[] } {
  const calls: { file: string; args: readonly string[] }[] = [];
  const exec: KeychainExec = (file, args) => {
    calls.push({ file, args });
    if ("throws" in result) return Promise.reject(new Error("spawn ENOENT: security not found"));
    return Promise.resolve({ code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
  };
  return { exec, calls: () => calls };
}

const bytesOf = (s: string): number[] => [...new TextEncoder().encode(s)];

describe("createSecurityCliKeychainBackend — success", () => {
  it("success_returns_value_bytes_minus_trailing_newline", async () => {
    const be = createSecurityCliKeychainBackend({ exec: fakeExec({ code: 0, stdout: "s3cr3t-key\n" }).exec });
    const r = await be.read(SVC, ACCT);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect([...r.value]).toEqual(bytesOf("s3cr3t-key")); // exactly one trailing \n stripped
  });

  it("invokes_security_with_an_args_array_no_shell", async () => {
    const fe = fakeExec({ code: 0, stdout: "k\n" });
    await createSecurityCliKeychainBackend({ exec: fe.exec }).read(SVC, ACCT);
    const call = fe.calls()[0];
    expect(call?.file).toBe(SECURITY_BIN); // absolute /usr/bin/security — no PATH lookup
    expect(call?.args).toEqual(["find-generic-password", "-w", "-s", SVC, "-a", ACCT]); // discrete argv, no shell
  });

  it("a_service_or_account_with_shell_metacharacters_is_passed_as_ONE_argv_token", async () => {
    // argv-injection defense: even a hostile-looking value is a single argv element, never interpreted by a shell.
    const fe = fakeExec({ code: 0, stdout: "k\n" });
    await createSecurityCliKeychainBackend({ exec: fe.exec }).read("a;rm -rf /", "$(whoami)");
    expect(fe.calls()[0]?.args).toEqual(["find-generic-password", "-w", "-s", "a;rm -rf /", "-a", "$(whoami)"]);
  });

  it("success_binary_key_round_trips_losslessly_no_string_step", async () => {
    // a raw-binary key (high bytes) as a Uint8Array stdout must round-trip byte-exact — NO lossy UTF-8 string
    // step touches the secret value (rule 7: the value never goes through .toString()).
    const raw = new Uint8Array([0xff, 0x00, 0xfe, 0x80, 0x0a]); // trailing \n
    const be = createSecurityCliKeychainBackend({ exec: fakeExec({ code: 0, stdout: raw }).exec });
    const r = await be.read(SVC, ACCT);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect([...r.value]).toEqual([0xff, 0x00, 0xfe, 0x80]); // newline stripped, bytes intact
  });

  it("success_with_no_trailing_newline_returns_bytes_unchanged", async () => {
    const be = createSecurityCliKeychainBackend({ exec: fakeExec({ code: 0, stdout: "no-newline" }).exec });
    const r = await be.read(SVC, ACCT);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect([...r.value]).toEqual(bytesOf("no-newline"));
  });

  it("returns_an_exact_sized_copy_never_aliasing_the_exec_buffer", async () => {
    // rule-7 hygiene: even on the no-newline Uint8Array path, the ok value must be a fresh exact-sized copy —
    // never a view retaining the exec's (possibly pooled/oversized) backing buffer.
    const backing = new Uint8Array([1, 2, 3, 4, 5]); // no trailing newline
    const be = createSecurityCliKeychainBackend({ exec: fakeExec({ code: 0, stdout: backing }).exec });
    const r = await be.read(SVC, ACCT);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect([...r.value]).toEqual([1, 2, 3, 4, 5]);
      expect(r.value.byteOffset).toBe(0);
      expect(r.value.buffer.byteLength).toBe(r.value.length); // exact-sized — no oversized/shared buffer
      expect(r.value.buffer).not.toBe(backing.buffer); // a distinct buffer (copy), not the exec's
    }
  });

  it("de-aliases_a_pooled_Buffer_view_the_real_execFile_yields", async () => {
    // the real execFile returns stdout as a Node Buffer — a VIEW into a shared pool (Buffer.slice shares memory,
    // unlike Uint8Array.slice). The backend must copy via `new Uint8Array(subarray)` so the ok value neither
    // retains the ~KB pool nor exposes neighboring pool bytes via `.buffer`.
    const pool = Buffer.alloc(4096, 0x07); // a pooled backing buffer
    const view = pool.subarray(100, 105); // a 5-byte VIEW at offset 100, no trailing newline
    expect(view.byteOffset).toBe(100); // sanity: the input genuinely aliases the pool
    const be = createSecurityCliKeychainBackend({ exec: fakeExec({ code: 0, stdout: view }).exec });
    const r = await be.read(SVC, ACCT);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect([...r.value]).toEqual([7, 7, 7, 7, 7]);
      expect(r.value.byteOffset).toBe(0);
      expect(r.value.buffer.byteLength).toBe(5); // exact-sized — NOT the 4096-byte pool
      expect(r.value.buffer).not.toBe(pool.buffer); // a distinct buffer, no pool retention
    }
  });

  it("exit_0_with_only_a_newline_returns_an_empty_key", async () => {
    const be = createSecurityCliKeychainBackend({ exec: fakeExec({ code: 0, stdout: "\n", stderr: "warn" }).exec });
    const r = await be.read(SVC, ACCT);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.length).toBe(0); // backend strips → empty; the Slice-1 adapter is what REJECTS empty
  });

  it("a_code_0_stdout_above_the_max_key_length_is_rejected_not_served", async () => {
    // trust boundary (17.2 — mirrors the 17.1 zero-length reject): the wrapper must not TRUST the swappable
    // injected exec to have bounded stdout. A code-0 value FAR larger than any real key/token (an HMAC key is
    // 32-64B, provider keys/tokens are well under 4KB) is anomalous — NEVER served as a key. The 4KB bound is
    // generous headroom under the real execFile's 64KB maxBuffer (which bounds the real path).
    const over = await createSecurityCliKeychainBackend({
      exec: fakeExec({ code: 0, stdout: new Uint8Array(4097).fill(0x41) }).exec,
    }).read(SVC, ACCT);
    expect(isErr(over)).toBe(true);
    if (isErr(over)) expect(over.error.kind).toBe("backend_error");
    // non-vacuity: a value AT the bound still serves — this rejects the anomalous, never a real key.
    const at = await createSecurityCliKeychainBackend({
      exec: fakeExec({ code: 0, stdout: new Uint8Array(4096).fill(0x41) }).exec,
    }).read(SVC, ACCT);
    expect(isOk(at)).toBe(true);
    if (isOk(at)) expect(at.value.length).toBe(4096);
    // the guard is on the RAW length (before the newline-strip): a 4097-byte value ending in \n (which WOULD
    // strip to 4096) is STILL rejected — locks the raw-length semantics so a strip-then-check refactor can't
    // silently widen the bound, and no anomalous blob is copied.
    const withNl = new Uint8Array(4097).fill(0x41);
    withNl[4096] = 0x0a; // trailing newline
    const rejNl = await createSecurityCliKeychainBackend({ exec: fakeExec({ code: 0, stdout: withNl }).exec }).read(SVC, ACCT);
    expect(isErr(rejNl)).toBe(true);
    if (isErr(rejNl)) expect(rejNl.error.kind).toBe("backend_error");
  });
});

describe("createSecurityCliKeychainBackend — fault mapping (typed, never throws)", () => {
  it("exit_44_maps_not_found", async () => {
    const be = createSecurityCliKeychainBackend({ exec: fakeExec({ code: 44, stderr: "item not found" }).exec });
    const r = await be.read(SVC, ACCT);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("not_found");
  });

  it("KEY-ENCODING: a printable-ASCII (base64) key round-trips byte-exact — the provisioning contract", async () => {
    // ⛔ WHY THIS PIN EXISTS. `security find-generic-password -w` returns the value as LOWERCASE HEX
    // whenever it contains ANY non-printable byte, with NO marker. MEASURED 2026-08-28 on a throwaway
    // keychain: `abc\n` → "6162630a", `a\tb` → "610962", `abcé` → "616263c3a9"; printable ASCII and
    // base64 come back RAW.
    // ⇒ a RAW-BINARY HMAC key at `sow/kw-signing` would reach `createHmac("sha256", key)` as its HEX
    // ASCII — wrong bytes, double length — and would stamp AND verify SELF-CONSISTENTLY. It would look
    // like it works, and break only on rotation or cross-tool verification.
    // ⛔ No reader can detect this: the hex of `abc\n` is byte-identical to the literal string
    // "6162630a". The ambiguity is irreducible at read time, so the contract is a PROVISIONING rule and
    // this test pins the shape that satisfies it.
    const b64 = "yuC3kA3C4BIun8NoHmZA/5e0Ua15Qx3inPSUJUPVgcE=";
    const be = createSecurityCliKeychainBackend({ exec: fakeExec({ code: 0, stdout: `${b64}\n` }).exec });
    const r = await be.read(SVC, ACCT);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(new TextDecoder().decode(r.value)).toBe(b64);
  });

  it("a LOCKED keychain — exit 128, EMPTY stderr — maps `locked`, not `backend_error` (§ARM-17, MEASURED)", async () => {
    // ⛔⛔ THE ASSUMPTION THIS REPLACES WAS WRONG, and it was wrong on the path the classifier's own
    // comment called "the direction that matters". Both this file and the live-classifier suite
    // recorded `locked` as UNMEASURED because "reaching it means locking the operator's login
    // keychain, which a test must not do to someone's machine."
    // ⭐ That premise was FALSE: a THROWAWAY keychain at a temp path, never added to the search
    // list, measures it without touching the operator's login keychain at all.
    //
    // MEASURED 2026-08-28, macOS Darwin 25.5.0, against the real `/usr/bin/security`:
    //   create-keychain → add-generic-password (dummy) → lock-keychain → find-generic-password -w
    //   ⇒ macOS shows a MODAL UNLOCK DIALOG. Dismissed, it exits **128 with EMPTY stdout AND stderr**.
    //
    // ⇒ the stderr-pattern branch cannot fire — there is no stderr — so a locked keychain fell to
    // `backend_error`, which `mapUnavailableReason` folds to `"missing"`. The operator was told the
    // credential DID NOT EXIST when it existed and the keychain was merely locked, and the whole
    // `onKeychainLocked` → keychain-locked HealthItem path (worker L41/L53) was unreachable on the
    // real CLI.
    const r = await createSecurityCliKeychainBackend({
      exec: fakeExec({ code: 128, stdout: "", stderr: "" }).exec,
    }).read(SVC, ACCT);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("locked");
  });

  it("NON-VACUITY: a 128 that DOES carry stderr is still classified by its stderr, not blanket-locked", async () => {
    // The new branch requires EMPTY stderr on purpose. Without that, any 128 would be relabelled
    // `locked` — which is RETRYABLE — and a genuinely terminal fault would retry forever, the exact
    // hazard the classifier's own comment names.
    const r = await createSecurityCliKeychainBackend({
      exec: fakeExec({ code: 128, stderr: "security: something else went wrong" }).exec,
    }).read(SVC, ACCT);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("backend_error");
  });

  it("errSecInteractionNotAllowed maps to `locked` — against the string macOS ACTUALLY emits", async () => {
    // ⛔ THE DEFECT THIS PINS. The branch read `s.includes("interaction not allowed")`, and macOS
    // emits "User interaction **is** not allowed." — the contiguous literal never occurs, so the
    // disjunct was DEAD for the very OSStatus it was written for.
    // ⭐ MEASURED (Darwin 25.5.0), by `/usr/bin/security error <code>`:
    //     -25308 (0xFFFF9D24) → "User interaction is not allowed."
    //     -25315 (0xFFFF9D1D) → "User interaction is required, but is currently not allowed."
    //   An exhaustive scan of the keychain block -25000..-26000 finds NO message containing the
    //   literal "interaction not allowed" — the pattern could not fire on any real macOS string.
    // ⚠ `security`'s exit code is the OSStatus truncated to 8 bits, confirmed with two live points
    //   (-25300 → 44, -25294 → 50) ⇒ -25308 → 36 and -25315 → 29. Neither is 44, neither is 128,
    //   neither is TIMED_OUT_EXIT — so no other branch caught them either: they fell through to
    //   `backend_error`, which `mapUnavailableReason` folds to "missing".
    // ⇒ ***the headless/daemon path reproduced the exact "told the credential does not exist when
    //   it exists" defect the 128 branch was written to eliminate*** — while the file's own header
    //   asserted this direction was already covered.
    for (const [code, stderr] of [
      [36, "security: SecKeychainSearchCopyNext: User interaction is not allowed."],
      [29, "security: SecKeychainSearchCopyNext: User interaction is required, but is currently not allowed."],
    ] as const) {
      const r = await createSecurityCliKeychainBackend({ exec: fakeExec({ code, stderr }).exec }).read(SVC, ACCT);
      expect(isErr(r)).toBe(true);
      if (isErr(r)) expect(r.error.kind).toBe("locked");
    }
  });

  it("locked_and_denied_signals_map_typed", async () => {
    // ⚠ This fixture used to read `{ code: 128, stderr: "SecKeychain: interaction not allowed" }` —
    // a string macOS does NOT produce, invented to match the pattern rather than measured from the
    // tool. That is exactly how the dead disjunct above read as covered for a whole round: the only
    // test exercising it fed it an input reality never generates. Now the measured wording + exit.
    const rl = await createSecurityCliKeychainBackend({
      exec: fakeExec({ code: 36, stderr: "security: SecKeychainSearchCopyNext: User interaction is not allowed." }).exec,
    }).read(SVC, ACCT);
    expect(isErr(rl)).toBe(true);
    if (isErr(rl)) expect(rl.error.kind).toBe("locked");

    const rlw = await createSecurityCliKeychainBackend({
      exec: fakeExec({ code: 36, stderr: "the keychain is LOCKED" }).exec,
    }).read(SVC, ACCT);
    expect(isErr(rlw)).toBe(true);
    if (isErr(rlw)) expect(rlw.error.kind).toBe("locked");

    const rd = await createSecurityCliKeychainBackend({
      exec: fakeExec({ code: 128, stderr: "user interaction: auth failed, not authorized" }).exec,
    }).read(SVC, ACCT);
    expect(isErr(rd)).toBe(true);
    if (isErr(rd)) expect(rd.error.kind).toBe("denied");
  });

  it("a_blocked_stderr_is_NOT_misclassified_as_locked", async () => {
    // the `\blocked\b` word-boundary must not fire on "blocked" (b+locked) — it falls through to backend_error.
    const r = await createSecurityCliKeychainBackend({
      exec: fakeExec({ code: 1, stderr: "access was blocked by policy" }).exec,
    }).read(SVC, ACCT);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("backend_error");
  });

  it("unrecognized_nonzero_maps_backend_error", async () => {
    const be = createSecurityCliKeychainBackend({ exec: fakeExec({ code: 1, stderr: "some other failure" }).exec });
    const r = await be.read(SVC, ACCT);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("backend_error");
  });

  it("exec_throw_or_reject_maps_backend_error", async () => {
    const be = createSecurityCliKeychainBackend({ exec: fakeExec({ throws: true }).exec });
    const r = await be.read(SVC, ACCT); // must NOT throw across the seam
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.kind).toBe("backend_error");
  });
});

describe("createSecurityCliKeychainBackend — rule-7 leakage (detail bounded + scrubbed; value never in detail)", () => {
  it("detail_is_bounded_and_secret_scrubbed", async () => {
    // a 39-char "secret-shaped" RUN (≥16 chars of the scrubber's charset) — SYNTHETIC + low-entropy on purpose so
    // the secrets-guard (gitleaks) doesn't false-positive; the scrubber keys on RUN LENGTH, not entropy.
    const SECRET_RUN = "SECRET_SHAPED_RUN_THAT_MUST_BE_REDACTED";
    const STDOUT_VALUE = "THE_SECRET_VALUE_SHOULD_NEVER_LEAK";
    const be = createSecurityCliKeychainBackend({
      exec: fakeExec({
        code: 1,
        stdout: STDOUT_VALUE, // a fault path must IGNORE stdout entirely (structural no-leak)
        stderr: `error: keychain material ${SECRET_RUN} ${"x".repeat(400)} trailing`,
      }).exec,
    });
    const r = await be.read(SVC, ACCT);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const detail = r.error.detail ?? "";
      expect(detail.length).toBeLessThanOrEqual(200); // bounded
      expect(detail).not.toContain(SECRET_RUN); // secret-shaped run scrubbed
      expect(detail).not.toContain(STDOUT_VALUE); // stdout NEVER reaches detail
      expect(detail).toContain("1"); // the exit code IS included (harmless debug context)
    }
  });
});
