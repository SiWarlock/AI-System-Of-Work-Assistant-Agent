// Slice 6.2 — adversarial regression for the NO-DUPLICATE-EXTERNAL-WRITE invariant
// under CONCURRENCY (safety rule 3 / §20.1 replay gate / ARCHITECTURE §2.5: "a
// replayed Hermes automation produces no duplicate external action ... enforced by
// the gateways"). The sequential same-idempotencyKey case was already covered; the
// gap the adversarial-verify pass found was the INTERLEAVED case — two dispatches
// that BOTH pass the existence check before either records a receipt. The fix is an
// atomic create-reservation (ReceiptStore.reserve): only the reservation WINNER may
// call adapter.create; the loser holds. These tests fail on a plain check-then-act.
import { describe, it, expect } from "vitest";
import { ok, err } from "@sow/contracts";
import type { Result, WriteReceipt } from "@sow/contracts";
import type { TargetWriteAdapter, AdapterError } from "../src/tools/adapter-port";
import { dispatchExternalWrite, type ExternalWriteDeps } from "../src/tools/gateway";
import { buildEnvelopeFromAction } from "../src/tools/envelope";
import {
  InMemoryReceiptStore,
  makeProposedAction,
  makeWriteReceipt,
} from "./support/fakes";

const FIXED_CLOCK = (): string => "2026-07-01T00:00:00.000Z";

function baseDeps(adapter: TargetWriteAdapter, store: InMemoryReceiptStore): ExternalWriteDeps {
  return {
    adapter,
    receiptStore: store,
    requireApproval: () => ({ requiresApproval: false }),
    recordPendingApproval: async () => ok(undefined),
    isApproved: async () => false,
    audit: async () => {},
    clock: FIXED_CLOCK,
  };
}

function envFor(action = makeProposedAction()) {
  const built = buildEnvelopeFromAction(action, { preconditions: ["exists_check"] });
  if (!built.ok) throw new Error("test envelope failed to build");
  return built.value;
}

// Yield to the macrotask queue (draining all pending microtasks each tick) until
// `pred` holds — used to park dispatch D1 inside adapter.create before starting D2.
async function waitUntil(pred: () => boolean, maxTicks = 200): Promise<void> {
  for (let i = 0; i < maxTicks && !pred(); i += 1) {
    await new Promise((r) => setTimeout(r, 0));
  }
  if (!pred()) throw new Error("waitUntil: predicate never became true");
}

describe("dispatchExternalWrite — INTERLEAVED concurrency (no duplicate external write) — spec(§20.1 replay gate / §8)", () => {
  it("two dispatches interleaved on the same object → adapter.create fires EXACTLY once", async () => {
    const action = makeProposedAction({ idempotencyKey: "idem_race", canonicalObjectKey: "cok_race" });
    const env = envFor(action);
    const store = new InMemoryReceiptStore();

    let createCalls = 0;
    let releaseCreate!: (r: Result<WriteReceipt, AdapterError>) => void;
    const createGate = new Promise<Result<WriteReceipt, AdapterError>>((res) => {
      releaseCreate = res;
    });

    const adapter: TargetWriteAdapter = {
      targetSystem: "drive",
      // The object does NOT exist at the vendor for either dispatch's probe.
      existenceCheck: async () => ok(null),
      // Blocks until the test releases it, so D1 is parked mid-create while D2 runs.
      create: async () => {
        createCalls += 1;
        return createGate;
      },
      update: async () => err<AdapterError>({ code: "unknown", message: "unused" }),
    };
    const deps = baseDeps(adapter, store);

    // D1 enters and parks inside adapter.create — meaning it has already reserved
    // the object identity (existence check → none → reserve → create).
    const d1 = dispatchExternalWrite(env, action, deps);
    await waitUntil(() => createCalls === 1);

    // D2 runs to completion WHILE D1 is parked mid-create. On the buggy check-then-
    // act it would see "no receipt yet" and fire a SECOND create. With the atomic
    // reservation it sees the reservation in progress and holds — never a 2nd create.
    const d2 = await dispatchExternalWrite(env, action, deps);
    expect(d2.status).toBe("held");
    expect(createCalls).toBe(1);

    // Let D1 commit.
    releaseCreate(ok(makeWriteReceipt({ externalObjectId: "ext_race" })));
    const r1 = await d1;
    expect(r1.status).toBe("created");
    // The load-bearing assertion: exactly ONE external create for one object.
    expect(createCalls).toBe(1);

    // A later replay short-circuits on the committed receipt (still one create).
    const r3 = await dispatchExternalWrite(env, action, deps);
    expect(r3.status).toBe("reused");
    expect(createCalls).toBe(1);
  });

  it("a create FAULT releases the reservation so a later retry can re-claim and create", async () => {
    const action = makeProposedAction({ idempotencyKey: "idem_rel", canonicalObjectKey: "cok_rel" });
    const env = envFor(action);
    const store = new InMemoryReceiptStore();

    let createCalls = 0;
    const outcomes: Array<Result<WriteReceipt, AdapterError>> = [
      err<AdapterError>({ code: "unreachable", message: "target down" }),
      ok(makeWriteReceipt({ externalObjectId: "ext_retry" })),
    ];
    const adapter: TargetWriteAdapter = {
      targetSystem: "drive",
      existenceCheck: async () => ok(null),
      create: async () => {
        const outcome = outcomes[createCalls]!;
        createCalls += 1;
        return outcome;
      },
      update: async () => err<AdapterError>({ code: "unknown", message: "unused" }),
    };
    const deps = baseDeps(adapter, store);

    // First attempt: create faults → held, and the reservation is RELEASED.
    const first = await dispatchExternalWrite(env, action, deps);
    expect(first.status).toBe("held");

    // Retry: because the reservation was released (not left locked forever), the
    // retry re-claims it and creates successfully.
    const second = await dispatchExternalWrite(env, action, deps);
    expect(second.status).toBe("created");
    expect(createCalls).toBe(2);
  });
});
