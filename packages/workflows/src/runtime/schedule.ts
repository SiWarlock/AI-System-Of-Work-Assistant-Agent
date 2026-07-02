// @sow/workflows — 7.2 runtime: durable schedule registration (LIFE-2/LIFE-5 spine).
//
// PURE + deterministic + workflow-safe: imports NOTHING from @temporalio, NOTHING
// from node:crypto, and calls NO Date.now()/Math.random(). Time comes only from
// the INJECTED Clock; durable last-run state comes only from the INJECTED
// ScheduleStore (persisted via P2 — NEVER in Temporal history). §16 error
// convention: every method returns a typed `Result<T, ScheduleError>` with an
// ENUMERABLE closed code set — never throws across the boundary; fail-closed.
//
// A registration maps a scheduleId → the recurring workflow trigger. Two
// idempotency properties matter across a process restart:
//   • register — re-registering the same schedule after a bounce REUSES the
//     existing durable bookkeeping (no reset, no double-seed). A novel schedule
//     seeds its initial bookkeeping at the current clock reading.
//   • advance — advancing the last-run twice at the SAME clock reading is a no-op
//     the second time (advanceBookkeeping is deterministic on the reading, so the
//     re-put is byte-identical → no drift).
//
// SCOPE NOTE (arch_gap, Phase 10): the durable ScheduleBookkeeping field set is
// FROZEN and carries no `trigger`, so the scheduleId→trigger map lives in this
// registry instance's memory. Trigger-conflict detection therefore holds WITHIN a
// running registry; persisting the trigger across restarts is a Phase-10 store
// concern (the P2 adapter that backs ScheduleStore). Flagged, not silently
// assumed.
import { ok, err } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import type { Clock, ScheduleStore } from "../ports/operational";
import type { WorkflowTrigger } from "../ports/operational";
import { advanceBookkeeping } from "./clock";

/** The closed, enumerable §16 failure set for schedule registration/advance. */
export type ScheduleErrorCode = "trigger_conflict" | "not_registered";

/** A typed schedule error — never thrown; returned in a `Result`. */
export interface ScheduleError {
  readonly code: ScheduleErrorCode;
  readonly message: string;
}

/** A registered schedule: the scheduleId ↔ recurring workflow trigger mapping. */
export interface RegisteredSchedule {
  readonly scheduleId: string;
  readonly trigger: WorkflowTrigger;
}

/** The registry's injected dependencies. */
export interface ScheduleRegistryDeps {
  readonly store: ScheduleStore;
  readonly clock: Clock;
}

/** The durable-schedule registration abstraction (7.2). */
export interface ScheduleRegistry {
  /**
   * Register a schedule → trigger mapping. Idempotent: a novel schedule seeds its
   * durable bookkeeping at the current clock reading; a re-register with the SAME
   * trigger reuses the existing bookkeeping unchanged; a re-register with a
   * DIFFERENT trigger for the same id fails `trigger_conflict`.
   */
  register(
    scheduleId: string,
    trigger: WorkflowTrigger,
  ): Promise<Result<RegisteredSchedule, ScheduleError>>;

  /**
   * Advance a registered schedule's durable last-run to the current clock reading.
   * Idempotent at a fixed clock reading (re-put is byte-identical). An unregistered
   * schedule fails `not_registered`.
   */
  advance(scheduleId: string): Promise<Result<void, ScheduleError>>;
}

const triggerConflict = (id: string): ScheduleError => ({
  code: "trigger_conflict",
  message: `schedule already registered with a different trigger: ${id}`,
});

const notRegistered = (id: string): ScheduleError => ({
  code: "not_registered",
  message: `schedule is not registered: ${id}`,
});

/**
 * Build a durable schedule registry over an injected ScheduleStore + Clock. The
 * registry is a plain object closing over an in-memory trigger map; all durable
 * state flows through the store, so a fresh registry over the SAME store on
 * restart keeps advancing the persisted bookkeeping.
 */
export function createScheduleRegistry(
  deps: ScheduleRegistryDeps,
): ScheduleRegistry {
  const { store, clock } = deps;
  const triggers = new Map<string, WorkflowTrigger>();

  return {
    async register(scheduleId, trigger) {
      const existing = triggers.get(scheduleId);
      if (existing !== undefined && existing !== trigger) {
        return err(triggerConflict(scheduleId));
      }
      triggers.set(scheduleId, trigger);

      // Seed durable bookkeeping ONLY when novel — reuse an existing row across a
      // restart (never reset a prior last-run).
      const bk = await store.getBookkeeping(scheduleId);
      if (bk === undefined) {
        await store.put(advanceBookkeeping(scheduleId, clock));
      }
      return ok({ scheduleId, trigger });
    },

    async advance(scheduleId) {
      if (!triggers.has(scheduleId)) {
        return err(notRegistered(scheduleId));
      }
      await store.put(advanceBookkeeping(scheduleId, clock));
      return ok(undefined);
    },
  };
}
