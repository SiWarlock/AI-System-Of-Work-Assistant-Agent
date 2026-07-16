// Task 16.2 — connectorPoll registration + connectorSyncHealth schedule (worker leg). RED-first.
//
// Wires the poll driver's real seam: createConnectorPollResolve binds an adapter (from the 16.1
// ComposedConnectors) + a cursor repo + the 15.1 connectorIngestionBridge (onRecords) + backoff, so
// a driven poll fetches → bridges → registerSource → dispatchSourceIngestion → note. The
// connectorSyncHealth workflow is registered in the sandbox bundle with a schedule config, and the
// polled set is enumerated from the ENABLED 14.2 connector instances — EMPTY in the shipped default,
// so a scheduled tick is inert (no fetch, no health). Pure-build / dormant (NO hard line) — the real
// transport/tokenRef + durable schedule bookkeeping + live schedule START are Phase-23 arming.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { ok, err, isOk, isErr, workflowId, type Result } from "@sow/contracts";
import type { WorkflowRunRef } from "@sow/contracts";
import type { SourceIngestionInput } from "@sow/workflows";
import {
  createConnectorPollActivity,
  runConnectorSyncHealth,
  type ConnectorTarget,
  type ConnectorSyncHealthInput,
  type ConnectorSyncHealthDeps,
  type ConnectorSyncHealthFailure,
} from "@sow/workflows";
import type {
  Clock,
  WorkflowRunRefRepository,
  ScheduleStore,
  ScheduleBookkeeping,
  DbResult,
} from "@sow/workflows/ports/operational";
import type {
  ConnectorTransport,
  ConnectorTransportResult,
  ConnectorCursorRepository,
} from "@sow/integrations";
import type { ConnectorInstanceRow } from "@sow/db";
import type { DispatchOutcome, DispatchError } from "../../src/temporal/dispatchSourceIngestion";
import { composeConnectors } from "../../src/composition/connectors";
import {
  createConnectorIngestionBridge,
  type ConnectorIngestionBinding,
} from "../../src/composition/connectorIngestionBridge";
import {
  createConnectorPollResolve,
  enumerateEnabledConnectorTargets,
  CONNECTOR_SYNC_SCHEDULE,
  CONNECTOR_POLL_BACKOFF,
} from "../../src/composition/connectorPolling";

const NOW = "2026-07-02T12:00:00.000Z";

// --- fakes ------------------------------------------------------------------

/** A fake connector cursor repo — a miss is a fresh sync; upsert records the cursor. */
function fakeCursors(): ConnectorCursorRepository {
  const store = new Map<string, { cursor?: string }>();
  return {
    get: vi.fn((connectorId: string, workspaceId: string) => {
      const hit = store.get(`${connectorId}:${workspaceId}`);
      return Promise.resolve(hit ? ok(hit) : err({ code: "not_found", message: "nf" }));
    }),
    upsert: vi.fn((rec: { connectorId: string; workspaceId: string; cursor?: string }) => {
      store.set(`${rec.connectorId}:${rec.workspaceId}`, { ...(rec.cursor !== undefined ? { cursor: rec.cursor } : {}) });
      return Promise.resolve(ok(rec));
    }),
  } as unknown as ConnectorCursorRepository;
}

/** A fake transport that returns ONE page of the given items then done (records to ingest). */
function recordsTransport(items: readonly { id: string; hash: string; raw: unknown }[]): ConnectorTransport {
  return async (): Promise<ConnectorTransportResult> => ({ ok: true, items, done: true });
}

const binding = (over: Partial<ConnectorIngestionBinding> = {}): ConnectorIngestionBinding => ({
  connectorId: "asana",
  workspaceId: "ws-a",
  origin: "connector:asana",
  type: "asana_task",
  sensitivity: "normal",
  routingHints: { connectorId: "asana" },
  ...over,
});

/** A fake source dispatch that records the SourceIngestionInput it received (the note path). */
function fakeDispatch() {
  const calls: SourceIngestionInput[] = [];
  const dispatch = async (input: SourceIngestionInput): Promise<Result<DispatchOutcome, DispatchError>> => {
    calls.push(input);
    const wid = input.run.workflowId as unknown as string;
    return ok({ workflowId: wid, dispatched: true, deduped: false });
  };
  return { dispatch, calls };
}

const registerDeps = () => ({ seenContentHash: async (): Promise<boolean> => false });

const instance = (over: Partial<ConnectorInstanceRow> = {}): ConnectorInstanceRow =>
  ({
    instanceId: "inst-1",
    connectorId: "asana",
    workspaceId: "ws-a",
    tokenRef: "keychain:asana:ws-a",
    state: "enabled",
    cadence: "@hourly",
    ...over,
  }) as ConnectorInstanceRow;

// --- runConnectorSyncHealth fakes (mirror packages/workflows connector-sync-health.test) ----

function makeClock(now: string = NOW): Clock {
  return { now: () => now };
}
function makeRuns(): WorkflowRunRefRepository {
  const store = new Map<string, WorkflowRunRef>();
  const notFound = { ok: false as const, error: { code: "not_found" as const, message: "nf" } };
  return {
    getByIdempotencyKey: vi.fn((k: string): DbResult<WorkflowRunRef> => {
      const hit = store.get(k);
      return Promise.resolve(hit ? ok(hit) : notFound);
    }),
    create: vi.fn((r: WorkflowRunRef): DbResult<WorkflowRunRef> => {
      store.set(r.idempotencyKey, r);
      return Promise.resolve(ok(r));
    }),
    get: vi.fn((): DbResult<WorkflowRunRef> => Promise.resolve(notFound)),
    update: vi.fn((r: WorkflowRunRef): DbResult<WorkflowRunRef> => Promise.resolve(ok(r))),
  } as unknown as WorkflowRunRefRepository;
}
function makeSchedule(bk?: ScheduleBookkeeping): ScheduleStore {
  let stored = bk;
  return {
    getBookkeeping: vi.fn(() => Promise.resolve(stored)),
    put: vi.fn((b: ScheduleBookkeeping) => {
      stored = b;
      return Promise.resolve();
    }),
  };
}
function makeHealthSink(): { sink: ConnectorSyncHealthDeps["health"]; surfaced: ConnectorSyncHealthFailure[] } {
  const surfaced: ConnectorSyncHealthFailure[] = [];
  const sink: ConnectorSyncHealthDeps["health"] = {
    surface: vi.fn((f: ConnectorSyncHealthFailure) => {
      surfaced.push(f);
      return Promise.resolve(ok({ routedToHealth: true, routedToOutbox: false }));
    }),
  };
  return { sink, surfaced };
}
function syncHealthInput(over: Partial<ConnectorSyncHealthInput> = {}): ConnectorSyncHealthInput {
  return {
    run: { workflowId: workflowId("wf-cs-1"), trigger: "schedule", workspaceId: "ws-a", idempotencyKey: "idem-cs-1" },
    scheduleId: CONNECTOR_SYNC_SCHEDULE.scheduleId,
    intervalMs: CONNECTOR_SYNC_SCHEDULE.intervalMs,
    catchUpWindowMs: CONNECTOR_SYNC_SCHEDULE.catchUpWindowMs,
    connectors: [],
    ...over,
  };
}

// ---------------------------------------------------------------------------

describe("createConnectorPollResolve (16.2 — the real poll resolve binding)", () => {
  it("poll_resolve_binds_adapter_cursor_bridge_backoff: resolve returns the ComposedConnectors port + syncDeps carrying the injected cursors/onRecords(bridge)/backoff/clock + the target workspace [spec(§8)]", () => {
    const connectors = composeConnectors(); // 16.1 inert default
    const cursors = fakeCursors();
    const bridge = { onRecords: async (): Promise<Result<void, never>> => ok(undefined) };
    const resolve = createConnectorPollResolve({
      connectors,
      cursors,
      backoffCfg: CONNECTOR_POLL_BACKOFF,
      clock: () => NOW,
      bridgeFor: () => bridge,
    });
    const { port, syncDeps } = resolve({ connectorId: "asana", workspaceId: "ws-a" });
    expect(port.connectorId).toBe("asana"); // the 16.1-composed adapter, by connectorId
    expect(syncDeps.cursors).toBe(cursors);
    expect(syncDeps.workspaceId).toBe("ws-a"); // WS-2 — the target's workspace
    expect(syncDeps.backoffCfg).toBe(CONNECTOR_POLL_BACKOFF);
    expect(syncDeps.onRecords).toBe(bridge.onRecords); // the 15.1 bridge is the onRecords consumer
  });

  it("poll_resolve_fails_closed_on_unknown_connectorId: an unknown connectorId ⇒ a port whose fetch is `unreachable` (NEVER a silent no-op/success) — the port leg, isolated with a REAL bridge [spec(§8)]", async () => {
    const bridge = { onRecords: async (): Promise<Result<void, never>> => ok(undefined) };
    const resolve = createConnectorPollResolve({
      connectors: composeConnectors(),
      cursors: fakeCursors(),
      backoffCfg: CONNECTOR_POLL_BACKOFF,
      clock: () => NOW,
      bridgeFor: () => bridge, // binding IS resolvable — isolate the unknown-connectorId (port) leg
    });
    const { port } = resolve({ connectorId: "not-a-real-connector", workspaceId: "ws-a" });
    const fetched = await port.fetch();
    expect(isErr(fetched) && fetched.error.code).toBe("unreachable"); // loud fail-closed, not a silent no-op
  });

  it("poll_resolve_fails_closed_on_missing_binding: a KNOWN connectorId (real adapter) but no resolvable binding ⇒ onRecords fails closed (holds the page, never a silent accept) — the binding leg, isolated [spec(§8)]", async () => {
    const resolve = createConnectorPollResolve({
      connectors: composeConnectors(),
      cursors: fakeCursors(),
      backoffCfg: CONNECTOR_POLL_BACKOFF,
      clock: () => NOW,
      bridgeFor: () => undefined, // no binding — isolate the missing-binding (onRecords) leg
    });
    const { port, syncDeps } = resolve({ connectorId: "asana", workspaceId: "ws-a" });
    expect(port.connectorId).toBe("asana"); // the port itself is real (known connectorId)
    const handled = await syncDeps.onRecords([{ recordId: "r", contentHash: "h", payload: {} }]);
    expect(isErr(handled)).toBe(true); // no binding ⇒ HOLD, never a silent accept
  });

  it("scheduled_poll_over_fake_records_bridges_to_a_note: a driven poll with a fake-records transport + a real bridge ⇒ fetch → registerSource → dispatchSourceIngestion (the note path), fakes only [spec(§19.3)]", async () => {
    const connectors = composeConnectors(recordsTransport([{ id: "task-1", hash: "h1", raw: { title: "a task" } }]));
    const d = fakeDispatch();
    const bridge = createConnectorIngestionBridge({ binding: binding(), registerDeps: registerDeps(), dispatch: d.dispatch });
    const resolve = createConnectorPollResolve({
      connectors,
      cursors: fakeCursors(),
      backoffCfg: CONNECTOR_POLL_BACKOFF,
      clock: () => NOW,
      bridgeFor: () => bridge,
    });
    const pollActivity = createConnectorPollActivity({ resolve });
    const result = await pollActivity.poll({ connectorId: "asana", workspaceId: "ws-a" });
    expect(isOk(result) && result.value.status).toBe("advanced"); // the page committed
    // the fake record flowed poll → bridge → registerSource → dispatch (workspace-bound, WS-8).
    expect(d.calls).toHaveLength(1);
    expect(d.calls[0]?.run.idempotencyKey).toBe("src:ws-a:h1");
    expect(d.calls[0]?.context.source.workspaceId as unknown as string).toBe("ws-a");
  });
});

describe("enumerateEnabledConnectorTargets (16.2 — poll only enabled 14.2 instances)", () => {
  it("shipped_default_enumeration_is_empty_and_a_tick_mints_no_health: no ENABLED instances ⇒ [] targets ⇒ a scheduled run polls nothing + surfaces NO health (inert, no spam) [spec(§19.3)]", async () => {
    // Only enabled instances are polled; a paused instance is excluded; no instances ⇒ empty.
    expect(enumerateEnabledConnectorTargets([])).toEqual([]);
    expect(enumerateEnabledConnectorTargets([instance({ state: "paused" })])).toEqual([]);
    const enabled = enumerateEnabledConnectorTargets([instance({ connectorId: "drive", state: "enabled" })]);
    expect(enabled).toEqual([{ connectorId: "drive", workspaceId: "ws-a" }]); // default ws-a

    // The shipped-default tick: empty connectors ⇒ no poll, ZERO health surfaced (dormancy).
    const poll = { poll: vi.fn() };
    const { sink, surfaced } = makeHealthSink();
    const outcome = await runConnectorSyncHealth(syncHealthInput({ connectors: enumerateEnabledConnectorTargets([]) }), {
      poll: poll as unknown as ConnectorSyncHealthDeps["poll"],
      wakeDrain: { drain: vi.fn(() => Promise.resolve(ok({ drained: 0, reused: 0, held: 0, failed: 0 }))) },
      health: sink,
      runs: makeRuns(),
      schedule: makeSchedule(),
      clock: makeClock(),
    });
    expect(poll.poll).not.toHaveBeenCalled(); // nothing fetched
    expect(surfaced).toHaveLength(0); // no error-health minted on an inert tick
    expect(outcome.degradedConnectors).toEqual([]);
  });
});

describe("connectorSyncHealth registration + schedule (16.2)", () => {
  it("connector_sync_health_is_registered_in_the_bundle: the workflow is exported from the sandbox workflows module + connectorPoll is a registered activity [spec(§9)]", () => {
    const workflowsSrc = readFileSync(new URL("../../src/temporal/workflows.ts", import.meta.url), "utf8");
    expect(workflowsSrc).toMatch(/export\s+async\s+function\s+connectorSyncHealthWorkflow/);
    const activitiesSrc = readFileSync(new URL("../../src/composition/buildActivities.ts", import.meta.url), "utf8");
    // Tightly anchored (L28 RED-on-weaken): the ACTUAL delegation, not any stray `connectorPoll:` mention.
    expect(activitiesSrc).toMatch(/connectorPoll:\s*\(connector\)\s*=>\s*connectorPollPort\.poll\(connector\)/);
  });

  it("missed_schedule_collapses_to_one_run_on_wake: with stale bookkeeping spanning multiple intervals, the 16.2 schedule config collapses the catch-up to ONE run (LIFE-2/LIFE-4) [spec(§9)]", async () => {
    // Bookkeeping last ran MANY intervals ago (within the catch-up window) ⇒ collapse-to-one.
    const staleAt = new Date(new Date(NOW).getTime() - CONNECTOR_SYNC_SCHEDULE.intervalMs * 5).toISOString();
    const bookkeeping: ScheduleBookkeeping = { scheduleId: CONNECTOR_SYNC_SCHEDULE.scheduleId, lastRunWall: staleAt };
    const outcome = await runConnectorSyncHealth(syncHealthInput({ connectors: [] }), {
      poll: { poll: vi.fn() } as unknown as ConnectorSyncHealthDeps["poll"],
      wakeDrain: { drain: vi.fn(() => Promise.resolve(ok({ drained: 0, reused: 0, held: 0, failed: 0 }))) },
      health: makeHealthSink().sink,
      runs: makeRuns(),
      schedule: makeSchedule(bookkeeping),
      clock: makeClock(),
    });
    expect(outcome.collapsed).toBe(true); // >1 missed occurrence folded into ONE run
  });
});
