// Task 11.4 Slice 3 (capstone) — the boot wiring that makes the Slice-1/2 KeychainSecretsAdapter reachable,
// behind an owner-provisioning gate. `buildKeychainSecrets(gate)` constructs the real adapter+backend ONLY when
// the gate is present, exposing a `SecretsPort` (→ the C5.4b provenanceServingOracle.secrets = OFF-lock 2) + a
// thin `getSecret` SecretsAccessor facade (provider API keys). Default (no gate) ⇒ undefined ⇒ INERT / byte-
// equivalent — no real `security` process. SAFETY-CRITICAL (rule 7). All tests drive a FAKE exec (no real Keychain).
import { describe, it, expect, vi } from "vitest";
import { ok, err, isOk, isErr } from "@sow/contracts";
import type { ProviderId, Result } from "@sow/contracts";
import type { SecretsAccessor, SecretUnavailableReason } from "@sow/providers";
import {
  buildKeychainSecrets,
  createLockRoutingSecretsAccessor,
  mapExecResult,
  type KeychainLockRouter,
} from "../../src/secrets/keychain-boot";
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

});

// 17.3 (Slice-4 of the 11.4 chain) — the getSecret facade threaded into a DEGRADED-by-default, lock-routing
// SecretsAccessor for the ModelProvider (§7). Lands the deferred it.todo (Q3): a `locked` resolution routes to
// KeychainLockController.onKeychainLocked (mints the keychain-locked HealthItem, §16/LIFE-6); `invalid_ref`
// (collapsed to `missing` by 17.2's mapUnavailableReason — a config error, not a lock) must NOT route there.
// LOAD-BEARING: EVERY reason fails closed to a typed Err — NEVER a plaintext fallback (rule 7). No real Keychain,
// no arming — a FAKE facade + a spy router (the arming is the owner-gated crossing).
describe("createLockRoutingSecretsAccessor — degraded-by-default + locked→HealthItem routing (17.3)", () => {
  const SUBJECT = "anthropic" as ProviderId;
  const NOW_ISO = "2026-07-16T00:00:00.000Z";
  const now = (): string => NOW_ISO;

  /** A spy KeychainLockRouter — records the RAW input the accessor passes (so the redaction pin is non-vacuous).
   *  `calls` = onKeychainLocked spy (name kept for the existing tests); `missingCalls` = the 18.16/CP-6
   *  onCredentialUnavailable spy. `throwOnMissing` makes the missing-mint router reject (best-effort pin). */
  function makeRouter(opts: { throwOnMissing?: boolean } = {}): {
    router: KeychainLockRouter;
    calls: Array<Record<string, unknown>>;
    missingCalls: Array<Record<string, unknown>>;
  } {
    const calls: Array<Record<string, unknown>> = [];
    const missingCalls: Array<Record<string, unknown>> = [];
    const router: KeychainLockRouter = {
      onKeychainLocked: (input): Promise<unknown> => {
        calls.push(input as unknown as Record<string, unknown>);
        return Promise.resolve();
      },
      onCredentialUnavailable: (input): Promise<unknown> => {
        missingCalls.push(input as unknown as Record<string, unknown>);
        if (opts.throwOnMissing === true) return Promise.reject(new Error("router boom"));
        return Promise.resolve();
      },
    };
    return { router, calls, missingCalls };
  }

  /** A fake getSecret facade that THROWS (the real Keychain adapter can — TCC/spawn/native, L9). */
  const facadeThrowing = (): SecretsAccessor => ({
    getSecret: (): Promise<Result<string, { reason: SecretUnavailableReason }>> => {
      throw new Error("native keychain error");
    },
  });

  /** A fake getSecret facade returning a fixed result (no real Keychain). */
  const facadeReturning = (r: Result<string, { reason: SecretUnavailableReason }>): SecretsAccessor => ({
    getSecret: (): Promise<Result<string, { reason: SecretUnavailableReason }>> => Promise.resolve(r),
  });

  it("degraded_by_default_absent_facade_yields_missing_mints_credential_unavailable_not_locked", async () => {
    // spec(§7 §6 L11): gate ABSENT ⇒ facade undefined ⇒ fail-closed `missing` — no real creds. 18.16/CP-6: a
    // genuinely-absent credential now mints the credential-unavailable OBSERVABILITY item (NOT a keychain lock).
    const { router, calls, missingCalls } = makeRouter();
    const acc = createLockRoutingSecretsAccessor(undefined, router, SUBJECT, now);
    const r = await acc.getSecret(REF);
    expect(isErr(r) && r.error.reason).toBe("missing");
    expect(calls).toHaveLength(0); // NOT mislabeled a keychain lock (L41)
    expect(missingCalls).toHaveLength(1); // credential-unavailable minted (18.16/CP-6)
  });

  it("locked_routes_to_onKeychainLocked_and_fails_closed_no_plaintext", async () => {
    // spec(§16 — LOAD-BEARING): a `locked` resolution mints the keychain-locked HealthItem (routes once) AND the
    // accessor returns the fail-closed Err — NEVER an ok plaintext string (no silent plaintext fallback, rule 7).
    const { router, calls } = makeRouter();
    const acc = createLockRoutingSecretsAccessor(facadeReturning(err({ reason: "locked" })), router, SUBJECT, now);
    const r = await acc.getSecret(REF);
    expect(isOk(r)).toBe(false);
    expect(isErr(r) && r.error.reason).toBe("locked");
    expect(calls).toHaveLength(1);
    expect(calls[0]?.subjectRef).toBe(SUBJECT);
    expect(calls[0]?.now).toBe(NOW_ISO);
  });

  it("reason_missing_mints_credential_unavailable_not_locked", async () => {
    // 18.16/CP-6 (lands the deferred it.todo): `missing` (17.2 mapUnavailableReason collapses invalid_ref +
    // backend_error + a genuinely-missing key — the split is a documented Future-TODO) now mints the GENERIC
    // credential-unavailable OBSERVABILITY item — NOT a keychain lock (L41 — missing is not mislabeled a lock).
    const { router, calls, missingCalls } = makeRouter();
    const acc = createLockRoutingSecretsAccessor(facadeReturning(err({ reason: "missing" })), router, SUBJECT, now);
    const r = await acc.getSecret(REF);
    expect(isErr(r) && r.error.reason).toBe("missing");
    expect(calls).toHaveLength(0); // NOT a keychain lock
    expect(missingCalls).toHaveLength(1); // credential-unavailable minted
  });

  it("reason_denied_fails_closed_WITHOUT_routing_either_mint", async () => {
    // spec(§16): `denied` is neither a lock nor a missing-provisioning signal — it fails closed WITHOUT minting
    // either item (a denied-visibility signal is a separate Phase-18 follow-up).
    const { router, calls, missingCalls } = makeRouter();
    const acc = createLockRoutingSecretsAccessor(facadeReturning(err({ reason: "denied" })), router, SUBJECT, now);
    const r = await acc.getSecret(REF);
    expect(isErr(r) && r.error.reason).toBe("denied");
    expect(calls).toHaveLength(0);
    expect(missingCalls).toHaveLength(0);
  });

  it("routing_input_carries_no_ref_or_secret_value_redaction", async () => {
    // rule 7: the routing input is EXACTLY {subjectRef, now} — the ref and any secret value NEVER cross into the
    // health path (nothing to leak to the HealthItem / logs).
    const { router, calls } = makeRouter();
    const acc = createLockRoutingSecretsAccessor(facadeReturning(err({ reason: "locked" })), router, SUBJECT, now);
    await acc.getSecret(REF);
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0] ?? {}).sort()).toEqual(["now", "subjectRef"]);
  });

  it("ok_resolution_returns_value_only_in_ok_result_no_route", async () => {
    // spec(§7): a resolvable key returns the value ONLY in the ok Result and does NOT route (no spurious health).
    const { router, calls } = makeRouter();
    const acc = createLockRoutingSecretsAccessor(facadeReturning(ok("sk-live-value")), router, SUBJECT, now);
    const r = await acc.getSecret(REF);
    expect(isOk(r) && r.value).toBe("sk-live-value");
    expect(calls).toHaveLength(0);
  });

  it.each([
    { label: "async-reject", facade: { getSecret: (): Promise<never> => Promise.reject(new Error("TCC denied")) } as SecretsAccessor },
    { label: "sync-throw", facade: facadeThrowing() },
  ])(
    "facade_that_throws_fails_closed_to_missing_never_rejects_and_mints ($label)",
    async ({ facade }) => {
      // §16 (never throws across the boundary) / rule 7 / L9: the REAL Keychain adapter CAN throw (TCC denial / spawn /
      // native error). BOTH a synchronous throw AND an async rejection from `getSecret` must be caught and DEGRADE to a
      // typed `missing` Err (never propagate), and the synthesized-missing path mints. Assert UNCONDITIONALLY (L15).
      const { router, calls, missingCalls } = makeRouter();
      const acc = createLockRoutingSecretsAccessor(facade, router, SUBJECT, now);
      const r = await acc.getSecret(REF);
      expect(isErr(r) && r.error.reason).toBe("missing");
      expect(calls).toHaveLength(0);
      expect(missingCalls).toHaveLength(1); // 18.16/CP-6: the synthesized-missing (throw) path also mints
    },
  );

  it("router_reject_on_locked_still_returns_the_fail_closed_locked_err_never_rejects", async () => {
    // §16 / L21+L29: a router (health-mint) FAULT must NOT change the fail-closed secret result — the accessor STILL
    // resolves to the `locked` Err, never rejecting. Best-effort routing; the secret degrade is what the caller sees.
    const rejectingRouter: KeychainLockRouter = {
      onKeychainLocked: (): Promise<never> => Promise.reject(new Error("health sink fault")),
      onCredentialUnavailable: (): Promise<never> => Promise.reject(new Error("health sink fault")),
    };
    const acc = createLockRoutingSecretsAccessor(
      facadeReturning(err({ reason: "locked" })),
      rejectingRouter,
      SUBJECT,
      now,
    );
    const r = await acc.getSecret(REF);
    expect(isOk(r)).toBe(false);
    expect(isErr(r) && r.error.reason).toBe("locked");
  });

  it("router_reject_on_missing_still_returns_the_fail_closed_missing_err_never_rejects", async () => {
    // §16 / L21+L29: the credential-unavailable mint is best-effort observability — a router FAULT must NOT change
    // the fail-closed secret result. Assert UNCONDITIONALLY (L15): a reject makes `await` throw ⇒ RED.
    const { router, missingCalls } = makeRouter({ throwOnMissing: true });
    const acc = createLockRoutingSecretsAccessor(facadeReturning(err({ reason: "missing" })), router, SUBJECT, now);
    const r = await acc.getSecret(REF);
    expect(isOk(r)).toBe(false);
    expect(isErr(r) && r.error.reason).toBe("missing");
    expect(missingCalls).toHaveLength(1); // it attempted the mint, then swallowed the fault
  });

  it("missing_routing_input_carries_no_ref_or_secret_value_redaction", async () => {
    // rule 7: the credential-unavailable routing input is EXACTLY {subjectRef, now} — the ref/key never crosses
    // into the health path (nothing to leak to the HealthItem / logs). Non-vacuous — asserts the exact key set.
    const { router, missingCalls } = makeRouter();
    const acc = createLockRoutingSecretsAccessor(facadeReturning(err({ reason: "missing" })), router, SUBJECT, now);
    await acc.getSecret(REF);
    expect(missingCalls).toHaveLength(1);
    expect(Object.keys(missingCalls[0] ?? {}).sort()).toEqual(["now", "subjectRef"]);
    expect(JSON.stringify(missingCalls[0])).not.toContain(REF);
  });

  it("missing_and_locked_route_to_DISTINCT_mints_never_cross_fire", async () => {
    // 18.16/CP-6 + L41: `locked` → onKeychainLocked ONLY; `missing` → onCredentialUnavailable ONLY. The two signals
    // never cross-fire — a missing credential is never mislabeled a lock, and a lock never mints credential-unavailable.
    const a = makeRouter();
    await createLockRoutingSecretsAccessor(facadeReturning(err({ reason: "locked" })), a.router, SUBJECT, now).getSecret(REF);
    expect(a.calls).toHaveLength(1);
    expect(a.missingCalls).toHaveLength(0);
    const b = makeRouter();
    await createLockRoutingSecretsAccessor(facadeReturning(err({ reason: "missing" })), b.router, SUBJECT, now).getSecret(REF);
    expect(b.calls).toHaveLength(0);
    expect(b.missingCalls).toHaveLength(1);
  });
});
