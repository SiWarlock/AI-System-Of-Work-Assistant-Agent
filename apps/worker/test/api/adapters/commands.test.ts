// Task 8.4 (integrator step) — the @sow/db + dispatch-seam command-port adapters,
// over a REAL genesis-migrated in-memory sqlite. The load-bearing (safety-critical)
// behaviors:
//   • the approval command applies EXACTLY ONCE via the real @sow/db CAS — the first
//     genuine transition returns applied:true and drives the dispatch port ONCE;
//   • a SECOND-CHANNEL replay (the same decision from Telegram after the Mac apply)
//     is an idempotent no-op — applied:false, NO second durable write, and NO second
//     dispatch (REQ-F-012 / §9 exactly-once; safety 1 + 3 one-writer);
//   • the durable row moved exactly once (a re-read shows the single applied status);
//   • the triage port REUSES the caller's idempotencyKey verbatim (ING-4 replay-safe)
//     and routes the effect ONLY through the injected dispatch (never a direct write).
import { describe, it, expect, afterEach } from "vitest";
import { ok, isErr, isOk } from "@sow/contracts";
import type { Approval, Result, FailureVariant } from "@sow/contracts";
import { openDatabase, type OpenDatabase } from "../../../src/composition/backends";
import {
  createDbApprovalCommandPort,
  createDbTriagePort,
  type TriageDispatchFn,
} from "../../../src/api/adapters/commands";
import { decideApprovalCommand } from "../../../src/api/procedures/approvalCommands";
import { disposeTriageCommand } from "../../../src/api/procedures/triageCommands";

// --- real migrated in-memory sqlite (genesis-migrated repos) ----------------
const opened: OpenDatabase[] = [];
afterEach(() => {
  for (const o of opened.splice(0)) o.conn.close();
});
async function freshDb(): Promise<OpenDatabase> {
  const o = await openDatabase({ dbPath: ":memory:" });
  opened.push(o);
  return o;
}

const NOW = "2026-07-02T12:00:00.000Z";
const clock = (): string => NOW;

function pendingApproval(id: string): Approval {
  return {
    id: id as Approval["id"],
    actionRef: `act-${id}` as Approval["actionRef"],
    workspaceId: "ws-001" as Approval["workspaceId"],
    status: "pending",
    actor: "user:cody",
    channel: "mac",
    payloadHash: "sha256:pending",
  };
}

/** A recording dispatch — proves the genuine transition drives the side effect ONCE. */
function recordingDispatch(): {
  fn: (a: Approval) => Promise<Result<void, FailureVariant>>;
  calls: Approval[];
} {
  const calls: Approval[] = [];
  return {
    calls,
    fn: (a: Approval): Promise<Result<void, FailureVariant>> => {
      calls.push(a);
      return Promise.resolve(ok(undefined));
    },
  };
}

// ── (a) approval command port over the real @sow/db CAS ───────────────────────

describe("createDbApprovalCommandPort — exactly-once over the real @sow/db CAS", () => {
  it("applies a pending→approved transition EXACTLY ONCE and dispatches once", async () => {
    const o = await freshDb();
    const seeded = await o.repos.approvals.create(pendingApproval("apr-1"));
    if (isErr(seeded)) throw new Error("seed failed");

    const port = createDbApprovalCommandPort(o.repos.approvals);
    const dispatch = recordingDispatch();

    const res = await decideApprovalCommand(
      { approvals: port, dispatchApproval: dispatch.fn, now: clock },
      { approvalId: "apr-1", decision: "approve", channel: "mac" },
    );

    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.applied).toBe(true);
      expect(res.value.approval.status).toBe("approved");
    }
    // Genuine transition → dispatched exactly once.
    expect(dispatch.calls.length).toBe(1);

    // The durable row moved exactly once.
    const row = await o.repos.approvals.get("apr-1" as Approval["id"]);
    expect(isOk(row)).toBe(true);
    if (isOk(row)) expect(row.value.status).toBe("approved");
  });

  it("a SECOND-CHANNEL replay is an idempotent no-op — no 2nd apply, no 2nd dispatch", async () => {
    const o = await freshDb();
    const seeded = await o.repos.approvals.create(pendingApproval("apr-2"));
    if (isErr(seeded)) throw new Error("seed failed");

    const port = createDbApprovalCommandPort(o.repos.approvals);
    const dispatch = recordingDispatch();
    const deps = { approvals: port, dispatchApproval: dispatch.fn, now: clock };

    // Channel 1 (Mac) applies.
    const first = await decideApprovalCommand(deps, {
      approvalId: "apr-2",
      decision: "approve",
      channel: "mac",
    });
    expect(isOk(first)).toBe(true);
    if (isOk(first)) expect(first.value.applied).toBe(true);

    // Channel 2 (Telegram) replays the SAME decision — idempotent no-op.
    const second = await decideApprovalCommand(deps, {
      approvalId: "apr-2",
      decision: "approve",
      channel: "telegram",
    });
    expect(isOk(second)).toBe(true);
    if (isOk(second)) {
      expect(second.value.applied).toBe(false); // NO durable write.
      expect(second.value.approval.status).toBe("approved");
    }

    // Exactly-once: dispatched ONCE total across both channels.
    expect(dispatch.calls.length).toBe(1);
  });

  it("reject on an already-terminal (approved) item is a typed err with NO state change", async () => {
    const o = await freshDb();
    const seeded = await o.repos.approvals.create({
      ...pendingApproval("apr-3"),
      status: "approved",
    });
    if (isErr(seeded)) throw new Error("seed failed");

    const port = createDbApprovalCommandPort(o.repos.approvals);
    const dispatch = recordingDispatch();

    const res = await decideApprovalCommand(
      { approvals: port, dispatchApproval: dispatch.fn, now: clock },
      { approvalId: "apr-3", decision: "reject", channel: "mac" },
    );
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.kind).toBe("write_conflict");
    // No dispatch on a rejected transition.
    expect(dispatch.calls.length).toBe(0);
    // Row unchanged.
    const row = await o.repos.approvals.get("apr-3" as Approval["id"]);
    if (isOk(row)) expect(row.value.status).toBe("approved");
  });

  it("a defer stamps snoozeUntil/expiresAt from the injected clock (durable)", async () => {
    const o = await freshDb();
    const seeded = await o.repos.approvals.create(pendingApproval("apr-4"));
    if (isErr(seeded)) throw new Error("seed failed");

    const port = createDbApprovalCommandPort(o.repos.approvals);
    const dispatch = recordingDispatch();
    const res = await decideApprovalCommand(
      { approvals: port, dispatchApproval: dispatch.fn, now: clock },
      { approvalId: "apr-4", decision: "defer", channel: "mac" },
    );
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.approval.status).toBe("deferred");
      expect(res.value.approval.snoozeUntil).toBeDefined();
      expect(res.value.approval.expiresAt).toBeDefined();
    }
    const row = await o.repos.approvals.get("apr-4" as Approval["id"]);
    if (isOk(row)) {
      expect(row.value.status).toBe("deferred");
      expect(row.value.snoozeUntil).toBeDefined();
    }
  });
});

// ── (b) triage port over the injected dispatch seam ───────────────────────────

describe("createDbTriagePort — verbatim idempotencyKey reuse over the dispatch seam", () => {
  it("reuses the caller's idempotencyKey verbatim (ING-4) and dispatches only via the seam", async () => {
    const dispatched: Array<{ sourceId: string; idempotencyKey: string; disposition: string }> = [];
    const dispatch: TriageDispatchFn = (input) => {
      dispatched.push(input);
      return Promise.resolve(ok({ idempotencyKey: input.idempotencyKey }));
    };
    const port = createDbTriagePort(dispatch);

    const res = await disposeTriageCommand(
      { triage: port },
      { sourceId: "src-1", idempotencyKey: "idem-verbatim-1", disposition: "accept" },
    );
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect(res.value.idempotencyKey).toBe("idem-verbatim-1");
    // The ONLY effect is the injected dispatch, with the key reused verbatim.
    expect(dispatched.length).toBe(1);
    expect(dispatched[0]!.idempotencyKey).toBe("idem-verbatim-1");
    expect(dispatched[0]!.sourceId).toBe("src-1");
    expect(dispatched[0]!.disposition).toBe("accept");
  });

  it("a REPLAY (same idempotencyKey) lands the SAME key through the seam — one effect per key", async () => {
    const dispatched: string[] = [];
    // A dedupe-aware dispatch: the Temporal client dedupes by the key at boot; here
    // we model that the SAME key is passed through both times (replay-safe).
    const dispatch: TriageDispatchFn = (input) => {
      dispatched.push(input.idempotencyKey);
      return Promise.resolve(ok({ idempotencyKey: input.idempotencyKey }));
    };
    const port = createDbTriagePort(dispatch);
    const input = { sourceId: "src-2", idempotencyKey: "idem-replay", disposition: "reroute" };

    await disposeTriageCommand({ triage: port }, input);
    await disposeTriageCommand({ triage: port }, input);
    // Both re-entries carried the IDENTICAL key — the pipeline dedupes on it (ING-4).
    expect(dispatched).toEqual(["idem-replay", "idem-replay"]);
  });

  it("a dispatch fault surfaces as a typed err (never throws across the boundary)", async () => {
    const dispatch: TriageDispatchFn = () =>
      Promise.resolve({
        ok: false,
        error: { kind: "degraded_unavailable", message: "temporal unavailable", retryable: true },
      });
    const port = createDbTriagePort(dispatch);
    const res = await disposeTriageCommand(
      { triage: port },
      { sourceId: "src-3", idempotencyKey: "idem-3", disposition: "accept" },
    );
    expect(isErr(res)).toBe(true);
    if (isErr(res)) expect(res.error.kind).toBe("degraded_unavailable");
  });
});
