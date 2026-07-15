// Task 14.2 — the per-workspace connector-instance config registry composition. RED-first.
//
// SAFETY-CRITICAL (rule 7 tokenRef-reference-only + WS-8 rule 4 + the workspace-binding
// immutability anchor, consistent with 14.1/14.6). `registerConnectorInstance` persists an
// opaque tokenRef REFERENCE only (never credential bytes — the input shape has no secret
// field), binds only to a 14.1-registered workspace, and rejects a re-registration that
// changes the workspace binding (the isolation anchor). No live vendor call — config only.
//
// Unit-tested over a fake repo + a fake workspace registry (the Phase-16/23 consumers of the
// record are dormant — deferred, Lesson 11).
import { describe, it, expect } from "vitest";
import { ok, err, isErr, isOk, type Result } from "@sow/contracts";
import type { ConnectorInstanceRow, ConnectorInstanceState, DbError, ConnectorInstanceRepository, ReadModelRecord, ReadModelRepository } from "@sow/db";
import { READ_MODEL_KEYS } from "../../src/api/adapters/readModel";
import {
  registerConnectorInstance,
  setConnectorInstanceState,
  setConnectorInstanceCadence,
  type RegisterConnectorInstanceInput,
} from "../../src/composition/connectorConfig";

const NOW = "2026-07-15T00:00:00.000Z";
const wsId = (s: string): ConnectorInstanceRow["workspaceId"] => s as ConnectorInstanceRow["workspaceId"];

function regInput(over: Partial<RegisterConnectorInstanceInput> = {}): RegisterConnectorInstanceInput {
  return {
    instanceId: "gdrive-1",
    connectorId: "google-drive",
    workspaceId: "employer-work",
    tokenRef: "keychain:sow/employer-work/google-drive",
    cadence: "0 */6 * * *",
    ...over,
  };
}

class FakeConnectorRepo implements ConnectorInstanceRepository {
  rows = new Map<string, ConnectorInstanceRow>();
  upsertCalls = 0;
  faultOn: "get" | "upsert" | null = null;
  seed(...rs: ConnectorInstanceRow[]): this {
    for (const r of rs) this.rows.set(r.instanceId, r);
    return this;
  }
  async upsert(row: ConnectorInstanceRow): Promise<Result<ConnectorInstanceRow, DbError>> {
    this.upsertCalls += 1;
    if (this.faultOn === "upsert") return err({ code: "unavailable", message: "x" });
    this.rows.set(row.instanceId, row);
    return ok(row);
  }
  async get(instanceId: string): Promise<Result<ConnectorInstanceRow, DbError>> {
    if (this.faultOn === "get") return err({ code: "unavailable", message: "x" });
    const r = this.rows.get(instanceId);
    return r ? ok(r) : err({ code: "not_found", message: "x" });
  }
  async listByWorkspace(workspaceId: ConnectorInstanceRow["workspaceId"]): Promise<Result<ConnectorInstanceRow[], DbError>> {
    return ok([...this.rows.values()].filter((r) => r.workspaceId === workspaceId));
  }
  async setState(instanceId: string, state: ConnectorInstanceState): Promise<Result<ConnectorInstanceRow, DbError>> {
    const r = this.rows.get(instanceId);
    if (!r) return err({ code: "not_found", message: "x" });
    const next = { ...r, state };
    this.rows.set(instanceId, next);
    return ok(next);
  }
  async setCadence(instanceId: string, cadence: string): Promise<Result<ConnectorInstanceRow, DbError>> {
    const r = this.rows.get(instanceId);
    if (!r) return err({ code: "not_found", message: "x" });
    const next = { ...r, cadence };
    this.rows.set(instanceId, next);
    return ok(next);
  }
}

function fakeReadModels(opts: { registered?: readonly string[]; faultOnRegistry?: boolean } = {}): ReadModelRepository {
  return {
    async get(key: string): Promise<Result<ReadModelRecord, DbError>> {
      if (key === READ_MODEL_KEYS.registry) {
        if (opts.faultOnRegistry) return err({ code: "unavailable", message: "x" });
        return ok({ readModelKey: key, data: { workspaceIds: opts.registered ?? [] }, rebuiltAt: NOW } as ReadModelRecord);
      }
      return err({ code: "not_found", message: "x" });
    },
    async put(r: ReadModelRecord): Promise<Result<ReadModelRecord, DbError>> {
      return ok(r);
    },
    async clear(): Promise<Result<void, DbError>> {
      return ok(undefined);
    },
  };
}

describe("registerConnectorInstance (14.2 — connector-instance config registry)", () => {
  it("register_round_trips: a registered instance (registered ws + cadence + tokenRef ref) round-trips; defaults to paused [spec(§8)]", async () => {
    const repo = new FakeConnectorRepo();
    const readModels = fakeReadModels({ registered: ["employer-work"] });
    const res = await registerConnectorInstance({ repo, readModels }, regInput());
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.instanceId).toBe("gdrive-1");
      expect(res.value.tokenRef).toBe("keychain:sow/employer-work/google-drive");
      expect(res.value.cadence).toBe("0 */6 * * *");
      expect(res.value.state).toBe("paused"); // fail-safe default — enabled only on explicit toggle
    }
    const got = await repo.get("gdrive-1");
    expect(isOk(got) && got.value.connectorId).toBe("google-drive");
  });

  it("register_rejects_unregistered_workspace: an instance for a ws ABSENT from the 14.1 registry ⇒ workspace_unknown (fail-closed) [spec(§5)]", async () => {
    const repo = new FakeConnectorRepo();
    const res = await registerConnectorInstance({ repo, readModels: fakeReadModels({ registered: [] }) }, regInput());
    expect(isErr(res) && res.error.code).toBe("workspace_unknown");
    expect(repo.upsertCalls).toBe(0);
  });

  it("reregister_changing_workspace_is_rejected: existing instanceId + CHANGED workspaceId ⇒ connector_instance_workspace_immutable; binding preserved; same-ws re-register idempotent [spec(§5)]", async () => {
    const repo = new FakeConnectorRepo();
    const readModels = fakeReadModels({ registered: ["employer-work", "personal-business"] });
    expect(isOk(await registerConnectorInstance({ repo, readModels }, regInput({ workspaceId: "employer-work" })))).toBe(true);
    const rebind = await registerConnectorInstance({ repo, readModels }, regInput({ workspaceId: "personal-business" }));
    expect(isErr(rebind) && rebind.error.code).toBe("connector_instance_workspace_immutable");
    const got = await repo.get("gdrive-1");
    expect(isOk(got) && got.value.workspaceId).toBe("employer-work"); // anchor preserved
    // Same-workspace re-register updates (idempotent) — e.g. a new cadence.
    const same = await registerConnectorInstance({ repo, readModels }, regInput({ workspaceId: "employer-work", cadence: "0 0 * * *" }));
    expect(isOk(same)).toBe(true);
    expect(isOk(await repo.get("gdrive-1")) && (await repo.get("gdrive-1") as { value: ConnectorInstanceRow }).value.cadence).toBe("0 0 * * *");
  });

  it("register_registry_fault_fails_closed: a WS-8 registry READ fault ⇒ store_fault, NO upsert (fail-closed before the instance is touched) [spec(§5)]", async () => {
    const repo = new FakeConnectorRepo();
    const res = await registerConnectorInstance({ repo, readModels: fakeReadModels({ faultOnRegistry: true }) }, regInput());
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe("store_fault");
    expect(repo.upsertCalls).toBe(0);
  });

  it("register_get_fault_fails_closed: the pre-upsert existence-check get faulting ⇒ store_fault, NO upsert (fail-closed) [spec(§16)]", async () => {
    const repo = new FakeConnectorRepo();
    repo.faultOn = "get";
    const res = await registerConnectorInstance({ repo, readModels: fakeReadModels({ registered: ["employer-work"] }) }, regInput());
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.code).toBe("store_fault");
    expect(repo.upsertCalls).toBe(0);
  });

  it("tokenRef_reference_only_no_secret_persisted: the persisted record carries ONLY the opaque tokenRef reference — no credential/token bytes; register does no live vendor call (rule 7) [spec(§8)]", async () => {
    const repo = new FakeConnectorRepo();
    await registerConnectorInstance({ repo, readModels: fakeReadModels({ registered: ["employer-work"] }) }, regInput());
    const stored = repo.rows.get("gdrive-1");
    // The row's keys are config-only — no `secret`/`token`/`credential` field exists by construction.
    expect(Object.keys(stored ?? {})).toEqual(
      expect.arrayContaining(["instanceId", "connectorId", "workspaceId", "tokenRef", "state", "cadence"]),
    );
    expect(Object.keys(stored ?? {})).not.toContain("secret");
    expect(Object.keys(stored ?? {})).not.toContain("token");
    expect(Object.keys(stored ?? {})).not.toContain("credential");
    // The tokenRef is a REFERENCE handle, persisted verbatim (never resolved to secret bytes here).
    expect(stored?.tokenRef).toBe("keychain:sow/employer-work/google-drive");
  });
});

describe("setConnectorInstanceState / setConnectorInstanceCadence (14.2 — enable/pause + cadence)", () => {
  it("enable_pause_persists: pause then enable persists + round-trips [spec(§8)]", async () => {
    const repo = new FakeConnectorRepo();
    const readModels = fakeReadModels({ registered: ["employer-work"] });
    await registerConnectorInstance({ repo, readModels }, regInput());
    expect(isOk(await setConnectorInstanceState({ repo }, "gdrive-1", "enabled"))).toBe(true);
    expect(isOk(await repo.get("gdrive-1")) && (await repo.get("gdrive-1") as { value: ConnectorInstanceRow }).value.state).toBe("enabled");
    await setConnectorInstanceState({ repo }, "gdrive-1", "paused");
    expect((await repo.get("gdrive-1") as { value: ConnectorInstanceRow }).value.state).toBe("paused");
  });

  it("set_cadence_persists: a cadence update persists [spec(§8)]", async () => {
    const repo = new FakeConnectorRepo();
    await registerConnectorInstance({ repo, readModels: fakeReadModels({ registered: ["employer-work"] }) }, regInput());
    expect(isOk(await setConnectorInstanceCadence({ repo }, "gdrive-1", "@daily"))).toBe(true);
    expect((await repo.get("gdrive-1") as { value: ConnectorInstanceRow }).value.cadence).toBe("@daily");
  });

  it("set_state_on_unknown_instance_is_instance_unknown: toggling a missing instance ⇒ instance_unknown (fail-closed) [spec(§16)]", async () => {
    const repo = new FakeConnectorRepo();
    const res = await setConnectorInstanceState({ repo }, "nope", "enabled");
    expect(isErr(res) && res.error.code).toBe("instance_unknown");
  });
});
