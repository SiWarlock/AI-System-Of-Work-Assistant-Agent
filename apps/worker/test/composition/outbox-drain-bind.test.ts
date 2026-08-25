// 21.4b — buildDrainDeps / buildWakeDrainHook (the wake-drain deps FACTORY, pure,
// unbound). See ../../src/composition/outboxDrainBind.ts's module header for what
// each function assembles and why. This suite proves:
//
//   • buildDrainDeps binds `dispatch` to `dispatchRouted(writeAdapters, ...)` — a
//     drained entry reaches the REGISTRY-PICKED vendor adapter, never the
//     fail-closed `createUnroutedWriteAdapter()` sentinel that sits on
//     `gatewayDeps.adapter`.
//   • buildWakeDrainHook's returned fn re-drives the held outbox via
//     `runWakeDrain`, and its signature satisfies `createKeychainLockController`'s
//     `KeychainLockDeps.wakeDrain` contract directly (no adapter shim needed).
//   • the drain shares the replay gate (safety rule 3) — a same-idempotencyKey
//     replay is `reused`, zero duplicate transport `create` calls.
//   • `limit` clamps a non-positive value UP to `DEFAULT_WAKE_LIMIT`, never drops
//     work to a zero-width sweep.
//   • no `Math.random()` anywhere in the module — jitter is strictly injected.
//   • DORMANCY: neither factory has a call-site in any of the four composition-
//     root files this slice deliberately leaves untouched (PROV-6's territory).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { ok, err, isOk } from "@sow/contracts";
import type { AuditId, ProviderId, TargetSystem } from "@sow/contracts";
import {
  createUnroutedWriteAdapter,
  buildWriteAdapterRegistry,
  drainOutbox,
} from "@sow/integrations";
import type {
  AdapterTransport,
  AdapterTransportRequest,
  TransportResponse,
  TargetWriteAdapter,
  ExternalWriteDeps,
  ReceiptStore,
  ReceiptRecord,
  OutboxRepository,
  OutboxEntry,
  BackoffConfig,
  DrainResult,
} from "@sow/integrations";
import type { DbError, DbResult } from "@sow/db";
import { DEFAULT_WAKE_LIMIT } from "@sow/workflows";
import {
  createHealthSurface,
  type HealthSurfaceStore,
  type SurfacedHealthItem,
} from "../../src/health/surface";
import {
  createKeychainLockController,
  type ProviderDegradationStore,
} from "../../src/lifecycle/degraded/keychain-locked";
import {
  buildDrainDeps,
  buildWakeDrainHook,
} from "../../src/composition/outboxDrainBind";

const CLOCK = (): string => "2026-08-24T00:00:00.000Z";
const BACKOFF_CFG: BackoffConfig = { baseMs: 1000, maxMs: 60000, maxAttempts: 5 };
const WORKSPACE = "personal-business";

// --- fakes ---------------------------------------------------------------------

// Records every AdapterTransportRequest it receives. `query` always misses (no
// prior object) so the pipeline proceeds to `create`; `create` synthesizes a
// fresh vendor id per call — mirrors a real vendor happy-path.
function createRecordingTransport(): { transport: AdapterTransport; calls: AdapterTransportRequest[] } {
  const calls: AdapterTransportRequest[] = [];
  let nextId = 0;
  const transport: AdapterTransport = (req: AdapterTransportRequest): Promise<TransportResponse> => {
    calls.push(req);
    if (req.op === "create") {
      return Promise.resolve({
        ok: true,
        object: { externalObjectId: `ext_${req.targetSystem}_${nextId++}` },
      });
    }
    return Promise.resolve({ ok: true, object: null });
  };
  return { transport, calls };
}

// A minimal, correct in-memory ReceiptStore mirroring the real reservation
// semantics (reserved/in_progress/committed) `dispatchExternalWrite` depends on.
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

function makeGatewayDeps(adapter: TargetWriteAdapter, receiptStore: ReceiptStore): ExternalWriteDeps {
  return {
    adapter,
    receiptStore,
    requireApproval: () => ({ requiresApproval: false }), // auto-allow: reach dispatch
    recordPendingApproval: async () => ok(undefined),
    isApproved: async () => true,
    audit: async () => undefined,
    clock: CLOCK,
  };
}

// A local Map-backed OutboxRepository — mirrors the worker's own established
// per-test fixture convention (apps/worker/test/composition/notebook-sync-
// bind.test.ts's makeFakeOutbox).
function makeFakeOutbox(): OutboxRepository {
  const byId = new Map<string, OutboxEntry>();
  return {
    enqueue: (entry: OutboxEntry): DbResult<OutboxEntry> => {
      byId.set(entry.outboxId, entry);
      return Promise.resolve(ok(entry));
    },
    get: (outboxId: string): DbResult<OutboxEntry> => {
      const e = byId.get(outboxId);
      return Promise.resolve(e !== undefined ? ok(e) : err<DbError>({ code: "not_found", message: "not found" }));
    },
    getByIdempotencyKey: (idempotencyKey: string): DbResult<OutboxEntry> => {
      for (const e of byId.values()) {
        if (e.idempotencyKey === idempotencyKey) return Promise.resolve(ok(e));
      }
      return Promise.resolve(err<DbError>({ code: "not_found", message: "not found" }));
    },
    listDue: (): DbResult<OutboxEntry[]> => Promise.resolve(ok([...byId.values()])),
    update: (entry: OutboxEntry): DbResult<OutboxEntry> => {
      byId.set(entry.outboxId, entry);
      return Promise.resolve(ok(entry));
    },
  };
}

function makeHeldEntry(overrides: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    outboxId: "outbox_1",
    actionRef: "action_1",
    workspaceId: WORKSPACE,
    targetSystem: "todoist",
    canonicalObjectKey: "cok_todoist_1",
    idempotencyKey: "idem_todoist_1",
    payloadHash: "sha256:deadbeef",
    approvalPolicy: "auto_allowed",
    status: "retry_queued",
    payload: { title: "buy milk" },
    attempts: 0,
    enqueuedAt: CLOCK(),
    updatedAt: CLOCK(),
    ...overrides,
  };
}

function makeReceiptRecord(overrides: Partial<ReceiptRecord> = {}): ReceiptRecord {
  return {
    idempotencyKey: "idem_todoist_1",
    canonicalObjectKey: "cok_todoist_1",
    targetSystem: "todoist" as TargetSystem,
    payloadHash: "sha256:deadbeef",
    receipt: { externalObjectId: "ext_prior", recordedAt: CLOCK() },
    recordedAt: CLOCK(),
    ...overrides,
  };
}

// A fresh happy-path rig: recording transport + real routing registry + empty
// receipt store + the SENTINEL bound to gatewayDeps.adapter (spied so a call to
// it would be caught).
function makeRig() {
  const { transport, calls: transportCalls } = createRecordingTransport();
  const writeAdapters = buildWriteAdapterRegistry({ transport, clock: CLOCK });
  const sentinel = createUnroutedWriteAdapter();
  const sentinelCreate = vi.spyOn(sentinel, "create");
  const sentinelExistenceCheck = vi.spyOn(sentinel, "existenceCheck");
  const receiptStore = createInMemoryReceiptStore();
  const gatewayDeps = makeGatewayDeps(sentinel, receiptStore);
  return { writeAdapters, transportCalls, gatewayDeps, sentinelCreate, sentinelExistenceCheck, receiptStore };
}

// --- tests -----------------------------------------------------------------

describe("buildDrainDeps — routes through dispatchRouted, never the unrouted sentinel", () => {
  it("a due todoist entry dispatches a real transport create and lands receipt_recorded, never rejected", async () => {
    const { writeAdapters, transportCalls, gatewayDeps, sentinelCreate, sentinelExistenceCheck } = makeRig();
    const outbox = makeFakeOutbox();
    await outbox.enqueue(makeHeldEntry());

    const drainDeps = buildDrainDeps({ gatewayDeps, workspaceId: WORKSPACE, writeAdapters, clock: CLOCK, backoffCfg: BACKOFF_CFG });
    const result = await drainOutbox(outbox, drainDeps);

    expect(result).toEqual({ drained: 1, reused: 0, held: 0, failed: 0, skipped: 0 });

    const createCalls = transportCalls.filter((c) => c.op === "create" && c.targetSystem === "todoist");
    expect(createCalls).toHaveLength(1);

    // The sentinel on gatewayDeps.adapter was NEVER touched — proves the routed
    // seam, not the raw adapter, handled the write.
    expect(sentinelCreate).not.toHaveBeenCalled();
    expect(sentinelExistenceCheck).not.toHaveBeenCalled();

    const entry = await outbox.get("outbox_1");
    expect(isOk(entry)).toBe(true);
    if (!isOk(entry)) return;
    expect(entry.value.status).toBe("receipt_recorded");
  });
});

describe("buildWakeDrainHook — re-drives the held outbox exactly once per invocation", () => {
  it("one invocation drains the one due entry and issues exactly one transport create", async () => {
    const { writeAdapters, transportCalls, gatewayDeps } = makeRig();
    const outbox = makeFakeOutbox();
    await outbox.enqueue(makeHeldEntry());
    const drainDeps = buildDrainDeps({ gatewayDeps, workspaceId: WORKSPACE, writeAdapters, clock: CLOCK, backoffCfg: BACKOFF_CFG });

    const hook = buildWakeDrainHook({ outbox, drainDeps });
    const result = await hook({ reason: "power_resume", now: CLOCK() });

    expect(result).toEqual({ drained: 1, reused: 0, held: 0, failed: 0, skipped: 0 });
    expect(transportCalls.filter((c) => c.op === "create")).toHaveLength(1);
  });

  it("a replay of the same idempotencyKey returns reused with ZERO duplicate external create (safety rule 3)", async () => {
    const { writeAdapters, transportCalls, gatewayDeps, receiptStore } = makeRig();
    // Pre-seed the receipt store — the entry's write already landed once.
    await receiptStore.put(makeReceiptRecord());
    const outbox = makeFakeOutbox();
    await outbox.enqueue(makeHeldEntry());
    const drainDeps = buildDrainDeps({ gatewayDeps, workspaceId: WORKSPACE, writeAdapters, clock: CLOCK, backoffCfg: BACKOFF_CFG });

    const hook = buildWakeDrainHook({ outbox, drainDeps });
    const result = await hook({ reason: "network_reconnect", now: CLOCK() });

    expect(result).toEqual({ drained: 0, reused: 1, held: 0, failed: 0, skipped: 0 });
    expect(transportCalls.filter((c) => c.op === "create")).toHaveLength(0);
  });
});

describe("buildWakeDrainHook — satisfies createKeychainLockController's wakeDrain contract", () => {
  const PROVIDER = "claude" as ProviderId;
  const AUDIT = "audit_wake_drain" as AuditId;

  function makeHealthSurface(): ReturnType<typeof createHealthSurface> {
    const rows = new Map<string, SurfacedHealthItem>();
    const store: HealthSurfaceStore = {
      getByDedupeKey: (k) => Promise.resolve(rows.get(k)),
      put: (r) => {
        rows.set(r.dedupeKey, r);
        return Promise.resolve();
      },
      list: () => Promise.resolve([...rows.values()]),
    };
    return createHealthSurface(store);
  }

  function makeDegradationStore(): ProviderDegradationStore {
    const degraded = new Set<ProviderId>();
    return {
      markDegraded: (p) => {
        degraded.add(p);
        return Promise.resolve();
      },
      clearDegraded: (p) => {
        degraded.delete(p);
        return Promise.resolve();
      },
      isDegraded: (p) => Promise.resolve(degraded.has(p)),
    };
  }

  it("plugged straight in as KeychainLockDeps.wakeDrain, onUnlock surfaces the REAL drain counts", async () => {
    const { writeAdapters, gatewayDeps } = makeRig();
    const outbox = makeFakeOutbox();
    await outbox.enqueue(makeHeldEntry());
    const drainDeps = buildDrainDeps({ gatewayDeps, workspaceId: WORKSPACE, writeAdapters, clock: CLOCK, backoffCfg: BACKOFF_CFG });
    const hook = buildWakeDrainHook({ outbox, drainDeps });

    const ctl = createKeychainLockController({
      surface: makeHealthSurface(),
      degradationStore: makeDegradationStore(),
      auditRef: AUDIT,
      // No adapter/shim needed — the hook's own signature satisfies the port.
      wakeDrain: hook,
    });

    await ctl.onKeychainLocked({ subjectRef: PROVIDER, now: CLOCK() });
    await ctl.holdJob("job-K", { subjectRef: PROVIDER });

    const unlocked = await ctl.onUnlock({ reason: "power_resume", now: CLOCK() });
    expect(isOk(unlocked)).toBe(true);
    if (!isOk(unlocked)) return;
    // This is the REAL drain outcome from the seeded todoist entry — not a canned
    // fake — proving the hook is genuinely wired into the port, not merely
    // type-compatible with it.
    const drain: DrainResult = unlocked.value.drain;
    expect(drain).toEqual({ drained: 1, reused: 0, held: 0, failed: 0, skipped: 0 });
    expect(ctl.heldJobs()).toHaveLength(0);
  });
});

describe("buildDrainDeps — threads workspaceId onto DrainDeps (task 24.50, safety rule 4)", () => {
  it("a due entry from a DIFFERENT workspace is SKIPPED — never dispatched, never touches the transport", async () => {
    const { writeAdapters, transportCalls, gatewayDeps } = makeRig();
    const outbox = makeFakeOutbox();
    // The matching entry (WORKSPACE) and a foreign one (employer-work) land in
    // the SAME outbox pass.
    await outbox.enqueue(makeHeldEntry());
    await outbox.enqueue(
      makeHeldEntry({
        outboxId: "outbox_foreign",
        workspaceId: "employer-work",
        canonicalObjectKey: "cok_todoist_foreign",
        idempotencyKey: "idem_todoist_foreign",
      }),
    );

    const drainDeps = buildDrainDeps({ gatewayDeps, workspaceId: WORKSPACE, writeAdapters, clock: CLOCK, backoffCfg: BACKOFF_CFG });
    const result = await drainOutbox(outbox, drainDeps);

    // Exactly the WORKSPACE entry drained; the foreign one is skipped, not
    // evaluated against this pass's (differently-scoped) approval posture.
    expect(result).toEqual({ drained: 1, reused: 0, held: 0, failed: 0, skipped: 1 });
    // Only ONE transport create — the foreign entry never reached dispatch.
    expect(transportCalls.filter((c) => c.op === "create")).toHaveLength(1);

    // The skipped entry is left EXACTLY as it was — no attempts bump, no store
    // mutation — so a later, correctly-scoped pass can still drain it.
    const foreign = await outbox.get("outbox_foreign");
    expect(isOk(foreign)).toBe(true);
    if (!isOk(foreign)) return;
    expect(foreign.value.status).toBe("retry_queued");
    expect(foreign.value.attempts).toBe(0);
  });
});

describe("buildDrainDeps — limit clamping", () => {
  it("an omitted limit defaults to DEFAULT_WAKE_LIMIT", () => {
    const { writeAdapters, gatewayDeps } = makeRig();
    const drainDeps = buildDrainDeps({ gatewayDeps, workspaceId: WORKSPACE, writeAdapters, clock: CLOCK, backoffCfg: BACKOFF_CFG });
    expect(drainDeps.limit).toBe(DEFAULT_WAKE_LIMIT);
  });

  it.each([0, -1, -100])(
    "a non-positive supplied limit (%i) is CLAMPED UP to DEFAULT_WAKE_LIMIT, never dropped",
    (bad) => {
      const { writeAdapters, gatewayDeps } = makeRig();
      const drainDeps = buildDrainDeps({
        gatewayDeps,
        workspaceId: WORKSPACE,
        writeAdapters,
        clock: CLOCK,
        backoffCfg: BACKOFF_CFG,
        limit: bad,
      });
      expect(drainDeps.limit).toBe(DEFAULT_WAKE_LIMIT);
    },
  );

  it("a positive supplied limit passes through unchanged", () => {
    const { writeAdapters, gatewayDeps } = makeRig();
    const drainDeps = buildDrainDeps({
      gatewayDeps,
      workspaceId: WORKSPACE,
      writeAdapters,
      clock: CLOCK,
      backoffCfg: BACKOFF_CFG,
      limit: 7,
    });
    expect(drainDeps.limit).toBe(7);
  });
});

describe("outboxDrainBind — no Math.random anywhere; jitter is strictly injected", () => {
  it("the module source contains no Math.random call", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../../src/composition/outboxDrainBind.ts", import.meta.url)),
      "utf8",
    );
    expect(src.includes("Math.random")).toBe(false);
  });

  it("an injected jitter is threaded through to the built DrainDeps unchanged", () => {
    const { writeAdapters, gatewayDeps } = makeRig();
    const jitter = (base: number): number => base + 42;
    const drainDeps = buildDrainDeps({
      gatewayDeps,
      workspaceId: WORKSPACE,
      writeAdapters,
      clock: CLOCK,
      backoffCfg: BACKOFF_CFG,
      jitter,
    });
    expect(drainDeps.jitter).toBe(jitter);
  });

  it("an omitted jitter leaves the field absent (never a Math.random default)", () => {
    const { writeAdapters, gatewayDeps } = makeRig();
    const drainDeps = buildDrainDeps({ gatewayDeps, workspaceId: WORKSPACE, writeAdapters, clock: CLOCK, backoffCfg: BACKOFF_CFG });
    expect(drainDeps.jitter).toBeUndefined();
  });
});

describe("outboxDrainBind — DORMANCY: zero call-sites in the four composition-root files", () => {
  it("buildDrainDeps and buildWakeDrainHook appear in none of buildActivities.ts / backends.ts / boot.ts / workflows.ts", () => {
    const relPaths = [
      "../../src/composition/buildActivities.ts",
      "../../src/composition/backends.ts",
      "../../src/boot.ts",
      "../../src/temporal/workflows.ts",
    ];
    for (const rel of relPaths) {
      const src = readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
      expect(src.includes("buildDrainDeps")).toBe(false);
      expect(src.includes("buildWakeDrainHook")).toBe(false);
    }
  });
});
