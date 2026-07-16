// Task 11.4 Slice 1 — the KeychainSecretsAdapter CORE: a mockable macOS-Keychain backend seam + the pure
// `createKeychainSecretsAdapter` implementing `@sow/knowledge` `SecretsPort.resolveSigningKey` over the injected
// backend. `resolveSigningKey` is C5.4b's OFF-lock-2 signing-key source (it drops into the `provenanceServingOracle`
// bundle). This slice does NO real Keychain I/O — the real macOS `security`-CLI backend is Slice 2, behind this
// same seam.
//
// SAFETY-CRITICAL (safety rule 7 — top-tier secrets surface). The load-bearing invariants:
//   • the resolved key bytes are returned ONLY in the ok Result's local binding — NEVER stringified, logged, or
//     placed in a typed error;
//   • every backend fault maps to a typed `SecretUnresolved` carrying ONLY the ref + a FIXED class token
//     (`KeychainUnresolvedReason`) — NEVER the key material and NEVER the backend's raw `.detail`/stderr;
//   • a malformed `keychain://…` ref fails closed WITHOUT a backend call (ref-injection guard, WS-8-style);
//   • the adapter NEVER throws across the boundary — a throwing/rejecting backend folds to `backend_error`.
import { ok, err, isOk } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import type { SecretsPort, SecretRef, SecretUnresolved } from "@sow/knowledge";

/** The narrow macOS-Keychain read surface (injected, async, TOTAL — never throws). Slice 2 wraps `security` CLI. */
export interface KeychainBackend {
  read(service: string, account: string): Promise<Result<Uint8Array, KeychainBackendError>>;
}

/**
 * A typed backend read failure. `kind` is the redaction-safe class; `detail` is the OPTIONAL raw backend
 * diagnostic (e.g. `security`-CLI stderr) — the adapter reads ONLY `kind` and DROPS `detail`, so raw material
 * never crosses the redaction boundary. The real Slice-2 backend may populate `detail`; the adapter never does.
 */
export interface KeychainBackendError {
  readonly kind: "not_found" | "locked" | "denied" | "backend_error";
  readonly detail?: string;
}

/**
 * The FIXED, redaction-safe `SecretUnresolved.reason` vocabulary this adapter emits. The four Keychain-fault
 * tokens are retryable-on-unlock (the boot-slice degraded controller's inputs); `invalid_ref` is a NON-retryable
 * misconfiguration (a bad reference), categorically distinct from a runtime Keychain fault.
 */
export type KeychainUnresolvedReason = "invalid_ref" | "missing" | "locked" | "denied" | "backend_error";

const REASON_FOR_KIND: Record<KeychainBackendError["kind"], KeychainUnresolvedReason> = {
  not_found: "missing",
  locked: "locked",
  denied: "denied",
  backend_error: "backend_error",
};

/** Map a backend fault `kind` to its fixed reason token. `Object.hasOwn`-guarded so a contract-violating backend
 *  returning an out-of-union `kind` (incl. a prototype name like `toString`/`constructor`) fails SAFE to
 *  `backend_error` — never a prototype-chain read (worker Lesson 13). */
function reasonForKind(kind: KeychainBackendError["kind"]): KeychainUnresolvedReason {
  return Object.hasOwn(REASON_FOR_KIND, kind) ? REASON_FOR_KIND[kind] : "backend_error";
}

/** The `keychain://` URI scheme. EXPORTED so the 17.4 secret-ref convention composes refs against the SAME scheme
 *  (single-sourced — no duplicated literal that could drift, L37). */
export const SCHEME = "keychain://";
/** Bound the whole ref (defense for the Slice-2 `security`-CLI boundary this charset feeds). */
const MAX_REF_LENGTH = 512;
/** Per-segment charset — bars whitespace, path separators, and shell metacharacters (defense atop the args-array
 *  exec Slice 2 uses), and bars a LEADING `-` so a segment can never be mistaken for a CLI option. `.`/`..`
 *  traversal TOKENS are rejected separately (a dotted segment like `com.sow` is fine). */
const SEGMENT = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;

/**
 * Parse + validate an opaque `keychain://<service>/<account>` reference into its structured parts, or `null`
 * when malformed. Fail-closed: exactly two non-empty segments, each charset-clean and not a `.`/`..` traversal
 * token. The caller makes NO backend call on `null` (ref-injection defense).
 *
 * EXPORTED so the 17.4 secret-ref convention (`secretRefConvention.ts`) reuses the SAME traversal-safe parse to
 * build refs traversal-safe BY CONSTRUCTION (round-trip validation) + parse them back — a single-sourced charset
 * (no duplicate that could drift and re-open the ref-injection surface, L5/L37).
 */
export function parseKeychainRef(ref: string): { readonly service: string; readonly account: string } | null {
  if (ref.length > MAX_REF_LENGTH) return null; // bounded input for the downstream CLI
  if (!ref.startsWith(SCHEME)) return null;
  const segments = ref.slice(SCHEME.length).split("/");
  if (segments.length !== 2) return null;
  const service = segments[0];
  const account = segments[1];
  if (service === undefined || account === undefined) return null; // (length===2 ⇒ defined; strict-index guard)
  for (const seg of [service, account]) {
    if (seg.length === 0 || seg === "." || seg === ".." || !SEGMENT.test(seg)) return null;
  }
  return { service, account };
}

/** Build a `SecretUnresolved` carrying ONLY the ref + a fixed class token — never key material or raw detail. */
function unresolved(ref: SecretRef, reason: KeychainUnresolvedReason): SecretUnresolved {
  return { code: "secret_unresolved", ref, reason };
}

/**
 * The real `SecretsPort` over an injected {@link KeychainBackend}. `resolveSigningKey` parses the ref
 * (fail-closed, no backend call on malformed), dispatches to the backend, and maps every fault to a typed
 * ref-only `SecretUnresolved`. Never throws.
 *
 * BYTE HYGIENE (trust boundary — L10 / the L9/L20 don't-trust-the-injected-boundary posture): the adapter is
 * the SOLE key holder over a SWAPPABLE backend, so it GUARANTEES its returned bytes are INDEPENDENT of the
 * backend's buffer by de-aliasing a hit into a fresh `Uint8Array` — it never RELIES on the backend to have
 * de-aliased (a backend that returned a view/pooled-Buffer slice would otherwise leak that aliasing through the
 * SecretsPort, and on the secrets surface an aliasing leak IS key exposure). The key bytes are never stringified
 * or logged. (The real `security`-CLI backend also de-aliases the stdout Buffer — the primary defense; this copy
 * is defense-in-depth on top.)
 */
export function createKeychainSecretsAdapter(backend: KeychainBackend): SecretsPort {
  return {
    async resolveSigningKey(ref: SecretRef): Promise<Result<Uint8Array, SecretUnresolved>> {
      const parsed = parseKeychainRef(ref);
      if (parsed === null) return err(unresolved(ref, "invalid_ref")); // fail-closed — NO backend call
      try {
        const read = await backend.read(parsed.service, parsed.account);
        if (isOk(read)) {
          // a zero-length key is not usable HMAC signing material (a backend anomaly) — reject, never serve it.
          if (read.value.length === 0) return err(unresolved(ref, "backend_error"));
          // De-alias at the trust boundary: return an INDEPENDENT copy so the SecretsPort's bytes never
          // share memory with the backend's (possibly view/pooled) buffer — `new Uint8Array(view)` COPIES
          // for both Uint8Array + Buffer (unlike `.slice`, which a Node Buffer overrides to share memory).
          return ok(new Uint8Array(read.value));
        }
        return err(unresolved(ref, reasonForKind(read.error.kind))); // `.detail` deliberately DROPPED
      } catch {
        return err(unresolved(ref, "backend_error")); // §16 — a throwing/rejecting backend never escapes
      }
    },
  };
}
