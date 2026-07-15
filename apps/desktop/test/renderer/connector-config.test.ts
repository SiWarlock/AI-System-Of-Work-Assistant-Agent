// Task 14.2 (desktop leg) — the renderer connector-config command-callers. The renderer only
// REQUESTS config — the worker (connectorConfig.register/setState/setCadence) owns the candidate-
// data gate (tokenRef reference-only whitelist), the one-writer persist, and the UI-safe summary
// (which OMITS tokenRef). These wrappers fold a typed err / transport throw / malformed ok to
// { ok: false } (desktop Lesson 6). tokenRef is forwarded as an opaque REFERENCE on register;
// it is NEVER echoed back (the returned summary has no tokenRef field).
import { describe, it, expect, vi } from "vitest";
import {
  createRegisterConnector,
  createSetConnectorState,
  createSetConnectorCadence,
} from "../../renderer/lib/connector-config";

function fakeClient(paths: Record<string, (input: unknown) => Promise<unknown>>): never {
  return {
    connectorConfig: {
      register: { mutate: paths["register"] },
      setState: { mutate: paths["setState"] },
      setCadence: { mutate: paths["setCadence"] },
    },
  } as never;
}

const OK_INSTANCE = { instanceId: "i1", connectorId: "drive", workspaceId: "ws_a", state: "paused", cadence: "@daily" };

describe("createRegisterConnector", () => {
  it("forwards the tokenRef REFERENCE + config fields, returns the UI-safe summary (no tokenRef echoed)", async () => {
    const mutate = vi.fn(() => Promise.resolve({ ok: true, value: OK_INSTANCE }));
    const register = createRegisterConnector(fakeClient({ register: mutate }));
    const r = await register({ instanceId: "i1", connectorId: "drive", workspaceId: "ws_a", tokenRef: "keychain://my-drive-token", cadence: "@daily" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.instance.instanceId).toBe("i1");
      expect(r.instance).not.toHaveProperty("tokenRef"); // never echoed (rule 7)
    }
    // The tokenRef reference IS forwarded to the worker (which resolves it via SecretsPort, not here).
    expect(mutate).toHaveBeenCalledWith({ instanceId: "i1", connectorId: "drive", workspaceId: "ws_a", tokenRef: "keychain://my-drive-token", cadence: "@daily" });
  });

  it("folds a typed err (store fault / unknown workspace) to { ok: false } — no raw cause", async () => {
    const register = createRegisterConnector(fakeClient({ register: () => Promise.resolve({ ok: false, error: { kind: "degraded_unavailable", cause: { code: "CONNECTOR_STORE_FAULT" } } }) }));
    expect((await register({ instanceId: "i1", connectorId: "drive", workspaceId: "ws_a", tokenRef: "ref", cadence: "@daily" })).ok).toBe(false);
  });

  it("folds a transport throw + a malformed ok to { ok: false }", async () => {
    const thrown = createRegisterConnector(fakeClient({ register: () => Promise.reject(new Error("down")) }));
    expect((await thrown({ instanceId: "i1", connectorId: "drive", workspaceId: "ws_a", tokenRef: "ref", cadence: "@daily" })).ok).toBe(false);
    const malformed = createRegisterConnector(fakeClient({ register: () => Promise.resolve({ ok: true, value: { connectorId: "drive" } }) }));
    expect((await malformed({ instanceId: "i1", connectorId: "drive", workspaceId: "ws_a", tokenRef: "ref", cadence: "@daily" })).ok).toBe(false);
  });
});

describe("createSetConnectorState / createSetConnectorCadence", () => {
  it("setState forwards {instanceId, state} and returns the updated summary", async () => {
    const mutate = vi.fn(() => Promise.resolve({ ok: true, value: { ...OK_INSTANCE, state: "enabled" } }));
    const setState = createSetConnectorState(fakeClient({ setState: mutate }));
    const r = await setState("i1", "enabled");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.instance.state).toBe("enabled");
    expect(mutate).toHaveBeenCalledWith({ instanceId: "i1", state: "enabled" });
  });

  it("setCadence forwards {instanceId, cadence} and returns the updated summary", async () => {
    const mutate = vi.fn(() => Promise.resolve({ ok: true, value: { ...OK_INSTANCE, cadence: "@hourly" } }));
    const setCadence = createSetConnectorCadence(fakeClient({ setCadence: mutate }));
    const r = await setCadence("i1", "@hourly");
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.instance.cadence).toBe("@hourly");
    expect(mutate).toHaveBeenCalledWith({ instanceId: "i1", cadence: "@hourly" });
  });

  it("both fold a typed err / transport throw to { ok: false }", async () => {
    const errState = createSetConnectorState(fakeClient({ setState: () => Promise.resolve({ ok: false, error: { kind: "validation_rejected" } }) }));
    expect((await errState("i1", "enabled")).ok).toBe(false);
    const thrownCadence = createSetConnectorCadence(fakeClient({ setCadence: () => Promise.reject(new Error("x")) }));
    expect((await thrownCadence("i1", "@daily")).ok).toBe(false);
  });
});
