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
//   • OBS-2 — outbox depth over a threshold emits a `write_through_failed`
//     GatewayHealthSignal; held items are not expired by the health check.
import { describe, it, expect } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import {
  holdWrite,
  outboxHealth,
  toOutboxStatus,
  type HoldReason,
} from "../src/tools/outbox";
import { WRITE_THROUGH_BLOCKED_HEALTH_CLASS } from "../src/health/health-signal";
import {
  InMemoryOutbox,
  makeEnvelope,
  makeProposedAction,
  makeOutboxEntry,
} from "./support/fakes";

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

describe("outboxHealth — OBS-2 depth breach", () => {
  it("emits a write_through_failed signal when depth exceeds the threshold", async () => {
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
    const signal = await outboxHealth(outbox, { now: clock(), depthThreshold: 3, limit: 1000 });
    expect(signal).not.toBeUndefined();
    expect(signal?.failureClass).toBe(WRITE_THROUGH_BLOCKED_HEALTH_CLASS);
  });

  it("emits NO signal when depth is at or below the threshold (held items still present, not expired)", async () => {
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
    const signal = await outboxHealth(outbox, { now: clock(), depthThreshold: 3, limit: 1000 });
    expect(signal).toBeUndefined();

    // The held item is NOT expired by the health check — it remains due.
    const due = await outbox.listDue("2026-07-01T02:00:00.000Z", 100);
    expect(isOk(due)).toBe(true);
    if (!isOk(due)) return;
    expect(due.value.map((e) => e.idempotencyKey)).toContain("idem_only");
  });
});
