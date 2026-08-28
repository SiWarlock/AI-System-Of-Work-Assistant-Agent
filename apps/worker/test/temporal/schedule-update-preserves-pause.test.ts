// @sow/worker — task F2 LIVE pin (SOW_TEMPORAL-gated; the default suite never needs a live
// Temporal server, mirrors schedule-occurrence-identity.test.ts's own harness shape).
//
// `ScheduleHandle.update` on the real `@temporalio/client` SDK REPLACES the whole server-side
// schedule with whatever the update callback returns — there is no partial-merge. A callback that
// returns `state: {}` (the pre-fix shape) gets proto3's absent-bool zero-value for `paused`, which
// SILENTLY UNPAUSES a paused schedule. This is NOT documented in the SDK reference (there is no
// unit-level fake that can observe the real wire encoding), so it is MEASURED here against a real
// ephemeral Temporal server rather than assumed — exactly the shape
// schedule-occurrence-identity.test.ts already established for the sibling per-tick-identity
// question.
//
// This drives the REAL `createRealScheduleClientPort` adapter + the REAL
// `createTemporalScheduleRegistrar`, not a hand-rolled schedule client call: creates a schedule
// PAUSED (registrar's `ensure()`, the create branch — a fresh scheduleId), then calls `ensure()` a
// SECOND time on the identical spec (the update branch, since the schedule now exists), and
// asserts the schedule is STILL paused afterward. Before the F2 fix this test REDS — see the
// structured report's `verification` for the transcript (RED against `state: {}`, reverted to
// confirm GREEN against the fix).
//
// ⛔ task D3 — this file pins BOTH directions of the property, not just paused → paused. The
// echo-`previous.state.paused` fix (boot.ts) is symmetric by design: a converge must preserve
// whichever pause state the schedule already had, never hardcode either `true` or `false`. The
// second `it` below pins the unpaused → unpaused direction (owner unpauses via the real SDK
// `ScheduleHandle.unpause()`, then a re-`ensure()` must leave it unpaused) — a hardcoded
// `state: { paused: true }` would silently re-pause a schedule the owner had deliberately
// unpaused, and the paused → paused test alone cannot see that regression.
import { describe, it, expect } from "vitest";
import { isOk } from "@sow/contracts";
import { SOW_TEMPORAL } from "../support/temporalGate";
import { createRealScheduleClientPort } from "../../src/boot";
import { createTemporalScheduleRegistrar, type TemporalScheduleSpec } from "../../src/temporal/scheduleRegistrar";

describe.skipIf(!SOW_TEMPORAL)("Temporal schedule re-ensure preserves pause state (task F2, LIVE)", () => {
  it("a schedule created PAUSED stays paused after a second ensure() (the update branch)", async () => {
    const { TestWorkflowEnvironment } = await import("@temporalio/testing");
    const { ScheduleNotFoundError } = await import("@temporalio/client");
    const env = await TestWorkflowEnvironment.createLocal();
    try {
      const scheduleId = `sow-f2-unpause-pin-${Date.now()}`;
      const spec: TemporalScheduleSpec = {
        scheduleId,
        intervalMs: 60_000,
        action: {
          workflowType: "anyWorkflowType",
          workflowId: `${scheduleId}-workflow`,
          taskQueue: "sow-control-plane",
          args: [],
        },
      };

      const port = createRealScheduleClientPort(
        env.client.schedule,
        (e): boolean => e instanceof ScheduleNotFoundError,
      );
      const registrar = createTemporalScheduleRegistrar({ client: port });

      const afterCreate = await registrar.ensure(spec);
      expect(isOk(afterCreate)).toBe(true);
      if (isOk(afterCreate)) expect(afterCreate.value.action).toBe("created");

      const createdDescribe = await env.client.schedule.getHandle(scheduleId).describe();
      expect(createdDescribe.state.paused).toBe(true);

      // ⛔ THE PIN — re-`ensure` the SAME still-paused schedule (the update branch). Before the F2
      // fix, `createRealScheduleClientPort.update` sent `state: {}` here and the real SDK's
      // proto3 encoding of an absent `paused` field UNPAUSED the schedule.
      const afterUpdate = await registrar.ensure(spec);
      expect(isOk(afterUpdate)).toBe(true);
      if (isOk(afterUpdate)) expect(afterUpdate.value.action).toBe("updated");

      const updatedDescribe = await env.client.schedule.getHandle(scheduleId).describe();
      expect(updatedDescribe.state.paused).toBe(true);

      await env.client.schedule.getHandle(scheduleId).delete();
    } finally {
      await env.teardown();
    }
  }, 60_000);

  // ⛔ THE MISSING DIRECTION — task D3. The test above pins paused → paused only. The doc comment
  // on `RealScheduleClientSurface.update` (boot.ts) names the OTHER direction as equally
  // load-bearing ("it must never hardcode `true` … would silently RE-PAUSE a schedule the owner
  // had deliberately unpaused") and nothing asserted it: a hardcoded `state: { paused: true }`
  // SURVIVES the test above unnoticed (measured — see this task's structured report).
  //
  // Same harness shape as the paused → paused pin: create PAUSED through the real
  // `createRealScheduleClientPort` + `createTemporalScheduleRegistrar` (the create branch), then
  // UNPAUSE it the way an owner actually would — the real SDK `ScheduleHandle.unpause()`, not a
  // hand-rolled client call — then re-`ensure()` the SAME spec (the update branch) and assert the
  // schedule is STILL unpaused. A converge must echo whatever pause state the owner left it in,
  // in EITHER direction.
  it("a schedule UNPAUSED by the owner stays unpaused after a second ensure() (the update branch)", async () => {
    const { TestWorkflowEnvironment } = await import("@temporalio/testing");
    const { ScheduleNotFoundError } = await import("@temporalio/client");
    const env = await TestWorkflowEnvironment.createLocal();
    try {
      const scheduleId = `sow-f2-owner-unpause-pin-${Date.now()}`;
      const spec: TemporalScheduleSpec = {
        scheduleId,
        intervalMs: 60_000,
        action: {
          workflowType: "anyWorkflowType",
          workflowId: `${scheduleId}-workflow`,
          taskQueue: "sow-control-plane",
          args: [],
        },
      };

      const port = createRealScheduleClientPort(
        env.client.schedule,
        (e): boolean => e instanceof ScheduleNotFoundError,
      );
      const registrar = createTemporalScheduleRegistrar({ client: port });

      const afterCreate = await registrar.ensure(spec);
      expect(isOk(afterCreate)).toBe(true);
      if (isOk(afterCreate)) expect(afterCreate.value.action).toBe("created");

      const createdDescribe = await env.client.schedule.getHandle(scheduleId).describe();
      expect(createdDescribe.state.paused).toBe(true);

      // The OWNER unpauses — the real SDK method, not a fabricated `update` call.
      await env.client.schedule.getHandle(scheduleId).unpause();

      const afterOwnerUnpause = await env.client.schedule.getHandle(scheduleId).describe();
      expect(afterOwnerUnpause.state.paused).toBe(false);

      // ⛔ THE PIN — re-`ensure` the SAME now-unpaused schedule (the update branch). A hardcoded
      // `state: { paused: true }` in `createRealScheduleClientPort.update` would silently
      // RE-PAUSE it here; only echoing `previous.state.paused` keeps it unpaused.
      const afterReEnsure = await registrar.ensure(spec);
      expect(isOk(afterReEnsure)).toBe(true);
      if (isOk(afterReEnsure)) expect(afterReEnsure.value.action).toBe("updated");

      const updatedDescribe = await env.client.schedule.getHandle(scheduleId).describe();
      expect(updatedDescribe.state.paused).toBe(false);

      await env.client.schedule.getHandle(scheduleId).delete();
    } finally {
      await env.teardown();
    }
  }, 60_000);
});
