// Task 8.5 (c) — the single authenticated push-stream subscription procedure.
//
// `createPushStream(deps)` is the seam the integrator mounts over
// `applyWSSHandler` (the Phase-0 API-spike primitive: tRPC v11 subscription over
// WebSocket). It returns:
//   - `publisher`: the in-process {@link StreamPublisher} handle the worker feeds
//     workflow/approval/health/read-model changes into (the wiring seam);
//   - `router`: a tRPC router with a single `onEvent` subscription procedure that
//     yields `tracked(eventId, uiSafePayload)` — auth-gated, resumable, UI-safe;
//   - `subscribe`: the transport-agnostic async generator the subscription runs
//     (exposed so it is unit-testable WITHOUT a real socket).
//
// AUTH BEFORE EVENTS. The handshake (8.5b) runs the SAME 8.1 interceptor in the
// tRPC `createContext`, storing a typed `Result<AuthedContext, FailureVariant>`
// on `ctx.auth`. The subscription checks that outcome FIRST: on `err` it yields
// NOTHING and completes — no event ever flows to an unauthenticated / off-origin
// consumer (UNAUTHORIZED / FORBIDDEN pre-subscription).
//
// LOSSLESS RESUME — FAIL CLOSED. `input.lastEventId` drives a bounded server-side
// resume through `planResume` (the 8.6 seam): an IN-WINDOW cursor replays the
// exact missed events, contiguous, no gap, no dup; an OVER-HORIZON (aged-out)
// cursor yields ONE distinguished resync-from-snapshot control frame BEFORE any
// live tail — never a silently-gapped partial replay that could drop a committed
// change from the UI. Each event value is `tracked(eventId, uiSafePayload)` so
// the client resumes from the last-seen id; the resync frame is `tracked` under a
// distinguished non-numeric id carrying only a typed `{ __control: "resync" }`
// marker (no raw/secret data). Consumers stay idempotent by event id (at-least-
// once seam); an approval.update carries a stable eventId and the source deduped
// the transition, so a replayed/resumed workflow produces NO duplicate approval.
//
// §16: no throw across the boundary — a bad input is a validation err surfaced
// via the base `errorFormatter`; the generator never throws raw.
import { tracked, type AnyRouter } from "@trpc/server";
import type { StreamEvent } from "@sow/contracts";
import { isErr, type Result, type FailureVariant } from "@sow/contracts";
import { router, publicProcedure, type ApiContext } from "../trpc";
import type { AuthInterceptor } from "../auth/interceptor";
import type { AuthedContext } from "../auth/sessionAuth";
import {
  createStreamPublisher,
  type StreamPublisher,
  type StreamPublisherOptions,
} from "./eventClasses";
import { planResume } from "./resume";
import type { DashboardCardSource } from "../projections/uiSafe";

/** The read-model dashboard-card source the publisher accepts (re-export). */
export type DashboardCardSourceInput = DashboardCardSource;

/** Dependencies for {@link createPushStream}. */
export interface PushStreamDeps {
  /** The composed 8.1 auth interceptor (worker VERIFIES; never mints). */
  readonly interceptor: AuthInterceptor;
  /** An existing publisher to reuse; else one is created from `publisherOptions`. */
  readonly publisher?: StreamPublisher;
  /** Options for the created publisher (bounded replay window) when none supplied. */
  readonly publisherOptions?: StreamPublisherOptions;
}

/** The subscription input: an optional resume cursor (the last-seen event id). */
export interface PushStreamInput {
  readonly lastEventId?: string;
}

/** Options controlling how {@link PushStream.subscribe} tails live events. */
export interface SubscribeOptions extends PushStreamInput {
  /**
   * When provided, the generator TAILS live events after the replay until this
   * signal aborts (the production WS path). When absent, it completes after the
   * replay drains — the deterministic, socket-free unit-test path.
   */
  readonly signal?: AbortSignal;
}

/**
 * The typed marker a RESYNC-from-snapshot control frame carries as its `data`
 * (FINDING 1). Deliberately minimal + distinctive: a single `__control: "resync"`
 * literal — carries NO raw content, no secret, no event payload. Unambiguous vs a
 * normal UI-safe payload (which never has a `__control` key AND whose frame never
 * sets `TrackedItem.control`).
 */
export interface ResyncControl {
  readonly __control: "resync";
}

/**
 * The distinguished resume id the resync control frame is tracked under. Not a
 * numeric event seq (real eventIds are `String(seq)`), so a client can never
 * mistake it for a resumable event id.
 */
export const RESYNC_CONTROL_ID = "__resync__" as const;

/** The single, canonical resync control frame yielded on an over-horizon resume. */
export const RESYNC_CONTROL_FRAME: TrackedItem = {
  id: RESYNC_CONTROL_ID,
  data: { __control: "resync" },
  control: "resync",
};

/**
 * One yielded item from {@link PushStream.subscribe}: either a normal event
 * `{ id, data }` (UI-safe payload) OR the distinguished resync control frame
 * (`control === "resync"`, `data` = the typed {@link ResyncControl} marker).
 */
export interface TrackedItem {
  /** The tRPC `tracked()` resume id (= the event's `eventId`), or {@link RESYNC_CONTROL_ID}. */
  readonly id: string;
  /** The UI-safe payload (never a secret / raw content — WS-8), or the resync marker. */
  readonly data: StreamEvent["payload"] | ResyncControl;
  /**
   * Present + `"resync"` ONLY on the resync control frame — the unambiguous
   * discriminator a client uses to tell a control signal apart from a real event.
   * Absent on every normal event frame.
   */
  readonly control?: "resync";
}

/**
 * Type guard: is this yielded item the RESYNC-from-snapshot control frame? A
 * client (and the tests) uses this to branch: on `true`, refetch a snapshot
 * rather than treating the item as a resumable committed event.
 */
export function isResyncControl(item: TrackedItem): boolean {
  return item.control === "resync";
}

/** The assembled push stream the integrator mounts. */
export interface PushStream {
  /** The publisher handle the worker feeds changes into. */
  readonly publisher: StreamPublisher;
  /**
   * A tRPC router carrying the single `onEvent` subscription procedure. Typed as
   * `AnyRouter` at this seam (the concrete procedure map isn't nameable across a
   * `declaration: true` build — TS2742); the integrator mounts this runtime
   * router value alongside the query/command routers at the composition root and
   * derives the renderer's typed `AppRouter` from `typeof` the composed router
   * there, exactly as `server.ts` does with `typeof appRouter`.
   */
  readonly router: AnyRouter;
  /**
   * The transport-agnostic subscription generator. Given the handshake's auth
   * outcome + a resume cursor, yields `{ id, data }` for each event (replay,
   * then — if a `signal` is supplied — live tail until aborted). On a failed
   * auth outcome it yields NOTHING and completes.
   */
  subscribe(
    auth: Result<AuthedContext, FailureVariant>,
    opts: SubscribeOptions,
  ): AsyncGenerator<TrackedItem, void, unknown>;
}

/**
 * Build the core subscription generator over a publisher. Auth-gated: a rejected
 * auth outcome yields nothing. Replays the missed events from `lastEventId`, then
 * (only when a `signal` is supplied) tails live events until abort.
 */
async function* runSubscription(
  publisher: StreamPublisher,
  auth: Result<AuthedContext, FailureVariant>,
  opts: SubscribeOptions,
): AsyncGenerator<TrackedItem, void, unknown> {
  // 1. AUTH GATE FIRST — no event flows to an unauthenticated consumer.
  if (isErr(auth)) return;

  // Dedupe by event id across the replay→tail boundary: a live event that also
  // landed in the replay window must not be re-yielded (at-least-once seam).
  const yielded = new Set<string>();

  // 2. FAIL-CLOSED resume via `planResume` (FINDING 1). Routing the on-wire
  //    resume through the same over-horizon logic as the 8.6 reconnect seam means
  //    an aged-out `lastEventId` gets the EXPLICIT resync-from-snapshot control
  //    frame — NOT a silently-gapped partial replay that could drop a committed
  //    change from the UI.
  const plan = planResume(publisher, opts.lastEventId);
  if (plan.kind === "resync") {
    // One distinguished resync control frame BEFORE any live tail: the client
    // refetches a snapshot rather than assuming a complete gap catch-up. It then
    // re-establishes from the current head via the live tail below (if wired).
    yield RESYNC_CONTROL_FRAME;
  } else {
    // In-window: lossless replay of exactly the missed events (unchanged path).
    for (const ev of plan.events) {
      yielded.add(ev.eventId);
      yield { id: ev.eventId, data: ev.payload };
    }
  }

  // 3. Live tail — only when the caller wired an abort signal (the WS path). The
  //    socket-free unit path passes no signal and completes after the replay.
  const signal = opts.signal;
  if (signal === undefined) return;
  if (signal.aborted) return;

  // Bridge the EventEmitter into the generator via a bounded async queue.
  const queue: StreamEvent[] = [];
  let notify: (() => void) | undefined;
  const off = publisher.onEvent((ev) => {
    queue.push(ev);
    notify?.();
  });
  const onAbort = (): void => notify?.();
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    while (!signal.aborted) {
      if (queue.length === 0) {
        await new Promise<void>((resolve) => {
          notify = resolve;
        });
        notify = undefined;
        continue;
      }
      const ev = queue.shift();
      if (ev === undefined) continue;
      if (yielded.has(ev.eventId)) continue; // already replayed — idempotent.
      yielded.add(ev.eventId);
      yield { id: ev.eventId, data: ev.payload };
    }
  } finally {
    off();
    signal.removeEventListener("abort", onAbort);
  }
}

/** Plain-function input validator (no zod at the transport edge; §16-safe). */
function parsePushStreamInput(raw: unknown): PushStreamInput {
  if (typeof raw !== "object" || raw === null) return {};
  const r = raw as Record<string, unknown>;
  const lastEventId = typeof r["lastEventId"] === "string" ? r["lastEventId"] : undefined;
  return lastEventId === undefined ? {} : { lastEventId };
}

/** Build the tRPC router carrying the single `onEvent` subscription procedure.
 *  Return type is widened to `AnyRouter` for a portable `.d.ts` (TS2742) — the
 *  runtime value keeps the full concrete procedure map for the integrator's mount. */
function buildRouter(publisher: StreamPublisher): AnyRouter {
  return router({
    // The §10 push stream. Runs behind the handshake (auth on `ctx.auth`), yields
    // `tracked(eventId, uiSafePayload)`, resumable from `input.lastEventId`.
    onEvent: publicProcedure.input(parsePushStreamInput).subscription(async function* (opts: {
      ctx: ApiContext;
      input: PushStreamInput;
      signal: AbortSignal | undefined;
    }) {
      const gen = runSubscription(publisher, opts.ctx.auth, {
        lastEventId: opts.input.lastEventId,
        signal: opts.signal,
      });
      for await (const item of gen) {
        // The tRPC `tracked()` envelope — the client resumes from `id`.
        yield tracked(item.id, item.data);
      }
    }),
  });
}

/**
 * Assemble the push stream. The integrator mounts `router` over `applyWSSHandler`
 * and feeds `publisher` from the worker's workflow/approval/health/read-model
 * sources. `subscribe` is the same generator the procedure runs — exposed for
 * deterministic, socket-free unit tests.
 */
export function createPushStream(deps: PushStreamDeps): PushStream {
  const publisher = deps.publisher ?? createStreamPublisher(deps.publisherOptions);
  const built = buildRouter(publisher);
  return {
    publisher,
    router: built,
    subscribe(auth, opts) {
      return runSubscription(publisher, auth, opts);
    },
  };
}
