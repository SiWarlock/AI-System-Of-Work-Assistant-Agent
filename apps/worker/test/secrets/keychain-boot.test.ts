// Task 11.4 Slice 3 (capstone) — the boot wiring that makes the Slice-1/2 KeychainSecretsAdapter reachable,
// behind an owner-provisioning gate. `buildKeychainSecrets(gate)` constructs the real adapter+backend ONLY when
// the gate is present, exposing a `SecretsPort` (→ the C5.4b provenanceServingOracle.secrets = OFF-lock 2) + a
// thin `getSecret` SecretsAccessor facade (provider API keys). Default (no gate) ⇒ undefined ⇒ INERT / byte-
// equivalent — no real `security` process. SAFETY-CRITICAL (rule 7). All tests drive a FAKE exec (no real Keychain).
import { describe, it, expect, vi } from "vitest";
import { ok, err, isOk, isErr } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import { buildKeychainSecrets, mapExecResult } from "../../src/secrets/keychain-boot";
import type { KeychainExec } from "../../src/secrets/keychain-backend";

const REF = "keychain://providers/openai";

/** A fake execFile-shaped exec (the gate's injected seam) — synthetic {code, stdout, stderr}; records calls. */
function fakeExec(
  result: { code: number; stdout?: Uint8Array | string; stderr?: string } | { throws: true },
): { exec: KeychainExec; calls: () => number } {
  let n = 0;
  const exec: KeychainExec = () => {
    n += 1;
    if ("throws" in result) return Promise.reject(new Error("spawn ENOENT"));
    return Promise.resolve({ code: result.code, stdout: result.stdout ?? "", stderr: result.stderr ?? "" });
  };
  return { exec, calls: () => n };
}

describe("mapExecResult — execFile callback → KeychainExec result (no spawn)", () => {
  it("null_error_maps_code_0_numeric_code_round_trips_faults_map_negative_one", () => {
    expect(mapExecResult(null, Buffer.from("key\n"), Buffer.from("")).code).toBe(0);
    expect(mapExecResult(Object.assign(new Error("x"), { code: 44 }), Buffer.from(""), Buffer.from("nf")).code).toBe(44);
    // spawn failure (string errno) and timeout/signal (no numeric code) both fail-closed to -1 (→ backend_error)
    expect(
      mapExecResult(Object.assign(new Error("enoent"), { code: "ENOENT" }), Buffer.from(""), Buffer.from("")).code,
    ).toBe(-1);
    expect(mapExecResult(new Error("killed"), Buffer.from(""), Buffer.from("")).code).toBe(-1);
  });

  it("a_fault_can_NEVER_map_to_code_0_even_with_partial_stdout", () => {
    // load-bearing: garbage stdout during a spawn-failure/timeout must never be taken for a success value.
    const r = mapExecResult(new Error("partial fault"), Buffer.from("LEAKED_PARTIAL_BYTES"), Buffer.from(""));
    expect(r.code).not.toBe(0);
    expect(r.stdout instanceof Uint8Array).toBe(true);
  });
});

describe("buildKeychainSecrets — inert by default (owner-provisioning gate)", () => {
  it("gate_absent_returns_undefined_AND_never_invokes_the_real_exec_factory", () => {
    // NON-VACUOUS no-spawn pin: with no gate, the injectable real-exec FACTORY is never called (⇒ no real
    // execFile/`security` ever built) and the result is undefined ⇒ boot stays byte-equivalent to pre-slice.
    const makeRealExec = vi.fn(() => fakeExec({ code: 44 }).exec);
    expect(buildKeychainSecrets(undefined, makeRealExec)).toBeUndefined();
    expect(makeRealExec).not.toHaveBeenCalled();
  });

  it("gate_present_without_an_exec_selects_the_real_factory_but_spawns_nothing_at_construction", () => {
    // a present gate WITHOUT an injected execFile selects the REAL execFile wrapper (factory called once) — but
    // merely CONSTRUCTING the adapter spawns nothing (a spawn happens only on a resolve call we never make here).
    const makeRealExec = vi.fn(() => fakeExec({ code: 44 }).exec);
    const built = buildKeychainSecrets({}, makeRealExec);
    expect(built).toBeDefined();
    expect(makeRealExec).toHaveBeenCalledTimes(1);
    expect(typeof built?.secrets.resolveSigningKey).toBe("function");
    expect(typeof built?.getSecret.getSecret).toBe("function");
  });

  it("an_injected_execFile_is_used_and_the_real_factory_is_NOT", () => {
    const makeRealExec = vi.fn(() => fakeExec({ code: 44 }).exec);
    const built = buildKeychainSecrets({ execFile: fakeExec({ code: 0, stdout: "k\n" }).exec }, makeRealExec);
    expect(built).toBeDefined();
    expect(makeRealExec).not.toHaveBeenCalled(); // the gate's own exec wins; the real wrapper is never built
  });
});

describe("buildKeychainSecrets — provisioned gate builds the SecretsPort + getSecret facade", () => {
  it("gate_present_builds_secretsport_and_facade_routing_to_the_exec", async () => {
    const fe = fakeExec({ code: 0, stdout: "sk-live-value\n" });
    const built = buildKeychainSecrets({ execFile: fe.exec });
    expect(built).toBeDefined();
    if (built === undefined) return;
    // the SecretsPort resolves signing-key BYTES through the adapter→backend→fake exec
    const sk = await built.secrets.resolveSigningKey(REF);
    expect(isOk(sk)).toBe(true);
    if (isOk(sk)) expect([...sk.value]).toEqual([...new TextEncoder().encode("sk-live-value")]);
    // the getSecret facade resolves the SAME through to a STRING (provider API-key shape)
    const gs = await built.getSecret.getSecret(REF);
    expect(isOk(gs)).toBe(true);
    if (isOk(gs)) expect(gs.value).toBe("sk-live-value");
    expect(fe.calls()).toBeGreaterThan(0);
  });
});

describe("getSecret facade — maps result + errors (fail-closed, never throws)", () => {
  const getSecretOver = (
    result: { code: number; stdout?: Uint8Array | string; stderr?: string } | { throws: true },
    ref = REF,
  ): Promise<Result<string, { reason: string }>> => {
    const built = buildKeychainSecrets({ execFile: fakeExec(result).exec });
    if (built === undefined) throw new Error("expected built");
    return built.getSecret.getSecret(ref) as Promise<Result<string, { reason: string }>>;
  };

  it("maps_missing_locked_denied_directly", async () => {
    const missing = await getSecretOver({ code: 44 });
    expect(isErr(missing) && missing.error.reason).toBe("missing");
    const locked = await getSecretOver({ code: 128, stderr: "interaction not allowed" });
    expect(isErr(locked) && locked.error.reason).toBe("locked");
    const denied = await getSecretOver({ code: 128, stderr: "auth failed, not authorized" });
    expect(isErr(denied) && denied.error.reason).toBe("denied");
  });

  it("fail_closes_invalid_ref_and_backend_error_to_missing", async () => {
    // a malformed ref (adapter `invalid_ref`) and a backend fault (`backend_error`) both read as "no key" to the
    // provider (which degrades it) — never a throw, never a false success, never a widened reason.
    const invalid = await getSecretOver({ code: 0, stdout: "unused" }, "not-a-keychain-ref");
    expect(isErr(invalid) && invalid.error.reason).toBe("missing");
    const backendErr = await getSecretOver({ code: 1, stderr: "some other failure" });
    expect(isErr(backendErr) && backendErr.error.reason).toBe("missing");
  });

  it("never_throws_on_backend_throw", async () => {
    const r = await getSecretOver({ throws: true });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.reason).toBe("missing"); // backend_error → fail-closed missing
  });
});

describe("boot provenance-secrets sourcing (OFF-lock 2 flips only under provisioning)", () => {
  it("secrets_source_is_undefined_when_unprovisioned_and_a_real_SecretsPort_when_provisioned", () => {
    // this is exactly what boot threads into provenanceServingOracle.secrets:
    //   `const keychainSecrets = buildKeychainSecrets(config.keychainSecrets); … keychainSecrets?.secrets ?? …`
    expect(buildKeychainSecrets(undefined)?.secrets).toBeUndefined(); // unprovisioned ⇒ no Keychain source ⇒ OFF-lock 2 unchanged
    const provisioned = buildKeychainSecrets({ execFile: fakeExec({ code: 44 }).exec });
    expect(provisioned?.secrets).toBeDefined(); // provisioned ⇒ the real Keychain SecretsPort is the source
  });

  // Q3 DEFERRED to a Slice-4 follow-up (the KeychainLockController is not boot-wired, and the signing-key/
  // API-key resolution call-sites are dormant). Wiring point: route a `locked` result from
  // secrets.resolveSigningKey / getSecret → KeychainLockController.onKeychainLocked (mark provider degraded, hold
  // job retryable); `invalid_ref` (config error) must NOT route there. See brief 051 Q3 + docs/briefs Slice-4.
  it.todo("Slice-4: a `locked` resolution routes to KeychainLockController.onKeychainLocked; invalid_ref does not");
});
