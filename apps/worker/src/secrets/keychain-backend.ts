// Task 11.4 Slice 2 — the real macOS `security`-CLI Keychain read backend behind the Slice-1 `KeychainBackend`
// seam. `createSecurityCliKeychainBackend({ exec })` runs `security find-generic-password -w -s <svc> -a <acct>`
// over an INJECTED execFile-shaped `exec` (an args ARRAY, NEVER a shell string) and maps exit/stderr to the
// typed `KeychainBackendError`. This slice does NO real Keychain I/O — every test drives a FAKE `exec`; the real
// `security` binary runs only at owner-provisioning (Slice 3, owner-gated).
//
// SAFETY-CRITICAL (safety rule 7). The `-w` STDOUT IS THE SECRET VALUE:
//   • it is returned ONLY in the ok `Uint8Array` (one trailing `\n` stripped, interior bytes untouched) — never
//     stringified/`.toString()`'d, never logged, never placed in `detail`;
//   • a FAULT path reads ONLY the exit code + stderr — it never touches stdout, so the secret can't reach
//     `detail` BY CONSTRUCTION;
//   • `detail` is a BOUNDED, secret-scrubbed stderr+code summary (defense-in-depth atop the structural guarantee;
//     the Slice-1 adapter drops `detail` entirely anyway).
// argv-injection-proof: an args array (no shell) + absolute bin (no PATH lookup) + getopt option-value semantics
// (`-s`/`-a` values are consumed literally regardless of a leading `-`) + the Slice-1 leading-`-` charset guard.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import type { KeychainBackend, KeychainBackendError } from "./keychain-adapter";

/** The injected execFile-shaped exec seam (NO shell). Slice 3 supplies a real `execFile` wrapper (bounded
 *  timeout + maxBuffer). `stdout` is `Uint8Array | string` so a raw-binary key round-trips without a lossy step. */
export type KeychainExec = (
  file: string,
  args: readonly string[],
) => Promise<{ readonly code: number; readonly stdout: Uint8Array | string; readonly stderr: string }>;

/** The macOS `security` binary — ABSOLUTE so `exec` never does a PATH lookup (no binary-hijack). */
export const SECURITY_BIN = "/usr/bin/security";

/** Sentinel exit for "the exec was killed by its own timeout" — see `classifyFault`.
 *  Defined HERE, not in `keychain-boot.ts`, because boot imports this module: putting it there
 *  and importing it back would create a cycle. `mapExecResult` re-exports it for its callers. */
export const TIMED_OUT_EXIT = -2;

const NEWLINE = 0x0a;
const DETAIL_MAX = 200;
/** Max RAW code-0 stdout length (bytes, any trailing newline INCLUDED — the guard checks the raw value before
 *  the newline-strip so an anomalous blob is never copied). A value larger is anomalous — an HMAC key is 32-64B
 *  and a provider key/token is well under it; 4KB is generous headroom, far under the real execFile's 64KB maxBuffer. */
const MAX_KEY_LEN = 4096;
/** A secret-shaped run: ≥16 chars of a key/base64/hex-ish alphabet. Redacted from `detail` (belt-and-suspenders
 *  over the structural guarantee that `detail` never reads stdout). */
const SECRET_SHAPED = /[A-Za-z0-9+/=_-]{16,}/g;

/** Convert stdout to bytes (a `Uint8Array` passes through byte-exact; a string is UTF-8 encoded). */
function toBytes(stdout: Uint8Array | string): Uint8Array {
  return typeof stdout === "string" ? new TextEncoder().encode(stdout) : stdout;
}

/**
 * Strip EXACTLY one trailing `\n` (the CLI's) — nothing else; interior/other-whitespace bytes are untouched.
 * ALWAYS returns a fresh, exact-sized COPY so the returned secret can never alias/retain the exec's (possibly
 * pooled/oversized) backing buffer (rule 7 hygiene). Uses the `new Uint8Array(view)` CONSTRUCTOR — NOT `.slice`:
 * a Node `Buffer` (what a real `execFile` yields) overrides `Uint8Array.prototype.slice` with VIEW (shared-memory)
 * semantics, so `.slice` would re-alias the pool; the constructor always copies for both `Uint8Array` and `Buffer`.
 */
function stripOneTrailingNewline(bytes: Uint8Array): Uint8Array {
  const end = bytes.length > 0 && bytes[bytes.length - 1] === NEWLINE ? bytes.length - 1 : bytes.length;
  return new Uint8Array(bytes.subarray(0, end));
}

/**
 * Classify a non-zero exit into a typed `kind`. `44` = errSecItemNotFound (well-known, stable). locked/denied are
 * classified by STDERR PATTERN (case-insensitive) rather than brittle numeric codes, which vary by macOS version.
 * ⚠ GO-LIVE VERIFY — PARTIALLY DISCHARGED 2026-08-28. Split the claim, because the two halves have very
 * different evidence:
 *   • MEASURED against the live binary (macOS Darwin 25.5.0), pinned by
 *     `test/secrets/keychain-live-classifier.test.ts` under `SOW_KEYCHAIN=1`: a missing item really does exit
 *     `44` with stderr "security: SecKeychainSearchCopyNext: The specified item could not be found in the
 *     keychain." That string trips NONE of the locked/denied patterns, so if this 44 branch were ever removed
 *     or reordered the case degrades to `backend_error` — never to a confidently wrong `locked`. Note what the
 *     mocked tests could and could not do here: they pin "44 ⇒ not_found" (they FEED the 44); only the live
 *     probe pins "macOS actually returns 44".
 *   • ✅ `locked` NOW MEASURED (2026-08-28) — AND THE ASSUMPTION IT REPLACES WAS WRONG.
 *     ⛔ This comment used to say `locked` was unreachable because "reaching it means locking the operator's
 *     login keychain … which a test must not do to someone's machine." ⭐ THAT PREMISE WAS FALSE: a THROWAWAY
 *     keychain at a temp path, never added to the search list, measures it without touching the operator's
 *     login keychain at all. The impossibility was assumed, not tested — on the one branch the same comment
 *     called "the direction that matters".
 *     MEASURED, macOS Darwin 25.5.0: `create-keychain` → `add-generic-password` (dummy) → `lock-keychain` →
 *     `find-generic-password -w` ⇒ macOS shows a MODAL UNLOCK DIALOG; dismissed, it exits **128 with EMPTY
 *     stdout AND stderr**. ⇒ the stderr-pattern branch CANNOT FIRE — there is no stderr — so a locked
 *     keychain fell through to `backend_error`, which `keychain-boot.ts`'s `mapUnavailableReason` folds to
 *     `"missing"`. ***The operator was told the credential DID NOT EXIST when it existed and the keychain was
 *     merely locked*** — and the entire `onKeychainLocked` → keychain-locked HealthItem path (worker L41/L53)
 *     was UNREACHABLE via the real CLI. Fixed by the `code === 128 && empty stderr` branch below.
 *   ⚠ OPERATIONAL CONSEQUENCE, measured and NOT fixed here: EVERY `security` CLI path blocks on that modal
 *     dialog — `show-keychain-info` on a locked keychain hangs too (verified: killed at 8s), so there is NO
 *     non-prompting lock-state pre-check available from this CLI. In production `createRealExecFile`'s
 *     `timeout: 5_000` bounds it: the read costs 5s and folds to `backend_error`. ⇒ the 128 branch covers the
 *     DISMISSED-dialog case; the UNANSWERED case still degrades to `backend_error` by timeout.
 *   ⚠ BOUNDARY, stated because it decides which branch is right: this was measured in a session WITH a window
 *     server (how this Electron app actually runs). A true headless/daemon context may instead return
 *     `errSecInteractionNotAllowed` — the exact string the pattern branch already matches. Both branches are
 *     therefore live, for different contexts; neither supersedes the other.
 *   • STILL UNMEASURED: `denied`. It needs a real ACL denial, and its stderr token set remains an ASSUMPTION.
 * ⛔⛔ KEY-ENCODING CONTRACT — MEASURED 2026-08-28, AND IT IS A REAL HAZARD, NOT A CONFIRMATION.
 * This line used to read "likewise still unverified (it needs a provisioned item)". A DUMMY item on a
 * throwaway keychain was a provisioned item, and the answer matters:
 *
 *   `security find-generic-password -w` RETURNS THE VALUE AS LOWERCASE HEX whenever it contains ANY
 *   non-printable byte — and gives NO MARKER distinguishing that from a raw value.
 *
 * MEASURED (Darwin 25.5.0): `sk-ant-api03-AbCdEf123` → raw · `hello-world_123.=+/` → raw ·
 * `abc\n` → `6162630a` · `abc\xc3\xa9` → `616263c3a9` · `a\tb` → `610962`. A base64 key
 * (`yuC3kA3C4BIun8NoHmZA/5e0Ua15Qx3inPSUJUPVgcE=`) round-trips BYTE-EXACT.
 *
 * ⛔ WHY THIS IS DANGEROUS AND NOT MERELY ANNOYING: `resolveSigningKey` feeds `createHmac("sha256", key)`
 * (`provenance-stamp.ts`). A RAW-BINARY HMAC key provisioned at `sow/kw-signing` would be read back as
 * its HEX ASCII — different bytes, double length — and would then stamp AND verify SELF-CONSISTENTLY
 * with the wrong key. ⇒ ***it would look like it works.*** The defect surfaces only when the key is
 * rotated, re-provisioned, or verified by anything that reads the keychain differently.
 *
 * ⛔ NO RUNTIME GUARD IS POSSIBLE, and that is a conclusion rather than an omission: `security` DESTROYS
 * the distinction. A value that is legitimately the string `"6162630a"` is byte-identical to the hex
 * rendering of raw `abc\n`, so no reader can tell them apart. The ambiguity is irreducible AT READ TIME,
 * which is exactly why the contract has to be enforced at PROVISIONING time.
 * ⇒ **THE CONTRACT: every keychain-stored key MUST be printable ASCII — base64 for anything binary.**
 * `§ARM-17`'s provisioning instruction states it; this comment is the measurement behind it.
 */
function classifyFault(code: number, stderr: string): KeychainBackendError["kind"] {
  if (code === 44) return "not_found";
  const s = stderr.toLowerCase();
  // `\blocked\b` (word boundary) matches "…is locked" but NOT "blocked" (no boundary before its `l`).
  if (s.includes("interaction not allowed") || /\blocked\b/.test(s)) return "locked";
  if (s.includes("denied") || s.includes("not authorized") || s.includes("auth failed")) return "denied";
  // ⛔ MEASURED (2026-08-28) — a LOCKED keychain reaches here with NOTHING to pattern-match: exit 128,
  // empty stdout AND stderr. Requiring EMPTY stderr is load-bearing: `locked` is RETRYABLE, so a
  // blanket `128 ⇒ locked` would make a genuinely terminal 128 retry forever — the hazard this
  // function's own comment names. A 128 that carries a message is still classified by that message.
  if (code === 128 && stderr.trim().length === 0) return "locked";
  // ⛔ TIMED_OUT_EXIT (-2) — the exec was killed by its own timeout. On macOS that means a keychain
  // dialog is waiting (locked, or an ACL the operator has not authorised); a genuinely absent item
  // returns 44 instantly. `locked` is the right disposition for BOTH: it is retryable once the operator
  // acts, and it routes to `onKeychainLocked` (worker L41), which tells them to deal with the keychain.
  // ⚠ It may in truth be `denied` — a timeout cannot distinguish the two, and that is stated rather than
  // guessed. What matters is that it is no longer reported as `"missing"`.
  if (code === TIMED_OUT_EXIT) return "locked";
  return "backend_error";
}

/** Build a BOUNDED, secret-scrubbed debug `detail` from the exit code + stderr. NEVER stdout. */
function scrubDetail(code: number, stderr: string): string {
  const redacted = stderr.replace(SECRET_SHAPED, "[REDACTED]");
  const summary = `exit ${code}: ${redacted}`;
  return summary.length > DETAIL_MAX ? summary.slice(0, DETAIL_MAX) : summary;
}

/** Deps for the security-CLI backend. */
export interface SecurityCliKeychainBackendDeps {
  readonly exec: KeychainExec;
}

/**
 * The real `KeychainBackend` over the macOS `security` CLI. `read(service, account)` runs
 * `security find-generic-password -w -s <service> -a <account>` via the injected `exec`, returns the `-w` value
 * (one trailing `\n` stripped) as `Uint8Array` on exit 0, and maps every fault to a typed `KeychainBackendError`.
 * Never throws — a rejecting/ENOENT/timeout `exec` folds to `backend_error`.
 */
export function createSecurityCliKeychainBackend(deps: SecurityCliKeychainBackendDeps): KeychainBackend {
  return {
    async read(service: string, account: string): Promise<Result<Uint8Array, KeychainBackendError>> {
      try {
        const { code, stdout, stderr } = await deps.exec(SECURITY_BIN, [
          "find-generic-password",
          "-w",
          "-s",
          service,
          "-a",
          account,
        ]);
        if (code === 0) {
          const raw = toBytes(stdout);
          // Trust boundary (mirror the Slice-1 zero-length reject): a code-0 value FAR larger than any real
          // key/token is anomalous — the wrapper doesn't TRUST the swappable exec to have bounded stdout.
          // Reject on the RAW length (before de-aliasing, so an anomalous blob is never copied); never served.
          if (raw.length > MAX_KEY_LEN) return err({ kind: "backend_error", detail: "key exceeds max length" });
          // the ONLY place the secret leaves — straight into the ok Result; never logged, never in detail.
          return ok(stripOneTrailingNewline(raw));
        }
        // FAULT: read only code + stderr — stdout (which could carry partial secret bytes) is deliberately IGNORED.
        return err({ kind: classifyFault(code, stderr), detail: scrubDetail(code, stderr) });
      } catch {
        // §16 — a spawn failure / ENOENT / timeout never escapes the seam; the thrown value (which may embed
        // stderr) is NOT bound, so nothing from it leaks.
        return err({ kind: "backend_error", detail: "exec failed" });
      }
    },
  };
}
