// @sow/integrations — slice 6.5 WRITE OUTBOX: hold-on-outage (test-first).
//
// The outbox is the fail-closed landing pad for a write that CANNOT dispatch right
// now (connector outage / adapter 'unreachable' / not-yet-approved-but-queued).
// Rather than dropping or failing the write, `holdWrite` persists the FULL
// envelope (idempotencyKey + canonicalObjectKey + payloadHash + targetSystem +
// payload + status) via OutboxRepository.enqueue, so the reconnect drain (6.5b)
// can re-drive it replay-safely.
//
// Invariants pinned here:
//   • HOLD-THROUGH-OUTAGE — a write attempted during 'unreachable' is enqueued
//     with its full envelope, not dropped, and mapped onto a NON-terminal status.
//   • Held items NEVER silently expire — a held entry is due (listDue returns it).
//   • Replay idempotency — re-holding the SAME idempotencyKey is a no-op (the
//     existing entry is reused, never a second enqueue).
//   • OBS-2 — outbox depth over a threshold reports a `breach` probe carrying an
//     `outbox_blocked` GatewayHealthSignal; held items are not expired by the
//     health check; a store fault reports `probe_failed`, never confusable with
//     an empty (healthy) queue (task 24.8).
//   • Reachability (task 24.8) — an OPTIONAL `HoldDeps.health` binding runs the
//     depth probe after a successful hold (replay-reuse or fresh enqueue) and
//     hands the result to an injected sink; with NO binding, `holdWrite` never
//     calls `listDue` (the shipped default stays dormant/unchanged).
import { describe, it, expect, vi } from "vitest";
import { isOk, isErr, err } from "@sow/contracts";
import type { DbError } from "@sow/db";
import {
  holdWrite,
  outboxHealth,
  toOutboxStatus,
  type HoldReason,
  type OutboxHealthProbe,
} from "../src/tools/outbox";
import { OUTBOX_BLOCKED_HEALTH_CLASS } from "../src/health/health-signal";
import {
  InMemoryOutbox,
  makeEnvelope,
  makeProposedAction,
  makeOutboxEntry,
} from "./support/fakes";

/**
 * An `InMemoryOutbox` whose `listDue` always faults — used only to exercise
 * `outboxHealth`'s `probe_failed` branch. Subclassed here (test-local, not in
 * `support/fakes.ts`) rather than modifying the shared fake.
 */
class FaultingListDueOutbox extends InMemoryOutbox {
  override async listDue(): ReturnType<InMemoryOutbox["listDue"]> {
    return err<DbError>({ code: "unavailable", message: "listDue store fault (test double)" });
  }
}

const clock = (): string => "2026-07-01T00:00:00.000Z";

describe("holdWrite — hold-through-outage", () => {
  it("HOLD-THROUGH-OUTAGE: an unreachable write is enqueued with its FULL envelope, not dropped", async () => {
    const outbox = new InMemoryOutbox();
    const env = makeEnvelope({ idempotencyKey: "idem_hold_1", canonicalObjectKey: "cok_drive_hold" });
    const action = makeProposedAction({
      idempotencyKey: "idem_hold_1",
      canonicalObjectKey: "cok_drive_hold",
      payload: { title: "held doc" },
    });

    const held = await holdWrite(
      { env, action, reason: "unreachable", workspaceId: "employer-work" },
      outbox,
      { clock, outboxId: () => "outbox_hold_1" },
    );

    expect(isOk(held)).toBe(true);
    if (!isOk(held)) return;

    // The persisted entry carries the FULL envelope identity + payload.
    const entry = held.value;
    expect(entry.idempotencyKey).toBe("idem_hold_1");
    expect(entry.canonicalObjectKey).toBe("cok_drive_hold");
    expect(entry.payloadHash).toBe(env.payloadHash);
    expect(entry.targetSystem).toBe("drive");
    expect(entry.actionRef).toBe(action.actionId);
    expect(entry.payload).toEqual({ title: "held doc" });

    // It actually landed in the store (not dropped).
    const stored = await outbox.getByIdempotencyKey("idem_hold_1");
    expect(isOk(stored)).toBe(true);
  });

  it("maps 'unreachable' onto the NON-terminal retry_queued status (never a terminal drop)", async () => {
    const outbox = new InMemoryOutbox();
    const held = await holdWrite(
      {
        env: makeEnvelope({ idempotencyKey: "idem_u" }),
        action: makeProposedAction({ idempotencyKey: "idem_u" }),
        reason: "unreachable",
        workspaceId: "employer-work",
      },
      outbox,
      { clock, outboxId: () => "outbox_u" },
    );
    expect(isOk(held)).toBe(true);
    if (!isOk(held)) return;
    expect(held.value.status).toBe("retry_queued");
  });

  it("maps 'not_approved' onto the NON-terminal proposed status (queued, awaiting approval)", async () => {
    const outbox = new InMemoryOutbox();
    const held = await holdWrite(
      {
        env: makeEnvelope({ idempotencyKey: "idem_a" }),
        action: makeProposedAction({ idempotencyKey: "idem_a" }),
        reason: "not_approved",
        workspaceId: "employer-work",
      },
      outbox,
      { clock, outboxId: () => "outbox_a" },
    );
    expect(isOk(held)).toBe(true);
    if (!isOk(held)) return;
    expect(held.value.status).toBe("proposed");
  });

  it("HELD ITEMS NEVER SILENTLY EXPIRE: a held entry is returned by listDue (non-terminal, due now)", async () => {
    const outbox = new InMemoryOutbox();
    await holdWrite(
      {
        env: makeEnvelope({ idempotencyKey: "idem_due" }),
        action: makeProposedAction({ idempotencyKey: "idem_due" }),
        reason: "unreachable",
        workspaceId: "employer-work",
      },
      outbox,
      { clock, outboxId: () => "outbox_due" },
    );
    const due = await outbox.listDue("2026-07-01T01:00:00.000Z", 100);
    expect(isOk(due)).toBe(true);
    if (!isOk(due)) return;
    expect(due.value.map((e) => e.idempotencyKey)).toContain("idem_due");
  });

  it("REPLAY: re-holding the SAME idempotencyKey reuses the existing entry, never a second enqueue", async () => {
    const outbox = new InMemoryOutbox();
    const args = {
      env: makeEnvelope({ idempotencyKey: "idem_dup" }),
      action: makeProposedAction({ idempotencyKey: "idem_dup" }),
      reason: "unreachable" as HoldReason,
      workspaceId: "employer-work",
    };
    const first = await holdWrite(args, outbox, { clock, outboxId: () => "outbox_dup_1" });
    const second = await holdWrite(args, outbox, { clock, outboxId: () => "outbox_dup_2" });

    expect(isOk(first)).toBe(true);
    expect(isOk(second)).toBe(true);
    if (!isOk(first) || !isOk(second)) return;
    // Second reuses the first entry's id — no duplicate row created.
    expect(second.value.outboxId).toBe("outbox_dup_1");
    expect(first.value.outboxId).toBe("outbox_dup_1");
  });

  it("PERSISTS the original approvalPolicy on the entry (24.15 — redrive must not reconstruct a neutral stand-in)", async () => {
    // spec(§8) — task 24.15: the entry must carry the ORIGINAL approvalPolicy token
    // so a later redrive can reconstruct a faithful action, not a hardcoded literal.
    const outbox = new InMemoryOutbox();
    const action = makeProposedAction({
      idempotencyKey: "idem_policy",
      canonicalObjectKey: "cok_policy",
      approvalPolicy: "auto_private",
    });
    const held = await holdWrite(
      {
        env: makeEnvelope({ idempotencyKey: "idem_policy", canonicalObjectKey: "cok_policy" }),
        action,
        reason: "unreachable",
        workspaceId: "employer-work",
      },
      outbox,
      { clock, outboxId: () => "outbox_policy" },
    );
    expect(isOk(held)).toBe(true);
    if (!isOk(held)) return;
    expect(held.value.approvalPolicy).toBe("auto_private");
  });

  it("propagates a store enqueue fault as a typed err (never throws, never a silent drop)", async () => {
    // A repo whose enqueue always faults and getByIdempotencyKey reports novel.
    const faulting = new InMemoryOutbox();
    // Force a conflict by pre-inserting a DIFFERENT entry under the same id but a
    // different idempotencyKey, then attempt an enqueue on that id.
    await faulting.enqueue(makeOutboxEntry({ outboxId: "occupied", idempotencyKey: "other" }));
    const res = await holdWrite(
      {
        env: makeEnvelope({ idempotencyKey: "idem_novel" }),
        action: makeProposedAction({ idempotencyKey: "idem_novel" }),
        reason: "unreachable",
        workspaceId: "employer-work",
      },
      faulting,
      { clock, outboxId: () => "occupied" },
    );
    expect(isErr(res)).toBe(true);
  });
});

describe("toOutboxStatus — machine-state mapping", () => {
  it("maps each hold reason onto a non-terminal ProposedAction machine state", () => {
    expect(toOutboxStatus("unreachable")).toBe("retry_queued");
    expect(toOutboxStatus("not_approved")).toBe("proposed");
    expect(toOutboxStatus("queued")).toBe("retry_queued");
  });
});

// 24.8: outboxHealth's return type widened from `GatewayHealthSignal | undefined`
// to the tri-state `OutboxHealthProbe`. The two tests below REPLACE the prior
// pair pinning the old two-state contract — that contract is what task 24.8
// corrects, not a behavior this package still owns:
//   • the breach case previously asserted `write_through_failed` (an ATTEMPT
//     class) for what is actually a HOLD condition (a backlog that was never
//     attempted); 24.21 added the correct `outbox_blocked` class + `error`
//     severity specifically so 24.8 could wire it here — asserting the OLD
//     class now would pin the exact defect this package exists to fix.
//   • `undefined` for "no signal" is no longer distinguishable from a store
//     fault (the bug 24.8 fixes); the tri-state `{kind:"ok"}` fixes that.
// A third, genuinely NEW test (`probe_failed`) is added below — there was no
// prior assertion for a `listDue` fault because the old signature could not
// express it (a fault and an empty queue both produced `undefined`).
describe("outboxHealth — OBS-2 depth breach (tri-state)", () => {
  it("reports a breach probe (outbox_blocked / severity error) when depth exceeds the threshold", async () => {
    const outbox = new InMemoryOutbox();
    for (let i = 0; i < 5; i += 1) {
      await holdWrite(
        {
          env: makeEnvelope({ idempotencyKey: `idem_${i}` }),
          action: makeProposedAction({ idempotencyKey: `idem_${i}` }),
          reason: "unreachable",
          workspaceId: "employer-work",
        },
        outbox,
        { clock, outboxId: () => `outbox_${i}` },
      );
    }
    const probe: OutboxHealthProbe = await outboxHealth(outbox, {
      now: clock(),
      depthThreshold: 3,
      limit: 1000,
    });
    expect(probe.kind).toBe("breach");
    if (probe.kind !== "breach") return;
    expect(probe.signal.failureClass).toBe(OUTBOX_BLOCKED_HEALTH_CLASS);
    expect(probe.signal.severity).toBe("error");
  });

  it("reports {kind:'ok'} when depth is at or below the threshold (held items still present, not expired)", async () => {
    const outbox = new InMemoryOutbox();
    await holdWrite(
      {
        env: makeEnvelope({ idempotencyKey: "idem_only" }),
        action: makeProposedAction({ idempotencyKey: "idem_only" }),
        reason: "unreachable",
        workspaceId: "employer-work",
      },
      outbox,
      { clock, outboxId: () => "outbox_only" },
    );
    const probe = await outboxHealth(outbox, { now: clock(), depthThreshold: 3, limit: 1000 });
    expect(probe).toEqual({ kind: "ok" });

    // The held item is NOT expired by the health check — it remains due.
    const due = await outbox.listDue("2026-07-01T02:00:00.000Z", 100);
    expect(isOk(due)).toBe(true);
    if (!isOk(due)) return;
    expect(due.value.map((e) => e.idempotencyKey)).toContain("idem_only");
  });

  it("reports {kind:'probe_failed'} with a FIXED safe literal reason when listDue faults — never the store's raw error text (rule 7)", async () => {
    const faulting = new FaultingListDueOutbox();
    const probe = await outboxHealth(faulting, { now: clock(), depthThreshold: 3, limit: 1000 });
    expect(probe.kind).toBe("probe_failed");
    if (probe.kind !== "probe_failed") return;
    // The store's raw error text must never leak into the probe.
    expect(probe.reason).not.toContain("listDue store fault (test double)");
    expect(probe.reason.length).toBeGreaterThan(0);
  });

  it("a store fault (probe_failed) is never confusable with a healthy empty queue (ok) — distinct kinds", async () => {
    const empty = new InMemoryOutbox();
    const okProbe = await outboxHealth(empty, { now: clock(), depthThreshold: 3, limit: 1000 });
    const faulting = new FaultingListDueOutbox();
    const faultProbe = await outboxHealth(faulting, {
      now: clock(),
      depthThreshold: 3,
      limit: 1000,
    });
    expect(okProbe.kind).toBe("ok");
    expect(faultProbe.kind).toBe("probe_failed");
    expect(okProbe.kind).not.toBe(faultProbe.kind);
  });
});

describe("holdWrite — OBS-2 reachability (task 24.8)", () => {
  it("with a bound health sink and depthThreshold 0, delivers exactly ONE breach probe to the sink", async () => {
    const outbox = new InMemoryOutbox();
    const sink = vi.fn<(p: OutboxHealthProbe) => void>();
    const held = await holdWrite(
      {
        env: makeEnvelope({ idempotencyKey: "idem_reach" }),
        action: makeProposedAction({ idempotencyKey: "idem_reach" }),
        reason: "unreachable",
        workspaceId: "employer-work",
      },
      outbox,
      {
        clock,
        outboxId: () => "outbox_reach",
        health: {
          probe: { now: clock(), depthThreshold: 0, limit: 1000 },
          sink,
        },
      },
    );
    expect(isOk(held)).toBe(true);
    expect(sink).toHaveBeenCalledTimes(1);
    const delivered = sink.mock.calls[0]?.[0];
    expect(delivered?.kind).toBe("breach");
  });

  it("runs the probe on the REPLAY-REUSE path too, not only on a fresh enqueue", async () => {
    const outbox = new InMemoryOutbox();
    const args = {
      env: makeEnvelope({ idempotencyKey: "idem_replay_reach" }),
      action: makeProposedAction({ idempotencyKey: "idem_replay_reach" }),
      reason: "unreachable" as HoldReason,
      workspaceId: "employer-work",
    };
    const sink = vi.fn<(p: OutboxHealthProbe) => void>();
    const healthDeps = { probe: { now: clock(), depthThreshold: 0, limit: 1000 }, sink };
    // First call: fresh enqueue.
    await holdWrite(args, outbox, { clock, outboxId: () => "outbox_replay_1", health: healthDeps });
    // Second call: same idempotencyKey -> replay-reuse early-return path.
    await holdWrite(args, outbox, { clock, outboxId: () => "outbox_replay_2", health: healthDeps });
    expect(sink).toHaveBeenCalledTimes(2);
  });

  it("swallows a sink that throws — a health probe never fails the hold", async () => {
    const outbox = new InMemoryOutbox();
    const throwingSink = vi.fn(() => {
      throw new Error("sink boom");
    });
    const held = await holdWrite(
      {
        env: makeEnvelope({ idempotencyKey: "idem_sink_throws" }),
        action: makeProposedAction({ idempotencyKey: "idem_sink_throws" }),
        reason: "unreachable",
        workspaceId: "employer-work",
      },
      outbox,
      {
        clock,
        outboxId: () => "outbox_sink_throws",
        health: { probe: { now: clock(), depthThreshold: 0, limit: 1000 }, sink: throwingSink },
      },
    );
    expect(isOk(held)).toBe(true);
    expect(throwingSink).toHaveBeenCalledTimes(1);
  });
});

describe("holdWrite — dormancy pin (POSITIVE CONTROL, task 24.8)", () => {
  it("with NO health dep, holdWrite calls listDue ZERO times and returns results byte-identical to the pre-24.8 shape", async () => {
    const outbox = new InMemoryOutbox();
    const listDueSpy = vi.spyOn(outbox, "listDue");

    const held = await holdWrite(
      {
        env: makeEnvelope({ idempotencyKey: "idem_dormant" }),
        action: makeProposedAction({ idempotencyKey: "idem_dormant" }),
        reason: "unreachable",
        workspaceId: "employer-work",
      },
      outbox,
      { clock, outboxId: () => "outbox_dormant" },
    );

    // POSITIVE CONTROL: the spy itself is live — a second, health-bound call on
    // an otherwise-identical outbox DOES invoke listDue, so a spy stuck at zero
    // calls above is a real dormancy result, not a broken/no-op spy.
    const controlOutbox = new InMemoryOutbox();
    const controlSpy = vi.spyOn(controlOutbox, "listDue");
    await holdWrite(
      {
        env: makeEnvelope({ idempotencyKey: "idem_control" }),
        action: makeProposedAction({ idempotencyKey: "idem_control" }),
        reason: "unreachable",
        workspaceId: "employer-work",
      },
      controlOutbox,
      {
        clock,
        outboxId: () => "outbox_control",
        health: { probe: { now: clock(), depthThreshold: 0, limit: 1000 }, sink: () => {} },
      },
    );
    expect(controlSpy).toHaveBeenCalledTimes(1);

    // The actual assertion: the no-health-dep call above never touched listDue.
    expect(listDueSpy).toHaveBeenCalledTimes(0);

    expect(isOk(held)).toBe(true);
    if (!isOk(held)) return;
    expect(held.value).toEqual({
      outboxId: "outbox_dormant",
      actionRef: "action_1",
      workspaceId: "employer-work",
      targetSystem: "drive",
      canonicalObjectKey: "cok_drive_abc",
      idempotencyKey: "idem_dormant",
      payloadHash: "sha256:deadbeef",
      status: "retry_queued",
      payload: { title: "x" },
      approvalPolicy: "requires_approval",
      attempts: 0,
      enqueuedAt: "2026-07-01T00:00:00.000Z",
      updatedAt: "2026-07-01T00:00:00.000Z",
    });
  });
});
