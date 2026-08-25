// @sow/workflows — R7-g: Flow-3 calendar-payload KEY allowlist (fails closed on an
// unknown field).
//
// WHY THIS EXISTS: `payloadCarriesRawContent` (proposeWindows.ts, task 24.19/24.32)
// is a VALUE-SHAPE guess — it rejects a payload value that LOOKS raw-content-shaped
// (multi-line / over-length). It says nothing about WHICH FIELDS may ride a
// cross-workspace calendar proposal at all: an unknown key whose value happens to be
// short and single-line (a leaked `attendeeEmail`, `organizerNote`,
// `sourceEventTitle`, ...) passes the value-shape check by shape alone. This module
// is the OTHER axis: a closed, explicit allowlist of the keys
// `createProposeWindowsActivity` is actually permitted to emit on the
// ACTUALLY-DISPATCHED payload. The allowlist is the authority on WHICH fields may
// ride the payload; `payloadCarriesRawContent` remains the authority on WHAT may be
// in the fields it allows — the two checks COMPOSE (proposeWindows.ts runs both),
// neither replaces the other.
//
// Adding a key here is a rule-4 (workspace-isolation) decision, not a refactor: it
// widens what a cross-workspace scheduling proposal is permitted to carry. Do NOT
// add a key because it "might be needed" — an allowlist that anticipates is not an
// allowlist. The set below is derived from exactly what `createProposeWindowsActivity`
// emits today (proposeWindows.ts's `DerivedCalendarAction.payload`, populated from a
// `ValidatedProposal`'s `ProposedWindow` — `../ports/crossCalendarScheduling.ts`'s
// `start` / `end` / `genericExplanation`, the ONLY fields that contract declares).

/** The closed set of calendar-event-payload keys a cross-workspace scheduling
 * proposal may carry. Frozen — this is a fixed vocabulary, not a runtime-mutable
 * configuration surface. */
export const CALENDAR_PAYLOAD_KEYS: ReadonlySet<string> = Object.freeze(
  new Set(["start", "end", "genericExplanation"]),
);

/** Sentinel returned for a payload that is not a plain object at all (`null`, an
 * array, a primitive, ...). Fail-closed: such an input is refused, never treated as
 * "no unknown key found". */
const NON_PLAIN_OBJECT_SENTINEL = "<non-plain-object-payload>";

/**
 * Returns the first payload key NOT on {@link CALENDAR_PAYLOAD_KEYS}, or `null` when
 * every own key — string-named OR Symbol-keyed, enumerable OR not — is allowlisted.
 * PURE, never throws.
 *
 * Traverses via `Object.getOwnPropertyNames` + `Object.getOwnPropertySymbols` —
 * NEVER `Object.keys`/`Object.entries`/`for...in` — so a non-enumerable or
 * Symbol-keyed field cannot ride past the guard unseen (mirrors the traversal
 * hardening `@sow/contracts`'s `carriesRawContent` already has, task 24.19).
 *
 * Fail-closed on a non-plain-object input: `null`, an array, or a non-object value
 * returns the sentinel key name — never `null` — because a caller that folds a
 * non-null return to `build_failed` would otherwise treat a malformed payload as
 * clean, which is the exact silent-pass this guard exists to prevent.
 */
export function unknownCalendarPayloadKey(payload: Record<string, unknown>): string | null {
  if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
    return NON_PLAIN_OBJECT_SENTINEL;
  }

  for (const name of Object.getOwnPropertyNames(payload)) {
    if (!CALENDAR_PAYLOAD_KEYS.has(name)) return name;
  }

  const symbols = Object.getOwnPropertySymbols(payload);
  const firstSymbol = symbols[0];
  if (firstSymbol !== undefined) {
    return firstSymbol.description !== undefined
      ? `Symbol(${firstSymbol.description})`
      : "Symbol()";
  }

  return null;
}
