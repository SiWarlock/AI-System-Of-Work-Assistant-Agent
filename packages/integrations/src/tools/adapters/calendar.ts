// @sow/integrations — 6.4 CALENDAR write adapter (create/update event).
//
// Per-target identity for the canonicalObjectKey (safety invariant 2 existence
// probe): a calendar event is identified by its (calendar, event) coordinates.
// arch_gap: §8 never pins a per-target identity contract for a calendar event —
// we adopt {calendarId, eventKey}, defaulting from the envelope's canonical +
// idempotency keys so the transport can resolve the vendor object. A wiring layer
// with richer coordinates injects a fuller deriver via a custom spec if needed;
// this default keeps the no-duplicate probe correct (match-by-canonical-key).
import type { TargetWriteAdapter } from "../adapter-port";
import type { AdapterDeps } from "./adapter-core";
import { makeTargetWriteAdapter } from "./adapter-core";

/**
 * Factory: a calendar `TargetWriteAdapter` over the injected transport + clock.
 * Create/update an event; existence-probe by the event's canonical identity.
 */
export function createCalendarWriteAdapter(deps: AdapterDeps): TargetWriteAdapter {
  return makeTargetWriteAdapter(
    {
      targetSystem: "calendar",
      deriveIdentity: (env) => ({
        calendarId: env.canonicalObjectKey,
        eventKey: env.idempotencyKey,
      }),
    },
    deps,
  );
}
