// @sow/workflows — SINGLE-SOURCED safety-rule-7 activity-boundary redaction.
//
// THE ARCHITECTURAL FACT: registering a function as a Temporal ACTIVITY turns
// its return value into durable, REPLAYED workflow history — a log sink under
// safety rule 7 ("redaction strips secrets, raw content and prompts before any
// log sink"). A value that was a harmless in-process return becomes a rule-7
// exposure the moment the function it flows through is registered.
//
// `cause` is the concrete hazard: an arbitrary thrown/forwarded value can be a
// provider/HTTP error carrying a request URL with a token, an Authorization
// header, a DB driver error carrying a DSN, or an fs error carrying an
// absolute vault path. NOTE a thrown `Error` INSTANCE serializes to `{}` under
// Temporal's default JSON payload converter (message/stack are non-enumerable),
// but a thrown PLAIN OBJECT — the common shape for a provider/driver rejection
// — serializes IN FULL. "It's just an Error" is never a safe assumption here.
//
// `dropCause` is NOT the one place every activity-boundary error in this package
// redacts at — an earlier version of this comment claimed exactly that, and the
// 24.73 census measured it false: seven activity-boundary sites under
// packages/workflows/src carried a rule-7 redaction note, and only three of them
// imported this helper (a live `rg -ln "SAFETY RULE 7" packages/workflows/src` will
// read differently — it now also matches THIS file's own prose, and the inventory
// below has since grown). What IS true: `dropCause` is the
// shared helper for the subset of sites whose `message` is ALREADY safe (fixed, or
// interpolating only a caller-supplied/configured identifier — never caller-,
// provider-, or filesystem-derived detail) and needs only its `cause` stripped. It
// keeps the STABLE, closed-taxonomy `code` byte-identical (every workflow driver
// switches on it — dropping or remapping it silently breaks them) and the
// caller-supplied `message` unchanged, and drops `cause` unconditionally. It
// deliberately does NOT touch `message`: a call site whose `message` cannot be
// PROVEN safe must NOT rely on this helper alone — it must rebuild a fixed/safe
// `message` itself (see the inventory below), because `dropCause` guarantees only
// that `cause` never rides along.
//
// THE FULL INVENTORY (so this file never again asserts more than it can support):
//   • dropCause consumers — `message` is provably safe as-is, only `cause` needs
//     dropping: connectorPoll.ts, approvalTransition.ts,
//     workflows/systemHealthSurfacing.ts. Mirrors `dropCommitFailureCause`
//     (activities/outputWorkflows.ts) and `commitFailureToVariant`
//     (apps/worker/src/api/procedures/semanticMutationDispatch.ts) — the same
//     discipline, single-sourced HERE so these three sites don't each
//     re-implement "keep code, drop cause" independently. `outputWorkflows.ts`'s
//     copy predates this helper and is OUT of this slice's territory (do not
//     touch — see the file's own note); a future pass can fold it in.
//     `apps/worker/src/composition/buildActivities.ts` holds a further local
//     duplicate — a future CROSS-TRACK pass should import this helper instead of
//     re-implementing it a fourth time (worker territory, not this package's to
//     edit).
//   • Bespoke "rebuild `message` too" sites — the failure is forwarded from an
//     injected, out-of-this-package dependency whose `message` cannot be proven
//     free of caller/provider/fs-derived detail, so BOTH `cause` and `message` are
//     dropped: a fresh literal is built per closed `code` (never reading `.cause`,
//     never forwarding `.message`). `refreshConnectors.ts`'s
//     `redactConnectorRefreshError` is the original of this shape;
//     `reindexGbrain.ts`, `buildGclProjection.ts`, and `deterministicProgress.ts`
//     (24.73 round 2) each carry their own local mirror of it, one per distinct
//     injected-port error-code union — this shape does NOT generalize into one
//     shared helper the way `dropCause` does, because each site's safe-message
//     mapping table is genuinely different content, not a repeated structural
//     transform. `gatherAvailability.ts` redacts per-call-site inline instead of
//     via a named function (its two failure branches, plus a gate-rejection
//     `reason` field that isn't a `{code,message,cause}` shape at all, don't share
//     a single reusable table either).
//   • `dashboardUpdate.ts` never populates `cause` in the first place (its `catch`
//     discards the thrown value entirely) and its `message` is already a fixed
//     generic string — there is nothing for a helper to drop.
// None of the above is a gap this package still owes: every rule-7 boundary site
// it owns redacts by one of these three disciplines, chosen for what that site's
// `message` can actually prove.
//
// Preserves in-process consumers: this helper only ever runs at the point a
// value is ABOUT TO cross an activity boundary — it never touches a value
// still held in-process. E.g. `HealthActivityError.cause` built inside
// `healthItem.ts` is legitimately consumed in-process elsewhere; only what
// `systemHealthSurfacing.ts` RETURNS from a registered activity is redacted.
export function dropCause<C extends string>(failure: {
  readonly code: C;
  readonly message: string;
  readonly cause?: unknown;
}): { readonly code: C; readonly message: string } {
  return { code: failure.code, message: failure.message };
}
