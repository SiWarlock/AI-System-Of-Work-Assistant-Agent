// 9.4b follow-up: the desktop supervisor (worker-host) drives the INITIAL Temporal
// connect. On the degraded (no-proof-spine) first render it must record the outage as
// an operator-visible worker_down item — otherwise System Health shows a false "All
// systems healthy". `reportInitialConnect` is that driver: connect, and on the degraded
// variant drive the degraded controller's `onConnectionLost` (which persists through the
// surface → the systemHealth query's table). A ready connect does nothing.
//
// Load-bearing behaviors pinned here:
//   • the DEGRADED verdict is `!result.ok` (not a misread field) → records exactly once;
//   • a READY connect never touches the health surface;
//   • a health-persist fault inside onConnectionLost does NOT throw (§16) — the driver
//     still reports the degraded verdict so the supervisor backs off, never crash-loops.
import { describe, it, expect } from "vitest";
import { ok, err, auditId } from "@sow/contracts";
import type { HealthItem, Result } from "@sow/contracts";
import { reportInitialConnect } from "../src/boot";
import type { BootstrapReady, BootstrapDegraded } from "../src/temporal/worker";
import type {
  TemporalUnavailabilityController,
  ConnectionLostInput,
} from "../src/lifecycle/degraded/temporal-unavailable";

const NOW = "2026-07-03T00:00:00.000Z";

function workerDownItem(): HealthItem {
  return {
    id: "worker_down|temporal:default",
    failureClass: "worker_down",
    severity: "error",
    message: "Temporal server unreachable — dispatch is held.",
    auditRef: auditId("worker-boot:temporal-degraded"),
    openedAt: NOW,
    state: "open",
  };
}

/** A fake degraded controller that records every onConnectionLost input. */
function fakeController(
  over: Partial<TemporalUnavailabilityController> = {},
): { ctrl: TemporalUnavailabilityController; calls: ConnectionLostInput[] } {
  const calls: ConnectionLostInput[] = [];
  const ctrl: TemporalUnavailabilityController = {
    onConnectionLost: (input) => {
      calls.push(input);
      return Promise.resolve(ok({ healthItem: workerDownItem(), retryInMs: 500, repairMessage: "held" }));
    },
    onDispatchRequest: () => Promise.resolve(ok({ disposition: "held" })),
    onReconnect: () => Promise.resolve(ok({ resumedCount: 0 })),
    heldQueue: () => [],
    isDegraded: () => true,
    ...over,
  };
  return { ctrl, calls };
}

const degradedResult: Result<BootstrapReady, BootstrapDegraded> = err({
  code: "temporal_unavailable",
  dispatchEnabled: false,
  degraded: true,
  shouldReconnect: true,
  backoffMs: 500,
  healthItem: workerDownItem(),
  message: "unreachable",
});

const readyValue: BootstrapReady = { taskQueue: "sow-control-plane", dispatchEnabled: true };
const readyResult: Result<BootstrapReady, BootstrapDegraded> = ok(readyValue);

describe("reportInitialConnect", () => {
  it("degraded connect → records the outage via onConnectionLost (recentFailures empty) and reports degraded:true", async () => {
    const { ctrl, calls } = fakeController();
    const out = await reportInitialConnect(
      { connectTemporal: () => Promise.resolve(degradedResult), degraded: ctrl },
      { now: NOW },
    );
    expect(out.degraded).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.now).toBe(NOW);
    expect(calls[0]?.recentFailures).toEqual([]);
  });

  it("ready connect → does NOT touch the health surface and reports degraded:false", async () => {
    const { ctrl, calls } = fakeController();
    const out = await reportInitialConnect(
      { connectTemporal: () => Promise.resolve(readyResult), degraded: ctrl },
      { now: NOW },
    );
    expect(out.degraded).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("a health-persist fault inside onConnectionLost does NOT throw — still reports degraded:true", async () => {
    const { ctrl } = fakeController({
      onConnectionLost: () =>
        Promise.resolve(err({ code: "health_persist_failed", message: "db down" })),
    });
    const out = await reportInitialConnect(
      { connectTemporal: () => Promise.resolve(degradedResult), degraded: ctrl },
      { now: NOW },
    );
    expect(out.degraded).toBe(true);
  });
});
