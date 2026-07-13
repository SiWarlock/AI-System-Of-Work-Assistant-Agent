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

const NEWLINE = 0x0a;
const DETAIL_MAX = 200;
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
 * ⚠ GO-LIVE VERIFY: the exact real exit codes, the stderr STRINGS (incl. substring false-positives — the `locked`
 * word-boundary vs `blocked`, the denied token set), AND the Keychain key-encoding contract must all be checked
 * against the live `security` binary when the owner provisions the signing key — the mocked tests pin this
 * CLASSIFIER, not the real codes/strings.
 */
function classifyFault(code: number, stderr: string): KeychainBackendError["kind"] {
  if (code === 44) return "not_found";
  const s = stderr.toLowerCase();
  // `\blocked\b` (word boundary) matches "…is locked" but NOT "blocked" (no boundary before its `l`).
  if (s.includes("interaction not allowed") || /\blocked\b/.test(s)) return "locked";
  if (s.includes("denied") || s.includes("not authorized") || s.includes("auth failed")) return "denied";
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
          // the ONLY place the secret leaves — straight into the ok Result; never logged, never in detail.
          return ok(stripOneTrailingNewline(toBytes(stdout)));
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
