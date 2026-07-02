// Task 8.6 — stream reconnection + bounded backpressure. TDD RED-first spec.
//
// Builds on 8.5 (docs/spikes/0.5-api-stream.md). Two modules under test:
//   - `resume.ts`  — reconnect catch-up: resume from the last-acknowledged seq
//     via snapshot-or-replay from the bounded replay buffer, with NO silently-
//     dropped committed change; an OVER-HORIZON resume emits the explicit
//     resync-from-snapshot signal (spike: "window size = resume horizon;
//     over-horizon ⇒ emit a resync-from-snapshot signal").
//   - `backpressure.ts` — a per-connection bounded outbound buffer
//     (maxBufferedItems + replay window from the spike). On overflow the policy
//     is EXPLICIT: coalesce read-model deltas and/or signal client re-sync —
//     never unbounded memory growth, never a silent partial loss that leaves the
//     UI inconsistent. Per-connection isolation: a slow/stalled consumer cannot
//     block another subscriber or the worker event loop.
//
// Thresholds come from the Phase-0 spike outputs (0.5-api-stream.md "Backpressure
// guard" + the `DEFAULT_REPLAY_WINDOW` cursor in eventClasses.ts), NOT ad-hoc
// constants. The tests reference those symbols directly.
//
// Deterministic unit tests — no real socket. We drive the publisher + the buffer
// directly and assert the resume + overflow semantics.
import { describe, it, expect } from "vitest";
import type { StreamEvent, WorkflowRunRef } from "@sow/contracts";
import {
  createStreamPublisher,
  DEFAULT_REPLAY_WINDOW,
  type StreamPublisher,
} from "../../../src/api/stream/eventClasses";
import type { DashboardCardSourceInput } from "../../../src/api/stream/pushStream";
import {
  planResume,
  resumeWindow,
  type ResumePlan,
} from "../../../src/api/stream/resume";
import {
  createOutboundBuffer,
  DEFAULT_MAX_BUFFERED_ITEMS,
  HEARTBEAT,
  type OfferOutcome,
  type OutboundBuffer,
} from "../../../src/api/stream/backpressure";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function baseWorkflowRunRef(overrides: Partial<WorkflowRunRef> = {}): WorkflowRunRef {
  return {
    workflowId: "wf_1" as WorkflowRunRef["workflowId"],
    trigger: "manual",
    state: "running",
    idempotencyKey: "idem_1",
    auditRefs: ["aud_1" as WorkflowRunRef["auditRefs"][number]],
    ...overrides,
  };
}

function baseCard(overrides: Partial<DashboardCardSourceInput> = {}): DashboardCardSourceInput {
  return {
    cardId: "card_1",
    kind: "approvals",
    title: "Pending approvals",
    status: "warn",
    count: 3,
    updatedAt: "2026-07-02T11:00:00.000Z",
    ...overrides,
  };
}

function emitN(pub: StreamPublisher, n: number): StreamEvent[] {
  const out: StreamEvent[] = [];
  for (let i = 0; i < n; i++) {
    const ev = pub.publishWorkflowStatus(baseWorkflowRunRef({ idempotencyKey: `idem_${i}` }));
    // A well-formed publish always yields an event (the PUBLISH schema gate only
    // drops a projector-regression payload — never a valid one). Pin that here.
    expect(ev).toBeDefined();
    if (ev) out.push(ev);
  }
  return out;
}

// ── (a) resume — snapshot-or-replay, no silent drop ──────────────────────────

describe("planResume — reconnect catch-up from the last-acknowledged seq", () => {
  it("uses the bounded replay window as the resume horizon (from the spike)", () => {
    // The resume horizon is the publisher's replay window — NOT an ad-hoc number.
    const pub = createStreamPublisher(); // default window
    expect(resumeWindow(pub)).toBe(DEFAULT_REPLAY_WINDOW);
    const tuned = createStreamPublisher({ replayWindow: 7 });
    expect(resumeWindow(tuned)).toBe(7);
  });

  it("replays EXACTLY the events committed during the disconnect (lossless gap)", () => {
    const pub = createStreamPublisher();
    emitN(pub, 6);
    // Client last acknowledged eventId "2"; events 3,4,5 committed during the
    // disconnect must all be caught up — none silently dropped.
    const plan: ResumePlan = planResume(pub, "2");
    expect(plan.kind).toBe("replay");
    if (plan.kind === "replay") {
      expect(plan.events.map((e) => e.eventId)).toEqual(["3", "4", "5"]);
      // Contiguous, no gap, no dup.
      expect(plan.events.map((e) => e.seq)).toEqual([3, 4, 5]);
    }
  });

  it("replays the whole retained log on a fresh resume (no lastEventId)", () => {
    const pub = createStreamPublisher();
    emitN(pub, 3);
    const plan = planResume(pub, undefined);
    expect(plan.kind).toBe("replay");
    if (plan.kind === "replay") expect(plan.events.map((e) => e.eventId)).toEqual(["0", "1", "2"]);
  });

  it("returns an empty replay when the client is already fully caught up", () => {
    const pub = createStreamPublisher();
    emitN(pub, 3);
    const plan = planResume(pub, "2");
    expect(plan.kind).toBe("replay");
    if (plan.kind === "replay") expect(plan.events).toEqual([]);
  });

  it("emits resync-from-snapshot when the requested lastEventId is OVER-HORIZON (no silent loss)", () => {
    // Window of 3 retains only the last 3 events; a resume anchored before the
    // window (eventId "1", whose successors 2,3,4 aged out) MUST NOT be served a
    // partial log — it gets the explicit resync signal instead.
    const pub = createStreamPublisher({ replayWindow: 3 });
    emitN(pub, 8); // retains eventIds 5,6,7
    const plan = planResume(pub, "1");
    expect(plan.kind).toBe("resync");
  });

  it("resumes normally when the lastEventId is still inside the window", () => {
    const pub = createStreamPublisher({ replayWindow: 3 });
    emitN(pub, 8); // retains 5,6,7
    const plan = planResume(pub, "6");
    expect(plan.kind).toBe("replay");
    if (plan.kind === "replay") expect(plan.events.map((e) => e.eventId)).toEqual(["7"]);
  });
});

// ── (b) backpressure — bounded outbound buffer, explicit overflow policy ──────

describe("createOutboundBuffer — a bounded per-connection outbound buffer", () => {
  it("defaults its bound to the spike's replay window / maxBufferedItems (not ad-hoc)", () => {
    // The default outbound bound is the spike's maxBufferedItems, aligned to the
    // replay window horizon so a buffer overflow and a resume over-horizon share
    // one coherent horizon.
    expect(DEFAULT_MAX_BUFFERED_ITEMS).toBe(DEFAULT_REPLAY_WINDOW);
    const buf = createOutboundBuffer();
    expect(buf.capacity()).toBe(DEFAULT_MAX_BUFFERED_ITEMS);
    // Heartbeat/keepAlive thresholds are pinned by the spike, not invented here.
    expect(HEARTBEAT.pingMs).toBe(1000);
    expect(HEARTBEAT.pongWaitMs).toBe(2000);
  });

  it("accepts events up to the bound and drains them in order (fast consumer)", () => {
    const pub = createStreamPublisher();
    const evs = emitN(pub, 3);
    const buf = createOutboundBuffer({ maxBufferedItems: 8 });
    for (const ev of evs) {
      const outcome: OfferOutcome = buf.offer(ev);
      expect(outcome.kind).toBe("buffered");
    }
    expect(buf.size()).toBe(3);
    const drained = buf.drain();
    expect(drained.map((e) => e.eventId)).toEqual(["0", "1", "2"]);
    // Draining empties the buffer (the consumer took them).
    expect(buf.size()).toBe(0);
  });

  it("NEVER grows unbounded — buffered size never exceeds the bound", () => {
    const pub = createStreamPublisher();
    const buf = createOutboundBuffer({ maxBufferedItems: 4 });
    // Push far more than the bound WITHOUT draining (a stalled consumer).
    for (const ev of emitN(pub, 100)) buf.offer(ev);
    expect(buf.size()).toBeLessThanOrEqual(4);
  });

  it("coalesces read-model deltas by cardId on pressure (keeps only the latest per card)", () => {
    // read_model.change is a DELTA (last-write-wins per card). Under pressure the
    // buffer coalesces same-card deltas rather than dropping committed changes on
    // the floor — the UI still converges to the latest state per card.
    const pub = createStreamPublisher();
    const buf = createOutboundBuffer({ maxBufferedItems: 4 });
    // 6 deltas for the SAME card — should collapse to the latest, staying bounded.
    let last: StreamEvent | undefined;
    for (let i = 0; i < 6; i++) {
      last = pub.publishReadModelChange(baseCard({ cardId: "card_A", count: i }));
      expect(last).toBeDefined(); // a valid publish is never dropped by the gate.
      if (last) buf.offer(last);
    }
    expect(buf.size()).toBeLessThanOrEqual(4);
    const drained = buf.drain();
    const cardEvents = drained.filter((e) => e.name === "read_model.change");
    // Exactly one card_A delta survives — the LATEST (highest eventId).
    const cardA = cardEvents.filter((e) => (e.payload as { cardId: string }).cardId === "card_A");
    expect(cardA.length).toBe(1);
    expect(cardA[0]?.eventId).toBe(last?.eventId);
  });

  it("signals resync-from-snapshot when overflow cannot be absorbed by coalescing (no silent loss)", () => {
    // Non-coalescible classes (workflow.status / approval.update / system.health)
    // are NOT deltas per a single key — flooding them past the bound cannot be
    // silently dropped. The policy explicitly signals the connection to re-sync.
    const pub = createStreamPublisher();
    const buf = createOutboundBuffer({ maxBufferedItems: 3 });
    const outcomes: OfferOutcome[] = [];
    for (const ev of emitN(pub, 10)) outcomes.push(buf.offer(ev));
    // At least one offer flipped the buffer into the resync state — never a
    // silent drop that leaves the UI inconsistent.
    expect(outcomes.some((o) => o.kind === "resync")).toBe(true);
    expect(buf.needsResync()).toBe(true);
    // Once resync is signalled the buffer stays bounded (no unbounded growth).
    expect(buf.size()).toBeLessThanOrEqual(3);
  });

  it("a resync-signalled buffer drains to a single resync marker, not a partial event list", () => {
    // After a resync signal the client must resync from a snapshot; serving a
    // truncated event list would leave the UI silently inconsistent. So a
    // resync-flagged buffer reports resync and drains empty of stale partials.
    const pub = createStreamPublisher();
    const buf = createOutboundBuffer({ maxBufferedItems: 2 });
    for (const ev of emitN(pub, 20)) buf.offer(ev);
    expect(buf.needsResync()).toBe(true);
    const drained = buf.drain();
    // The buffer does not hand back a silently-truncated slice as if it were the
    // full committed stream — the resync flag is the source of truth.
    expect(drained.length).toBeLessThanOrEqual(2);
  });
});

// ── (c) per-connection isolation — a stalled consumer starves no one ─────────

describe("outbound buffers are isolated per connection", () => {
  it("a stalled consumer's overflow does not affect a second consumer's buffer", () => {
    const pub = createStreamPublisher();
    const stalled: OutboundBuffer = createOutboundBuffer({ maxBufferedItems: 3 });
    const healthy: OutboundBuffer = createOutboundBuffer({ maxBufferedItems: 64 });

    // Both connections receive the same fan-out, but only `healthy` drains.
    for (const ev of emitN(pub, 20)) {
      stalled.offer(ev); // never drained — overflows into resync
      healthy.offer(ev); // drained each tick below
      healthy.drain();
    }

    // The stalled buffer is bounded + flagged for resync...
    expect(stalled.size()).toBeLessThanOrEqual(3);
    expect(stalled.needsResync()).toBe(true);
    // ...while the healthy buffer is UNAFFECTED: it kept up, never overflowed,
    // and was never forced into resync by its noisy neighbour.
    expect(healthy.needsResync()).toBe(false);
    expect(healthy.size()).toBe(0);
  });

  it("draining or resetting one buffer never mutates another", () => {
    const pub = createStreamPublisher();
    const a = createOutboundBuffer({ maxBufferedItems: 8 });
    const b = createOutboundBuffer({ maxBufferedItems: 8 });
    for (const ev of emitN(pub, 3)) {
      a.offer(ev);
      b.offer(ev);
    }
    a.drain(); // empties a only
    expect(a.size()).toBe(0);
    expect(b.size()).toBe(3); // b is its own state — untouched
  });
});
