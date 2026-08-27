// @sow/worker — the MEASURED pin under the 25.2/25.4 per-tick-input design
// (SOW_TEMPORAL-gated; the default suite never needs a live Temporal server).
//
// `apps/worker/src/temporal/scheduleArgs.ts` derives a scheduled occurrence's
// idempotencyKey from `workflowInfo().workflowId`. That is only correct if
// Temporal makes the started workflow id UNIQUE PER OCCURRENCE — otherwise every
// tick would share one key, `resolveRun` would report `reused: true` forever, and
// the schedule would collapse to a single run for all time.
//
// This is not documented in the SDK reference, so it is MEASURED here rather than
// assumed. If a future Temporal version stops appending the scheduled time, this
// pin reds and the derivation must change BEFORE any schedule is armed.
import { describe, it, expect } from "vitest";
import { SOW_TEMPORAL } from "../support/temporalGate";

describe.skipIf(!SOW_TEMPORAL)("Temporal schedule occurrence identity", () => {
  it("appends the scheduled time to the configured workflowId, making each occurrence distinct", async () => {
    const { TestWorkflowEnvironment } = await import("@temporalio/testing");
    const env = await TestWorkflowEnvironment.createLocal();
    try {
      const scheduleId = `sow-identity-pin-${Date.now()}`;
      const configuredWorkflowId = "sow-identity-pin-fixed-id";
      const handle = await env.client.schedule.create({
        scheduleId,
        spec: { intervals: [{ every: "2s" }] },
        action: {
          type: "startWorkflow",
          workflowType: "anyWorkflowType",
          workflowId: configuredWorkflowId,
          taskQueue: "sow-identity-pin-queue",
          args: [],
        },
      });

      // Nothing polls this task queue, so the executions never start — but the
      // schedule records the identity it launched under, which is the whole
      // question. Two occurrences at a 2s cadence.
      await new Promise((r) => setTimeout(r, 7000));

      const started = (await handle.describe()).info.recentActions.map(
        (a) => a.action.workflow.workflowId,
      );
      await handle.delete();

      expect(started.length).toBeGreaterThan(0);
      for (const id of started) {
        // The configured id is a PREFIX, never the whole id — the suffix is what
        // makes the occurrence distinct.
        expect(id.startsWith(`${configuredWorkflowId}-`)).toBe(true);
        expect(id).not.toBe(configuredWorkflowId);
      }
      // Distinct occurrences ⇒ distinct ids ⇒ distinct idempotency keys.
      expect(new Set(started).size).toBe(started.length);
    } finally {
      await env.teardown();
    }
  }, 60_000);
});
