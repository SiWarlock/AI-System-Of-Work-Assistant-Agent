// §5 audit signal — the CLOCK-FREE precursor to a contracts AuditRecord.
//
// `packages/policy` is PURE (no clock), but an AuditRecord carries
// `timestamps.occurredAt`, a clock value. So policy emits an `AuditSignal`
// (everything an AuditRecord needs EXCEPT the timestamp) and the impure caller
// stamps `occurredAt` via `toAuditRecordInput`. REDACTION-SAFE by construction:
// a signal carries refs / hashes / codes ONLY — never raw content, prompts,
// credentials, or tokens (CLAUDE.md safety rule 7 + §16).
import type { AuditRecord } from "@sow/contracts";
import type { DenialReason } from "./denials";

// ARCH_GAP: the frozen `FailureClass` enum (packages/contracts shared-enums) has
// NO 'policy_denial' member. A policy DENY is USUALLY correct fail-closed
// behavior, not an operational health fault — so we do NOT invent a new enum
// member and `healthSignalClass` stays OPTIONAL, set only where the spec
// requires operational visibility (egress status REQ-S-002, admission
// rejection). This named constant abstracts that health class without touching
// the frozen enum. Reported in the task manifest flags.
export const POLICY_DENIAL_HEALTH_CLASS = "policy_denial" as const;

/**
 * Clock-free data needed to build an AuditRecord. `denialCode` + `healthSignalClass`
 * are policy-internal signal fields (dropped at the AuditRecord boundary — the
 * frozen AuditRecordSchema is `.strict()` and names neither).
 */
export interface AuditSignal {
  readonly actor: string;
  readonly event: string;
  readonly refs: readonly string[];
  readonly payloadHash: string;
  readonly beforeSummary: string;
  readonly afterSummary: string;
  /** Present on DENY signals; the closed §5 denial code. */
  readonly denialCode?: DenialReason;
  /** Set only where operational visibility is required (see ARCH_GAP above). */
  readonly healthSignalClass?: string;
}

/** Input to `buildAuditSignal` — structurally the signal itself. */
export interface BuildAuditSignalInput {
  readonly actor: string;
  readonly event: string;
  readonly refs: readonly string[];
  readonly payloadHash: string;
  readonly beforeSummary: string;
  readonly afterSummary: string;
  readonly denialCode?: DenialReason;
  readonly healthSignalClass?: string;
}

/**
 * Build a clock-free AuditSignal. Returns a fresh, normalized object (refs
 * copied) so the caller cannot mutate policy-internal state. Pure.
 */
export function buildAuditSignal(input: BuildAuditSignalInput): AuditSignal {
  const signal: AuditSignal = {
    actor: input.actor,
    event: input.event,
    refs: [...input.refs],
    payloadHash: input.payloadHash,
    beforeSummary: input.beforeSummary,
    afterSummary: input.afterSummary,
    ...(input.denialCode !== undefined ? { denialCode: input.denialCode } : {}),
    ...(input.healthSignalClass !== undefined
      ? { healthSignalClass: input.healthSignalClass }
      : {}),
  };
  return signal;
}

// --- redaction safety -------------------------------------------------------

// Credential-shaped prefixes (provider API keys, cloud creds, PEM blocks). A
// content hash such as "sha256:deadbeef" does NOT match any of these.
const CREDENTIAL_PREFIX =
  /(sk-[a-z0-9]|sk_(live|test)|xox[baprs]-|gh[pousr]_|AKIA[0-9A-Z]{16}|-----BEGIN|eyJ[A-Za-z0-9_-]{10,}\.)/;

// Sensitive keywords that indicate a raw-content / secret leak. Deliberately
// omits "token" so a structured code (e.g. AUTH_TOKEN_INVALID) — which is never
// scanned anyway (codes are excluded) — cannot cause a false positive.
const SENSITIVE_KEYWORD =
  /\b(pass(word|wd)|secret|api[_-]?key|bearer|credential|private[_ -]?key|passphrase)\b/i;

// A URL userinfo credential (`scheme://user:pass@host` or `//user:pass@host`).
// Catches an endpoint whose basic-auth secret is an arbitrary token that would
// otherwise slip past the keyword/prefix checks — so a raw endpoint ref carrying
// `user:pass@` is flagged even though the modules now emit host-only refs.
const URL_USERINFO_CREDENTIAL = /\/\/[^/\s:@]+:[^/\s@]+@/;

function looksUnsafe(s: string): boolean {
  return (
    CREDENTIAL_PREFIX.test(s) ||
    SENSITIVE_KEYWORD.test(s) ||
    URL_USERINFO_CREDENTIAL.test(s)
  );
}

/**
 * True iff the signal carries only refs / hashes / codes — no field looks
 * credential-shaped or carries raw content. `denialCode` + `healthSignalClass`
 * are closed codes/class constants and are NOT scanned. Pure.
 */
export function isRedactionSafe(signal: AuditSignal): boolean {
  const scanned: readonly string[] = [
    signal.actor,
    signal.event,
    signal.payloadHash,
    signal.beforeSummary,
    signal.afterSummary,
    ...signal.refs,
  ];
  for (const field of scanned) {
    if (looksUnsafe(field)) return false;
  }
  return true;
}

/**
 * Local invariant guard: throw if the signal is not redaction-safe. Intra-module
 * assertion only (not a cross-subsystem boundary) — callers that need a typed
 * outcome use `isRedactionSafe`.
 */
export function assertRedactionSafe(signal: AuditSignal): void {
  if (!isRedactionSafe(signal)) {
    throw new Error(
      "AuditSignal failed redaction check: a field is credential-shaped or carries raw content",
    );
  }
}

/**
 * Stamp a clock-free signal into an AuditRecord-shaped object the impure caller
 * can persist. `occurredAt` is supplied by the caller (policy has no clock).
 * The policy-internal `denialCode` / `healthSignalClass` fields are dropped —
 * the frozen `AuditRecordSchema` is `.strict()` and names neither.
 */
export function toAuditRecordInput(
  signal: AuditSignal,
  occurredAt: string,
): AuditRecord {
  return {
    actor: signal.actor,
    event: signal.event,
    refs: [...signal.refs],
    payloadHash: signal.payloadHash,
    beforeSummary: signal.beforeSummary,
    afterSummary: signal.afterSummary,
    timestamps: { occurredAt },
  };
}
