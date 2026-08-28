// @sow/integrations — the replay gate must FAIL CLOSED on a store fault.
//
// ⛔ THE DEFECT THIS PINS. `ReceiptStore.getByIdempotencyKey` returns
// `ReceiptRecord | undefined`, which cannot say "I could not tell". The shipped
// worker adapter therefore collapsed every failure to `undefined`
// (`createReceiptStoreAdapter`: `if (isErr(r)) return undefined; // not_found (or
// any lookup fault) → miss`), and the sqlite adapter's `run()` maps a THROWN driver
// error into exactly such a typed err.
//
// On the REPLAY GATE a miss means "no prior write — proceed", so a locked database
// file or a closed connection read as PERMISSION TO WRITE AGAIN. That is a
// fail-OPEN on the mechanism safety rule 3 rests on:
//
//   "replay reuses the receipt ⇒ zero duplicate external writes"
//
// The optional `*Checked` lookups let the store distinguish miss from fault;
// `resolveExisting` prefers them and turns a fault into a typed `error` outcome,
// which the gateway already handles fail-closed (never creates; holds for retry).
import { describe, it, expect } from "vitest";
import { resolveExisting } from "../src/tools/existence-check";
import type { ReceiptStore, ReceiptLookup } from "../src/ports/persistence";
import type { TargetWriteAdapter } from "../src/tools/adapter-port";
import type { ExternalWriteEnvelope } from "@sow/contracts";
import { ok } from "@sow/contracts";
import { vi } from "vitest";

const ENV = {
  targetSystem: "drive",
  canonicalObjectKey: "cok:drive:project-a:00_brief",
  idempotencyKey: "idem_1",
  payloadHash: "hash_a",
} as unknown as ExternalWriteEnvelope;

/**
 * A store where ONLY the named arm faults; the other answers a clean miss.
 *
 * ⚠ Both arms fault-check, so a store that faults on BOTH cannot tell you WHICH
 * check fired — a mutation deleting arm (a)'s check still produced `error` via arm
 * (b), and an earlier version of this suite passed that mutation. Isolating the
 * arms is what makes each pin independently load-bearing.
 */
function faultingOn(arm: "replay" | "object"): ReceiptStore {
  const fault = async (): Promise<ReceiptLookup> => ({ kind: "fault", code: "unavailable" });
  const miss = async (): Promise<ReceiptLookup> => ({ kind: "miss" });
  return {
    getByIdempotencyKey: async () => undefined,
    getByCanonicalObjectKey: async () => undefined,
    getByIdempotencyKeyChecked: arm === "replay" ? fault : miss,
    getByCanonicalObjectKeyChecked: arm === "object" ? fault : miss,
    reserve: async () => ({ kind: "reserved" }) as never,
    release: async () => undefined,
    put: async () => undefined,
  };
}

/** A store whose lookups BOTH fault (the locked-DB / closed-connection case). */
function faultingStore(): ReceiptStore {
  const fault = async (): Promise<ReceiptLookup> => ({ kind: "fault", code: "unavailable" });
  return {
    // The legacy pair still collapses the fault to `undefined` — that is the
    // fail-open, kept here deliberately so the test proves the CHECKED pair is what
    // rescues it rather than some incidental change.
    getByIdempotencyKey: async () => undefined,
    getByCanonicalObjectKey: async () => undefined,
    getByIdempotencyKeyChecked: fault,
    getByCanonicalObjectKeyChecked: fault,
    reserve: async () => ({ kind: "reserved" }) as never,
    release: async () => undefined,
    put: async () => undefined,
  };
}

/** A store that answers cleanly with a genuine MISS. */
function missingStore(): ReceiptStore {
  const miss = async (): Promise<ReceiptLookup> => ({ kind: "miss" });
  return {
    getByIdempotencyKey: async () => undefined,
    getByCanonicalObjectKey: async () => undefined,
    getByIdempotencyKeyChecked: miss,
    getByCanonicalObjectKeyChecked: miss,
    reserve: async () => ({ kind: "reserved" }) as never,
    release: async () => undefined,
    put: async () => undefined,
  };
}

function adapterSpy(): { adapter: TargetWriteAdapter; probes: () => number } {
  const existenceCheck = vi.fn(async () => ok(null));
  return {
    adapter: {
      targetSystem: "drive",
      existenceCheck,
      create: vi.fn(),
      update: vi.fn(),
    } as unknown as TargetWriteAdapter,
    probes: () => existenceCheck.mock.calls.length,
  };
}

describe("resolveExisting — a receipt-store fault is NOT a miss (safety rule 3)", () => {
  it("arm (a) ALONE: a faulting REPLAY lookup yields `error` even when the object lookup is a clean miss", async () => {
    const { adapter, probes } = adapterSpy();
    const out = await resolveExisting(ENV, adapter, faultingOn("replay"));
    expect(out.kind).toBe("error");
    expect(probes()).toBe(0);
  });

  it("arm (b) ALONE: a faulting OBJECT lookup yields `error` even when the replay lookup is a clean miss", async () => {
    const { adapter, probes } = adapterSpy();
    const out = await resolveExisting(ENV, adapter, faultingOn("object"));
    expect(out.kind).toBe("error");
    expect(probes()).toBe(0);
  });

  it("a faulting replay lookup yields `error`, NOT `none` — the gateway must not proceed to create", async () => {
    const { adapter, probes } = adapterSpy();
    const out = await resolveExisting(ENV, adapter, faultingStore());

    // ⛔ THE LOAD-BEARING ASSERTION. Under the old collapse this returned `none`,
    // which is the gateway's permission to create — a second real vendor write for
    // an envelope that may already have been written.
    expect(out.kind).toBe("error");
    if (out.kind !== "error") return;
    expect(out.error.code).toBe("unreachable"); // transient ⇒ retryable, not terminal
    // It short-circuits BEFORE the live vendor probe: we could not establish the
    // replay state, so nothing downstream should run.
    expect(probes()).toBe(0);
  });

  it("a genuine MISS still yields `none` — the fix must not make every lookup a fault", async () => {
    const { adapter, probes } = adapterSpy();
    const out = await resolveExisting(ENV, adapter, missingStore());

    // The negative control. Without this, "always return error" would pass the test
    // above while breaking every first-time write in the product.
    expect(out.kind).toBe("none");
    expect(probes()).toBe(1); // a real miss DOES reach the live vendor probe
  });

  it("a store WITHOUT the checked pair still works (optional seam, byte-equivalent)", async () => {
    const { adapter } = adapterSpy();
    const legacy: ReceiptStore = {
      getByIdempotencyKey: async () => undefined,
      getByCanonicalObjectKey: async () => undefined,
      reserve: async () => ({ kind: "reserved" }) as never,
      release: async () => undefined,
      put: async () => undefined,
    };
    // An implementor that omits the checked pair keeps the old behaviour — it simply
    // cannot simulate a fault. Safe for a fake; NOT acceptable for a real store,
    // which is why the production adapter implements it.
    expect((await resolveExisting(ENV, adapter, legacy)).kind).toBe("none");
  });
});
