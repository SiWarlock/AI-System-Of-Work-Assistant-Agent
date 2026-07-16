// Task 11.4 Slice 3 (capstone) — the boot wiring that makes the Slice-1/2 KeychainSecretsAdapter reachable,
// behind an OWNER-PROVISIONING gate. `buildKeychainSecrets(gate)` constructs the real adapter + `security`-CLI
// backend ONLY when the gate is present, exposing a `SecretsPort` (→ sources C5.4b's `provenanceServingOracle`
// `.secrets`, i.e. OFF-lock 2's signing-key) + a thin `getSecret` `SecretsAccessor` facade (provider API keys).
//
// INERT BY DEFAULT (rule 7): gate ABSENT (the shipped default) ⇒ `undefined` ⇒ NOTHING constructed — no adapter,
// no backend, no real `execFile`/`security` process. The first real Keychain touch is owner-gated. The real
// bounded `execFile` wrapper is built ONLY on the provisioned path (never invoked off-path). The `getSecret`
// facade fail-closes an unresolvable ref to `missing` (the provider degrades) — never a throw or false success.
import { execFile } from "node:child_process";
import { ok, err, isOk, isErr } from "@sow/contracts";
import type { ProviderId, Result } from "@sow/contracts";
import type { SecretsPort } from "@sow/knowledge";
import type { SecretsAccessor, SecretUnavailable, SecretUnavailableReason } from "@sow/providers";
import { createKeychainSecretsAdapter } from "./keychain-adapter";
import { createSecurityCliKeychainBackend, type KeychainExec } from "./keychain-backend";

/** The owner-provisioning gate. PRESENCE (any object) provisions the Keychain path; ABSENT ⇒ inert. An injected
 *  `execFile` is for tests; production omits it ⇒ the real bounded wrapper is used. */
export interface KeychainSecretsGate {
  readonly execFile?: KeychainExec;
}

/**
 * Map Node's `execFile` callback triple to the `KeychainExec` result. EXPORTED so the code→exit mapping is
 * unit-testable WITHOUT spawning (the real `execFile` is otherwise only exercised at owner-provisioning).
 * LOAD-BEARING: a fault (`error !== null`) can NEVER map to `code 0` — so a spawn-failure/timeout's garbage stdout
 * is never mistaken for a success value. A numeric `error.code` is the process exit code; a spawn failure / timeout
 * / signal (string `code` like ENOENT, or none) ⇒ `-1` ⇒ the backend classifies it `backend_error`.
 */
export function mapExecResult(
  error: (Error & { code?: unknown }) | null,
  stdout: unknown,
  stderr: unknown,
): { readonly code: number; readonly stdout: Uint8Array; readonly stderr: string } {
  const errCode = error?.code;
  const code = error === null ? 0 : typeof errCode === "number" ? errCode : -1;
  return {
    code,
    stdout: stdout instanceof Uint8Array ? stdout : new TextEncoder().encode(String(stdout ?? "")),
    stderr: Buffer.isBuffer(stderr) ? stderr.toString("utf8") : String(stderr ?? ""),
  };
}

/** The real `execFile` wrapper: NO shell, bounded (short timeout + small maxBuffer — the key is tiny), stdout as a
 *  Buffer (the Slice-2 backend de-aliases it). Built ONLY on the provisioned path. ⚠ GO-LIVE VERIFY: exercised
 *  against the live `security` binary only at owner-provisioning (no test spawns a real process). */
function createRealExecFile(): KeychainExec {
  return (file, args) =>
    new Promise((resolve) => {
      execFile(
        file,
        [...args],
        { timeout: 5_000, maxBuffer: 64 * 1024, encoding: "buffer", shell: false },
        (error: (Error & { code?: unknown }) | null, stdout, stderr) => resolve(mapExecResult(error, stdout, stderr)),
      );
    });
}

/** Map the adapter's `SecretUnresolved.reason` to the providers' 3-token `SecretUnavailable.reason`, FAIL-CLOSED:
 *  `invalid_ref`/`backend_error`/unknown ⇒ `missing` (the provider reads "no key" ⇒ degrades — never a throw,
 *  never a false success, never a widened reason). */
function mapUnavailableReason(reason: string | undefined): SecretUnavailableReason {
  return reason === "locked" ? "locked" : reason === "denied" ? "denied" : "missing";
}

/** A thin `getSecret` facade over a `SecretsPort`: resolves the ref to bytes, decodes to a STRING (a provider API
 *  key is text), maps every fault to a typed `SecretUnavailable`. Never throws (the adapter never throws). The
 *  string value reaches ONLY the ok Result — never logged. */
const TEXT_DECODER = new TextDecoder();

function makeGetSecretFacade(secrets: SecretsPort): SecretsAccessor {
  return {
    async getSecret(ref: string): Promise<Result<string, SecretUnavailable>> {
      const r = await secrets.resolveSigningKey(ref);
      if (isOk(r)) return ok(TEXT_DECODER.decode(r.value));
      return err({ reason: mapUnavailableReason(r.error.reason) });
    },
  };
}

/**
 * Construct the real Keychain-backed `SecretsPort` + `getSecret` facade — or `undefined` when the gate is ABSENT
 * (inert; nothing built). When present, the `execFile` is the gate's injected one (tests) or the real bounded
 * wrapper (production). `makeRealExec` is an injectable factory (default = the real wrapper) so a test can spy
 * that it is NEVER invoked absent the gate (the non-vacuous no-spawn pin).
 */
export function buildKeychainSecrets(
  gate?: KeychainSecretsGate,
  makeRealExec: () => KeychainExec = createRealExecFile,
): { readonly secrets: SecretsPort; readonly getSecret: SecretsAccessor } | undefined {
  if (gate === undefined) return undefined; // INERT — no adapter/backend/exec constructed
  const exec = gate.execFile ?? makeRealExec(); // the real wrapper is built ONLY here (provisioned path)
  const secrets = createKeychainSecretsAdapter(createSecurityCliKeychainBackend({ exec }));
  return { secrets, getSecret: makeGetSecretFacade(secrets) };
}

/**
 * A narrow routing port over the 10.5(b) `KeychainLockController`: report a Keychain LOCK for a provider so it is
 * marked degraded and a keychain-locked `HealthItem` is surfaced (§16 / LIFE-6). Declared as a STRUCTURAL SUBSET of
 * `KeychainLockController.onKeychainLocked` so the Phase-18 boot binding passes the real controller unchanged — this
 * module stays free of a `@sow/lifecycle` import + fully fakeable in a unit test.
 */
export interface KeychainLockRouter {
  onKeychainLocked(input: { readonly subjectRef: ProviderId; readonly now: string }): Promise<unknown>;
}

/**
 * Thread the `getSecret` facade into a DEGRADED-by-default, lock-routing `SecretsAccessor` for the ModelProvider
 * (§7). `facade` is the built getSecret (present ⇒ provisioned) or `undefined` (gate ABSENT — the shipped default):
 *   • ABSENT  ⇒ EVERY resolve fails closed to `missing` (no real creds, no route — byte-equivalent, L11 dormancy).
 *   • PRESENT ⇒ delegate; a `locked` resolution routes to `router.onKeychainLocked` (mints the keychain-locked
 *     HealthItem, §16) and the accessor STILL returns the fail-closed Err — NEVER a plaintext fallback (rule 7).
 * `missing`/`denied` fail closed WITHOUT routing: `missing` collapses invalid_ref/backend_error (config errors,
 * `mapUnavailableReason`) which must NOT be mislabeled a Keychain lock (the it.todo contract); `denied` is not a
 * lock (a `denied`-visibility signal is a Phase-18 follow-up). Only `subjectRef` + `now` cross into the health path
 * — never the ref or the secret value (which lives ONLY in the ok Result, never logged).
 *
 * PURE + effect-injected: the FUTURE Phase-18 boot binding supplies the built facade, the real
 * `KeychainLockController` as `router`, the resolving provider's `subjectRef`, and the injected clock. Building this
 * crosses NO hard line — the arming (provision creds + bind the real ModelProvider deps) is the owner-gated crossing.
 */
export function createLockRoutingSecretsAccessor(
  facade: SecretsAccessor | undefined,
  router: KeychainLockRouter,
  subjectRef: ProviderId,
  now: () => string,
): SecretsAccessor {
  return {
    async getSecret(ref: string): Promise<Result<string, SecretUnavailable>> {
      if (facade === undefined) return err({ reason: "missing" }); // DEGRADED — gate absent ⇒ no creds, no route
      let resolved: Result<string, SecretUnavailable>;
      try {
        resolved = await facade.getSecret(ref);
      } catch {
        // FAIL-CLOSED (§16 never-throws / rule 7 / L9): the real Keychain adapter CAN throw (TCC denial / spawn /
        // native error — cf. gbrain-http-read-client's same-seam guard). Degrade to `missing`, never propagate.
        return err({ reason: "missing" });
      }
      if (isErr(resolved) && resolved.error.reason === "locked") {
        // Route ONLY a `locked` result → mint the keychain-locked HealthItem (§16). `missing` (the invalid_ref /
        // backend_error collapse) and `denied` intentionally do NOT route here — a config error is not a lock.
        try {
          await router.onKeychainLocked({ subjectRef, now: now() });
        } catch {
          // Best-effort health mint: a router fault must NOT change the fail-closed secret result (§16). The caller
          // still degrades on the `locked` Err below; the Phase-18 binding SHOULD supply a never-reject router (L21/L29).
        }
      }
      return resolved; // fail-closed Err (or the ok value) — NEVER a plaintext fallback
    },
  };
}
