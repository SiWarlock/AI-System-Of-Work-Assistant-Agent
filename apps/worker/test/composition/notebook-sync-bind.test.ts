// 21.9a — buildNotebookSync (the dormant NotebookLM sync worker-bind factory).
// See ../../src/composition/notebookSyncBind.ts's module header for WHY the
// routed adapter's existenceCheck always answers "not locally known" and why the
// nested dispatch runs over a throwaway inner receipt store.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
  OutboxRepository,
  OutboxEntry,
  ManagedDocBodies,
} from "@sow/integrations";
import type { DbError } from "@sow/db";
import { buildNotebookSync, type NotebookSyncBindDeps } from "../../src/composition/notebookSyncBind";

const FIXED_CLOCK = (): string => "2026-08-24T00:00:00.000Z";

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

// A minimal, correct in-memory ReceiptStore — mirrors the REAL reservation
// semantics (reserved/in_progress/committed) dispatchExternalWrite depends on
// (packages/integrations/src/tools/gateway.ts step 3.5, verified against
// packages/integrations/test/tool-gateway-race.test.ts).
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
      reserved.delete(objKey);
      return Promise.resolve(undefined);
    },
  };
}

// A fake Drive TargetWriteAdapter — mirrors packages/integrations/test/notebook-
// sync.test.ts's makeFakeDriveAdapter shape (create remembers the object so a
// live existenceCheck on the SAME key hits; a per-key "unreachable" opt-in drives
// the hold-through-outage path). Read, not modified (out of territory).
function makeFakeDriveAdapter(opts: { unreachableKeys?: ReadonlySet<string> } = {}): {
  adapter: TargetWriteAdapter;
  createCalls: () => number;
  store: Map<string, string>;
} {
  const objects = new Map<string, string>();
  const unreachable = opts.unreachableKeys ?? new Set<string>();
  let nextId = 0;
  const create = vi.fn(
    async (env: { canonicalObjectKey: string }): Promise<Result<WriteReceipt, AdapterError>> => {
      if (unreachable.has(env.canonicalObjectKey)) {
        return err<AdapterError>({ code: "unreachable", message: "drive endpoint unreachable" });
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
        if (unreachable.has(canonicalObjectKey)) {
          return err<AdapterError>({ code: "unreachable", message: "drive endpoint unreachable" });
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

function makeGatewayDeps(adapter: TargetWriteAdapter, store: ReceiptStore): {
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
    audit: async (rec) => {
      audits.push(rec);
    },
    clock: FIXED_CLOCK,
  };
  return { deps, audits };
}

// A registry-routed `dispatch` stand-in — exactly `dispatchRouted`'s observable
// shape (override the adapter, run the real §8 pipeline), mirroring
// buildActivities.ts:669's `(env, action, deps) => dispatchRouted(registry, env,
// action, deps)` curried over ONE fake drive adapter.
function makeRoutedDispatch(
  driveAdapter: TargetWriteAdapter,
): NotebookSyncBindDeps["dispatch"] & ReturnType<typeof vi.fn> {
  return vi.fn(
    async (env: ExternalWriteEnvelope, action: ProposedAction, deps: ExternalWriteDeps) =>
      dispatchExternalWrite(env, action, { ...deps, adapter: driveAdapter }),
  );
}

function makeFakeOutbox(): OutboxRepository {
  const byId = new Map<string, OutboxEntry>();
  return {
    enqueue: (entry) => {
      byId.set(entry.outboxId, entry);
      return Promise.resolve(ok(entry));
    },
    get: (outboxId) => {
      const e = byId.get(outboxId);
      return Promise.resolve(e !== undefined ? ok(e) : err<DbError>({ code: "not_found", message: "not found" }));
    },
    getByIdempotencyKey: (idempotencyKey) => {
      for (const e of byId.values()) {
        if (e.idempotencyKey === idempotencyKey) return Promise.resolve(ok(e));
      }
      return Promise.resolve(err<DbError>({ code: "not_found", message: "not found" }));
    },
    listDue: () => Promise.resolve(ok([...byId.values()])),
    update: (entry) => {
      byId.set(entry.outboxId, entry);
      return Promise.resolve(ok(entry));
    },
  };
}

function baseDeps(overrides: Partial<NotebookSyncBindDeps> = {}): NotebookSyncBindDeps {
  const { adapter } = makeFakeDriveAdapter();
  const store = createInMemoryReceiptStore();
  // The sentinel by default — proves nothing in this bind relies on `gateway.adapter`.
  const { deps: gateway } = makeGatewayDeps(createUnroutedWriteAdapter(), store);
  return {
    gateway,
    dispatch: makeRoutedDispatch(adapter),
    approvalPolicy: "auto_allowed",
    clock: FIXED_CLOCK,
    ...overrides,
  };
}

// --- tests -------------------------------------------------------------------

describe("buildNotebookSync — default-OFF gate (an unset gate)", () => {
  it("an unset gate yields undefined and constructs no NotebookPort", () => {
    const dispatch = vi.fn();
    const registerSchedule = vi.fn();
    const deps = baseDeps({ dispatch: dispatch as unknown as NotebookSyncBindDeps["dispatch"], registerSchedule });

    const port = buildNotebookSync(deps);

    expect(port).toBeUndefined();
    expect(registerSchedule).not.toHaveBeenCalled();
    expect(dispatch).not.toHaveBeenCalled();
  });
});

describe("buildNotebookSync — a truthy-but-not-true gate never arms", () => {
  const cases: Array<{ label: string; gate: NotebookSyncBindDeps["gate"] }> = [
    { label: "enabled:1", gate: { enabled: 1 as unknown as boolean } },
    { label: 'enabled:"true"', gate: { enabled: "true" as unknown as boolean } },
    { label: 'enabled:"false"', gate: { enabled: "false" as unknown as boolean } },
    { label: "enabled:{}", gate: { enabled: {} as unknown as boolean } },
    { label: "{} (enabled absent)", gate: {} },
    { label: "undefined gate", gate: undefined },
  ];

  it.each(cases)("$label never arms and never throws", ({ gate }) => {
    const deps = baseDeps({ gate });
    let result: ReturnType<typeof buildNotebookSync>;
    expect(() => {
      result = buildNotebookSync(deps);
    }).not.toThrow();
    expect(result!).toBeUndefined();
  });
});

describe("buildNotebookSync — armed: routes through the injected dispatch, never the unrouted sentinel", () => {
  it("Drive writes route through dispatch (targetSystem:'drive'); the sync does not come back rejected-by-sentinel", async () => {
    const { adapter: fakeDrive } = makeFakeDriveAdapter();
    const dispatch = makeRoutedDispatch(fakeDrive);
    const store = createInMemoryReceiptStore();
    // The sentinel — must never actually be invoked by the armed sync.
    const { deps: gateway } = makeGatewayDeps(createUnroutedWriteAdapter(), store);
    const deps = baseDeps({ gate: { enabled: true }, gateway, dispatch });

    const port = buildNotebookSync(deps);
    expect(port).toBeDefined();
    if (port === undefined) return;

    const res = await port.sync(makeMapping(), makeBodies());

    expect(dispatch).toHaveBeenCalled();
    const [, calledAction] = dispatch.mock.calls[0]!;
    expect((calledAction as { targetSystem: string }).targetSystem).toBe("drive");
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect([...res.value.upserted].sort()).toEqual([...NOTEBOOK_SLOTS].sort());
    }
  });
});

describe("buildNotebookSync — armed, over the stub transport: byte-equivalent to the module's own tested behaviour", () => {
  it("upserts all five slots on first sync; a second sync of the same bodies reuses receipts with no additional dispatch calls", async () => {
    const { adapter: fakeDrive, store: driveStore } = makeFakeDriveAdapter();
    const dispatch = makeRoutedDispatch(fakeDrive);
    const store = createInMemoryReceiptStore();
    const { deps: gateway } = makeGatewayDeps(createUnroutedWriteAdapter(), store);
    const deps = baseDeps({ gate: { enabled: true }, gateway, dispatch });
    const port = buildNotebookSync(deps);
    if (port === undefined) throw new Error("expected an armed port");

    const mapping = makeMapping();
    const bodies = makeBodies();

    const first = await port.sync(mapping, bodies);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect([...first.value.upserted].sort()).toEqual([...NOTEBOOK_SLOTS].sort());
    expect(first.value.reattachRequired).toEqual([]);
    expect(first.value.heldForRetry).toEqual([]);
    expect(driveStore.size).toBe(5);
    expect(dispatch.mock.calls.length).toBe(5);
    const dispatchCallsAfterFirst = dispatch.mock.calls.length;

    const second = await port.sync(mapping, bodies);
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    // Every slot still reports upserted (idempotent in-place) — exactly the
    // module's own "a SECOND sync of the same bodies REUSES receipts" pin
    // (packages/integrations/test/notebook-sync.test.ts).
    expect([...second.value.upserted].sort()).toEqual([...NOTEBOOK_SLOTS].sort());
    // Replay is short-circuited by the REAL shared receipt store's own
    // getByIdempotencyKey/getByCanonicalObjectKey lookup, BEFORE the wrapper's
    // existenceCheck/create (and therefore `dispatch`) is ever reached — no
    // duplicate Drive docs, no additional dispatch calls.
    expect(dispatch.mock.calls.length).toBe(dispatchCallsAfterFirst);
  });

  it("a blank slot mapping id still yields reattach_required, no create, NOT a throw (module parity)", async () => {
    const { adapter: fakeDrive } = makeFakeDriveAdapter();
    const dispatch = makeRoutedDispatch(fakeDrive);
    const store = createInMemoryReceiptStore();
    const { deps: gateway } = makeGatewayDeps(createUnroutedWriteAdapter(), store);
    const deps = baseDeps({ gate: { enabled: true }, gateway, dispatch });
    const port = buildNotebookSync(deps);
    if (port === undefined) throw new Error("expected an armed port");

    const mapping = makeMapping();
    const broken: NotebookMapping = {
      ...mapping,
      managedDocIds: { ...mapping.managedDocIds, "03_research": "   " },
    };

    const res = await port.sync(broken, makeBodies());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.value.reattachRequired).toEqual(["03_research"]);
    expect(res.value.upserted).toHaveLength(4);
    // The blank slot never dispatched at all.
    expect(dispatch).toHaveBeenCalledTimes(4);
  });
});

describe("buildNotebookSync — an unreachable Drive hold is enqueued to the injected outbox, never dropped and never a hard failure", () => {
  const unreachableAdapter: TargetWriteAdapter = {
    targetSystem: "drive",
    existenceCheck: async (): Promise<Result<ExistingObject | null, AdapterError>> =>
      err<AdapterError>({ code: "unreachable", message: "drive endpoint unreachable" }),
    create: async (): Promise<Result<WriteReceipt, AdapterError>> =>
      err<AdapterError>({ code: "unreachable", message: "drive endpoint unreachable" }),
    update: async (): Promise<Result<WriteReceipt, AdapterError>> =>
      err<AdapterError>({ code: "unknown", message: "unused" }),
  };

  it("with an outbox wired, every slot is held in the outbox and the sync does not fail", async () => {
    const dispatch = makeRoutedDispatch(unreachableAdapter);
    const store = createInMemoryReceiptStore();
    const { deps: gateway } = makeGatewayDeps(createUnroutedWriteAdapter(), store);
    const outboxRepo = makeFakeOutbox();
    let n = 0;
    const deps = baseDeps({
      gate: { enabled: true },
      gateway,
      dispatch,
      outbox: {
        repo: outboxRepo,
        hold: { clock: FIXED_CLOCK, outboxId: () => `outbox_${n++}` },
        workspaceId: "personal-business",
      },
    });
    const port = buildNotebookSync(deps);
    if (port === undefined) throw new Error("expected an armed port");

    const res = await port.sync(makeMapping(), makeBodies());

    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect([...res.value.heldForRetry].sort()).toEqual([...NOTEBOOK_SLOTS].sort());
    expect(res.value.upserted).toEqual([]);

    const due = await outboxRepo.listDue("2100-01-01T00:00:00.000Z", 100);
    expect(due.ok).toBe(true);
    if (due.ok) expect(due.value).toHaveLength(5);
  });

  it("without an outbox wired, an unreachable hold fails the sync closed (backward-compatible)", async () => {
    const dispatch = makeRoutedDispatch(unreachableAdapter);
    const store = createInMemoryReceiptStore();
    const { deps: gateway } = makeGatewayDeps(createUnroutedWriteAdapter(), store);
    const deps = baseDeps({ gate: { enabled: true }, gateway, dispatch }); // no outbox
    const port = buildNotebookSync(deps);
    if (port === undefined) throw new Error("expected an armed port");

    const res = await port.sync(makeMapping(), makeBodies());
    expect(res.ok).toBe(false);
  });
});

describe("buildNotebookSync — registerSchedule", () => {
  it("is invoked exactly once, and only on the armed path", () => {
    const registerUnarmed = vi.fn();
    const unarmedPort = buildNotebookSync(baseDeps({ registerSchedule: registerUnarmed }));
    expect(unarmedPort).toBeUndefined();
    expect(registerUnarmed).not.toHaveBeenCalled();

    const registerArmed = vi.fn();
    const armedPort = buildNotebookSync(baseDeps({ gate: { enabled: true }, registerSchedule: registerArmed }));
    expect(armedPort).toBeDefined();
    expect(registerArmed).toHaveBeenCalledTimes(1);
    expect(registerArmed).toHaveBeenCalledWith(armedPort);
  });

  it("an armed bind with no registerSchedule supplied still returns a port (registerSchedule is optional)", () => {
    const armedPort = buildNotebookSync(baseDeps({ gate: { enabled: true } }));
    expect(armedPort).toBeDefined();
  });
});

describe("buildNotebookSync — dormancy pin: zero call-sites in the four worker composition files PROV-6 owns", () => {
  it("the string buildNotebookSync appears in NONE of buildActivities.ts, backends.ts, boot.ts, provisionDev.ts", () => {
    const files = [
      "../../src/composition/buildActivities.ts",
      "../../src/composition/backends.ts",
      "../../src/boot.ts",
      "../../src/composition/provisionDev.ts",
    ];
    let scanned = 0;
    for (const rel of files) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      // Positive control: the read actually pulled real file content (not an
      // empty/failed read masquerading as a clean scan).
      expect(src.length).toBeGreaterThan(1000);
      expect(src.includes("buildNotebookSync")).toBe(false);
      scanned += 1;
    }
    expect(scanned).toBe(4);
  });
});
