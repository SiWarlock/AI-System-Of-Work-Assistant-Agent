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
// `existenceCheck` reports the hit. A per-key 404 opt-in makes existence + create
// return an "unlinked source" fault (the reattach signal).
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
        return err<AdapterError>({ code: "rejected", message: "drive 404: managed doc not found / source unlinked" });
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
          return err<AdapterError>({ code: "rejected", message: "drive 404: source unlinked" });
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

  it("without an outbox wired, an unreachable hold fails the sync closed (backward-compatible)", async () => {
    const store = new InMemoryReceiptStore();
    const { deps: gatewayDeps } = makeGatewayDeps(unreachableAdapter, store);
    const port = createNotebookLmSync({
      gateway: gatewayDeps,
      approvalPolicy: "auto_allowed",
      clock: FIXED_CLOCK,
    });

    const res = await port.sync(makeMapping(), makeBodies());
    expect(res.ok).toBe(false);
  });
});
