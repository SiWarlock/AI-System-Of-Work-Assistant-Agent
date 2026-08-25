// @sow/integrations — task 21.8a: the DEFAULT-OFF owner gate for the approval-
// card renderer built in this directory (mac-card.ts + telegram-card.ts).
//
// Mirrors `selectAdapterTransport` (apps/worker/src/composition/backends.ts:706)
// VERBATIM in its defensive shape, and the reasoning at backends.ts:693-705
// applies here unchanged: the owner-provisioned real renderer is selected ONLY
// when BOTH locks are satisfied —
//   - `gate.enabled` must be STRICTLY `=== true` (a truthy-but-not-`true` value
//     like `1` / `"true"` / `"false"` / `{}` never arms, closing the
//     truthy-coerce false-arming vector), AND
//   - `gate.make` must be an owner-provisioned factory (checked via
//     `typeof gate.make === "function"`).
// Absent/false EITHER lock ⇒ the deterministic no-op renderer, BYTE-IDENTICAL
// to today's `apps/worker/src/composition/buildActivities.ts:730`
// (`{ render: () => Promise.resolve(ok(undefined)) }`) — so the shipped default
// (`selectCardRenderer(undefined)`) is byte-equivalent and fully dormant. The
// real factory is NEVER invoked on the OFF path.
//
// No worker wiring happens in this slice (PROV-6's territory) — this module
// exports the seam only; no default flips, no key provisioned, no real network.
import { ok } from "@sow/contracts";
import type { CardRendererLike } from "./card-port";

/**
 * Default-OFF owner gate for the real card renderer. Both locks required to
 * arm; either absent/false ⇒ the no-op. Mirrors `WriteTransportGate`
 * (backends.ts:155).
 */
export interface CardTransportGate {
  /** STRICT `=== true` to arm the real renderer; anything else ⇒ no-op. */
  readonly enabled?: boolean;
  /** Owner-provisioned real-renderer factory; unbound ⇒ no-op (never invoked on OFF). */
  readonly make?: () => CardRendererLike;
}

/**
 * Select the outbound approval-card renderer, honouring the default-OFF owner
 * gate. See module header for the guard reasoning (type-robust on BOTH locks —
 * a JSON-sourced config could carry a non-boolean `enabled` or a non-function
 * `make` — fails CLOSED to the no-op on any malformed input, never arms and
 * never throws at boot).
 */
export function selectCardRenderer(gate?: CardTransportGate): CardRendererLike {
  if (gate?.enabled === true && typeof gate.make === "function") {
    return gate.make();
  }
  return { render: () => Promise.resolve(ok(undefined)) };
}
