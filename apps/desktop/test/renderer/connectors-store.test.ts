// Task 14.2 (desktop leg) — the connectors store slice.
//
// There is NO per-workspace connector LIST read on the worker (connectorConfig is mutations-only),
// so the surface tracks instances OPTIMISTICALLY from each mutation's returned UiSafeConnectorInstance,
// keyed by instanceId. `connectorsForWorkspace` is the WS-8 filter — a surface only ever shows the
// SELECTED onboarded workspace's instances, never another's.
// (14.3 System Health reuses the EXISTING `state.health` slice — already hydrated from
// systemHealth.items + kept live by the health stream — so it needs no new store slice.)
import { describe, it, expect } from "vitest";
import { initialStoreState } from "../../renderer/store";
import {
  upsertConnectorInstance,
  connectorsForWorkspace,
} from "../../renderer/store/projections";
import type { UiSafeConnectorInstanceView } from "../../renderer/lib/connector-config";

const inst = (instanceId: string, workspaceId: string, over: Partial<UiSafeConnectorInstanceView> = {}): UiSafeConnectorInstanceView => ({
  instanceId,
  connectorId: "drive",
  workspaceId,
  state: "paused",
  cadence: "@daily",
  ...over,
});

describe("connector-instance store slice (optimistic, WS-8 filtered)", () => {
  it("starts empty", () => {
    expect(initialStoreState.connectors.size).toBe(0);
    expect(connectorsForWorkspace(initialStoreState, "ws_a")).toEqual([]);
  });

  it("upserts an instance by instanceId, immutably", () => {
    const next = upsertConnectorInstance(initialStoreState, inst("i1", "ws_a"));
    expect(next).not.toBe(initialStoreState);
    expect(initialStoreState.connectors.size).toBe(0); // prior untouched
    expect(next.connectors.get("i1")?.workspaceId).toBe("ws_a");
  });

  it("re-upsert replaces by instanceId (a toggle's returned state wins), never duplicates", () => {
    const a = upsertConnectorInstance(initialStoreState, inst("i1", "ws_a", { state: "paused" }));
    const b = upsertConnectorInstance(a, inst("i1", "ws_a", { state: "enabled" }));
    expect(b.connectors.size).toBe(1);
    expect(b.connectors.get("i1")?.state).toBe("enabled");
  });

  it("connectorsForWorkspace returns ONLY the given workspace's instances (WS-8) — never another's", () => {
    let s = upsertConnectorInstance(initialStoreState, inst("i1", "ws_a"));
    s = upsertConnectorInstance(s, inst("i2", "ws_b"));
    s = upsertConnectorInstance(s, inst("i3", "ws_a"));
    expect(connectorsForWorkspace(s, "ws_a").map((c) => c.instanceId).sort()).toEqual(["i1", "i3"]);
    expect(connectorsForWorkspace(s, "ws_b").map((c) => c.instanceId)).toEqual(["i2"]);
    expect(connectorsForWorkspace(s, "ws_unknown")).toEqual([]);
  });

  it("no instance carries a tokenRef (the worker's UI-safe summary omits it — rule 7)", () => {
    const next = upsertConnectorInstance(initialStoreState, inst("i1", "ws_a"));
    expect(next.connectors.get("i1")).not.toHaveProperty("tokenRef");
  });
});
