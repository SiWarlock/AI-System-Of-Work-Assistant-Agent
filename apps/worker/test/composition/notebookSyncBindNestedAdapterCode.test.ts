// R4 — notebookSyncBind.ts's `foldDispatchOutcome` CRITICAL fix: it folds a NESTED
// `dispatchExternalWrite` result into an `AdapterError` for the OUTER dispatch. Before
// this fix it hardcoded `AdapterError.code` off the nested `ExternalWriteResult.status`
// alone ("held"→"unreachable", "conflict"→"conflict", "rejected"→"rejected"), discarding
// the real inner `adapterCode` (`ExternalWriteResult.adapterCode`, a field
// packages/integrations/src/tools/gateway.ts now carries — see that file's
// `ExternalWriteResult` doc comment).
//
// THE FUNCTIONAL BREAK this pins: `notebooklm-sync.ts`'s `isReattachResult` branches on
// `adapterCode === "not_found"` to decide "reattach this slot" (a missing/unlinked Drive
// doc/folder) vs. "hard failure" (fails the WHOLE sync closed, `notebooklm-sync.ts:255-
// 257`). When the vendor `create` fault is `not_found` at the NESTED dispatch (inside
// `buildRoutedDriveAdapter.routeWrite`), the OLD hardcoded fold collapsed it to
// `code:"rejected"` — losing the `not_found` signal — so the OUTER dispatch's
// `adapterCode` came back `"rejected"`, `isReattachResult` returned false, and the ENTIRE
// sync failed closed instead of reattach-listing the one affected slot. This is an
// operator-visible functional regression, not just a diagnostic one: five good slots
// would come back as a hard sync failure because of one reattach-eligible slot.
//
// Drives the REAL two-level dispatch chain: `buildNotebookSync`'s `TargetWriteAdapter`
// wraps a NESTED `dispatchExternalWrite` call (via the injected registry-routed
// `dispatch`) over a FAKE vendor Drive adapter, exactly mirroring
// notebook-sync-bind.test.ts's own `makeFakeDriveAdapter` / `makeRoutedDispatch`
// harness (kept LOCAL here — a new, distinctly-named file, not an edit to that one).
import { describe, it, expect, vi } from "vitest";
import { ok, err } from "@sow/contracts";
import type {
  Result,
  WriteReceipt,
  AuditRecord,
  NotebookMapping,
  ExternalWriteEnvelope,
  ProposedAction,
} from "@sow/contracts";
import {
  dispatchExternalWrite,
  createUnroutedWriteAdapter,
  NOTEBOOK_SLOTS,
} from "@sow/integrations";
import type {
  ExternalWriteDeps,
  TargetWriteAdapter,
  ExistingObject,
  AdapterError,
  ReceiptStore,
  ReceiptRecord,
  ManagedDocBodies,
} from "@sow/integrations";
import { buildNotebookSync, type NotebookSyncBindDeps } from "../../src/composition/notebookSyncBind";

const FIXED_CLOCK = (): string => "2026-08-27T00:00:00.000Z";

function makeMapping(partial: Partial<NotebookMapping> = {}): NotebookMapping {
  return {
    projectId: "proj_reattach",
    notebookKey: "nb_reattach",
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

function createInMemoryReceiptStore(): ReceiptStore {
  const byIdem = new Map<string, ReceiptRecord>();
  const byObject = new Map<string, ReceiptRecord>();
  const reserved = new Set<string>();
  const key = (sys: string, k: string): string => `${sys}|${k}`;
  return {
    getByIdempotencyKey: (k) => Promise.resolve(byIdem.get(k)),
    getByCanonicalObjectKey: (sys, k) => Promise.resolve(byObject.get(key(sys, k))),
    reserve: (sys, k) => {
      const objKey = key(sys, k);
      const committed = byObject.get(objKey);
      if (committed !== undefined) return Promise.resolve({ kind: "committed", record: committed });
      if (reserved.has(objKey)) return Promise.resolve({ kind: "in_progress" });
      reserved.add(objKey);
      return Promise.resolve({ kind: "reserved" });
    },
    release: (sys, k) => {
      reserved.delete(key(sys, k));
      return Promise.resolve(undefined);
    },
    put: (r) => {
      const objKey = key(r.targetSystem, r.canonicalObjectKey);
      byIdem.set(r.idempotencyKey, r);
      byObject.set(objKey, r);
      return Promise.resolve(undefined);
    },
  };
}

// A fake vendor Drive adapter whose `create` fails `not_found` on exactly the
// `failOnCallIndex`th call (the "folder gone" real-world shape adapter-port.ts's
// `AdapterError.code` doc comment names) and succeeds for every other call.
// `canonicalObjectKey` is an OPAQUE sha256-derived value
// (packages/domain/src/keys/canonical-key.ts) — it carries no readable slot
// name — so the fault is targeted by CALL ORDER: `sync()` awaits each of the
// five 00→04 slots sequentially (notebooklm-sync.ts's `for…of` loop), so the
// Nth `create` call always corresponds to the Nth slot in `NOTEBOOK_SLOTS`.
function makeFakeDriveAdapterWithNotFoundOn(
  failOnCallIndex: number,
): { adapter: TargetWriteAdapter; createCalls: () => number } {
  const objects = new Map<string, string>();
  let nextId = 0;
  let calls = 0;
  const create = vi.fn(
    async (env: { canonicalObjectKey: string }): Promise<Result<WriteReceipt, AdapterError>> => {
      const thisCall = calls++;
      if (thisCall === failOnCallIndex) {
        return err<AdapterError>({ code: "not_found", message: "drive folder unlinked" });
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
      async (canonicalObjectKey: string): Promise<Result<ExistingObject | null, AdapterError>> => {
        const hit = objects.get(canonicalObjectKey);
        return ok(hit === undefined ? null : { externalObjectId: hit, externalUrl: `https://drive/${hit}` });
      },
    ),
    create: create as unknown as TargetWriteAdapter["create"],
    update: vi.fn(async () => err<AdapterError>({ code: "unknown", message: "unused" })),
  };
  return { adapter, createCalls: () => create.mock.calls.length };
}

function makeGatewayDeps(adapter: TargetWriteAdapter, store: ReceiptStore): { deps: ExternalWriteDeps } {
  const audits: AuditRecord[] = [];
  const deps: ExternalWriteDeps = {
    adapter,
    receiptStore: store,
    requireApproval: () => ({ requiresApproval: false }),
    recordPendingApproval: async () => ok(undefined),
    isApproved: async () => false,
    audit: async (rec) => {
      audits.push(rec);
    },
    clock: FIXED_CLOCK,
  };
  return { deps };
}

// The registry-routed `dispatch` stand-in — runs the REAL §8 pipeline (the NESTED
// dispatchExternalWrite call notebookSyncBind.ts's `buildRoutedDriveAdapter` makes),
// exactly mirroring buildActivities.ts:669's curried `dispatchRouted`.
function makeRoutedDispatch(driveAdapter: TargetWriteAdapter): NotebookSyncBindDeps["dispatch"] {
  return async (env: ExternalWriteEnvelope, action: ProposedAction, deps: ExternalWriteDeps) =>
    dispatchExternalWrite(env, action, { ...deps, adapter: driveAdapter });
}

function armedDeps(driveAdapter: TargetWriteAdapter): NotebookSyncBindDeps {
  const store = createInMemoryReceiptStore();
  const { deps: gateway } = makeGatewayDeps(createUnroutedWriteAdapter(), store);
  return {
    gate: { enabled: true },
    gateway,
    dispatch: makeRoutedDispatch(driveAdapter),
    approvalPolicy: "auto_allowed",
    clock: FIXED_CLOCK,
  };
}

describe("notebookSyncBind foldDispatchOutcome — the nested dispatch's real adapterCode survives the fold (R4 critical fix)", () => {
  it("a nested not_found create fault reattaches the ONE affected slot; the other four still upsert (was: the whole sync failed closed)", async () => {
    const { adapter: fakeDrive, createCalls } = makeFakeDriveAdapterWithNotFoundOn(0);
    const port = buildNotebookSync(armedDeps(fakeDrive));
    if (port === undefined) throw new Error("expected an armed port");

    const res = await port.sync(makeMapping(), makeBodies());

    // THE PROOF: the sync SUCCEEDS overall (not a hard failure) and correctly
    // partitions the reattach-eligible slot away from the four clean upserts —
    // only reachable if the nested "not_found" adapterCode survived BOTH fold
    // layers (buildRoutedDriveAdapter's foldDispatchOutcome, then the outer
    // dispatchExternalWrite's own create-fault switch) intact.
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.reattachRequired).toEqual(["00_brief"]);
    expect([...res.value.upserted].sort()).toEqual(
      ["01_decisions", "02_meetings", "03_research", "04_open_questions"].sort(),
    );
    expect(res.value.heldForRetry).toEqual([]);
    // All five slots reached the vendor create (existence check always misses on a
    // fresh store) — the fault was a create fault, not a short-circuit.
    expect(createCalls()).toBe(5);
  });

  it("a nested `unreachable` create fault (no reattach signal) still fails the whole sync closed — the fallback path is unaffected by the fix", async () => {
    const objects = new Map<string, string>();
    let calls = 0;
    const adapter: TargetWriteAdapter = {
      targetSystem: "drive",
      existenceCheck: vi.fn(async () => ok(null)),
      create: vi.fn(
        async (env: { canonicalObjectKey: string }): Promise<Result<WriteReceipt, AdapterError>> => {
          if (calls++ === 0) {
            return err<AdapterError>({ code: "unreachable", message: "drive endpoint unreachable" });
          }
          const id = `drive_obj_${objects.size}`;
          objects.set(env.canonicalObjectKey, id);
          return ok<WriteReceipt>({ externalObjectId: id, recordedAt: FIXED_CLOCK() });
        },
      ),
      update: vi.fn(async () => err<AdapterError>({ code: "unknown", message: "unused" })),
    };
    const port = buildNotebookSync(armedDeps(adapter));
    if (port === undefined) throw new Error("expected an armed port");

    const res = await port.sync(makeMapping(), makeBodies());

    // An `unreachable` nested fault carries NO adapterCode "not_found" signal — it
    // correctly still routes to a hard failure (no outbox wired on this bind), NOT
    // a false reattach. The fix widens what SURVIVES the fold; it does not
    // reclassify every fault as a reattach.
    expect(res.ok).toBe(false);
  });
});
