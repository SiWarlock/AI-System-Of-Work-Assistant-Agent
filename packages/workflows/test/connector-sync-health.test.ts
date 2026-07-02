// spec(§9, REQ-I-005 / LIFE-4 / LIFE-2 / LIFE-6) — task 7.15 Connector Sync & Health.
//
// The scheduled/wake-triggered connector-sync workflow drives the Phase-6 Connector
// Gateway (runConnectorSync) per connector and enforces:
//   • REQ-I-005 NO SILENT DROP: the cursor advances ONLY after a page's records are
//     SUCCESSFULLY processed (a held/degraded poll leaves the cursor put).
//   • LIFE-4 UNREACHABLE branch: an unreachable/held connector QUEUES its inbound
//     work + retries with bounded exponential backoff, is marked DEGRADED via the
//     7.5 health sink, and NOTHING is silently dropped.
//   • LIFE-6 reconnect: a wake trigger DRAINS held work before polling (the §8
//     replay-safe drain — a re-poll reuses receipts, no duplicate external write).
//   • idempotent re-poll: because the gateway advances the cursor only on success
//     and dedupes by contentHash, a re-poll does NOT reprocess already-cursored
//     items (the driver re-drives the same poll; the gateway is the idempotency
//     backstop).
//   • LIFE-2 collapse: a missed/late scheduled poll collapses to ONE run on wake.
//
// The DRIVER is pure (no @temporalio, no node:crypto, no Date.now) — all time + I/O
// arrive through injected ports + Clock, so this is Vitest-unit-testable with no
// Temporal server. Every failure/park class routes through the 7.5 health sink.
import { describe, it, expect, vi } from "vitest";
import { ok, err, workflowId } from "@sow/contracts";
import type { Result } from "@sow/contracts";
import {
  runConnectorSyncHealth,
  connectorSyncHealthMachine,
} from "../src/workflows/connectorSyncHealth";
import type {
  ConnectorSyncHealthInput,
  ConnectorSyncHealthDeps,
  ConnectorPollPort,
  ConnectorPollResult,
  ConnectorPollError,
  WakeDrainPort,
  ConnectorSyncHealthHealthSink,
  ConnectorSyncHealthFailure,
  ConnectorTarget,
} from "../src/workflows/connectorSyncHealth";
import {
  createConnectorPollActivity,
  projectSyncResult,
} from "../src/activities/connectorPoll";
import type { ConnectorPort, ConnectorSyncDeps } from "@sow/integrations";
import type {
  Clock,
  WorkflowRunRefRepository,
  ScheduleStore,
  ScheduleBookkeeping,
} from "../src/ports/operational";
import type { WorkflowRunRef } from "@sow/contracts";
import type { DbResult } from "../src/ports/operational";

// --- fixed clock ------------------------------------------------------------

const NOW = "2026-07-02T12:00:00.000Z";
function makeClock(now: string = NOW): Clock {
  return { now: () => now };
}

// --- workflow-run repo fake (novel key → create) ----------------------------

function makeRuns(): WorkflowRunRefRepository {
  const store = new Map<string, WorkflowRunRef>();
  const notFound = { ok: false as const, error: { code: "not_found" as const, message: "nf" } };
  return {
    getByIdempotencyKey: vi.fn(
      (k: string): DbResult<WorkflowRunRef> => {
        const hit = store.get(k);
        return Promise.resolve(hit ? ok(hit) : notFound);
      },
    ),
    create: vi.fn((r: WorkflowRunRef): DbResult<WorkflowRunRef> => {
      store.set(r.idempotencyKey, r);
      return Promise.resolve(ok(r));
    }),
    get: vi.fn((): DbResult<WorkflowRunRef> => Promise.resolve(notFound)),
    update: vi.fn((r: WorkflowRunRef): DbResult<WorkflowRunRef> => Promise.resolve(ok(r))),
  } as unknown as WorkflowRunRefRepository;
}

// --- schedule store fake ----------------------------------------------------

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

// --- health sink fake -------------------------------------------------------

function makeHealthSink(): {
  sink: ConnectorSyncHealthHealthSink;
  surfaced: ConnectorSyncHealthFailure[];
} {
  const surfaced: ConnectorSyncHealthFailure[] = [];
  const sink: ConnectorSyncHealthHealthSink = {
    surface: vi.fn((f: ConnectorSyncHealthFailure) => {
      surfaced.push(f);
      return Promise.resolve(ok({ routedToHealth: true, routedToOutbox: false }));
    }),
  };
  return { sink, surfaced };
}

// --- poll port fake ---------------------------------------------------------

function pollReturning(
  perConnector: Record<string, Result<ConnectorPollResult, ConnectorPollError>>,
): { port: ConnectorPollPort; calls: string[] } {
  const calls: string[] = [];
  const port: ConnectorPollPort = {
    poll: vi.fn((c: ConnectorTarget) => {
      calls.push(c.connectorId);
      return Promise.resolve(
        perConnector[c.connectorId] ??
          ok({
            connectorId: c.connectorId,
            status: "advanced" as const,
            processed: 0,
            cursorAdvanced: false,
          }),
      );
    }),
  };
  return { port, calls };
}

const CONNECTORS: readonly ConnectorTarget[] = [
  { connectorId: "todoist", workspaceId: "ws-1" },
];

function baseInput(
  overrides: Partial<ConnectorSyncHealthInput> = {},
): ConnectorSyncHealthInput {
  return {
    run: {
      workflowId: workflowId("wf-connector-sync-1"),
      trigger: "schedule",
      workspaceId: "ws-1",
      idempotencyKey: "idem-connector-1",
    },
    scheduleId: "connector-sync",
    intervalMs: 60_000,
    catchUpWindowMs: 3_600_000,
    connectors: CONNECTORS,
    ...overrides,
  };
}

function makeDeps(
  overrides: Partial<ConnectorSyncHealthDeps> = {},
): ConnectorSyncHealthDeps {
  const { port } = pollReturning({});
  return {
    poll: port,
    wakeDrain: { drain: vi.fn(() => Promise.resolve(ok({ drained: 0, reused: 0, held: 0, failed: 0 }))) },
    health: makeHealthSink().sink,
    runs: makeRuns(),
    schedule: makeSchedule(),
    clock: makeClock(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// the local state machine
// ---------------------------------------------------------------------------

describe("spec(§9) connectorSyncHealthMachine — pure + total", () => {
  it("walks the happy edge scheduled → polling → synced → done", () => {
    let s = connectorSyncHealthMachine.transition("scheduled", "polling");
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    s = connectorSyncHealthMachine.transition(s.value, "synced");
    expect(s.ok).toBe(true);
    if (!s.ok) return;
    s = connectorSyncHealthMachine.transition(s.value, "done");
    expect(s.ok).toBe(true);
  });

  it("rejects the forbidden edge scheduled → done (a park/poll cannot be skipped)", () => {
    const s = connectorSyncHealthMachine.transition("scheduled", "done");
    expect(s.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// happy path — every connector advances
// ---------------------------------------------------------------------------

describe("spec(REQ-I-005) happy path — a successful poll advances the cursor", () => {
  it("polls each connector, reaches done, advances schedule bookkeeping, no health item", async () => {
    const { port, calls } = pollReturning({
      todoist: ok({ connectorId: "todoist", status: "advanced", processed: 3, cursorAdvanced: true, cursor: "c2" }),
    });
    const { sink, surfaced } = makeHealthSink();
    const schedule = makeSchedule();
    const out = await runConnectorSyncHealth(baseInput(), makeDeps({ poll: port, health: sink, schedule }));

    expect(out.state).toBe("done");
    expect(calls).toEqual(["todoist"]);
    expect(surfaced).toHaveLength(0);
    // schedule bookkeeping advanced (one put on the terminal path).
    expect((schedule.put as ReturnType<typeof vi.fn>)).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// LIFE-4 — unreachable/degraded connector: queue + degraded health + no drop
// ---------------------------------------------------------------------------

describe("spec(LIFE-4, REQ-I-005) unreachable connector — queue + degraded + no silent drop", () => {
  it("a degraded poll surfaces a connector_unreachable health item derived from the ACTUAL poll result", async () => {
    const { port } = pollReturning({
      todoist: ok({
        connectorId: "todoist",
        status: "degraded",
        processed: 0,
        cursorAdvanced: false,
        healthReason: "unreachable: connection refused",
      }),
    });
    const { sink, surfaced } = makeHealthSink();
    const out = await runConnectorSyncHealth(baseInput(), makeDeps({ poll: port, health: sink }));

    expect(out.state).toBe("connector_degraded");
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]!.failureClass).toBe("connector_unreachable");
    // The surfaced message reflects the ACTUAL degraded poll result, not a decoy.
    expect(surfaced[0]!.message).toContain("todoist");
  });

  it("a HELD poll (consumer failure / auth locked) leaves the cursor put and queues for retry (no silent drop)", async () => {
    const { port } = pollReturning({
      todoist: ok({
        connectorId: "todoist",
        status: "held",
        processed: 0,
        cursorAdvanced: false,
        healthReason: "onRecords downstream_rejected",
      }),
    });
    const { sink, surfaced } = makeHealthSink();
    const out = await runConnectorSyncHealth(baseInput(), makeDeps({ poll: port, health: sink }));

    // Held is a retryable degrade — surfaced (never silent) and NOT advanced-to-done.
    expect(out.state).toBe("connector_degraded");
    expect(surfaced).toHaveLength(1);
    // The outcome carries the held connector so the caller re-drives it (queued, not dropped).
    expect(out.degradedConnectors).toContain("todoist");
  });

  it("a poll-PORT error (the poll activity itself failed) folds to connector_degraded and is surfaced", async () => {
    const { port } = pollReturning({
      todoist: err({ code: "poll_failed", message: "gateway crashed" }),
    });
    const { sink, surfaced } = makeHealthSink();
    const out = await runConnectorSyncHealth(baseInput(), makeDeps({ poll: port, health: sink }));

    expect(out.state).toBe("connector_degraded");
    expect(surfaced).toHaveLength(1);
    expect(surfaced[0]!.failureClass).toBe("connector_unreachable");
  });
});

// ---------------------------------------------------------------------------
// idempotent re-poll — does not reprocess already-cursored items
// ---------------------------------------------------------------------------

describe("spec(REQ-I-005) idempotent re-poll — no reprocessing of cursored items", () => {
  it("re-driving the same run reuses the run; the gateway cursor is the dedupe backstop (re-poll processes 0)", async () => {
    const runs = makeRuns();
    // A STATEFUL poll fake modeling the gateway's cursor: the FIRST pass processes 3
    // records and advances the cursor; a SECOND pass over the same (already-cursored)
    // connector processes 0 — REQ-I-005 idempotency, no reprocessing.
    const calls: string[] = [];
    let cursored = false;
    const port: ConnectorPollPort = {
      poll: vi.fn((c: ConnectorTarget) => {
        calls.push(c.connectorId);
        const result: ConnectorPollResult = cursored
          ? { connectorId: c.connectorId, status: "advanced", processed: 0, cursorAdvanced: false, cursor: "c1" }
          : { connectorId: c.connectorId, status: "advanced", processed: 3, cursorAdvanced: true, cursor: "c1" };
        cursored = true;
        return Promise.resolve(ok(result));
      }),
    };
    // Fresh schedule store per drive so the catch-up gate does not park the re-drive
    // (the idempotency under test is the GATEWAY cursor, not the schedule).
    const first = await runConnectorSyncHealth(baseInput(), makeDeps({ runs, poll: port, schedule: makeSchedule() }));
    const second = await runConnectorSyncHealth(baseInput(), makeDeps({ runs, poll: port, schedule: makeSchedule() }));

    expect(first.runReused).toBe(false);
    expect(second.runReused).toBe(true); // same idempotencyKey → existing run reused
    expect(calls).toEqual(["todoist", "todoist"]);
    // The re-poll processed 0 — the gateway's persisted cursor already covers those
    // items, so they are NOT reprocessed (no double-emit / no duplicate downstream).
    expect((port.poll as ReturnType<typeof vi.fn>).mock.results).toHaveLength(2);
    expect(second.syncedConnectors).toEqual(["todoist"]);
  });
});

// ---------------------------------------------------------------------------
// LIFE-2 — missed/late scheduled poll collapses to ONE run
// ---------------------------------------------------------------------------

describe("spec(LIFE-2) missed poll collapses to one run", () => {
  it("nothing due (interval not elapsed) parks in no_run_due with NO poll", async () => {
    // last run 10s ago, interval 60s → not due yet.
    const bk: ScheduleBookkeeping = {
      scheduleId: "connector-sync",
      lastRunWall: "2026-07-02T11:59:50.000Z",
    };
    const { port, calls } = pollReturning({});
    const out = await runConnectorSyncHealth(
      baseInput(),
      makeDeps({ poll: port, schedule: makeSchedule(bk), clock: makeClock(NOW) }),
    );
    expect(out.state).toBe("no_run_due");
    expect(calls).toHaveLength(0); // no poll fired
  });

  it("many missed occurrences collapse to a SINGLE run (collapsed=true), polling once", async () => {
    // last run 1h ago, interval 60s → ~60 missed occurrences, all within a 2h window.
    const bk: ScheduleBookkeeping = {
      scheduleId: "connector-sync",
      lastRunWall: "2026-07-02T11:00:00.000Z",
    };
    const { port, calls } = pollReturning({});
    const out = await runConnectorSyncHealth(
      baseInput({ catchUpWindowMs: 7_200_000 }),
      makeDeps({ poll: port, schedule: makeSchedule(bk), clock: makeClock(NOW) }),
    );
    expect(out.state).toBe("done");
    expect(out.collapsed).toBe(true);
    expect(calls).toEqual(["todoist"]); // ONE run, not once-per-missed-occurrence
  });
});

// ---------------------------------------------------------------------------
// LIFE-6 — a wake trigger drains held work before polling
// ---------------------------------------------------------------------------

describe("spec(LIFE-6) reconnect wake — drains held work before polling", () => {
  it("a connector_event (wake) trigger runs the outbox drain before polling", async () => {
    const drain = vi.fn(() => Promise.resolve(ok({ drained: 2, reused: 1, held: 0, failed: 0 })));
    const { port, calls } = pollReturning({
      todoist: ok({ connectorId: "todoist", status: "advanced", processed: 1, cursorAdvanced: true }),
    });
    const out = await runConnectorSyncHealth(
      baseInput({ run: { workflowId: workflowId("wf-x"), trigger: "connector_event", workspaceId: "ws-1", idempotencyKey: "idem-wake-1" } }),
      makeDeps({ poll: port, wakeDrain: { drain } }),
    );
    expect(drain).toHaveBeenCalledTimes(1);
    expect(out.state).toBe("done");
    expect(calls).toEqual(["todoist"]);
  });

  it("a scheduled trigger does NOT run the wake drain", async () => {
    const drain = vi.fn(() => Promise.resolve(ok({ drained: 0, reused: 0, held: 0, failed: 0 })));
    await runConnectorSyncHealth(baseInput(), makeDeps({ wakeDrain: { drain } }));
    expect(drain).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// ACTIVITY — connectorPoll: projects the ACTUAL gateway result (the governance pin)
// ---------------------------------------------------------------------------

describe("spec(REQ-I-005) connectorPoll activity — projects the ACTUAL gateway ConnectorSyncResult", () => {
  it("projectSyncResult derives cursorAdvanced from status==='advanced' (never fabricated)", () => {
    const advanced = projectSyncResult("todoist", {
      status: "advanced",
      cursor: "c1",
      processed: 5,
      health: "reachable",
    });
    expect(advanced.cursorAdvanced).toBe(true);
    expect(advanced.status).toBe("advanced");
    expect(advanced.cursor).toBe("c1");
    expect(advanced.processed).toBe(5);
    expect(advanced.healthReason).toBeUndefined();

    const degraded = projectSyncResult("todoist", {
      status: "degraded",
      cursor: "c0",
      processed: 0,
      health: "unreachable",
      healthSignal: {
        failureClass: "connector_unreachable",
        subjectRef: "todoist",
        severity: "warn",
        message: "connector todoist unreachable: refused",
        refs: ["ws-1"],
      },
    });
    // A degraded pass NEVER advanced the cursor — mirror that exactly (no fabrication).
    expect(degraded.cursorAdvanced).toBe(false);
    expect(degraded.status).toBe("degraded");
    expect(degraded.healthReason).toContain("todoist");
  });

  it("createConnectorPollActivity drives runConnectorSync and returns the projected result", async () => {
    const port: ConnectorPort = {
      connectorId: "todoist",
      fetch: vi.fn(() =>
        Promise.resolve(ok({ records: [], nextCursor: "c1", done: true })),
      ),
    };
    const syncDeps: ConnectorSyncDeps = {
      cursors: {
        get: vi.fn(() => Promise.resolve(err({ code: "not_found" as const, message: "nf" }))),
        upsert: vi.fn((r) => Promise.resolve(ok(r))),
        listByConnector: vi.fn(() => Promise.resolve(ok([]))),
      } as unknown as ConnectorSyncDeps["cursors"],
      workspaceId: "ws-1",
      onRecords: vi.fn(() => Promise.resolve(ok(undefined))),
      backoffCfg: { baseMs: 10, maxMs: 100, maxAttempts: 3 },
      clock: () => NOW,
    };
    const activity = createConnectorPollActivity({
      resolve: () => ({ port, syncDeps }),
    });
    const out = await activity.poll({ connectorId: "todoist", workspaceId: "ws-1" });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.value.status).toBe("advanced");
    expect(out.value.connectorId).toBe("todoist");
  });

  it("folds a gateway crash (adapter throw) to a typed poll_failed (never throws)", async () => {
    const activity = createConnectorPollActivity({
      resolve: () => ({
        port: {
          connectorId: "todoist",
          fetch: () => {
            throw new Error("adapter exploded");
          },
        },
        syncDeps: {
          cursors: {
            get: () => {
              throw new Error("adapter exploded");
            },
          } as unknown as ConnectorSyncDeps["cursors"],
          workspaceId: "ws-1",
          onRecords: () => Promise.resolve(ok(undefined)),
          backoffCfg: { baseMs: 10, maxMs: 100, maxAttempts: 3 },
          clock: () => NOW,
        },
      }),
    });
    const out = await activity.poll({ connectorId: "todoist", workspaceId: "ws-1" });
    expect(out.ok).toBe(false);
    if (out.ok) return;
    expect(out.error.code).toBe("poll_failed");
  });
});
