// spec(§9) — task 7.9 APPROVAL-FLOW ACTIVITIES: the ports implemented over the
// real-shape ApprovalRepository CAS + the Tool Gateway + parity card renderer.
//
// These tests exercise the ACTIVITY layer (src/activities/approvalTransition.ts)
// against a test-local in-memory ApprovalRepository that models the DB's CAS
// contract (applyTransition is compare-and-set on expectedFromStatus, returning a
// `conflict` when the stored status no longer equals the expected from). They pin
// the EXACTLY-ONCE-across-both-channels property at the activity boundary (the
// driver tests pin it at the orchestration boundary with fakes):
//   • the apply CAS commits once; a second same-target apply is an idempotent no-op.
//   • a move onto a DIFFERENT terminal is a conflicting_approval.
//   • an expired approval can NEVER move to approved (the machine rejects the edge).
//   • record is idempotent by the envelope idempotencyKey (no second card).
//   • surface fails closed on a card parity break (one channel down).
import { describe, it, expect } from "vitest";
import { ok, err, isOk } from "@sow/contracts";
import type { Approval } from "@sow/contracts";
import { decideApprovalCas } from "@sow/db";
import type { ApprovalRepository, ApprovalTransitionOutcome, DbError, DbResult } from "@sow/db";
import {
  createRecordPendingActivity,
  createSurfaceCardActivity,
  createApplyTransitionActivity,
  createDispatchApprovedActivity,
} from "../src/activities/approvalTransition";
import type {
  RecordPendingGateway,
  CardRenderer,
  ApprovedDispatchGateway,
} from "../src/activities/approvalTransition";
import { makeApproval, makeApprovalContext, makeEnvelope, makeProposedAction } from "./support/approval-fakes";

// --- a test-local in-memory ApprovalRepository modeling the CAS contract ----

class InMemoryApprovalRepo implements ApprovalRepository {
  private readonly byId = new Map<string, Approval>();
  /** Number of DISTINCT durable transitions (a CAS conflict does NOT bump this). */
  applyCount = 0;

  seed(a: Approval): void {
    this.byId.set(a.id, a);
  }

  create(approval: Approval): DbResult<Approval> {
    if (this.byId.has(approval.id)) {
      return Promise.resolve(err({ code: "conflict", message: "exists" } satisfies DbError));
    }
    this.byId.set(approval.id, approval);
    return Promise.resolve(ok(approval));
  }
  get(id: Approval["id"]): DbResult<Approval> {
    const found = this.byId.get(id);
    return Promise.resolve(
      found === undefined ? err({ code: "not_found", message: id } satisfies DbError) : ok(found),
    );
  }
  listByStatus(status: Approval["status"]): DbResult<Approval[]> {
    return Promise.resolve(ok([...this.byId.values()].filter((a) => a.status === status)));
  }
  listByStatusAndWorkspace(
    status: Approval["status"],
    workspaceId: Approval["workspaceId"],
  ): DbResult<Approval[]> {
    return Promise.resolve(
      ok([...this.byId.values()].filter((a) => a.status === status && a.workspaceId === workspaceId)),
    );
  }
  applyTransition(
    id: Approval["id"],
    expectedFromStatus: Approval["status"],
    next: Approval,
  ): DbResult<ApprovalTransitionOutcome> {
    const current = this.byId.get(id);
    if (current === undefined) {
      return Promise.resolve(err({ code: "not_found", message: id } satisfies DbError));
    }
    // PARITY WITH THE SHIPPED ADAPTER: decide the CAS with the SAME shared 2.5
    // invariant (`decideApprovalCas`) both the sqlite + pg adapters use, so this
    // fake exercises the REAL activity+adapter pairing, and SURFACES `applied` the
    // same way (genuine transition → applied:true; idempotent no-op → applied:false).
    // A SAME-TARGET decision (current === next, e.g. a second-channel approve on an
    // already-approved record) is `idempotent_noop` → ok({applied:false}) — NOT a
    // conflict; only a stale DIFFERENT-target CAS (or a move out of a terminal) is.
    const verdict = decideApprovalCas(current.status, expectedFromStatus, next.status);
    switch (verdict.kind) {
      case "apply":
        this.byId.set(id, next);
        this.applyCount += 1;
        return Promise.resolve(ok({ approval: next, applied: true }));
      case "idempotent_noop":
        // No durable write, no applyCount bump — the record already holds the target.
        return Promise.resolve(ok({ approval: current, applied: false }));
      case "stale_conflict":
        return Promise.resolve(err({ code: "conflict", message: "stale" } satisfies DbError));
    }
  }
}

// --- seams -----------------------------------------------------------------

const okGateway: RecordPendingGateway = {
  reservePending(envelope) {
    return Promise.resolve(ok({ envelope, created: true }));
  },
};

const bothChannelsRenderer: CardRenderer = {
  render() {
    return Promise.resolve(ok(undefined));
  },
};

function partialRenderer(down: "mac" | "telegram"): CardRenderer {
  return {
    render(_a, channel) {
      return channel === down
        ? Promise.resolve(err({ message: `${channel} down` }))
        : Promise.resolve(ok(undefined));
    },
  };
}

const NOW = "2026-07-01T00:00:00.000Z";
const SNOOZE_UNTIL = "2026-07-02T00:00:00.000Z";
const EXPIRES_AT = "2026-07-08T00:00:00.000Z";

// --- record activity -------------------------------------------------------

describe("createRecordPendingActivity — idempotent record", () => {
  it("creates a pending approval once; a re-drive reuses it (created:false, no 2nd card)", async () => {
    const approvals = new InMemoryApprovalRepo();
    const record = createRecordPendingActivity({
      gateway: okGateway,
      approvals,
      now: NOW,
      expiresAt: EXPIRES_AT,
      actor: "user:alice",
      seedChannel: "mac",
    });
    const ctx = makeApprovalContext();

    const first = await record.record(ctx);
    expect(isOk(first)).toBe(true);
    if (isOk(first)) expect(first.value.created).toBe(true);

    const second = await record.record(ctx);
    expect(isOk(second)).toBe(true);
    if (isOk(second)) {
      expect(second.value.created).toBe(false); // idempotent — no 2nd card
      if (isOk(first)) expect(second.value.approval.id).toBe(first.value.approval.id);
    }
  });

  it("folds a gateway precondition failure to precondition_failed", async () => {
    const approvals = new InMemoryApprovalRepo();
    const gateway: RecordPendingGateway = {
      reservePending() {
        return Promise.resolve(err({ code: "precondition_failed", message: "stale" }));
      },
    };
    const record = createRecordPendingActivity({
      gateway,
      approvals,
      now: NOW,
      expiresAt: EXPIRES_AT,
      actor: "user:alice",
      seedChannel: "mac",
    });
    const res = await record.record(makeApprovalContext());
    expect(isOk(res)).toBe(false);
    if (!isOk(res)) expect(res.error.code).toBe("precondition_failed");
  });

  it("R3 (24.73 restore round): forwards a gateway failure verbatim — NOT redacted", async () => {
    // The deleted `redactRecordPendingGatewayError`'s own comment conceded it guards
    // nothing today (the bound gateway, buildActivities.ts's `recordPendingGateway`,
    // always returns `ok`), while costing the operator a real diagnostic if that
    // binding ever fails closed — e.g. a locked-Keychain message on a future
    // credential-backed reservation. This pins the restore.
    const approvals = new InMemoryApprovalRepo();
    const gateway: RecordPendingGateway = {
      reservePending() {
        return Promise.resolve(
          err({ code: "record_failed", message: "keychain locked: unlock it and retry" }),
        );
      },
    };
    const record = createRecordPendingActivity({
      gateway,
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
    // RESTORED: the gateway's own diagnostic message crosses verbatim — a
    // mutation-proof pin (a re-added redaction would replace this with a fixed
    // literal, failing this assertion).
    expect(res.error.message).toBe("keychain locked: unlock it and retry");
  });

  it("R3 (24.73 restore round): KEEP — a create() DbError's raw `cause` never crosses (record_failed)", async () => {
    // Distinct from the gateway-forward test above: this pins the OTHER dropCause
    // site in this file — deps.approvals.create()'s DbError. Unlike the gateway
    // failure (never populates cause in practice), a real DbError's `cause` can be
    // the raw driver throw (a DSN, a stack) per this file's own comment on the
    // dropCause call site — it must NEVER cross. Re-read also fails (not_found) so
    // the activity actually reaches the dropCause branch, not the re-read-reuse one.
    const poisonedCause = { dsn: "postgres://u:SECRET-DSN@h/db" };
    const approvals: ApprovalRepository = {
      create: () =>
        Promise.resolve(
          err({ code: "constraint_violation", message: "db said no", cause: poisonedCause } satisfies DbError),
        ),
      get: () => Promise.resolve(err({ code: "not_found", message: "no such id" } satisfies DbError)),
      listByStatus: () => Promise.resolve(ok([])),
      listByStatusAndWorkspace: () => Promise.resolve(ok([])),
      applyTransition: () => Promise.resolve(err({ code: "not_found", message: "n/a" } satisfies DbError)),
    };
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
    // The message interpolates only the CLOSED DbErrorCode — never driver text.
    expect(res.error.message).toBe("pending approval create failed: constraint_violation");
    // KEPT: cause is stripped — the DSN never crosses.
    expect(res.error.cause).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain("SECRET-DSN");
  });
});

// --- surface activity (parity) ---------------------------------------------

describe("createSurfaceCardActivity — Mac + Telegram parity", () => {
  it("renders on BOTH channels with parity", async () => {
    const surface = createSurfaceCardActivity(bothChannelsRenderer);
    const res = await surface.surface(makeApproval());
    expect(isOk(res)).toBe(true);
    if (isOk(res)) expect([...res.value.channels].sort()).toEqual(["mac", "telegram"]);
  });

  it("fails closed with parity_failed when one channel is down (no single-channel card)", async () => {
    const surface = createSurfaceCardActivity(partialRenderer("telegram"));
    const res = await surface.surface(makeApproval());
    expect(isOk(res)).toBe(false);
    if (!isOk(res)) {
      expect(res.error.code).toBe("parity_failed");
      expect(res.error.rendered).toEqual(["mac"]); // only mac rendered
    }
  });
});

// --- apply activity (CAS, exactly-once across both channels) ----------------

describe("createApplyTransitionActivity — EXACTLY-ONCE CAS", () => {
  function activity(approvals: InMemoryApprovalRepo) {
    return createApplyTransitionActivity({
      approvals,
      now: NOW,
      snoozeUntil: SNOOZE_UNTIL,
      expiresAt: EXPIRES_AT,
    });
  }

  it("commits an approve once; a 2nd approve from the other channel is a no-op", async () => {
    const approvals = new InMemoryApprovalRepo();
    const pending = makeApproval({ status: "pending", channel: "mac" });
    approvals.seed(pending);
    const apply = activity(approvals);

    const first = await apply.apply(pending, { decision: "approved", channel: "mac", actor: "user:alice" });
    expect(isOk(first)).toBe(true);
    if (isOk(first)) expect(first.value.applied).toBe(true);
    expect(approvals.applyCount).toBe(1);

    // Telegram approves the SAME approval (still holding the stale pending snapshot).
    const second = await apply.apply(pending, { decision: "approved", channel: "telegram", actor: "user:alice" });
    expect(isOk(second)).toBe(true);
    if (isOk(second)) {
      expect(second.value.applied).toBe(false); // idempotent no-op
      expect(second.value.noopReason).toBe("already_terminal");
    }
    expect(approvals.applyCount).toBe(1); // no double-apply / double-audit
  });

  // REGRESSION (adversarial-verify HIGH): the shipped ApprovalRepository returns
  // `idempotent_noop` → ok(current) (NOT err(conflict)) for a SAME-TARGET apply
  // where the caller's `from` ALREADY equals the target (approved → approved). The
  // driver re-reads the durable record before applying (record activity), so a
  // second-channel / replay approve arrives with from = current = "approved". On the
  // buggy code the activity hit the isOk(res) branch and returned { applied: TRUE },
  // which would let the driver's `if (!applied) return` guard be SKIPPED and dispatch
  // fire a SECOND time. It MUST be an idempotent no-op (applied:false, no CAS write).
  it("a same-target apply on an ALREADY-approved record is a no-op (applied:false), matching decideApprovalCas", async () => {
    const approvals = new InMemoryApprovalRepo();
    // The record is ALREADY approved (Mac already decided + the driver re-read it).
    const approved = makeApproval({ status: "approved", channel: "mac", actor: "user:alice" });
    approvals.seed(approved);
    const apply = activity(approvals);

    // Telegram approves the now-approved record: from = current = to = "approved".
    const res = await apply.apply(approved, { decision: "approved", channel: "telegram", actor: "user:alice" });
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.applied).toBe(false); // NOT true — no second apply
      expect(res.value.noopReason).toBe("already_terminal");
    }
    expect(approvals.applyCount).toBe(0); // zero durable transitions (no double-apply)
  });

  it("a move onto a DIFFERENT terminal is a conflicting_approval", async () => {
    const approvals = new InMemoryApprovalRepo();
    const pending = makeApproval({ status: "pending" });
    approvals.seed(pending);
    const apply = activity(approvals);

    // Mac approves.
    const macRes = await apply.apply(pending, { decision: "approved", channel: "mac", actor: "user:alice" });
    expect(isOk(macRes)).toBe(true);

    // Telegram REJECTS the same (stale) pending snapshot — a different terminal.
    const tgRes = await apply.apply(pending, { decision: "rejected", channel: "telegram", actor: "user:bob" });
    expect(isOk(tgRes)).toBe(false);
    if (!isOk(tgRes)) expect(tgRes.error.code).toBe("conflicting_approval");
    expect(approvals.applyCount).toBe(1); // still only ONE durable transition
  });

  it("an EXPIRED approval can NEVER move to approved (expired code, no transition)", async () => {
    const approvals = new InMemoryApprovalRepo();
    const expired = makeApproval({ status: "expired" });
    approvals.seed(expired);
    const apply = activity(approvals);

    const res = await apply.apply(expired, { decision: "approved", channel: "mac", actor: "user:alice" });
    expect(isOk(res)).toBe(false);
    if (!isOk(res)) expect(res.error.code).toBe("expired");
    expect(approvals.applyCount).toBe(0);
  });

  it("applySystem re-surfaces deferred → pending and auto-expires deferred → expired", async () => {
    const approvals = new InMemoryApprovalRepo();
    const deferred = makeApproval({ status: "deferred", snoozeUntil: SNOOZE_UNTIL });
    approvals.seed(deferred);
    const apply = activity(approvals);

    const resurfaced = await apply.applySystem(deferred, "resurface");
    expect(isOk(resurfaced)).toBe(true);
    if (isOk(resurfaced)) {
      expect(resurfaced.value.approval.status).toBe("pending");
      // snoozeUntil is cleared on a non-deferred record (contract refine).
      expect(resurfaced.value.approval.snoozeUntil).toBeUndefined();
    }

    // A fresh deferred record auto-expires.
    const approvals2 = new InMemoryApprovalRepo();
    const deferred2 = makeApproval({ id: makeApproval().id, status: "deferred" });
    approvals2.seed(deferred2);
    const apply2 = activity(approvals2);
    const expired = await apply2.applySystem(deferred2, "expire");
    expect(isOk(expired)).toBe(true);
    if (isOk(expired)) expect(expired.value.approval.status).toBe("expired");
  });

  it("a deferral stamps snoozeUntil (snoozeUntil ⇔ deferred contract)", async () => {
    const approvals = new InMemoryApprovalRepo();
    const pending = makeApproval({ status: "pending" });
    approvals.seed(pending);
    const apply = activity(approvals);

    const res = await apply.apply(pending, { decision: "deferred", channel: "mac", actor: "user:alice" });
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.approval.status).toBe("deferred");
      expect(res.value.approval.snoozeUntil).toBe(SNOOZE_UNTIL);
    }
  });

  it("R3 (24.73 restore round): KEEP — the CAS DbError's raw `cause` never crosses (apply_failed)", async () => {
    // Mirrors the record-activity pin above for THIS file's other DbError dropCause
    // site: applyTransition's own DbError (any non-conflict code folds to
    // apply_failed via foldApplyDbError's default arm). `cause` can be a raw driver
    // throw (a DSN, a stack) — it must never cross; only the stable folded code +
    // a message built from the CLOSED DbErrorCode do.
    const poisonedCause = { dsn: "postgres://u:SECRET-DSN-2@h/db" };
    const approvals: ApprovalRepository = {
      create: () => Promise.resolve(ok(makeApproval())),
      get: () => Promise.resolve(err({ code: "not_found", message: "n/a" } satisfies DbError)),
      listByStatus: () => Promise.resolve(ok([])),
      listByStatusAndWorkspace: () => Promise.resolve(ok([])),
      applyTransition: () =>
        Promise.resolve(
          err({ code: "unavailable", message: "db down", cause: poisonedCause } satisfies DbError),
        ),
    };
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
    expect(res.error.message).toBe("apply transition failed: unavailable");
    expect(res.error.cause).toBeUndefined();
    expect(JSON.stringify(res)).not.toContain("SECRET-DSN-2");
  });
});

// --- dispatch activity (envelope reuse) ------------------------------------

describe("createDispatchApprovedActivity — Tool Gateway envelope", () => {
  it("delegates to the gateway and reports created / reused", async () => {
    let calls = 0;
    const gateway: ApprovedDispatchGateway = {
      dispatch(_action, envelope) {
        calls += 1;
        const status = calls === 1 ? "created" : "reused";
        return Promise.resolve(ok({ status, envelope }));
      },
    };
    const dispatch = createDispatchApprovedActivity(gateway);
    const first = await dispatch.dispatch(makeProposedAction(), makeEnvelope());
    expect(isOk(first)).toBe(true);
    if (isOk(first)) expect(first.value.status).toBe("created");
    const second = await dispatch.dispatch(makeProposedAction(), makeEnvelope());
    if (isOk(second)) expect(second.value.status).toBe("reused");
  });

  it("folds a held gateway outcome to the closed dispatch error", async () => {
    const gateway: ApprovedDispatchGateway = {
      dispatch() {
        return Promise.resolve(err({ code: "held", message: "gateway held" }));
      },
    };
    const dispatch = createDispatchApprovedActivity(gateway);
    const res = await dispatch.dispatch(makeProposedAction(), makeEnvelope());
    expect(isOk(res)).toBe(false);
    if (!isOk(res)) expect(res.error.code).toBe("held");
  });
});
