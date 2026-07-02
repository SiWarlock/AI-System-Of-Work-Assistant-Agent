// Task 8.6 (b)+(c) — bounded per-connection outbound backpressure.
//
// The Phase-0 API spike (docs/spikes/0.5-api-stream.md, "Backpressure guard")
// pins the contract: tRPC `onData` is PUSH (no consumer-driven backpressure at
// the callback), and the server generator's async-iterable "buffers UNBOUNDED
// if the generator stalls." The fix the spike names: "cap the server
// async-iterable with a replay window + `maxBufferedItems`; window size = resume
// horizon; over-horizon ⇒ emit a resync-from-snapshot signal." Plus keepAlive
// `{ pingMs: 1000, pongWaitMs: 2000 }` liveness (mapped to System Health).
//
// This module is the PER-CONNECTION outbound buffer that enforces that cap. Each
// subscriber gets its OWN `OutboundBuffer` (per-connection isolation): a slow /
// stalled consumer overflows only ITS buffer — it cannot block another
// subscriber's buffer or the worker event loop, because the buffer is a plain
// bounded in-memory structure with no shared mutable state and no blocking wait.
//
// OVERFLOW POLICY (explicit — never unbounded growth, never a silent partial
// loss that leaves the UI inconsistent):
//   1. COALESCE read-model deltas. `read_model.change` is a last-write-wins
//      DELTA per `cardId`; under pressure a superseded same-card delta is
//      collapsed into the latest, so the UI still converges to the current state
//      per card — no committed card-state is lost, memory stays bounded.
//   2. SIGNAL resync. When coalescing cannot absorb the overflow (the buffer is
//      full of NON-coalescible events — workflow.status / approval.update /
//      system.health, which are not per-key deltas), the buffer flips to a
//      RESYNC state: it stops accumulating stale partials and reports that the
//      connection must resync-from-snapshot (spike over-horizon signal). Serving
//      a silently-truncated slice would leave the UI missing committed changes,
//      so we never do — the resync flag is the source of truth.
//
// §16: no throw across the boundary — `offer` returns a typed `OfferOutcome`.
import type { StreamEvent } from "@sow/contracts";
import { DEFAULT_REPLAY_WINDOW } from "./eventClasses";

/**
 * The keepAlive / heartbeat thresholds pinned by the Phase-0 API spike
 * (`applyWSSHandler` keepAlive). Referenced by the integrator when it wires the
 * WS handler; surfaced here so the backpressure/liveness thresholds live in ONE
 * place (System-Health liveness maps to `pongWaitMs`), never re-invented.
 */
export const HEARTBEAT = { pingMs: 1000, pongWaitMs: 2000 } as const;

/**
 * The default per-connection outbound bound. Aligned to the spike's replay
 * window / resume horizon (`DEFAULT_REPLAY_WINDOW`) so a buffer OVERFLOW and a
 * resume OVER-HORIZON share ONE coherent horizon rather than two ad-hoc numbers.
 */
export const DEFAULT_MAX_BUFFERED_ITEMS = DEFAULT_REPLAY_WINDOW;

/** The read-model class whose deltas are last-write-wins coalescible by cardId. */
const READ_MODEL_CHANGE = "read_model.change";

/** The outcome of offering one event to a bounded outbound buffer. */
export type OfferOutcome =
  /** Accepted into the buffer (possibly after coalescing a superseded delta). */
  | { readonly kind: "buffered" }
  /** Coalesced onto an existing same-card delta (no net growth). */
  | { readonly kind: "coalesced" }
  /** Overflow that coalescing could not absorb ⇒ the connection must resync. */
  | { readonly kind: "resync" };

/** Options for {@link createOutboundBuffer}. */
export interface OutboundBufferOptions {
  /** The bound — defaults to {@link DEFAULT_MAX_BUFFERED_ITEMS}. Min 1. */
  readonly maxBufferedItems?: number;
}

/**
 * A bounded, per-connection outbound buffer. Isolated: each subscriber holds its
 * own instance; overflow in one never touches another (no shared mutable state).
 */
export interface OutboundBuffer {
  /**
   * Offer one event. Buffers it when there is room; coalesces a superseded
   * read-model delta under pressure; flips to `resync` when overflow cannot be
   * absorbed. NEVER grows past the bound; NEVER silently drops a non-coalescible
   * committed change (it signals resync instead).
   */
  offer(ev: StreamEvent): OfferOutcome;
  /**
   * Take the currently-buffered events (in seq order) and empty the buffer — the
   * consumer flushed them to its socket. Once the buffer has flipped to resync,
   * the resync flag (not this list) is the source of truth for the client.
   */
  drain(): readonly StreamEvent[];
  /** The number of events currently buffered (always ≤ {@link capacity}). */
  size(): number;
  /** The configured bound (`maxBufferedItems`). */
  capacity(): number;
  /** True once overflow forced a resync-from-snapshot signal for this connection. */
  needsResync(): boolean;
}

export function createOutboundBuffer(opts?: OutboundBufferOptions): OutboundBuffer {
  const capacity = Math.max(1, opts?.maxBufferedItems ?? DEFAULT_MAX_BUFFERED_ITEMS);
  // Insertion-ordered buffer (seq order — events are offered in publish order).
  const buffer: StreamEvent[] = [];
  // cardId → index in `buffer` for the retained (latest) delta of that card,
  // so a superseding same-card delta coalesces in place (last-write-wins).
  const cardIndex = new Map<string, number>();
  let resync = false;

  function cardIdOf(ev: StreamEvent): string | undefined {
    return ev.name === READ_MODEL_CHANGE
      ? (ev.payload as { cardId: string }).cardId
      : undefined;
  }

  /** Rebuild `cardIndex` after a structural buffer change (splice/clear). */
  function reindexCards(): void {
    cardIndex.clear();
    for (let i = 0; i < buffer.length; i++) {
      const cid = cardIdOf(buffer[i]!);
      if (cid !== undefined) cardIndex.set(cid, i);
    }
  }

  function offer(ev: StreamEvent): OfferOutcome {
    // Already in resync: the client will snapshot; keep bounded, accumulate nothing.
    if (resync) return { kind: "resync" };

    // 1. COALESCE — a newer delta for a card already buffered replaces the old
    //    one in place (last-write-wins). No net growth; UI still converges.
    const cid = cardIdOf(ev);
    if (cid !== undefined) {
      const at = cardIndex.get(cid);
      if (at !== undefined) {
        buffer[at] = ev; // supersede the retained delta for this card
        return { kind: "coalesced" };
      }
    }

    // 2. Room available ⇒ buffer it.
    if (buffer.length < capacity) {
      buffer.push(ev);
      if (cid !== undefined) cardIndex.set(cid, buffer.length - 1);
      return { kind: "buffered" };
    }

    // 3. FULL and this event is not coalescible onto an existing card. Try to
    //    reclaim room by coalescing any DUPLICATE-card deltas already buffered
    //    (defensive — normally coalesced on entry, but reindex proves headroom).
    reindexCards();
    if (buffer.length < capacity) {
      buffer.push(ev);
      if (cid !== undefined) cardIndex.set(cid, buffer.length - 1);
      return { kind: "buffered" };
    }

    // 4. Overflow coalescing cannot absorb ⇒ resync-from-snapshot. Stop holding
    //    stale partials (a truncated slice would look like the full stream and
    //    silently drop committed changes); the client resyncs from a snapshot.
    resync = true;
    buffer.length = 0;
    cardIndex.clear();
    return { kind: "resync" };
  }

  function drain(): readonly StreamEvent[] {
    const out = buffer.slice();
    buffer.length = 0;
    cardIndex.clear();
    return out;
  }

  return {
    offer,
    drain,
    size: () => buffer.length,
    capacity: () => capacity,
    needsResync: () => resync,
  };
}
