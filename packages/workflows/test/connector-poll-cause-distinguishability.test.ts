// spec(§9, LIFE-4, OBS-2) — C2: two DIFFERENT connector failures must not render as
// the same System Health item.
//
// System Health is the operator's primary diagnostic surface, and the §16
// `FailureClass` enum is frozen and coarse: EVERY held/degraded connector poll lands
// on `connector_unreachable` with the connectorId as `subjectRef`. So the health
// item's MESSAGE is the only place the distinction can live, and two hardening rounds
// had collapsed it:
//
//   (1) an expired/locked credential (`auth_locked`, remedy: unlock the Keychain /
//       re-authorize) and a consumer-side hold (KnowledgeWriter rejected the records,
//       remedy: investigate the write rejection) BOTH rendered
//       "connector granola held (queued for retry): connector held".
//   (2) a 429 (remedy: back off), a transport outage (remedy: check the network) and
//       a malformed vendor payload (remedy: file an adapter bug) ALL rendered
//       "connector <id> degraded: connector_unreachable", because the reason was
//       rebuilt from `failureClass` alone and `buildConnectorHealthSignal` always
//       stamps CONNECTOR_UNREACHABLE_HEALTH_CLASS.
//
// Every case below drives the REAL @sow/integrations gateway (`runConnectorSync`)
// through the REGISTERED activity (`createConnectorPollActivity`) — never a
// hand-rolled `ConnectorSyncResult` — so the pins cover the actual production chain
// including the observed-error-code tap. The two `held` cases additionally run the
// full pure driver (`runConnectorSyncHealth`) and compare the health-item message the
// operator actually sees.
//
// The discriminator is a CLOSED enum (`ConnectorPollResult.cause`); `healthReason` is
// its human rendering. Nothing here (and nothing in the source) parses the string to
// recover a machine fact — that is the exact pattern behind this subsystem's four
// live breaks.
import { describe, it, expect, vi } from "vitest";
import { ok, err, isOk, workflowId } from "@sow/contracts";
import type { WorkflowRunRef } from "@sow/contracts";
import { createConnectorPollActivity } from "../src/activities/connectorPoll";
import { runConnectorSyncHealth } from "../src/workflows/connectorSyncHealth";
import type {
  ConnectorPollResult,
  ConnectorSyncHealthDeps,
  ConnectorSyncHealthFailure,
  ConnectorSyncHealthHealthSink,
  ConnectorSyncHealthInput,
  ConnectorTarget,
} from "../src/workflows/connectorSyncHealth";
import type {
  ConnectorError,
  ConnectorPort,
  ConnectorRecord,
  ConnectorSyncDeps,
} from "@sow/integrations";
import type {
  Clock,
  DbResult,
  ScheduleStore,
  WorkflowRunRefRepository,
} from "../src/ports/operational";

const NOW = "2026-08-27T00:00:00.000Z";
const CONNECTOR: ConnectorTarget = { connectorId: "granola", workspaceId: "ws-1" };

// --- gateway harness --------------------------------------------------------

function fakeCursors(): ConnectorSyncDeps["cursors"] {
  return {
    get: () => Promise.resolve(err({ code: "not_found" as const, message: "nf" })),
    upsert: (r: unknown) => Promise.resolve(ok(r)),
    listByConnector: () => Promise.resolve(ok([])),
  } as unknown as ConnectorSyncDeps["cursors"];
}

function syncDeps(
  overrides: Partial<ConnectorSyncDeps> = {},
): ConnectorSyncDeps {
  return {
    cursors: fakeCursors(),
    workspaceId: CONNECTOR.workspaceId,
    onRecords: () => Promise.resolve(ok(undefined)),
    // maxAttempts 1 ⇒ a transient code is retried once and then EXHAUSTED (the
    // gateway `continue`s without sleeping, so this stays a fast unit test).
    backoffCfg: { baseMs: 1, maxMs: 1, maxAttempts: 1 },
    clock: () => NOW,
    ...overrides,
  };
}

/** A port whose every fetch fails with `code` — the adapter's `message` is poison. */
function failingPort(code: ConnectorError["code"]): ConnectorPort {
  return {
    connectorId: CONNECTOR.connectorId,
    fetch: () =>
      Promise.resolve(
        err({ code, message: "https://api.vendor.example?token=sk-LEAKME / /Users/x/vault/n.md" }),
      ),
  };
}

const RECORD: ConnectorRecord = { recordId: "r1", contentHash: "h1", payload: { raw: "x" } };

/** Poll ONE connector through the REAL gateway via the registered activity. */
async function pollThroughGateway(
  port: ConnectorPort,
  deps: ConnectorSyncDeps = syncDeps(),
): Promise<ConnectorPollResult> {
  const activity = createConnectorPollActivity({ resolve: () => ({ port, syncDeps: deps }) });
  const out = await activity.poll(CONNECTOR);
  // Every case here is a gateway VERDICT, not an activity crash: the ok arm.
  expect(out.ok).toBe(true);
  if (!isOk(out)) throw new Error("unreachable: the poll activity errored");
  return out.value;
}

// --- driver harness ---------------------------------------------------------

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

function makeSchedule(): ScheduleStore {
  return { getBookkeeping: vi.fn(() => Promise.resolve(undefined)), put: vi.fn(() => Promise.resolve()) };
}

function makeHealthSink(): {
  sink: ConnectorSyncHealthHealthSink;
  surfaced: ConnectorSyncHealthFailure[];
} {
  const surfaced: ConnectorSyncHealthFailure[] = [];
  return {
    surfaced,
    sink: {
      surface: vi.fn((f: ConnectorSyncHealthFailure) => {
        surfaced.push(f);
        return Promise.resolve(ok({ routedToHealth: true, routedToOutbox: false }));
      }),
    },
  };
}

const CLOCK: Clock = { now: () => NOW };

const INPUT: ConnectorSyncHealthInput = {
  run: {
    workflowId: workflowId("wf-connector-sync-c2"),
    trigger: "schedule",
    workspaceId: CONNECTOR.workspaceId,
    idempotencyKey: "idem-c2",
  },
  scheduleId: "connector-sync",
  intervalMs: 60_000,
  catchUpWindowMs: 3_600_000,
  connectors: [CONNECTOR],
};

/**
 * Drive the FULL pipeline for one connector: the real gateway behind the registered
 * activity, then the pure driver — and return the health item the operator sees.
 */
async function healthItemFor(
  port: ConnectorPort,
  deps: ConnectorSyncDeps = syncDeps(),
): Promise<ConnectorSyncHealthFailure> {
  const activity = createConnectorPollActivity({ resolve: () => ({ port, syncDeps: deps }) });
  const { sink, surfaced } = makeHealthSink();
  const driverDeps: ConnectorSyncHealthDeps = {
    poll: activity,
    wakeDrain: { drain: () => Promise.resolve(ok({ drained: 0, reused: 0, held: 0, failed: 0, skipped: 0 })) },
    health: sink,
    runs: makeRuns(),
    schedule: makeSchedule(),
    clock: CLOCK,
  };
  await runConnectorSyncHealth(INPUT, driverDeps);
  expect(surfaced).toHaveLength(1);
  return surfaced[0]!;
}

// ---------------------------------------------------------------------------
// FINDING 1 — auth_locked vs a consumer-side hold
// ---------------------------------------------------------------------------

describe("spec(LIFE-4) C2 finding 1 — a locked credential and a consumer hold render differently", () => {
  // The gateway's `auth_locked` arm: held, cursor untouched, NOT retried in-pass.
  const authLockedPort = failingPort("auth_locked");
  // The gateway's consumer arm: the fetch SUCCEEDS, `onRecords` rejects ⇒ held with
  // `health: "reachable"` (this is what separates it from the arm above).
  const consumerHoldPort: ConnectorPort = {
    connectorId: CONNECTOR.connectorId,
    fetch: () => Promise.resolve(ok({ records: [RECORD], nextCursor: "c1", done: true })),
  };
  const consumerHoldDeps = syncDeps({
    onRecords: () =>
      Promise.resolve(err({ code: "downstream_rejected" as const, message: "KnowledgeWriter said no" })),
  });

  it("both are `held` with the SAME failureClass + subjectRef — so the MESSAGE must carry the distinction", async () => {
    const locked = await healthItemFor(authLockedPort);
    const consumer = await healthItemFor(consumerHoldPort, consumerHoldDeps);

    // The premise of this whole file: the machine taxonomy genuinely cannot separate
    // these two. If a future FailureClass member DOES separate them, this assertion
    // goes RED and the message-level workaround can be revisited.
    expect(locked.failureClass).toBe("connector_unreachable");
    expect(consumer.failureClass).toBe(locked.failureClass);
    expect(locked.subjectRef).toBe(CONNECTOR.connectorId);
    expect(consumer.subjectRef).toBe(locked.subjectRef);

    // …and the messages must therefore differ. This is the regression: they were
    // byte-identical ("connector granola held (queued for retry): connector held").
    expect(consumer.message).not.toBe(locked.message);
  });

  it("the operator can tell WHICH remedy applies from the health item alone", async () => {
    const locked = await healthItemFor(authLockedPort);
    const consumer = await healthItemFor(consumerHoldPort, consumerHoldDeps);

    expect(locked.message).toContain("auth_locked");
    expect(locked.message).toContain("granola");
    expect(consumer.message).toContain("consumer_rejected");
    expect(consumer.message).toContain("granola");
    // Cross-check: neither leaks into the other's rendering.
    expect(locked.message).not.toContain("consumer_rejected");
    expect(consumer.message).not.toContain("auth_locked");
  });

  it("carries the machine discriminator as a typed enum, not only as prose", async () => {
    const locked = await pollThroughGateway(authLockedPort);
    const consumer = await pollThroughGateway(consumerHoldPort, consumerHoldDeps);

    expect(locked.status).toBe("held");
    expect(consumer.status).toBe("held");
    expect(locked.cause).toBe("auth_locked");
    expect(consumer.cause).toBe("consumer_rejected");
    // REQ-I-005 unchanged by any of this: a held pass never claims a cursor advance.
    expect(locked.cursorAdvanced).toBe(false);
    expect(consumer.cursorAdvanced).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FINDING 2 — 429 vs outage vs malformed payload
// ---------------------------------------------------------------------------

describe("spec(OBS-2) C2 finding 2 — three degrade causes under one failureClass render differently", () => {
  it("429, transport outage and malformed payload each render distinctly", async () => {
    const rateLimited = await pollThroughGateway(failingPort("rate_limited"));
    const outage = await pollThroughGateway(failingPort("unreachable"));
    const malformed = await pollThroughGateway(failingPort("malformed"));

    // All three really are the same closed class — that is why the class alone
    // cannot be the operator's answer.
    for (const r of [rateLimited, outage, malformed]) {
      expect(r.status).toBe("degraded");
      expect(r.healthReason).toContain("connector_unreachable");
    }

    const rendered = [rateLimited.healthReason, outage.healthReason, malformed.healthReason];
    expect(new Set(rendered).size).toBe(3);
    expect(rateLimited.cause).toBe("rate_limited");
    expect(outage.cause).toBe("transport_unreachable");
    expect(malformed.cause).toBe("malformed_response");
  });

  it("the `unknown` fetch code stays distinct from the other three (no silent collapse)", async () => {
    const unknown = await pollThroughGateway(failingPort("unknown"));
    const outage = await pollThroughGateway(failingPort("unreachable"));

    expect(unknown.cause).toBe("unknown_fetch_error");
    expect(unknown.healthReason).not.toBe(outage.healthReason);
  });

  it("every distinct cause across BOTH findings renders a distinct reason (no pair collapses)", async () => {
    const consumerHold = await pollThroughGateway(
      {
        connectorId: CONNECTOR.connectorId,
        fetch: () => Promise.resolve(ok({ records: [RECORD], nextCursor: "c1", done: true })),
      },
      syncDeps({
        onRecords: () =>
          Promise.resolve(err({ code: "downstream_rejected" as const, message: "rejected" })),
      }),
    );
    const coverage = await pollThroughGateway({
      connectorId: CONNECTOR.connectorId,
      fetch: () =>
        Promise.resolve(ok({ records: [], nextCursor: "c1", done: true, incompleteCoverage: true })),
    });
    const results = [
      consumerHold,
      coverage,
      await pollThroughGateway(failingPort("auth_locked")),
      await pollThroughGateway(failingPort("rate_limited")),
      await pollThroughGateway(failingPort("unreachable")),
      await pollThroughGateway(failingPort("malformed")),
      await pollThroughGateway(failingPort("unknown")),
    ];

    // 7 causes in, 7 distinct causes and 7 distinct renderings out.
    expect(new Set(results.map((r) => r.cause)).size).toBe(results.length);
    expect(new Set(results.map((r) => r.healthReason)).size).toBe(results.length);
    // 16.4 is untouched by the C2 restore: coverage-degrade is still fail-VISIBLE on
    // an ADVANCED pass (records committed, cursor advanced).
    expect(coverage.status).toBe("advanced");
    expect(coverage.cursorAdvanced).toBe(true);
    expect(coverage.cause).toBe("coverage_incomplete");
  });
});

// ---------------------------------------------------------------------------
// The mechanism the cause derivation rests on — pinned, not assumed
// ---------------------------------------------------------------------------

describe("spec(REQ-I-005) C2 — the observed error code never masquerades as the wrong cause", () => {
  it("a transient that was RETRIED and then SUCCEEDED does not become the cause of a later consumer hold", async () => {
    // Page 1 is rate-limited once, then succeeds and its records are handed to the
    // consumer, which rejects ⇒ a consumer hold whose LAST observed fetch code is
    // `rate_limited`. The cause must still be `consumer_rejected`: the gateway's own
    // `health: "reachable"` verdict is what gates reading the observed code at all.
    let call = 0;
    const flaky: ConnectorPort = {
      connectorId: CONNECTOR.connectorId,
      fetch: () => {
        call += 1;
        return call === 1
          ? Promise.resolve(err({ code: "rate_limited" as const, message: "429" }))
          : Promise.resolve(ok({ records: [RECORD], nextCursor: "c1", done: true }));
      },
    };
    const held = await pollThroughGateway(
      flaky,
      syncDeps({
        backoffCfg: { baseMs: 1, maxMs: 1, maxAttempts: 3 },
        onRecords: () =>
          Promise.resolve(err({ code: "downstream_rejected" as const, message: "rejected" })),
      }),
    );

    expect(call).toBeGreaterThan(1); // the retry really happened
    expect(held.status).toBe("held");
    expect(held.cause).toBe("consumer_rejected");
    expect(held.healthReason).not.toContain("rate_limited");
  });

  it("a clean advanced pass carries no cause and no reason at all", async () => {
    const advanced = await pollThroughGateway({
      connectorId: CONNECTOR.connectorId,
      fetch: () => Promise.resolve(ok({ records: [], nextCursor: "c1", done: true })),
    });
    expect(advanced.status).toBe("advanced");
    expect(advanced.cause).toBeUndefined();
    expect(advanced.healthReason).toBeUndefined();
  });

  it("no adapter-authored text rides along on ANY of the discriminated arms (safety rule 7)", async () => {
    // `failingPort` puts a token-bearing URL and a vault path in every
    // `ConnectorError.message`. The restore reads the error's CODE, never its
    // MESSAGE — this pins that the widened rendering did not widen the boundary.
    for (const code of ["auth_locked", "rate_limited", "unreachable", "malformed", "unknown"] as const) {
      const serialized = JSON.stringify(await pollThroughGateway(failingPort(code)));
      expect(serialized).not.toContain("sk-LEAKME");
      expect(serialized).not.toContain("api.vendor.example");
      expect(serialized).not.toContain("/Users/x/vault/n.md");
    }
  });
});
