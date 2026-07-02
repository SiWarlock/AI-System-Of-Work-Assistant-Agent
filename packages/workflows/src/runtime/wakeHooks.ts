// @sow/workflows — slice 7.3 WAKE / power-resume hooks (LIFE-6, §8, §9).
//
// Two pieces, split by the sandbox boundary:
//   • planWake — a PURE, deterministic decision: given a wake event (power resume
//     / network reconnect), decide WHETHER to drain the held outbox and with what
//     sweep limit. Imports NEITHER @temporalio NOR node:crypto; no Date.now() —
//     the wake `now` is carried on the event. Safe to import into workflow code.
//   • runWakeDrain — the ACTIVITY wrapper: when planWake says drain, it calls
//     `drainOutbox` (the §8 replay-safe drain from @sow/integrations) with the
//     injected deps. Because drainOutbox re-drives every held entry through the
//     Tool-Gateway pipeline (existence check + stored-receipt replay gate BEFORE
//     any create), a mid-flight activity that crashed is retried IDEMPOTENTLY —
//     an entry whose receipt already landed returns `reused` (adapter.create is
//     NEVER called again), so no partial/duplicate external side effect results.
//
// §16 error convention: no throw across the boundary — planWake returns a plain
// decision; runWakeDrain returns drainOutbox's typed counts (drainOutbox itself
// never throws).
import { drainOutbox } from "@sow/integrations";
import type { OutboxRepository, DrainDeps, DrainResult } from "@sow/integrations";

/** The closed set of wake reasons that trigger a held-outbox drain (LIFE-6). */
export type WakeReason = "power_resume" | "network_reconnect";

/** A wake/power-resume event. `now` is the wall reading captured at wake (injected). */
export interface WakeEvent {
  readonly reason: WakeReason;
  readonly now: string;
}

/** Tuning for {@link planWake}: the desired sweep limit for the drain pass. */
export interface WakeConfig {
  readonly limit: number;
}

/**
 * The wake decision: whether to drain, and the (clamped) sweep limit + `now` to
 * pass to the drain. A non-positive requested limit is clamped UP to
 * {@link DEFAULT_WAKE_LIMIT} — a zero-width sweep would leave held work stranded.
 */
export interface WakeDecision {
  readonly shouldDrain: boolean;
  readonly limit: number;
  readonly now: string;
}

/** The safe default sweep limit when a caller supplies a non-positive limit. */
export const DEFAULT_WAKE_LIMIT = 100 as const;

/**
 * Decide the wake response. Pure + deterministic. Both known wake reasons drain
 * (the whole point of a wake hook is to sweep held work); the limit is clamped to
 * a positive value so a mis-configured `0` never silently drops held entries.
 */
export function planWake(event: WakeEvent, config: WakeConfig): WakeDecision {
  const limit = config.limit > 0 ? config.limit : DEFAULT_WAKE_LIMIT;
  return { shouldDrain: true, limit, now: event.now };
}

/** Injected deps for {@link runWakeDrain}: the outbox repo + the §8 drain deps. */
export interface WakeDrainDeps {
  readonly outbox: OutboxRepository;
  readonly drainDeps: DrainDeps;
}

/** Zero-count result for a wake that decided NOT to drain. */
const NO_DRAIN: DrainResult = { drained: 0, reused: 0, held: 0, failed: 0 };

/**
 * Run the wake response: decide (planWake), then — if draining — re-drive the held
 * outbox through the replay-safe drain. Returns drainOutbox's typed counts. Never
 * throws. Idempotent across crashes (drainOutbox excludes terminal entries and
 * reuses any existing receipt → no duplicate external write).
 */
export async function runWakeDrain(
  event: WakeEvent,
  deps: WakeDrainDeps,
): Promise<DrainResult> {
  const decision = planWake(event, { limit: deps.drainDeps.limit });
  if (!decision.shouldDrain) {
    return NO_DRAIN;
  }
  return drainOutbox(deps.outbox, deps.drainDeps);
}
