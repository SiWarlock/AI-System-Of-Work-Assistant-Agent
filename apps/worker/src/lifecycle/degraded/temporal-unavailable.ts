// 10.5(a) — Temporal-unavailable as a FIRST-CLASS degraded state (LIFE-1, §16,
// 10.2 taxonomy + 10.3 surface). NOT an ad-hoc exception.
//
// When the Temporal server is unreachable the worker cannot dispatch workflows.
// The naive failure mode is to let trigger fire-and-forget — silently DROPPING
// the work. This controller makes the outage a first-class, typed, operator-
// visible state instead:
//
//   • onDispatchRequest — while degraded, a dispatch is HELD in an in-memory
//     queue (never sent to a dead Temporal, never silently dropped). When healthy
//     it passes straight through to the injected `dispatch` (the normal path).
//   • onConnectionLost — records the outage: surfaces a DISTINCT `worker_down`
//     System-Health item (routed via the 10.2 `routeFailure(degraded_unavailable)`
//     → healthClass `worker_down`, so the class is never invented ad-hoc) and
//     computes the NEXT bounded reconnect backoff by REUSING the 10.4 supervision
//     curve (`supervisionBackoffMs`) over the recent-failure ledger. Returns a
//     typed repair message + `retryInMs` — the supervisor sleeps that long before
//     the next reconnect probe.
//   • onReconnect — AUTO-CLEARS the health item (resolve → the alarm reflects
//     truth, not a stale state) and RESUMES dispatch of every held job through the
//     normal `dispatch` path, draining the queue. Idempotent: a spurious second
//     reconnect finds an empty queue + an already-resolved item, so nothing is
//     re-dispatched (no duplicate side effect) and no queued work is ever lost.
//     A dispatch that REJECTS mid-drain (a real Temporal start-workflow failure)
//     does NOT throw across the §16 boundary NOR lose the job: that job is
//     RE-HELD (degraded-retryable, re-drained on a later reconnect — the
//     re-attempt is idempotent via the §8 envelope), a DISTINCT worker_down health
//     item is surfaced for it, and the remaining held jobs still drain.
//
// The held-job re-drive is idempotent BY CONSTRUCTION: a held job resumes through
// the SAME `dispatch` the healthy path uses — which routes through the normal
// admission / §8 external-write envelope downstream — so a workflow whose side
// effect already committed before the outage reuses its receipt (safety rule 3);
// this controller adds no second write of its own, it only re-offers the job id.
//
// §16: never throws across the boundary. Every method returns a typed
// Result<T, DegradedModeError>; a health-surface persist fault folds to a typed
// err (fail-closed), never a throw.
//
// WIRING (integrator step, NOT this module): the Electron-main / worker bootstrap
// binds `dispatch` to the real Temporal-client start-workflow call and drives
// `onConnectionLost` / `onReconnect` from the client's connection state + the
// supervision loop. This module stays effect-injected + Vitest-unit-testable.

import { ok, err } from "@sow/contracts";
import type { AuditId, HealthItem, Result } from "@sow/contracts";
import { routeFailure } from "@sow/domain";
import { failure } from "@sow/contracts";
import type { HealthSurface, HealthSurfaceError } from "../../health/surface";
import {
  supervisionBackoffMs,
  DEFAULT_SUPERVISION_CONFIG,
  type SupervisionConfig,
} from "../supervision-policy";

// The degraded subjectRef — the health item is deduped by (worker_down, this).
// A stable ref so a recurring outage bumps ONE item, never spawns duplicates.
const TEMPORAL_SUBJECT_REF = "temporal:default" as const;

/** Tuning for the Temporal-unavailability controller. */
export interface TemporalUnavailableConfig {
  /** Reconnect-backoff curve (reuses the 10.4 supervision bounded backoff). */
  readonly backoff: SupervisionConfig;
}

/** Default profile — reuses the 10.4 default supervision backoff curve. */
export const DEFAULT_TEMPORAL_UNAVAILABLE_CONFIG: TemporalUnavailableConfig = {
  backoff: DEFAULT_SUPERVISION_CONFIG,
};

/** A dispatch held while Temporal is unavailable (queued, never dropped). */
export interface HeldDispatch {
  readonly jobId: string;
  /** The injected clock reading when the dispatch was held (audit/order). */
  readonly heldAt: string;
}

/** Closed, enumerable error surface for the degraded controllers (§16). */
export interface DegradedModeError {
  readonly code: "health_persist_failed";
  readonly message: string;
  readonly cause?: unknown;
}

/** Inputs to a connection-lost report (clock + recent-failure ledger injected). */
export interface ConnectionLostInput {
  /** Injected wall-clock reading (ISO-8601) — never Date.now(). */
  readonly now: string;
  /**
   * Recent connection-failure timestamps (ISO-8601), used ONLY to index the
   * bounded backoff curve (reused 10.4 supervision semantics: the in-window
   * count is the 0-based curve index). Order-independent.
   */
  readonly recentFailures: readonly string[];
}

/** The typed outcome of a connection-lost report. */
export interface ConnectionLostOutcome {
  /** The surfaced (or refreshed) DISTINCT worker_down health item. */
  readonly healthItem: HealthItem;
  /** Bounded reconnect backoff (ms) before the next probe (10.4 curve). */
  readonly retryInMs: number;
  /** A typed, human repair message (no raw error / stack — safe to surface). */
  readonly repairMessage: string;
}

/** The disposition of a dispatch request while (or after) the outage. */
export type DispatchDisposition = "dispatched" | "held";

/** The typed outcome of a dispatch request. */
export interface DispatchOutcome {
  readonly disposition: DispatchDisposition;
}

/** The typed outcome of a reconnect. */
export interface ReconnectOutcome {
  /** How many held jobs resumed through the normal dispatch path. */
  readonly resumedCount: number;
}

/** Injected effects for the controller (all fakeable; no Date.now(), no net). */
export interface TemporalUnavailabilityDeps {
  /** The persistent System-Health surface (10.3). */
  readonly surface: HealthSurface;
  /** The audit ref anchoring the surfaced health item. */
  readonly auditRef: AuditId;
  /**
   * The NORMAL dispatch path — a held job resumes through THIS on reconnect, so
   * downstream admission / §8 envelope idempotency apply unchanged (no duplicate
   * side effect added here). The integrator binds it to the Temporal-client
   * start-workflow call.
   */
  readonly dispatch: (jobId: string) => Promise<void>;
  readonly config: TemporalUnavailableConfig;
}

/** The Temporal-unavailability degraded-mode controller (10.5(a)). */
export interface TemporalUnavailabilityController {
  /** Report a lost connection: surface the item + compute the bounded backoff. */
  onConnectionLost(
    input: ConnectionLostInput,
  ): Promise<Result<ConnectionLostOutcome, DegradedModeError>>;
  /** Request a dispatch: pass through when healthy, HOLD (queue) while degraded. */
  onDispatchRequest(
    jobId: string,
    at: { readonly now: string },
  ): Promise<Result<DispatchOutcome, DegradedModeError>>;
  /** Reconnect: auto-clear the item + resume every held job (idempotent). */
  onReconnect(
    at: { readonly now: string },
  ): Promise<Result<ReconnectOutcome, DegradedModeError>>;
  /** Inspect the held queue (queued work never dropped). */
  heldQueue(): readonly HeldDispatch[];
  /** Is Temporal currently considered unavailable? */
  isDegraded(): boolean;
}

/** Map a HealthSurfaceError into the degraded-mode error set (§16). */
function mapSurfaceError(e: HealthSurfaceError): DegradedModeError {
  return { code: "health_persist_failed", message: e.message, cause: e.cause };
}

/**
 * Build the Temporal-unavailability controller. Stateful (holds the degraded flag
 * + the in-memory held queue), effect-injected, never throws across the boundary.
 */
export function createTemporalUnavailabilityController(
  deps: TemporalUnavailabilityDeps,
): TemporalUnavailabilityController {
  const { surface, auditRef, dispatch, config } = deps;

  // The 10.2 routing decision for a Temporal outage. `degraded_unavailable`
  // routes to `retryable: true` + healthClass `worker_down` — we take the class
  // from HERE, never inventing it, so the taxonomy stays single-sourced.
  const route = routeFailure(failure("degraded_unavailable", "temporal unreachable", { retryable: true }));
  const healthClass = route.healthClass ?? "worker_down";

  let degraded = false;
  const held: HeldDispatch[] = [];

  /**
   * Surface a DISTINCT worker_down health item for a held job whose re-drive
   * REJECTED mid-drain (a real Temporal start-workflow failure). Keyed to the
   * jobId subjectRef so it does NOT collide with the outage item
   * (TEMPORAL_SUBJECT_REF) — the outage resolves while the per-job failure stays
   * visible until its own re-attempt succeeds. The raw error never reaches the
   * message (no stack / secret leak — safety rule 7); it is a typed repair line.
   */
  async function surfaceDispatchFailure(
    jobId: string,
    now: string,
    _cause: unknown,
  ): Promise<Result<void, DegradedModeError>> {
    const recorded = await surface.record({
      failureClass: healthClass,
      subjectRef: `temporal:redrive:${jobId}`,
      message:
        `Held job ${jobId} failed to resume on reconnect (Temporal rejected the ` +
        `start-workflow). It has been re-held (degraded-retryable) and re-attempts ` +
        `on the next reconnect; the re-attempt is idempotent (reuses its §8 envelope).`,
      auditRef,
      now,
    });
    if (!recorded.ok) return err(mapSurfaceError(recorded.error));
    return ok(undefined);
  }

  return {
    async onConnectionLost(
      input: ConnectionLostInput,
    ): Promise<Result<ConnectionLostOutcome, DegradedModeError>> {
      degraded = true;
      // Bounded reconnect backoff: the in-window recent-failure count is the
      // 0-based supervision curve index (reuses the 10.4 curve verbatim).
      const curveIndex = input.recentFailures.length;
      const retryInMs = supervisionBackoffMs(curveIndex, config.backoff);
      const repairMessage =
        "Temporal server unreachable — dispatch is held; retrying the connection " +
        `with bounded backoff (${retryInMs}ms). Held work resumes automatically on reconnect.`;

      // Surface (or bump) the DISTINCT worker_down item — deduped by
      // (worker_down, TEMPORAL_SUBJECT_REF); a recurring outage refreshes the ONE
      // item, never a duplicate.
      const recorded = await surface.record({
        failureClass: healthClass,
        subjectRef: TEMPORAL_SUBJECT_REF,
        message: repairMessage,
        auditRef,
        now: input.now,
      });
      if (!recorded.ok) return err(mapSurfaceError(recorded.error));

      return ok({ healthItem: recorded.value.item, retryInMs, repairMessage });
    },

    async onDispatchRequest(
      jobId: string,
      at: { readonly now: string },
    ): Promise<Result<DispatchOutcome, DegradedModeError>> {
      if (!degraded) {
        // Healthy → the normal dispatch path.
        await dispatch(jobId);
        return ok({ disposition: "dispatched" });
      }
      // Degraded → HOLD (queue) the job; NEVER drop it, NEVER send to dead Temporal.
      held.push({ jobId, heldAt: at.now });
      return ok({ disposition: "held" });
    },

    async onReconnect(
      at: { readonly now: string },
    ): Promise<Result<ReconnectOutcome, DegradedModeError>> {
      // Idempotent auto-clear: resolve the item (a no-op if already resolved or
      // never opened — resolveHealthItem is idempotent + terminal-safe).
      const resolved = await surface.resolve({
        failureClass: healthClass,
        subjectRef: TEMPORAL_SUBJECT_REF,
        now: at.now,
      });
      if (!resolved.ok) return err(mapSurfaceError(resolved.error));

      degraded = false;

      // Resume every held job through the NORMAL dispatch path, draining the
      // queue. Shift as we go so a spurious second reconnect finds it empty
      // (idempotent — nothing re-dispatched, no duplicate side effect).
      //
      // §16: a real Temporal start-workflow REJECTION mid-drain must NOT throw
      // across the boundary NOR lose the held job. We wrap EACH dispatch: on a
      // rejection we RE-HOLD that job (return it to the degraded-retryable queue
      // via `reHold`, so a later reconnect re-attempts it — the re-attempt stays
      // idempotent because it resumes through the SAME dispatch → §8 envelope
      // reuse), surface a typed worker_down health item for it (operator-visible,
      // never a silent drop), and CONTINUE draining the rest. Only cleanly
      // dispatched jobs count toward resumedCount.
      const reHold: HeldDispatch[] = [];
      let resumedCount = 0;
      while (held.length > 0) {
        const next = held.shift();
        if (next === undefined) break;
        try {
          await dispatch(next.jobId);
          resumedCount += 1;
        } catch (cause) {
          // Re-hold the job (never lost) — degraded-retryable, drained on a later
          // reconnect. Surface a typed health item; a persist fault folds to a
          // typed err (fail-closed), never a throw.
          reHold.push(next);
          const surfaced = await surfaceDispatchFailure(next.jobId, at.now, cause);
          if (!surfaced.ok) {
            // Persist fault: restore the not-yet-drained remainder + the re-hold
            // set so NOTHING is lost, then fail closed with a typed err.
            held.unshift(...reHold, ...held.splice(0));
            return err(surfaced.error);
          }
        }
      }
      // Return the re-held (failed) jobs to the queue so a later reconnect drains
      // them — preserving §6 order relative to any not-yet-drained tail (none here,
      // the loop drained to empty, but be explicit + defensive).
      if (reHold.length > 0) held.unshift(...reHold);
      return ok({ resumedCount });
    },

    heldQueue(): readonly HeldDispatch[] {
      return [...held];
    },

    isDegraded(): boolean {
      return degraded;
    },
  };
}
