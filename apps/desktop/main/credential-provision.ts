// One-way credential provisioning: renderer → main → macOS Keychain. The value goes IN and never
// comes back out.
//
// ⛔⛔ THIS MODULE CROSSES A LINE THE ARCHITECTURE PREVIOUSLY HELD ABSOLUTELY, AND THE OWNER TOOK
// THAT DECISION EXPLICITLY ON 2026-09-03 AFTER BEING SHOWN THE COST. Recorded here because a future
// reader will otherwise assume the guards below were weakened by accident:
//   • Before this, NO Keychain WRITE capability existed anywhere in the repo. Every mention of
//     `add-generic-password` was a comment stating the code deliberately does not provision.
//   • The preload inventory guards forbade any channel matching /secret|keychain|connector/ and
//     allowed exactly ONE token-bearing channel. Both were amended, in the open, in this change.
//   • The residual the owner accepted: a vendor credential now transits the RENDERER process. This
//     app renders imported/untrusted content (the reason ING-7 exists), so a renderer compromise
//     that previously could not yield a vendor credential now can.
// ⭐ The mitigation is DIRECTIONALITY, and it is the one property this module must never lose:
// provisioning is WRITE-ONLY. Nothing here reads a credential back, and no channel exists that
// could. A compromised renderer can overwrite a credential; it cannot exfiltrate one.
//
// Pure + electron-free so it compiles under tsconfig.node.json and no `electron` import reaches a
// test (apps/desktop LESSONS §3). The caller injects the exec seam, so the suite spawns nothing.

/**
 * The `security(1)` seam. Discrete argv — NEVER a shell string, so a service/account/value cannot
 * be interpreted as a command (mirrors the worker's `security`-CLI backend).
 *
 * ⚠ ACCEPTED, DOCUMENTED RESIDUAL: the secret rides in ARGV. Measured 2026-09-03 —
 * `add-generic-password` has no usable stdin path: invoking `-w` with no value makes it silently
 * consume the NEXT argument as the password and exit 0, writing the wrong value to the wrong
 * keychain. (That probe wrote a stray item into the login keychain; it was deleted and verified
 * gone.) So argv is not a shortcut, it is the only correct option for this tool. The exposure is a
 * short-lived child process visible to same-user processes.
 */
export type CredentialExec = (args: readonly string[]) => Promise<{ readonly code: number }>;

/** Closed failure set. Each is a DIFFERENT user remedy — never collapse them. */
export type CredentialProvisionFailure =
  | "invalid_ref"
  | "empty_value"
  | "keychain_write_failed";

export interface CredentialProvisionResult {
  readonly ok: boolean;
  /** Present only on failure. A closed token — NEVER the value, the ref, or `security`'s output. */
  readonly reason?: CredentialProvisionFailure;
}

/** `security` exit code for a locked/denied keychain interaction. */
const SECURITY_OK = 0;

// ⛔ MIRRORED from `apps/worker/src/secrets/keychain-adapter.ts` (`SCHEME`, `MAX_REF_LENGTH`,
// `SEGMENT`, and the two-segment rule). It is a MIRROR, not a runtime import: Electron main cannot
// import `@sow/worker` at runtime (desktop L17 — it stays externalized, so the specifier would
// resolve to raw `.ts` and crash at load).
// ⚠ A mirror can DRIFT, and a drifted charset here would re-open the ref-injection surface the
// original guard closed. Drift is caught NOT by this comment but by
// `test/main/credential-ref-parity.test.ts`, which imports the worker's real parser (a test file is
// never bundled, so it carries no such constraint) and asserts the two agree BOTH ways over a
// shared corpus. Same shape as the existing `dotenv-shadowing-parity.test.ts` mirror.
const SCHEME = "keychain://";
const MAX_REF_LENGTH = 512;
const SEGMENT = /^[A-Za-z0-9_.][A-Za-z0-9_.-]*$/;

/**
 * Parse `keychain://<service>/<account>` into its two parts, or `null` when malformed. Fail-closed:
 * exactly two non-empty segments, each charset-clean and not a `.`/`..` traversal token.
 *
 * ⛔ Barring a LEADING `-` is load-bearing, not cosmetic: a segment beginning with `-` would reach
 * `security` as a CLI OPTION rather than a value.
 */
export function parseCredentialRef(
  ref: string,
): { readonly service: string; readonly account: string } | null {
  if (ref.length > MAX_REF_LENGTH) return null;
  if (!ref.startsWith(SCHEME)) return null;
  const segments = ref.slice(SCHEME.length).split("/");
  if (segments.length !== 2) return null;
  const service = segments[0];
  const account = segments[1];
  if (service === undefined || account === undefined) return null;
  for (const seg of [service, account]) {
    if (seg.length === 0 || seg === "." || seg === ".." || !SEGMENT.test(seg)) return null;
  }
  return { service, account };
}

/**
 * Store `value` at `ref` in the login Keychain, creating or REPLACING the item (`-U`). Idempotent:
 * re-provisioning the same ref overwrites rather than duplicating, so a user correcting a typo does
 * not leave a stale item that a later read might find first.
 *
 * TOTAL — never throws (§16): a throwing exec seam degrades to a typed failure. The renderer calls
 * this on a user gesture; a throw would surface as an unhandled rejection carrying the stack.
 *
 * ⛔ RULE 7 — `value` appears in EXACTLY ONE place: the argv handed to `security`. It is never
 * returned, never logged, never folded into a reason, and never echoed on either branch. Pinned by
 * `test/main/credential-provision.test.ts`, which greps the whole serialized result for it.
 */
export async function provisionCredential(
  ref: string,
  value: string,
  exec: CredentialExec,
): Promise<CredentialProvisionResult> {
  const parsed = parseCredentialRef(ref);
  if (parsed === null) return { ok: false, reason: "invalid_ref" };
  // A whitespace-only credential is not proof of anything and would fail closed later at a vendor
  // call with a far less obvious message. Refuse it here, where the user can still see the field.
  if (value.trim().length === 0) return { ok: false, reason: "empty_value" };
  try {
    const res = await exec([
      "add-generic-password",
      "-U", // update-if-exists ⇒ idempotent re-provisioning, never a duplicate item
      "-s",
      parsed.service,
      "-a",
      parsed.account,
      "-w",
      value,
    ]);
    return res.code === SECURITY_OK ? { ok: true } : { ok: false, reason: "keychain_write_failed" };
  } catch {
    return { ok: false, reason: "keychain_write_failed" };
  }
}
