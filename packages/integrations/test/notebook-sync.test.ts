// Slice 6.6 — NotebookPort + notebooklm.sync (Drive-backed managed-doc upsert).
//
// Adversarial pins for the two load-bearing behaviors:
//   1. The five 00–04 slots UPSERT through the Tool Gateway with a STABLE
//      per-slot canonicalObjectKey — a second sync of the same bodies REUSES the
//      stored receipts (no duplicate Drive docs on replay; safety invariant 2).
//   2. A missing slot mapping / adapter-404 → a typed { reattach_required, slot }
//      state ("re-add/refresh the NotebookLM source"), NOT a silent failure or a
//      throw (§16 fail-closed).
//
// Wiring uses the REAL Tool Gateway (dispatchExternalWrite) + a fake Drive
// TargetWriteAdapter, so the per-slot canonical-key + no-duplicate-write
// invariants are exercised end-to-end (not mocked away).
import { describe, it, expect, vi } from "vitest";
import { ok, err } from "@sow/contracts";
import type {
  Result,
  WriteReceipt,
  AuditRecord,
  NotebookMapping,
} from "@sow/contracts";
import { buildCanonicalObjectKey } from "@sow/domain";
import type {
  TargetWriteAdapter,
  ExistingObject,
  AdapterError,
} from "../src/tools/adapter-port";
import type { ExternalWriteDeps } from "../src/tools/gateway";
import {
  createNotebookLmSync,
  type NotebookSyncDeps,
} from "../src/notebook/notebooklm-sync";
import { NOTEBOOK_SLOTS, type ManagedDocBodies } from "../src/notebook/notebook-port";
import {
  createWriteHttpTransport,
  type WriteHttpSpec,
  type HttpTransport,
} from "../src/tools/adapters/write-http-transport";
import { createDriveWriteAdapter } from "../src/tools/adapters/drive";
import { InMemoryReceiptStore, InMemoryOutbox } from "./support/fakes";

// --- fixtures ----------------------------------------------------------------

const FIXED_CLOCK = (): string => "2026-07-01T00:00:00.000Z";

function makeMapping(partial: Partial<NotebookMapping> = {}): NotebookMapping {
  return {
    projectId: "proj_alpha",
    notebookKey: "nb_alpha",
    driveFolderId: "folder_1",
    managedDocIds: {
      "00_brief": "doc_00",
      "01_decisions": "doc_01",
      "02_meetings": "doc_02",
      "03_research": "doc_03",
      "04_open_questions": "doc_04",
    },
    ...partial,
  };
}

function makeBodies(): ManagedDocBodies {
  return {
    "00_brief": "# Brief\nbody-00",
    "01_decisions": "# Decisions\nbody-01",
    "02_meetings": "# Meetings\nbody-02",
    "03_research": "# Research\nbody-03",
    "04_open_questions": "# Open Questions\nbody-04",
  };
}

// A fake Drive adapter: a Map keyed by canonicalObjectKey. `create` returns a
// vendor id and remembers it (so a live existence probe on the SAME key hits);
// `existenceCheck` reports the hit. A per-key 404 opt-in makes existence +
// create return the closed `not_found` code (R1: the real Drive adapter
// promotes a structured 404 to this same code — drive.ts — so the fake models
// the PORT's contract directly rather than re-deriving the promotion).
function makeFakeDriveAdapter(opts: { notFoundKeys?: ReadonlySet<string> } = {}): {
  adapter: TargetWriteAdapter;
  createCalls: () => number;
  store: Map<string, string>;
} {
  const objects = new Map<string, string>();
  let nextId = 0;
  const notFound = opts.notFoundKeys ?? new Set<string>();

  const create = vi.fn(
    async (env: {
      canonicalObjectKey: string;
    }): Promise<Result<WriteReceipt, AdapterError>> => {
      if (notFound.has(env.canonicalObjectKey)) {
        return err<AdapterError>({ code: "not_found", message: "drive 404: managed doc not found / source unlinked" });
      }
      const id = `drive_obj_${nextId++}`;
      objects.set(env.canonicalObjectKey, id);
      return ok<WriteReceipt>({
        externalObjectId: id,
        externalUrl: `https://drive/${id}`,
        recordedAt: FIXED_CLOCK(),
      });
    },
  );

  const adapter: TargetWriteAdapter = {
    targetSystem: "drive",
    existenceCheck: vi.fn(
      async (
        canonicalObjectKey: string,
      ): Promise<Result<ExistingObject | null, AdapterError>> => {
        if (notFound.has(canonicalObjectKey)) {
          return err<AdapterError>({ code: "not_found", message: "drive 404: source unlinked" });
        }
        const hit = objects.get(canonicalObjectKey);
        return ok(hit === undefined ? null : { externalObjectId: hit, externalUrl: `https://drive/${hit}` });
      },
    ),
    create: create as unknown as TargetWriteAdapter["create"],
    update: vi.fn(async () => err<AdapterError>({ code: "unknown", message: "unused" })),
  };

  return { adapter, createCalls: () => create.mock.calls.length, store: objects };
}

function makeGatewayDeps(adapter: TargetWriteAdapter, store: InMemoryReceiptStore): {
  deps: ExternalWriteDeps;
  audits: AuditRecord[];
} {
  const audits: AuditRecord[] = [];
  const deps: ExternalWriteDeps = {
    adapter,
    receiptStore: store,
    requireApproval: () => ({ requiresApproval: false }),
    recordPendingApproval: async () => ok(undefined),
    isApproved: async () => false,
    audit: async (rec: AuditRecord) => {
      audits.push(rec);
    },
    clock: FIXED_CLOCK,
  };
  return { deps, audits };
}

function makeSyncDeps(overrides: {
  adapter?: TargetWriteAdapter;
  store?: InMemoryReceiptStore;
} = {}): { deps: NotebookSyncDeps; adapter: ReturnType<typeof makeFakeDriveAdapter>; store: InMemoryReceiptStore; gatewayDeps: ExternalWriteDeps } {
  const fake = overrides.adapter
    ? { adapter: overrides.adapter, createCalls: () => 0, store: new Map<string, string>() }
    : makeFakeDriveAdapter();
  const store = overrides.store ?? new InMemoryReceiptStore();
  const { deps: gatewayDeps } = makeGatewayDeps(fake.adapter, store);
  const deps: NotebookSyncDeps = {
    gateway: gatewayDeps,
    approvalPolicy: "auto_allowed",
    clock: FIXED_CLOCK,
  };
  return { deps, adapter: fake, store, gatewayDeps };
}

// --- tests -------------------------------------------------------------------

describe("createNotebookLmSync — five-slot UPSERT with stable per-slot keys", () => {
  it("upserts all five 00–04 slots through the gateway; result lists all five as upserted", async () => {
    const { deps, adapter } = makeSyncDeps();
    const port = createNotebookLmSync(deps);

    const res = await port.sync(makeMapping(), makeBodies());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect([...res.value.upserted].sort()).toEqual([...NOTEBOOK_SLOTS].sort());
    expect(res.value.reattachRequired).toEqual([]);
    // Exactly one create per slot (five distinct Drive docs).
    expect(adapter.createCalls()).toBe(5);
    expect(adapter.store.size).toBe(5);
  });

  it("uses the stable per-slot canonicalObjectKey = buildCanonicalObjectKey({drive, {project, slot}})", async () => {
    const { deps, adapter } = makeSyncDeps();
    const mapping = makeMapping();
    const port = createNotebookLmSync(deps);

    await port.sync(mapping, makeBodies());
    for (const slot of NOTEBOOK_SLOTS) {
      const expectedKey = buildCanonicalObjectKey({
        targetSystem: "drive",
        identity: { project: mapping.projectId, slot },
      });
      expect(adapter.store.has(expectedKey)).toBe(true);
    }
  });

  it("a SECOND sync of the same bodies REUSES receipts — no duplicate Drive docs (create still called 5× total)", async () => {
    const { deps, adapter } = makeSyncDeps();
    const mapping = makeMapping();
    const bodies = makeBodies();
    const port = createNotebookLmSync(deps);

    const first = await port.sync(mapping, bodies);
    expect(first.ok).toBe(true);
    expect(adapter.createCalls()).toBe(5);

    const second = await port.sync(mapping, bodies);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Every slot still reports upserted (idempotent in-place), but NO new create.
    expect([...second.value.upserted].sort()).toEqual([...NOTEBOOK_SLOTS].sort());
    expect(adapter.createCalls()).toBe(5);
    expect(adapter.store.size).toBe(5);
  });
});

describe("createNotebookLmSync — reattach_required (missing / unlinked source)", () => {
  it("a blank slot mapping id → reattach_required for that slot, no create, NOT a throw", async () => {
    const { deps, adapter } = makeSyncDeps();
    const mapping = makeMapping();
    // Simulate an unlinked source by blanking one managed-doc id.
    const broken: NotebookMapping = {
      ...mapping,
      managedDocIds: { ...mapping.managedDocIds, "03_research": "   " },
    };
    const port = createNotebookLmSync(deps);

    const res = await port.sync(broken, makeBodies());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.reattachRequired).toEqual(["03_research"]);
    expect(res.value.upserted).not.toContain("03_research");
    expect(res.value.upserted).toHaveLength(4);
    // The blank slot never issued a create.
    expect(adapter.createCalls()).toBe(4);
  });

  it("an adapter-404 for a slot → reattach_required, other slots still upsert", async () => {
    const mapping = makeMapping();
    const missKey = buildCanonicalObjectKey({
      targetSystem: "drive",
      identity: { project: mapping.projectId, slot: "02_meetings" },
    });
    const fake = makeFakeDriveAdapter({ notFoundKeys: new Set([missKey]) });
    const store = new InMemoryReceiptStore();
    const { deps: gatewayDeps } = makeGatewayDeps(fake.adapter, store);
    const port = createNotebookLmSync({
      gateway: gatewayDeps,
      approvalPolicy: "auto_allowed",
      clock: FIXED_CLOCK,
    });

    const res = await port.sync(mapping, makeBodies());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.reattachRequired).toEqual(["02_meetings"]);
    expect([...res.value.upserted].sort()).toEqual(
      NOTEBOOK_SLOTS.filter((s) => s !== "02_meetings").sort(),
    );
  });

  it("a non-404 rejected CREATE fault still fails the sync closed — discriminates on the closed code, not free text", async () => {
    // The vendor refuses the write (e.g. an expired/invalid credential) — a
    // `rejected` AdapterError that is NOT `not_found`. This must NOT be
    // mistaken for a reattach signal: isReattachReason matches ONLY the exact
    // closed `not_found` code, so a plain `rejected` reason
    // (`create fault (rejected)`) fails the whole sync closed, exactly as a
    // non-404 vendor refusal should.
    const rejectingAdapter: TargetWriteAdapter = {
      targetSystem: "drive",
      existenceCheck: async (): Promise<Result<ExistingObject | null, AdapterError>> => ok(null),
      create: async (): Promise<Result<WriteReceipt, AdapterError>> =>
        err<AdapterError>({ code: "rejected", message: "invalid_grant: credential expired" }),
      update: async (): Promise<Result<WriteReceipt, AdapterError>> =>
        err<AdapterError>({ code: "unknown", message: "unused" }),
    };
    const store = new InMemoryReceiptStore();
    const { deps: gatewayDeps } = makeGatewayDeps(rejectingAdapter, store);
    const port = createNotebookLmSync({
      gateway: gatewayDeps,
      approvalPolicy: "auto_allowed",
      clock: FIXED_CLOCK,
    });

    const res = await port.sync(makeMapping(), makeBodies());
    expect(res.ok).toBe(false);
  });
});

describe("createNotebookLmSync — hold-through-outage (§8: a held write is enqueued, not dropped)", () => {
  // A fully-unreachable Drive target (the existence probe faults 'unreachable', a
  // NON-reattach reason) → the gateway returns {status:'held'}.
  const unreachableAdapter: TargetWriteAdapter = {
    targetSystem: "drive",
    existenceCheck: async (): Promise<Result<ExistingObject | null, AdapterError>> =>
      err<AdapterError>({ code: "unreachable", message: "drive endpoint unreachable" }),
    create: async (): Promise<Result<WriteReceipt, AdapterError>> =>
      err<AdapterError>({ code: "unreachable", message: "drive endpoint unreachable" }),
    update: async (): Promise<Result<WriteReceipt, AdapterError>> =>
      err<AdapterError>({ code: "unknown", message: "unused" }),
  };

  it("a Drive outage holds each slot in the outbox and does NOT fail the sync", async () => {
    const store = new InMemoryReceiptStore();
    const { deps: gatewayDeps } = makeGatewayDeps(unreachableAdapter, store);
    const outboxRepo = new InMemoryOutbox();
    let n = 0;
    const port = createNotebookLmSync({
      gateway: gatewayDeps,
      approvalPolicy: "auto_allowed",
      clock: FIXED_CLOCK,
      outbox: {
        repo: outboxRepo,
        hold: { clock: FIXED_CLOCK, outboxId: () => `outbox_${n++}` },
        workspaceId: "personal-business",
      },
    });

    const res = await port.sync(makeMapping(), makeBodies());
    // Held, NOT dropped, NOT a hard sync failure.
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect([...res.value.heldForRetry].sort()).toEqual([...NOTEBOOK_SLOTS].sort());
    expect(res.value.upserted).toEqual([]);
    // Each held write is persisted in the outbox — drainable later, never lost.
    const due = await outboxRepo.listDue("2100-01-01T00:00:00.000Z", 100);
    expect(due.ok).toBe(true);
    if (due.ok) expect(due.value).toHaveLength(5);
  });

  // ⛔ THIS TEST PREVIOUSLY ASSERTED THE DEFECT, and its own name said so:
  // "an unreachable hold fails the sync closed (backward-compatible)". Whether an
  // outbox happens to be wired is an AUTO-RETRY CONVENIENCE — it has nothing to do
  // with whether this particular write can succeed later, so it must not change the
  // CLASSIFICATION of the fault. Under the old behaviour a Drive 429, a 503 or a
  // network outage failed the WHOLE five-slot sync closed on any deployment that
  // had not bound an outbox.
  // The hold is still not silent: the slot is reported held WITH its cause, it is
  // simply not retried unattended.
  it("without an outbox wired, an unreachable hold is still HELD (not a hard failure) and carries its cause", async () => {
    const store = new InMemoryReceiptStore();
    const { deps: gatewayDeps } = makeGatewayDeps(unreachableAdapter, store);
    const port = createNotebookLmSync({
      gateway: gatewayDeps,
      approvalPolicy: "auto_allowed",
      clock: FIXED_CLOCK,
    });

    const res = await port.sync(makeMapping(), makeBodies());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect([...res.value.heldForRetry].sort()).toEqual([...NOTEBOOK_SLOTS].sort());
    expect(res.value.upserted).toEqual([]);
    // The cause survives even with no outbox — otherwise an operator sees five
    // held slots and no way to tell an outage from a locked Keychain.
    expect(res.value.heldDetail).toHaveLength(5);
    expect(res.value.heldDetail?.[0]?.adapterCode).toBe("unreachable");
  });
});

// F3 BEHAVIOR CHANGE, PINNED DELIBERATELY (this round). `syncSlot`'s outbox branch
// is `status === "held" && !isReattachResult(...)`. Before the gateway's
// existence-fault arm learned to branch on the closed adapter code, EVERY
// existence-probe fault arrived as `held` — so a PERMANENT vendor refusal (an
// expired credential, a 401) was enqueued to the write outbox with
// `reason: "unreachable"` and reported to the caller as a SUCCESSFUL sync
// (`ok({heldForRetry:[…all five slots…]})`). A permanent auth failure recorded as
// an outage, on a retry loop that never expires.
//
// It now fails the sync CLOSED instead. That is a real, intended flip of `sync()`'s
// return for this case (ok → err); it is pinned here rather than left for a
// reviewer to discover.
describe("createNotebookLmSync — a PERMANENT Drive refusal is not an outage (F3)", () => {
  const refusingAdapter: TargetWriteAdapter = {
    targetSystem: "drive",
    existenceCheck: async (): Promise<Result<ExistingObject | null, AdapterError>> =>
      err<AdapterError>({ code: "rejected", message: "HTTP 401" }),
    create: async (): Promise<Result<WriteReceipt, AdapterError>> =>
      err<AdapterError>({ code: "rejected", message: "HTTP 401" }),
    update: async (): Promise<Result<WriteReceipt, AdapterError>> =>
      err<AdapterError>({ code: "unknown", message: "unused" }),
  };

  it("a permanently-refusing existence probe fails the sync closed and enqueues NOTHING, even with an outbox wired", async () => {
    const store = new InMemoryReceiptStore();
    const { deps: gatewayDeps } = makeGatewayDeps(refusingAdapter, store);
    const outboxRepo = new InMemoryOutbox();
    let n = 0;
    const port = createNotebookLmSync({
      gateway: gatewayDeps,
      approvalPolicy: "auto_allowed",
      clock: FIXED_CLOCK,
      outbox: {
        repo: outboxRepo,
        hold: { clock: FIXED_CLOCK, outboxId: () => `outbox_${n++}` },
        workspaceId: "personal-business",
      },
    });

    const res = await port.sync(makeMapping(), makeBodies());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("dispatch_failed");
    // A permanent refusal is NOT an outage — nothing is queued for a re-drive.
    const due = await outboxRepo.listDue("2100-01-01T00:00:00.000Z", 100);
    expect(due.ok).toBe(true);
    if (due.ok) expect(due.value).toHaveLength(0);
  });

  it("REGRESSION PIN: an adapter-404 existence probe still yields per-slot reattach, NOT a hard failure", async () => {
    // The `not_found` reattach path reads `adapterCode`, not `status`, so it must
    // survive the status change. This is the leg a fix that stopped the retry loop
    // but broke per-slot reattach would fail.
    const mapping = makeMapping();
    const missKey = buildCanonicalObjectKey({
      targetSystem: "drive",
      identity: { project: mapping.projectId, slot: "02_meetings" },
    });
    const fake = makeFakeDriveAdapter({ notFoundKeys: new Set([missKey]) });
    const store = new InMemoryReceiptStore();
    const { deps: gatewayDeps } = makeGatewayDeps(fake.adapter, store);
    const outboxRepo = new InMemoryOutbox();
    let n = 0;
    const port = createNotebookLmSync({
      gateway: gatewayDeps,
      approvalPolicy: "auto_allowed",
      clock: FIXED_CLOCK,
      outbox: {
        repo: outboxRepo,
        hold: { clock: FIXED_CLOCK, outboxId: () => `outbox_${n++}` },
        workspaceId: "personal-business",
      },
    });

    const res = await port.sync(mapping, makeBodies());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.reattachRequired).toEqual(["02_meetings"]);
    // A reattach is per-object, never an outbox re-drive (adapter-port.ts's
    // `AdapterError` doc block).
    const due = await outboxRepo.listDue("2100-01-01T00:00:00.000Z", 100);
    expect(due.ok).toBe(true);
    if (due.ok) expect(due.value).toHaveLength(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// W2 — a held write must not report a SUCCESSFUL sync, and must name its CAUSE.
//
// THE DEFECT THESE PIN. `syncSlot`'s hold branch had the gateway's typed fault in
// hand and discarded it, so `heldForRetry` carried slot NAMES only: a Drive outage
// and a locked Keychain (the 21.10 credential seam) produced the SAME observation
// at the boundary — `ok({heldForRetry:[…]})` with nothing naming the cause — even
// though the operator remedies are opposite (wait vs. unlock the Keychain and
// re-run). And `ok` alone read as "the notebook is in sync" when it was not.
//
// WHY THE HELD CASE IS STILL `ok` (pinned below, not left implicit): the write is
// durably enqueued to the outbox before `held` is ever reported, and the workflow
// driver (packages/workflows/src/workflows/notebookLmSync.ts) folds a non-empty
// `heldForRetry` into its distinct `outbox_held` state. Flipping to `err` would
// erase that state and make a self-healing outage terminal. The partial state is
// instead made explicit by `outcome`.
// ─────────────────────────────────────────────────────────────────────────────

// A Drive target that is unreachable at BOTH the existence probe and the create —
// the §8 outage shape: the gateway returns {status:'held', adapterCode:'unreachable'}.
const OUTAGE_ADAPTER: TargetWriteAdapter = {
  targetSystem: "drive",
  existenceCheck: async (): Promise<Result<ExistingObject | null, AdapterError>> =>
    err<AdapterError>({ code: "unreachable", message: "drive endpoint unreachable" }),
  create: async (): Promise<Result<WriteReceipt, AdapterError>> =>
    err<AdapterError>({ code: "unreachable", message: "drive endpoint unreachable" }),
  update: async (): Promise<Result<WriteReceipt, AdapterError>> =>
    err<AdapterError>({ code: "unknown", message: "unused" }),
};

function makeHeldSyncDeps(adapter: TargetWriteAdapter, secrets?: ExternalWriteDeps["secrets"]): {
  deps: NotebookSyncDeps;
  outboxRepo: InMemoryOutbox;
} {
  const store = new InMemoryReceiptStore();
  const { deps: gatewayGateway } = makeGatewayDeps(adapter, store);
  const outboxRepo = new InMemoryOutbox();
  let n = 0;
  return {
    deps: {
      gateway: secrets === undefined ? gatewayGateway : { ...gatewayGateway, secrets },
      approvalPolicy: "auto_allowed",
      clock: FIXED_CLOCK,
      outbox: {
        repo: outboxRepo,
        hold: { clock: FIXED_CLOCK, outboxId: () => `outbox_${n++}` },
        workspaceId: "personal-business",
      },
    },
    outboxRepo,
  };
}

describe("createNotebookLmSync — a held slot carries its CAUSE to the caller (W2)", () => {
  it("a Drive OUTAGE hold names the closed adapter code and forwards the gateway's diagnostic", async () => {
    const { deps } = makeHeldSyncDeps(OUTAGE_ADAPTER);
    const port = createNotebookLmSync(deps);

    const res = await port.sync(makeMapping(), makeBodies());
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    // One held entry per held slot, in the same canonical 00→04 order.
    expect(res.value.heldDetail.map((h) => h.slot)).toEqual([...res.value.heldForRetry]);
    expect(res.value.heldDetail).toHaveLength(NOTEBOOK_SLOTS.length);

    for (const entry of res.value.heldDetail) {
      // The CODE — the field a caller branches on. This is the assertion the
      // pre-fix build could not satisfy: nothing carried it past `syncSlot`.
      expect(entry.adapterCode).toBe("unreachable");
      // The diagnostic — what the operator reads. Forwarded verbatim from the
      // gateway, which built it from the closed code + the adapter's own
      // redaction-safe message.
      expect(entry.reason).toContain("unreachable");
    }
  });

  it("a LOCKED-Keychain hold is DISTINGUISHABLE from a Drive outage — no adapterCode, and the closed lock token survives", async () => {
    // The 21.10 credential seam holds the write at gateway step 2.5, BEFORE any
    // vendor call. The Drive adapter here is perfectly healthy — the ONLY thing
    // wrong is the Keychain — so a result indistinguishable from the outage case
    // above would be exactly the defect.
    const healthy = makeFakeDriveAdapter();
    const { deps } = makeHeldSyncDeps(healthy.adapter, {
      getSecret: async () => err({ reason: "locked" as const }),
    });
    const port = createNotebookLmSync(deps);

    const res = await port.sync(makeMapping(), makeBodies());
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.heldDetail).toHaveLength(NOTEBOOK_SLOTS.length);
    const first = res.value.heldDetail[0];
    expect(first).toBeDefined();
    if (first === undefined) return;

    // NOT an adapter fault — the field is ABSENT, not `undefined`-valued, so
    // "did this come from the adapter?" is answerable structurally.
    expect("adapterCode" in first).toBe(false);
    expect(first.adapterCode).toBeUndefined();
    // The closed `locked` token (worker LESSONS §41) is what tells the operator to
    // unlock the Keychain rather than wait out an outage.
    expect(first.reason).toContain("locked");
    // Fail-closed: no unauthenticated write was attempted.
    expect(healthy.createCalls()).toBe(0);
  });

  it("the two causes do not collapse: the same slot list, two different held causes", async () => {
    const outage = createNotebookLmSync(makeHeldSyncDeps(OUTAGE_ADAPTER).deps);
    const lockedDeps = makeHeldSyncDeps(makeFakeDriveAdapter().adapter, {
      getSecret: async () => err({ reason: "locked" as const }),
    }).deps;
    const locked = createNotebookLmSync(lockedDeps);

    const a = await outage.sync(makeMapping(), makeBodies());
    const b = await locked.sync(makeMapping(), makeBodies());
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;

    // Identical on the OLD surface — this is precisely why the old surface was
    // not enough.
    expect(a.value.heldForRetry).toEqual(b.value.heldForRetry);
    expect(a.value.outcome).toBe(b.value.outcome);
    // Different on the NEW one.
    expect(a.value.heldDetail).not.toEqual(b.value.heldDetail);
    expect(a.value.heldDetail[0]?.adapterCode).toBe("unreachable");
    expect(b.value.heldDetail[0]?.adapterCode).toBeUndefined();
  });

  it("both holds still reach the outbox — carrying the cause did not change the §8 disposition", async () => {
    const { deps: outageDeps, outboxRepo: outageBox } = makeHeldSyncDeps(OUTAGE_ADAPTER);
    const { deps: lockedDeps, outboxRepo: lockedBox } = makeHeldSyncDeps(
      makeFakeDriveAdapter().adapter,
      { getSecret: async () => err({ reason: "locked" as const }) },
    );

    await createNotebookLmSync(outageDeps).sync(makeMapping(), makeBodies());
    await createNotebookLmSync(lockedDeps).sync(makeMapping(), makeBodies());

    for (const box of [outageBox, lockedBox]) {
      const due = await box.listDue("2100-01-01T00:00:00.000Z", 100);
      expect(due.ok).toBe(true);
      if (due.ok) expect(due.value).toHaveLength(NOTEBOOK_SLOTS.length);
    }
  });
});

describe("createNotebookLmSync — `outcome` makes a partial sync unmissable (W2)", () => {
  it("a clean five-slot sync is `synced` and carries NO held entries", async () => {
    const { deps } = makeSyncDeps();
    const res = await createNotebookLmSync(deps).sync(makeMapping(), makeBodies());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.outcome).toBe("synced");
    expect(res.value.heldDetail).toEqual([]);
    expect(res.value.heldForRetry).toEqual([]);
  });

  it("a sync with a HELD slot is `incomplete`, not a clean success", async () => {
    const { deps } = makeHeldSyncDeps(OUTAGE_ADAPTER);
    const res = await createNotebookLmSync(deps).sync(makeMapping(), makeBodies());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Still `ok` — the write is durably held, not lost (see the block header) —
    // but the caller cannot read that `ok` as "the notebook is in sync".
    expect(res.value.outcome).toBe("incomplete");
    expect(res.value.heldForRetry).toHaveLength(NOTEBOOK_SLOTS.length);
  });

  it("a sync with a REATTACH slot is `incomplete` too — an unwritten slot is not a sync", async () => {
    const { deps } = makeSyncDeps();
    const mapping = makeMapping();
    const broken: NotebookMapping = {
      ...mapping,
      managedDocIds: { ...mapping.managedDocIds, "03_research": "   " },
    };
    const res = await createNotebookLmSync(deps).sync(broken, makeBodies());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.outcome).toBe("incomplete");
    expect(res.value.reattachRequired).toEqual(["03_research"]);
    // A reattach is not a hold: no held entry is fabricated for it.
    expect(res.value.heldDetail).toEqual([]);
  });

  it("a MIXED sync keeps `heldDetail` aligned with `heldForRetry` and reports `incomplete`", async () => {
    // 02_meetings 404s (reattach); 04_open_questions is unreachable (hold); the
    // rest upsert cleanly.
    const mapping = makeMapping();
    const keyFor = (slot: (typeof NOTEBOOK_SLOTS)[number]): string =>
      buildCanonicalObjectKey({ targetSystem: "drive", identity: { project: mapping.projectId, slot } });
    const notFoundKey = keyFor("02_meetings");
    const unreachableKey = keyFor("04_open_questions");
    const objects = new Map<string, string>();
    let nextId = 0;
    const mixed: TargetWriteAdapter = {
      targetSystem: "drive",
      existenceCheck: async (canonicalObjectKey: string): Promise<Result<ExistingObject | null, AdapterError>> => {
        if (canonicalObjectKey === notFoundKey) {
          return err<AdapterError>({ code: "not_found", message: "drive 404: source unlinked" });
        }
        if (canonicalObjectKey === unreachableKey) {
          return err<AdapterError>({ code: "unreachable", message: "drive endpoint unreachable" });
        }
        const hit = objects.get(canonicalObjectKey);
        return ok(hit === undefined ? null : { externalObjectId: hit, externalUrl: `https://drive/${hit}` });
      },
      create: async (env: { canonicalObjectKey: string }): Promise<Result<WriteReceipt, AdapterError>> => {
        const id = `drive_obj_${nextId++}`;
        objects.set(env.canonicalObjectKey, id);
        return ok<WriteReceipt>({ externalObjectId: id, externalUrl: `https://drive/${id}`, recordedAt: FIXED_CLOCK() });
      },
      update: async (): Promise<Result<WriteReceipt, AdapterError>> =>
        err<AdapterError>({ code: "unknown", message: "unused" }),
    };

    const { deps } = makeHeldSyncDeps(mixed);
    const res = await createNotebookLmSync(deps).sync(mapping, makeBodies());
    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.value.outcome).toBe("incomplete");
    expect(res.value.reattachRequired).toEqual(["02_meetings"]);
    expect(res.value.heldForRetry).toEqual(["04_open_questions"]);
    expect(res.value.heldDetail.map((h) => h.slot)).toEqual(["04_open_questions"]);
    expect(res.value.heldDetail[0]?.adapterCode).toBe("unreachable");
    expect([...res.value.upserted].sort()).toEqual(
      NOTEBOOK_SLOTS.filter((s) => s !== "02_meetings" && s !== "04_open_questions").sort(),
    );
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// W2 / 429 — a RATE LIMIT must reach the outbox, not terminate the sync.
//
// This drives the REAL chain end to end — fake `HttpTransport` →
// `createWriteHttpTransport` (whose `statusToFault` classifies the status) →
// `createDriveWriteAdapter` → the real `dispatchExternalWrite` → `syncSlot`'s hold
// branch — because the question ("does a 429 reach the hold branch?") is a claim
// about the WHOLE chain and cannot be answered by reading any one link.
//
// 403 is the non-vacuity control: it must still fail the sync CLOSED. Without it a
// green 429 test would also pass a build where EVERYTHING holds forever, which is
// the failure this round's status-classification fix exists to prevent in the other
// direction.
// ─────────────────────────────────────────────────────────────────────────────

const HTTP_SPEC: WriteHttpSpec = {
  baseUrl: "https://drive.example.com",
  allowedHosts: ["drive.example.com"],
  buildRequest: (req) => ({
    method: req.op === "query" ? "GET" : req.op === "create" ? "POST" : "PATCH",
    path: `/objects/${req.canonicalObjectKey}`,
    ...(req.op !== "query" ? { body: JSON.stringify(req.payload ?? {}) } : {}),
  }),
  mapResponse: (_status, json) => {
    const obj = json as { id?: string };
    if (typeof obj?.id !== "string") return { ok: false, fault: "unknown", detail: "missing id" };
    return { ok: true, object: { externalObjectId: obj.id } };
  },
};

function driveAdapterOverStatus(status: number): TargetWriteAdapter {
  const http: HttpTransport = {
    send: async () => ({ status, body: "{}" }),
  };
  const transport = createWriteHttpTransport(HTTP_SPEC, {
    http,
    secrets: { getSecret: async () => ok("write-token") },
  });
  return createDriveWriteAdapter({ transport, clock: FIXED_CLOCK });
}

describe("createNotebookLmSync — a vendor 429 reaches the outbox; a 403 still fails closed", () => {
  it("HTTP 429 (rate limited) HOLDS every slot in the outbox with adapterCode `unreachable` — never terminal", async () => {
    const { deps, outboxRepo } = makeHeldSyncDeps(driveAdapterOverStatus(429));
    const res = await createNotebookLmSync(deps).sync(makeMapping(), makeBodies());

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.outcome).toBe("incomplete");
    expect([...res.value.heldForRetry].sort()).toEqual([...NOTEBOOK_SLOTS].sort());
    for (const entry of res.value.heldDetail) {
      // 429 ∈ RETRYABLE_4XX ⇒ TransportFault "unreachable" ⇒ AdapterError
      // "unreachable" ⇒ gateway `held` ⇒ this hold branch. If any link in that
      // chain reclassifies 429 as terminal, this goes RED.
      expect(entry.adapterCode).toBe("unreachable");
    }
    const due = await outboxRepo.listDue("2100-01-01T00:00:00.000Z", 100);
    expect(due.ok).toBe(true);
    if (due.ok) expect(due.value).toHaveLength(NOTEBOOK_SLOTS.length);
  });

  it("HTTP 408 and 425 hold too (the rest of the retryable-4xx set)", async () => {
    for (const status of [408, 425]) {
      const { deps } = makeHeldSyncDeps(driveAdapterOverStatus(status));
      const res = await createNotebookLmSync(deps).sync(makeMapping(), makeBodies());
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.value.heldDetail[0]?.adapterCode).toBe("unreachable");
    }
  });

  it("NON-VACUITY: HTTP 403 is terminal — the sync fails closed and NOTHING is enqueued", async () => {
    const { deps, outboxRepo } = makeHeldSyncDeps(driveAdapterOverStatus(403));
    const res = await createNotebookLmSync(deps).sync(makeMapping(), makeBodies());

    expect(res.ok).toBe(false);
    const due = await outboxRepo.listDue("2100-01-01T00:00:00.000Z", 100);
    expect(due.ok).toBe(true);
    if (due.ok) expect(due.value).toHaveLength(0);
  });
});
