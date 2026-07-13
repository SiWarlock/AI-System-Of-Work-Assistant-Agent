// Task 11.4 Slice 1 — the KeychainSecretsAdapter CORE over a FAKE in-memory backend (no real Keychain I/O;
// the real macOS `security`-CLI backend is Slice 2, behind this same seam). SAFETY-CRITICAL secrets surface
// (rule 7): the resolved key bytes / raw backend detail must NEVER reach a typed error, a log, or a caller
// other than the return value. Every backend fault maps to a typed ref-only `SecretUnresolved`; never throws.
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import type { SecretsPort } from "@sow/knowledge";
import {
  createKeychainSecretsAdapter,
  type KeychainBackend,
  type KeychainBackendError,
} from "../../src/secrets/keychain-adapter";

const REF = "keychain://sow/kw-signing";
const KEY = new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1, 0]);

/** A fake in-memory Keychain backend, keyed `${service}/${account}`. Records call count for the fail-closed pin. */
function fakeBackend(opts: {
  bytes?: Record<string, Uint8Array>;
  error?: KeychainBackendError;
  throws?: boolean;
}): { backend: KeychainBackend; calls: () => number } {
  let n = 0;
  return {
    backend: {
      read: (service: string, account: string): Promise<Result<Uint8Array, KeychainBackendError>> => {
        n += 1;
        if (opts.throws === true) throw new Error("backend boom");
        if (opts.error !== undefined) return Promise.resolve(err(opts.error));
        const b = opts.bytes?.[`${service}/${account}`];
        return Promise.resolve(b !== undefined ? ok(b) : err({ kind: "not_found" }));
      },
    },
    calls: () => n,
  };
}

describe("createKeychainSecretsAdapter — resolve by reference", () => {
  it("resolves_signing_key_bytes_on_backend_hit", async () => {
    const adapter = createKeychainSecretsAdapter(fakeBackend({ bytes: { "sow/kw-signing": KEY } }).backend);
    const r = await adapter.resolveSigningKey(REF);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect([...r.value]).toEqual([...KEY]); // the exact fixture bytes, straight through
  });

  it("missing_locked_denied_map_to_typed_reason", async () => {
    const cases: { kind: KeychainBackendError["kind"]; reason: string }[] = [
      { kind: "not_found", reason: "missing" },
      { kind: "locked", reason: "locked" },
      { kind: "denied", reason: "denied" },
      { kind: "backend_error", reason: "backend_error" },
    ];
    for (const c of cases) {
      const adapter = createKeychainSecretsAdapter(fakeBackend({ error: { kind: c.kind } }).backend);
      const r = await adapter.resolveSigningKey(REF);
      expect(isErr(r)).toBe(true);
      if (isErr(r)) {
        expect(r.error.code).toBe("secret_unresolved");
        expect(r.error.ref).toBe(REF); // ref echoed (opaque, safe)
        expect(r.error.reason).toBe(c.reason); // FIXED class token
      }
    }
  });
});

describe("createKeychainSecretsAdapter — ref parsing is fail-closed (no backend call on malformed)", () => {
  it("malformed_ref_fails_closed_without_backend_call", async () => {
    const malformed = [
      "",
      "not-a-keychain-ref",
      "keychain://",
      "keychain://only-one-segment",
      "keychain://a/b/c", // too many segments
      "keychain://a/../b", // traversal
      "keychain://../x", // traversal token as a segment
      "keychain://a/", // empty account segment
      "keychain:///b", // empty service segment
      "keychain://a b/c", // space (charset)
      "keychain://a/b;rm -rf", // injection chars (charset)
      "keychain://a/b\n", // trailing newline fails closed (JS `$` w/o `m` matches only absolute end-of-input;
      //                     `\n` ∉ the charset ⇒ rejected — empirically ruling out the PCRE-style bypass, LESSONS §5.2)
      "keychain://a/b\u0000x", // embedded NUL (charset)
      "keychain://-w/x", // a segment starting with `-` (never mistakable for a CLI option)
      `keychain://sow/${"a".repeat(600)}`, // over the length cap
    ];
    for (const ref of malformed) {
      const fb = fakeBackend({ bytes: { "a/b": KEY } });
      const adapter = createKeychainSecretsAdapter(fb.backend);
      const r = await adapter.resolveSigningKey(ref);
      expect(isErr(r)).toBe(true);
      if (isErr(r)) {
        expect(r.error.code).toBe("secret_unresolved");
        expect(r.error.ref).toBe(ref);
        expect(r.error.reason).toBe("invalid_ref");
      }
      expect(fb.calls()).toBe(0); // fail-closed — the backend was NEVER consulted
    }
  });

  it("accepts_a_well_formed_multi_char_ref_with_dots_and_hyphens", async () => {
    // a reverse-DNS-style service + hyphenated account is valid (dots allowed within a segment, not as a token)
    const ref = "keychain://com.sow.app/kw-signing.v1";
    const fb = fakeBackend({ bytes: { "com.sow.app/kw-signing.v1": KEY } });
    const r = await createKeychainSecretsAdapter(fb.backend).resolveSigningKey(ref);
    expect(isOk(r)).toBe(true);
    expect(fb.calls()).toBe(1);
  });
});

describe("createKeychainSecretsAdapter — rule-7 leakage + no-throw", () => {
  it("err_never_carries_key_bytes_or_raw_backend_detail", async () => {
    // the raw backend detail embeds BOTH a secret-shaped token AND a stringified copy of the key bytes —
    // the adapter must drop ALL of it (maps `.kind` only), so the serialized err leaks NEITHER.
    const KEY_HEX = [...KEY].map((b) => b.toString(16).padStart(2, "0")).join("");
    const SECRET_SHAPED = `AKIA-super-secret-${KEY_HEX}-0xDEADBEEF`;
    const adapter = createKeychainSecretsAdapter(
      fakeBackend({ error: { kind: "backend_error", detail: SECRET_SHAPED } }).backend,
    );
    const r = await adapter.resolveSigningKey(REF);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      // the typed error carries ONLY {code, ref, reason} — the raw backend detail is DROPPED
      expect(Object.keys(r.error).sort()).toEqual(["code", "ref", "reason"].sort());
      expect(r.error.reason).toBe("backend_error");
      const serialized = JSON.stringify(r.error);
      expect(serialized).not.toContain(SECRET_SHAPED); // no raw detail
      expect(serialized).not.toContain(KEY_HEX); // no key bytes
      expect(serialized).not.toContain("DEADBEEF");
    }
  });

  it("never_throws_on_backend_throw", async () => {
    const adapter = createKeychainSecretsAdapter(fakeBackend({ throws: true }).backend);
    const r = await adapter.resolveSigningKey(REF); // must NOT throw across the boundary
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.reason).toBe("backend_error");
      expect(r.error.ref).toBe(REF);
    }
  });

  it("never_throws_on_backend_async_reject", async () => {
    const rejecting: KeychainBackend = {
      read: (): Promise<Result<Uint8Array, KeychainBackendError>> => Promise.reject(new Error("async boom")),
    };
    const r = await createKeychainSecretsAdapter(rejecting).resolveSigningKey(REF);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.reason).toBe("backend_error");
  });

  it("an_out_of_contract_backend_kind_fails_safe_to_backend_error", async () => {
    // a rogue/buggy backend returning a `kind` outside the union — incl. a prototype name — must NOT resolve up
    // the prototype chain; it fails safe to the general token (Object.hasOwn guard, worker Lesson 13).
    for (const rogueKind of ["totally_unknown", "toString", "constructor", "__proto__"]) {
      const rogue: KeychainBackend = {
        read: (): Promise<Result<Uint8Array, KeychainBackendError>> =>
          Promise.resolve(err({ kind: rogueKind } as unknown as KeychainBackendError)),
      };
      const r = await createKeychainSecretsAdapter(rogue).resolveSigningKey(REF);
      expect(isErr(r)).toBe(true);
      if (isErr(r)) expect(r.error.reason).toBe("backend_error");
    }
  });

  it("a_zero_length_key_from_the_backend_is_rejected_not_served", async () => {
    // an empty Uint8Array is not usable HMAC signing material — the SOLE key holder must never serve it.
    const adapter = createKeychainSecretsAdapter(
      fakeBackend({ bytes: { "sow/kw-signing": new Uint8Array(0) } }).backend,
    );
    const r = await adapter.resolveSigningKey(REF);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.reason).toBe("backend_error");
  });
});

describe("createKeychainSecretsAdapter — satisfies the knowledge SecretsPort contract", () => {
  it("satisfies_the_knowledge_SecretsPort_contract", () => {
    // structural: the adapter drops into StamperDeps.secrets / the provenanceServingOracle bundle (OFF-lock 2)
    const adapter: SecretsPort = createKeychainSecretsAdapter(fakeBackend({}).backend);
    expect(typeof adapter.resolveSigningKey).toBe("function");
  });
});
