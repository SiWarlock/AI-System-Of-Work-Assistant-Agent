// §5 audit signal — field-level redaction diagnosis (task 24.70).
//
// `isRedactionSafe` (`./audit-signal.ts`) scans six fields — actor, event, payloadHash,
// beforeSummary, afterSummary, refs (spread) — through a module-PRIVATE `looksUnsafe`
// union (`domainLooksUnsafe(s) || <local nets>`, task 24.110's (C')) and returns a bare
// boolean, so a REFUSED caller cannot know WHICH field tripped. `apps/worker/src/boot.ts`'s
// `persistDenial` refusal notice names this gap explicitly (task 24.62): two concurrent
// denials on the two Copilot paths were otherwise indistinguishable in the log sink.
//
// Field NAMES are a closed six-literal set, not content — naming one is safe under rule 7
// (redaction strips VALUES; a structural fact about which slot was unsafe is not a value).
//
// WHY THIS PROBES `isRedactionSafe` INSTEAD OF RE-IMPLEMENTING THE UNION: `looksUnsafe` is
// module-private, and this file may not touch `audit-signal.ts` / `audit-signal.test.ts`
// (a concurrent wave-1 slice owns them). Re-deriving the union arm here would create
// exactly the duplicated-heuristic drift this codebase has already paid for once (see
// 24.110's own header in `audit-signal.ts`). Instead: build a minimal probe signal in
// which every field EXCEPT the one under test carries a fixed known-safe constant, then
// call the EXPORTED `isRedactionSafe` on it. Because `looksUnsafe` is applied
// independently per scanned field (no cross-field dependency — see `isRedactionSafe`'s
// loop in `audit-signal.ts`), the probe's verdict for field X is exactly what a direct
// `looksUnsafe(realValueOfX)` call would have returned, without ever calling it.
import { isRedactionSafe, type AuditSignal } from "./audit-signal";

/**
 * The six fields `isRedactionSafe` scans, in scan order. Exhaustiveness against
 * `AuditSignal`'s required (hence scanned) keys is pinned in the test suite
 * (`the_six_literals_cover_every_scanned_key`) — a compile-time check, not restated here.
 */
export type UnsafeAuditField =
  | "actor"
  | "event"
  | "payloadHash"
  | "beforeSummary"
  | "afterSummary"
  | "refs";

type ScalarUnsafeField = Exclude<UnsafeAuditField, "refs">;

const SCALAR_SCAN_ORDER: readonly ScalarUnsafeField[] = [
  "actor",
  "event",
  "payloadHash",
  "beforeSummary",
  "afterSummary",
];

// The fixed backdrop every position but the one under test carries. Deliberately plain —
// no credential-shaped prefix, no sensitive keyword, no URL-userinfo shape — so it passes
// `isRedactionSafe` on its own and never masks the field actually being probed.
const SAFE_PROBE_VALUE = "sow-audit-signal-field-probe-safe-value";

const SAFE_PROBE_SIGNAL: AuditSignal = {
  actor: SAFE_PROBE_VALUE,
  event: SAFE_PROBE_VALUE,
  payloadHash: SAFE_PROBE_VALUE,
  beforeSummary: SAFE_PROBE_VALUE,
  afterSummary: SAFE_PROBE_VALUE,
  refs: [],
};

/** true iff `value` alone (every other scanned field at the safe backdrop) is unsafe. */
function scalarTripsAlone(field: ScalarUnsafeField, value: string): boolean {
  return !isRedactionSafe({ ...SAFE_PROBE_SIGNAL, [field]: value });
}

/** true iff a single ref entry `value` alone (every other scanned field, and every other
 *  ref, at the safe backdrop) is unsafe. */
function refTripsAlone(value: string): boolean {
  return !isRedactionSafe({ ...SAFE_PROBE_SIGNAL, refs: [value] });
}

function readScalarField(signal: AuditSignal, field: ScalarUnsafeField): string | null {
  const value: unknown = (signal as unknown as Record<string, unknown>)[field];
  return typeof value === "string" ? value : null;
}

function readRefsField(signal: AuditSignal): readonly unknown[] | null {
  const value: unknown = (signal as unknown as Record<string, unknown>)["refs"];
  return Array.isArray(value) ? value : null;
}

/**
 * Recover WHICH of the six fields `isRedactionSafe` scans made a signal unsafe, by probing
 * the exported `isRedactionSafe` — never re-implementing its union arm. Returns `null` iff
 * the signal is redaction-safe (mirrors `isRedactionSafe` exactly in both directions — see
 * the conformance pin `agrees_with_isRedactionSafe_in_both_directions`, which is also what
 * catches drift if the union arm this file deliberately does not duplicate ever changes).
 *
 * PURE, never throws. Fail-closed on a malformed signal: a field this cannot read as its
 * expected type (a non-string scalar, a non-array `refs`, a non-string ref entry) is
 * returned as the tripping field rather than skipped — an unreadable shape is never
 * reported as `null` (redaction-safe).
 *
 * Never returns or leaks a signal-derived VALUE — only one of the six field-name literals,
 * or `null`.
 */
export function firstUnsafeAuditField(signal: AuditSignal): UnsafeAuditField | null {
  if (typeof signal !== "object" || signal === null) return "actor";

  for (const field of SCALAR_SCAN_ORDER) {
    const value = readScalarField(signal, field);
    if (value === null) return field;
    if (scalarTripsAlone(field, value)) return field;
  }

  const refs = readRefsField(signal);
  if (refs === null) return "refs";
  for (const ref of refs) {
    if (typeof ref !== "string") return "refs";
    if (refTripsAlone(ref)) return "refs";
  }

  return null;
}
