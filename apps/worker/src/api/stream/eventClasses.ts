// Task 8.5 (a) — the event SOURCE for the §10 push stream.
//
// `createStreamPublisher` builds the in-process publisher the worker feeds
// workflow/approval/health/read-model changes into. Each publish:
//   1. PROJECTS the domain record to its UI-safe shape via the 8.2 projectors
//      (`../projections/uiSafe`) — so a `StreamEvent` can ONLY ever carry a
//      UI-safe payload (WS-8 / §10 leakage gate): no secret, Keychain ref, raw
//      Employer-Work content, prompt, or `AgentResult.logs` crosses;
//   2. assigns a MONOTONIC per-stream `seq` (Phase-0 API-spike cursor) and an
//      `eventId = String(seq)` (the tRPC `tracked()` resume id);
//   3. wraps the projected payload in the frozen `StreamEvent` discriminated
//      union, RE-VALIDATES it against the frozen `.strict()` `streamEventSchema`
//      at the PUBLISH boundary (defense-in-depth — a projector regression that
//      produced a non-UI-safe / malformed payload FAILS CLOSED: the event is
//      dropped, never emitted, never logged, `undefined` returned), and appends
//      it to a BOUNDED server-side replay log (keyed by eventId) so a resume from
//      `lastEventId` is lossless within the window.
//
// APPROVAL EXACTLY-ONCE. `publishApproval` dedupes by the approval TRANSITION
// identity (`${id}:${status}`): a replayed/resumed 8.4 workflow that re-drives
// the SAME transition produces NO duplicate approval event (returns `undefined`).
// A genuine NEXT transition (a new status) IS a new event. This keeps the stream
// exactly-once consistent with the 8.4 approval transition, per safety posture:
// consumers stay idempotent by event id (at-least-once seam), and the source
// never manufactures a duplicate for an idempotent re-drive.
//
// BACKPRESSURE / RESUME HORIZON. The replay log is bounded by `replayWindow`
// (the resume horizon, per the spike's backpressure guard). A resume whose
// `lastEventId` has aged out of the window is OVER-HORIZON: `resumeOrResync`
// returns a `resync` signal rather than a partial (silently-dropping) log.
//
// §16: no throw across the boundary — publish returns the event (or `undefined`
// for a deduped approval OR a payload rejected by the PUBLISH gate). PURE-ish:
// EventEmitter for fan-out, no I/O.
import { EventEmitter } from "node:events";
import type {
  Approval,
  HealthItem,
  WorkflowRunRef,
  StreamEvent,
  UiSafeApproval,
  UiSafeHealthItem,
  UiSafeWorkflowRunRef,
  UiSafeDashboardCard,
} from "@sow/contracts";
import { streamEventSchema } from "@sow/contracts";
import {
  toUiSafeApproval,
  toUiSafeHealthItem,
  toUiSafeWorkflowRunRef,
  toUiSafeDashboardCard,
  type DashboardCardSource,
} from "../projections/uiSafe";

/** The default bounded replay window (resume horizon). Chosen generous for a
 *  local single-renderer stream; the integrator may tune it via options. */
export const DEFAULT_REPLAY_WINDOW = 512;

/** The internal event name the EventEmitter fans out on (implementation detail). */
const EMIT = "stream-event";

/**
 * TEST-ONLY seam: override the UI-safe projectors so a test can inject a
 * projector REGRESSION (a leaked / malformed payload) and prove the publish-
 * boundary schema gate FAILS CLOSED. Production wiring never sets this — the real
 * projectors are the default. Each override, when present, replaces the matching
 * default projector for that event class.
 */
export interface UnsafeProjectorOverrides {
  readonly workflowRunRef?: (ref: WorkflowRunRef) => UiSafeWorkflowRunRef;
  readonly approval?: (approval: Approval) => UiSafeApproval;
  readonly healthItem?: (item: HealthItem) => UiSafeHealthItem;
  readonly dashboardCard?: (card: DashboardCardSource) => UiSafeDashboardCard;
}

/** Options for {@link createStreamPublisher}. */
export interface StreamPublisherOptions {
  /** Bounded replay-log size (the resume horizon). Defaults to {@link DEFAULT_REPLAY_WINDOW}. */
  readonly replayWindow?: number;
  /**
   * TEST-ONLY projector overrides — see {@link UnsafeProjectorOverrides}. Present
   * so a test can force a malformed/leaked payload through the projection step and
   * assert the frozen-schema PUBLISH gate drops it. Never set in production.
   */
  readonly unsafeProjectorOverrides?: UnsafeProjectorOverrides;
}

/**
 * The outcome of a resume attempt against the bounded log:
 *   - `replay`: `lastEventId` is inside the window ⇒ the exact missed events;
 *   - `resync`: `lastEventId` is over-horizon (aged out) ⇒ the consumer must
 *     resync from a snapshot (NEVER a silent partial-log drop).
 */
export type ResumeOutcome =
  | { readonly kind: "replay"; readonly events: readonly StreamEvent[] }
  | { readonly kind: "resync" };

/**
 * The in-process publisher handle the worker feeds changes into (the wiring
 * seam the integrator connects workflow/approval/health/read-model sources to).
 */
export interface StreamPublisher {
  /**
   * Publish a workflow-run status change (correlation = `workflowId`). Returns
   * the emitted event, or `undefined` when the projected payload FAILS the frozen
   * `streamEventSchema` PUBLISH gate (a projector regression — dropped, never
   * emitted; defense-in-depth so a non-UI-safe/malformed payload cannot ride out).
   */
  publishWorkflowStatus(ref: WorkflowRunRef): StreamEvent | undefined;
  /**
   * Publish an approval transition. Returns the emitted event, or `undefined`
   * when this exact transition (`id:status`) was already emitted (dedupe —
   * exactly-once by transition identity; no duplicate on a resumed workflow) OR
   * when the projected payload fails the frozen `streamEventSchema` PUBLISH gate.
   */
  publishApproval(approval: Approval): StreamEvent | undefined;
  /** Publish a System-Health item change (`undefined` when the PUBLISH gate rejects). */
  publishHealth(item: HealthItem): StreamEvent | undefined;
  /** Publish a read-model dashboard-card change (`undefined` when the PUBLISH gate rejects). */
  publishReadModelChange(card: DashboardCardSource): StreamEvent | undefined;

  /** The current monotonic seq that WILL be assigned to the next event. */
  nextSeq(): number;

  /**
   * The bounded replay window (= the resume HORIZON, per the Phase-0 API spike).
   * A `lastEventId` older than this many events behind the head is over-horizon
   * (`resumeOrResync` ⇒ `resync`). Exposed so the 8.6 resume/backpressure policy
   * shares this one coherent horizon rather than an independent ad-hoc constant.
   */
  replayWindow(): number;

  /**
   * The exact events AFTER `lastEventId` currently retained in the bounded log.
   * `undefined` ⇒ the whole retained log (a fresh subscribe). Lossless within
   * the window: contiguous seqs, no gap, no duplicate.
   */
  replayFrom(lastEventId: string | undefined): readonly StreamEvent[];

  /**
   * Resume against the bounded window with over-horizon detection: `replay`
   * (in-window) hands back the missed events; `resync` (aged out) signals a
   * snapshot resync instead of a silently-truncated log.
   */
  resumeOrResync(lastEventId: string | undefined): ResumeOutcome;

  /** Subscribe to LIVE events emitted after this call (fan-out via EventEmitter). */
  onEvent(listener: (ev: StreamEvent) => void): () => void;
}

export function createStreamPublisher(opts?: StreamPublisherOptions): StreamPublisher {
  const replayWindow = Math.max(1, opts?.replayWindow ?? DEFAULT_REPLAY_WINDOW);
  const emitter = new EventEmitter();
  // The bounded replay log — retains at most `replayWindow` most-recent events.
  const log: StreamEvent[] = [];
  // The transition-identity dedupe set for approval events (exactly-once).
  const seenApprovalTransitions = new Set<string>();
  let seq = 0;

  /** Append to the bounded log, evicting the oldest over the window. */
  function record(ev: StreamEvent): void {
    log.push(ev);
    if (log.length > replayWindow) {
      log.splice(0, log.length - replayWindow);
    }
    emitter.emit(EMIT, ev);
  }

  // The active projectors — the real 8.2 projectors by default; a test may
  // override any via `unsafeProjectorOverrides` to inject a projector regression
  // and prove the PUBLISH gate fails closed. Never overridden in production.
  const projectWorkflowRunRef =
    opts?.unsafeProjectorOverrides?.workflowRunRef ?? toUiSafeWorkflowRunRef;
  const projectApproval = opts?.unsafeProjectorOverrides?.approval ?? toUiSafeApproval;
  const projectHealthItem = opts?.unsafeProjectorOverrides?.healthItem ?? toUiSafeHealthItem;
  const projectDashboardCard =
    opts?.unsafeProjectorOverrides?.dashboardCard ?? toUiSafeDashboardCard;

  /**
   * Build + validate + record an event of the given class. DEFENSE-IN-DEPTH: the
   * built event is re-validated against the frozen `.strict()` `streamEventSchema`
   * at the PUBLISH boundary. A pass ⇒ assign the seq, record, emit, return it. A
   * FAIL (a projector regression that produced a non-UI-safe / malformed payload)
   * ⇒ DROP: no seq consumed, no record, no emit, return `undefined` — the bad
   * event never reaches a subscriber or the replay log (fail-closed, never throws).
   */
  function make(build: (seq: number, eventId: string) => StreamEvent): StreamEvent | undefined {
    // Build against the seq this event WOULD take, but do not advance `seq` until
    // the gate passes — so a dropped event leaves no gap in the emitted cursor.
    const candidate = build(seq, String(seq));
    if (!streamEventSchema.safeParse(candidate).success) {
      return undefined; // fail-closed: malformed/non-UI-safe payload — dropped.
    }
    seq += 1;
    record(candidate);
    return candidate;
  }

  function publishWorkflowStatus(ref: WorkflowRunRef): StreamEvent | undefined {
    const payload = projectWorkflowRunRef(ref);
    return make((s, eventId) => ({
      name: "workflow.status",
      seq: s,
      eventId,
      payload,
    }));
  }

  function publishApproval(approval: Approval): StreamEvent | undefined {
    // Exactly-once by transition identity: id + the status it transitioned TO.
    const identity = `${approval.id}:${approval.status}`;
    if (seenApprovalTransitions.has(identity)) {
      return undefined; // a re-driven (resumed-workflow) transition — no dup event.
    }
    const payload = projectApproval(approval);
    const ev = make((s, eventId) => ({
      name: "approval.update",
      seq: s,
      eventId,
      payload,
    }));
    // Only mark the transition consumed once it actually published — a payload
    // dropped by the gate must not poison the dedupe set (a corrected re-drive
    // of the SAME transition should still be able to publish).
    if (ev !== undefined) seenApprovalTransitions.add(identity);
    return ev;
  }

  function publishHealth(item: HealthItem): StreamEvent | undefined {
    const payload = projectHealthItem(item);
    return make((s, eventId) => ({
      name: "system.health",
      seq: s,
      eventId,
      payload,
    }));
  }

  function publishReadModelChange(card: DashboardCardSource): StreamEvent | undefined {
    const payload = projectDashboardCard(card);
    return make((s, eventId) => ({
      name: "read_model.change",
      seq: s,
      eventId,
      payload,
    }));
  }

  function replayFrom(lastEventId: string | undefined): readonly StreamEvent[] {
    if (lastEventId === undefined) return [...log];
    const idx = log.findIndex((e) => e.eventId === lastEventId);
    if (idx === -1) {
      // Not in the retained window. If the id is BEHIND the window (already
      // consumed & evicted) we cannot enumerate the exact missed set from the
      // log — callers wanting over-horizon detection use `resumeOrResync`. For
      // the plain accessor we return the whole retained log (never a partial gap
      // relative to an in-window anchor); over-horizon safety lives in
      // `resumeOrResync`.
      return [...log];
    }
    return log.slice(idx + 1);
  }

  function resumeOrResync(lastEventId: string | undefined): ResumeOutcome {
    if (lastEventId === undefined) {
      return { kind: "replay", events: [...log] };
    }
    const idx = log.findIndex((e) => e.eventId === lastEventId);
    if (idx !== -1) {
      return { kind: "replay", events: log.slice(idx + 1) };
    }
    // Not in the window. Distinguish "over-horizon (aged out)" from "ahead of
    // the head" (a bogus/future id): a numeric id strictly below the current
    // window's oldest retained seq is over-horizon ⇒ resync. Anything else
    // (empty log, non-numeric, or ahead) also fails closed to resync — we
    // cannot prove a lossless replay, so we never silently drop.
    return { kind: "resync" };
  }

  function onEvent(listener: (ev: StreamEvent) => void): () => void {
    emitter.on(EMIT, listener);
    return () => emitter.off(EMIT, listener);
  }

  return {
    publishWorkflowStatus,
    publishApproval,
    publishHealth,
    publishReadModelChange,
    nextSeq: () => seq,
    replayWindow: () => replayWindow,
    replayFrom,
    resumeOrResync,
    onEvent,
  };
}

export type { DashboardCardSource };
