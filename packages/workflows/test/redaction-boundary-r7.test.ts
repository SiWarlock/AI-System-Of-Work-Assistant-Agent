// spec(safety rule 7 / task 24.73 §16 never-throw sweep) — REDACT: close the
// rule-7 leaks in three REGISTERED Temporal activities this package owns:
//   • connectorPoll.ts        → registered `connectorPoll`
//   • systemHealthSurfacing.ts → registered `surfaceFailure` + the four
//     `*SurfaceFailure` sinks (all route through the SAME `surfaceWorkflowFailure`)
//   • approvalTransition.ts   → registered `approvalRecordPending` + `approvalApply`
//
// THE ARCHITECTURAL FACT: registering a function as a Temporal activity turns
// its return value into durable, REPLAYED workflow history — a log sink under
// safety rule 7. A raw `cause` forwarded from any of these three files is
// exactly the hazard: a provider/HTTP error carrying a URL+token, a DB driver
// error carrying a DSN, or an fs error carrying an absolute vault path.
//
// Each suite drives the activity through a HOSTILE injected dependency that
// fails carrying POISON — a secret marker, a foreign-DSN marker, or a REAL
// Node fs error with a stack trace + an absolute path as OWN ENUMERABLE
// properties (the exact reachable shape: unlike `new Error()`, whose
// message/stack are NON-enumerable, an fs ENOENT exposes `.path`/`.code`/
// `.errno`/`.syscall` as own enumerable properties, so it actually makes a
// `JSON.stringify` hostile-fixture assertion meaningful) — and asserts the
// poison is ABSENT from `JSON.stringify` of the WHOLE activity result, while
// the stable, closed `code` still crosses byte-identically (every workflow
// driver switches on it).
import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ok, err, isOk, auditId } from "@sow/contracts";
import type { Approval, HealthItem, Result } from "@sow/contracts";
import type { ApprovalRepository, ApprovalTransitionOutcome, DbError, DbResult } from "@sow/db";
import type { ConnectorPort, ConnectorSyncDeps } from "@sow/integrations";
import { createConnectorPollActivity } from "../src/activities/connectorPoll";
import type { ConnectorPollActivityDeps } from "../src/activities/connectorPoll";
import type { ConnectorTarget } from "../src/workflows/connectorSyncHealth";
import { surfaceWorkflowFailure } from "../src/workflows/systemHealthSurfacing";
import type { OutboxSink } from "../src/workflows/systemHealthSurfacing";
import type { Clock, HealthItemStore, OutboxEntry } from "../src/ports/operational";
import {
  createRecordPendingActivity,
  createApplyTransitionActivity,
} from "../src/activities/approvalTransition";
import type { RecordPendingGateway } from "../src/activities/approvalTransition";
import { makeApproval, makeApprovalContext } from "./support/approval-fakes";

// ---------------------------------------------------------------------------
// Shared hostile fixtures (mirrors output-activities/cause-redaction-boundary.test.ts)
// ---------------------------------------------------------------------------

const SECRET_POISON = "PZN9F3A1BSECRET-leak";
const URL_TOKEN_POISON = `https://api.example.com/v1?token=${SECRET_POISON}`;
const DSN_POISON = `postgres://u:${SECRET_POISON}@h/db`;
const POISON_DIR_NAME = "sow-r7-poison-does-not-exist";

/**
 * A REAL Node fs ENOENT error — carries an absolute path + a stack trace, and
 * (unlike a bare `new Error(...)`, whose `message`/`stack` are NON-enumerable)
 * exposes `.path`/`.code`/`.errno`/`.syscall` as OWN ENUMERABLE properties —
 * the exact reachable shape the census names ("a thrown fs error object
 * carrying an absolute vault path and a stack trace").
 */
function realFsPoison(): NodeJS.ErrnoException {
  const poisonPath = path.join(os.tmpdir(), POISON_DIR_NAME, "SECRETMARKER.md");
  try {
    fs.readFileSync(poisonPath);
    throw new Error("unreachable: poison path must not exist");
  } catch (e) {
    return e as NodeJS.ErrnoException;
  }
}

function expectNoPoison(serialized: string): void {
  expect(serialized).not.toContain(SECRET_POISON);
  expect(serialized).not.toContain(URL_TOKEN_POISON);
  expect(serialized).not.toContain(DSN_POISON);
  expect(serialized).not.toContain(POISON_DIR_NAME);
}

// ===========================================================================
// (A) connectorPoll.ts — createConnectorPollActivity: registered `connectorPoll`
// ===========================================================================

const CONNECTOR: ConnectorTarget = { connectorId: "drive-corp", workspaceId: "ws-1" };

function makeHostileResolveDeps(cause: unknown): ConnectorPollActivityDeps {
  return {
    resolve: () => {
      throw cause;
    },
  };
}

/** A minimal valid ConnectorSyncDeps so `runConnectorSync` reaches `port.fetch`. */
function makeSyncDeps(): ConnectorSyncDeps {
  return {
    cursors: {
      get: () => Promise.resolve(err({ code: "not_found", message: "no cursor" } as DbError)),
      upsert: (record) => Promise.resolve(ok(record)),
      listByConnector: () => Promise.resolve(ok([])),
    },
    workspaceId: "ws-1",
    onRecords: () => Promise.resolve(ok(undefined)),
    backoffCfg: { baseMs: 1, maxMs: 1, maxAttempts: 1 },
    clock: () => "2026-01-01T00:00:00.000Z",
  };
}

function makeHostileFetchDeps(cause: unknown): ConnectorPollActivityDeps {
  const port: ConnectorPort = {
    connectorId: CONNECTOR.connectorId,
    fetch: () => {
      throw cause;
    },
  };
  return {
    resolve: () => ({ port, syncDeps: makeSyncDeps() }),
  };
}

describe("createConnectorPollActivity — SAFETY RULE 7: no raw cause crosses the registered `connectorPoll` boundary", () => {
  it("a poisoned plain-object throw from `deps.resolve` never crosses — code still poll_failed", async () => {
    const activity = createConnectorPollActivity(makeHostileResolveDeps({ url: URL_TOKEN_POISON }));
    const r = await activity.poll(CONNECTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("poll_failed");
      expectNoPoison(JSON.stringify(r));
    }
  });

  it("a poisoned DSN-carrying throw from `deps.resolve` never crosses", async () => {
    const activity = createConnectorPollActivity(makeHostileResolveDeps({ dsn: DSN_POISON }));
    const r = await activity.poll(CONNECTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) expectNoPoison(JSON.stringify(r));
  });

  it("a REAL Node fs error thrown by `deps.resolve` (stack + absolute path) never crosses", async () => {
    const activity = createConnectorPollActivity(makeHostileResolveDeps(realFsPoison()));
    const r = await activity.poll(CONNECTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) expectNoPoison(JSON.stringify(r));
  });

  // §16 regression pin: `deps.resolve(connector)` used to sit OUTSIDE the try
  // block — a throwing resolve escaped the activity as an unhandled
  // rejection instead of folding to a typed err. This test would REJECT
  // (never resolve) on the pre-fix code; `.resolves` makes that failure loud.
  it("§16: a throwing `deps.resolve` resolves to a typed err — never an unhandled rejection", async () => {
    const activity = createConnectorPollActivity(makeHostileResolveDeps({ secret: SECRET_POISON }));
    await expect(activity.poll(CONNECTOR)).resolves.toMatchObject({
      ok: false,
      error: { code: "poll_failed" },
    });
  });

  it("a poisoned plain-object throw from the gateway's `port.fetch` (via runConnectorSync) never crosses", async () => {
    const activity = createConnectorPollActivity(makeHostileFetchDeps({ secret: SECRET_POISON, authorization: `Bearer sk-${SECRET_POISON}` }));
    const r = await activity.poll(CONNECTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("poll_failed");
      expectNoPoison(JSON.stringify(r));
    }
  });

  it("a REAL Node fs error thrown by `port.fetch` never crosses", async () => {
    const activity = createConnectorPollActivity(makeHostileFetchDeps(realFsPoison()));
    const r = await activity.poll(CONNECTOR);
    expect(r.ok).toBe(false);
    if (!r.ok) expectNoPoison(JSON.stringify(r));
  });
});

// ===========================================================================
// (B) systemHealthSurfacing.ts — surfaceWorkflowFailure: registered
//     `surfaceFailure` + the four `*SurfaceFailure` sinks
// ===========================================================================

const T0 = "2026-07-01T00:00:00.000Z";

class FakeClock implements Clock {
  constructor(private readonly opts: { now: string }) {}
  now(): string {
    return this.opts.now;
  }
}

function hostileOutbox(cause: unknown): OutboxSink {
  return {
    enqueueRetry: () => Promise.reject(cause),
  };
}

function hostileHealthStore(cause: unknown): HealthItemStore {
  return {
    getByDedupeKey: (): Promise<HealthItem | undefined> => Promise.resolve(undefined),
    put: (): Promise<void> => Promise.reject(cause),
    list: (): Promise<HealthItem[]> => Promise.resolve([]),
  };
}

function makeOutboxEntry(): OutboxEntry {
  return {
    outboxId: "ob-1",
    actionRef: "action-1",
    workspaceId: "ws-1",
    targetSystem: "gcal",
    canonicalObjectKey: "gcal:event:abc",
    idempotencyKey: "idem-1",
    payloadHash: "hash-1",
    status: "pending",
    attempts: 1,
    enqueuedAt: T0,
    updatedAt: T0,
  };
}

describe("surfaceWorkflowFailure — SAFETY RULE 7: no raw cause crosses the registered surfacing boundary", () => {
  it("outbox_failed: a poisoned plain-object throw from the outbox sink never crosses", async () => {
    const clock = new FakeClock({ now: T0 });
    const res = await surfaceWorkflowFailure(
      {
        failureClass: "write_through_failed",
        subjectRef: "gcal:event:abc",
        message: "target unreachable",
        auditRef: auditId("audit-1"),
        retry: makeOutboxEntry(),
      },
      { health: hostileHealthStore(new Error("unreached")), outbox: hostileOutbox({ url: URL_TOKEN_POISON, authorization: `Bearer ${SECRET_POISON}` }), clock },
    );
    expect(isOk(res)).toBe(false);
    if (isOk(res)) return;
    expect(res.error.code).toBe("outbox_failed");
    expectNoPoison(JSON.stringify(res));
  });

  it("outbox_failed: a REAL Node fs error thrown by the outbox sink never crosses", async () => {
    const clock = new FakeClock({ now: T0 });
    const res = await surfaceWorkflowFailure(
      {
        failureClass: "write_through_failed",
        subjectRef: "gcal:event:abc",
        message: "target unreachable",
        auditRef: auditId("audit-1"),
        retry: makeOutboxEntry(),
      },
      { health: hostileHealthStore(new Error("unreached")), outbox: hostileOutbox(realFsPoison()), clock },
    );
    expect(isOk(res)).toBe(false);
    if (isOk(res)) return;
    expectNoPoison(JSON.stringify(res));
  });

  it("surface_failed: a poisoned DSN-carrying throw from the health store's `put` (persist_failed) never crosses", async () => {
    const clock = new FakeClock({ now: T0 });
    const res = await surfaceWorkflowFailure(
      {
        failureClass: "worker_down",
        subjectRef: "worker-1",
        message: "down",
        auditRef: auditId("audit-1"),
      },
      { health: hostileHealthStore({ dsn: DSN_POISON }), outbox: hostileOutbox(new Error("unreached")), clock },
    );
    expect(isOk(res)).toBe(false);
    if (isOk(res)) return;
    expect(res.error.code).toBe("surface_failed");
    expectNoPoison(JSON.stringify(res));
  });

  it("surface_failed: a REAL Node fs error thrown by the health store's `put` never crosses", async () => {
    const clock = new FakeClock({ now: T0 });
    const res = await surfaceWorkflowFailure(
      {
        failureClass: "worker_down",
        subjectRef: "worker-1",
        message: "down",
        auditRef: auditId("audit-1"),
      },
      { health: hostileHealthStore(realFsPoison()), outbox: hostileOutbox(new Error("unreached")), clock },
    );
    expect(isOk(res)).toBe(false);
    if (isOk(res)) return;
    expectNoPoison(JSON.stringify(res));
  });
});

// ===========================================================================
// (C) approvalTransition.ts — registered `approvalRecordPending` + `approvalApply`
// ===========================================================================

const NOW = "2026-07-01T00:00:00.000Z";
const SNOOZE_UNTIL = "2026-07-02T00:00:00.000Z";
const EXPIRES_AT = "2026-07-08T00:00:00.000Z";

const okGateway: RecordPendingGateway = {
  reservePending(envelope) {
    return Promise.resolve(ok({ envelope, created: true }));
  },
};

/** A minimal ApprovalRepository whose every method is independently configurable. */
function makeHostileApprovalRepo(opts: {
  readonly createResult?: Result<Approval, DbError>;
  readonly getResult?: Result<Approval, DbError>;
  readonly applyResult?: Result<ApprovalTransitionOutcome, DbError>;
}): ApprovalRepository {
  return {
    create: (): DbResult<Approval> =>
      Promise.resolve(opts.createResult ?? err({ code: "unknown", message: "unused" })),
    get: (): DbResult<Approval> =>
      Promise.resolve(opts.getResult ?? err({ code: "not_found", message: "unused" })),
    listByStatus: (): DbResult<Approval[]> => Promise.resolve(ok([])),
    listByStatusAndWorkspace: (): DbResult<Approval[]> => Promise.resolve(ok([])),
    applyTransition: (): DbResult<ApprovalTransitionOutcome> =>
      Promise.resolve(opts.applyResult ?? err({ code: "unknown", message: "unused" })),
  };
}

describe("createRecordPendingActivity — SAFETY RULE 7: the nested DbError.cause never crosses `approvalRecordPending`", () => {
  it("a poisoned DSN-carrying DbError.cause on the create failure never crosses — code still record_failed", async () => {
    const approvals = makeHostileApprovalRepo({
      getResult: err({ code: "not_found", message: "no such approval" }),
      createResult: err({
        code: "unknown",
        message: "driver rejected the write",
        cause: { dsn: DSN_POISON },
      }),
    });
    const record = createRecordPendingActivity({
      gateway: okGateway,
      approvals,
      now: NOW,
      expiresAt: EXPIRES_AT,
      actor: "user:alice",
      seedChannel: "mac",
    });
    const res = await record.record(makeApprovalContext());
    expect(isOk(res)).toBe(false);
    if (isOk(res)) return;
    expect(res.error.code).toBe("record_failed");
    expectNoPoison(JSON.stringify(res));
  });

  it("a REAL Node fs error as the DbError.cause never crosses", async () => {
    const approvals = makeHostileApprovalRepo({
      getResult: err({ code: "not_found", message: "no such approval" }),
      createResult: err({
        code: "unknown",
        message: "driver rejected the write",
        cause: realFsPoison(),
      }),
    });
    const record = createRecordPendingActivity({
      gateway: okGateway,
      approvals,
      now: NOW,
      expiresAt: EXPIRES_AT,
      actor: "user:alice",
      seedChannel: "mac",
    });
    const res = await record.record(makeApprovalContext());
    expect(isOk(res)).toBe(false);
    if (isOk(res)) return;
    expectNoPoison(JSON.stringify(res));
  });
});

describe("createApplyTransitionActivity — SAFETY RULE 7: the nested DbError.cause never crosses `approvalApply`", () => {
  it("apply_failed: a poisoned plain-object DbError.cause on the CAS write never crosses", async () => {
    const approvals = makeHostileApprovalRepo({
      applyResult: err({
        code: "unavailable",
        message: "db connection dropped",
        cause: { url: URL_TOKEN_POISON, authorization: `Bearer ${SECRET_POISON}` },
      }),
    });
    const apply = createApplyTransitionActivity({
      approvals,
      now: NOW,
      snoozeUntil: SNOOZE_UNTIL,
      expiresAt: EXPIRES_AT,
    });
    const pending = makeApproval({ status: "pending" });
    const res = await apply.apply(pending, { decision: "approved", channel: "mac", actor: "user:alice" });
    expect(isOk(res)).toBe(false);
    if (isOk(res)) return;
    expect(res.error.code).toBe("apply_failed");
    expectNoPoison(JSON.stringify(res));
  });

  it("apply_failed: a REAL Node fs error as the DbError.cause never crosses", async () => {
    const approvals = makeHostileApprovalRepo({
      applyResult: err({ code: "unavailable", message: "db connection dropped", cause: realFsPoison() }),
    });
    const apply = createApplyTransitionActivity({
      approvals,
      now: NOW,
      snoozeUntil: SNOOZE_UNTIL,
      expiresAt: EXPIRES_AT,
    });
    const pending = makeApproval({ status: "pending" });
    const res = await apply.apply(pending, { decision: "approved", channel: "mac", actor: "user:alice" });
    expect(isOk(res)).toBe(false);
    if (isOk(res)) return;
    expectNoPoison(JSON.stringify(res));
  });

  // The domain approvalMachine's edge rejection is a lower-sensitivity, no-I/O
  // forward (no external channel to inject secret poison through) — pinned
  // structurally instead: the returned error carries ONLY code+message, no
  // `cause` key at all, byte-identical `illegal_transition` code.
  it("illegal_transition: the domain edge error is NEVER forwarded as `cause` (structural pin)", async () => {
    const approvals = makeHostileApprovalRepo({});
    const apply = createApplyTransitionActivity({
      approvals,
      now: NOW,
      snoozeUntil: SNOOZE_UNTIL,
      expiresAt: EXPIRES_AT,
    });
    // approved is terminal — a move to rejected is an illegal edge (never
    // reaches the CAS at all).
    const approved = makeApproval({ status: "approved" });
    const res = await apply.apply(approved, { decision: "rejected", channel: "mac", actor: "user:bob" });
    expect(isOk(res)).toBe(false);
    if (isOk(res)) return;
    expect(res.error.code).toBe("illegal_transition");
    expect(Object.keys(res.error).sort()).toEqual(["code", "message"]);
  });
});
