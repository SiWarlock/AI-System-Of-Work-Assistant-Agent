// @sow/integrations — in-memory test doubles + builders (SUPPORT, not a *.test.ts).
//
// Every downstream §8 gateway slice's tests import these:
//   • InMemoryReceiptStore     — ReceiptStore (Map by idempotencyKey + object key).
//   • InMemoryOutbox           — OutboxRepository (Map + listDue over nextAttemptAt,
//                                mirroring the sqlite adapter's due semantics).
//   • InMemoryConnectorCursors — ConnectorCursorRepository (Map by connector×ws).
// Each returns the EXACT @sow/db typed Result shapes (`Promise<Result<T,DbError>>`)
// per the interface. Plus deterministic builders: makeProposedAction / makeEnvelope
// / makeWriteReceipt. Kept clock-free — callers pass timestamps in.
import { ok, err } from "@sow/contracts";
import type {
  ProposedAction,
  ExternalWriteEnvelope,
  WriteReceipt,
  TargetSystem,
} from "@sow/contracts";
import type { DbError, DbResult } from "@sow/db";
import type {
  OutboxRepository,
  OutboxEntry,
  ConnectorCursorRepository,
  ConnectorCursorRecord,
  ReceiptStore,
  ReceiptRecord,
  ReceiptReservation,
} from "../../src/ports/persistence";

// Typed `not_found` DbError for an empty lookup — matches the sqlite adapter
// (`errors.ts`): a lookup miss is a typed Result, never a thrown exception.
const notFound = (what: string): DbError => ({ code: "not_found", message: `${what} not found` });

// --- ReceiptStore ------------------------------------------------------------

/**
 * Map-backed `ReceiptStore`. Indexes each receipt by `idempotencyKey` (replay
 * gate) and by `targetSystem\|canonicalObjectKey` (pre-write existence check).
 * Deterministic; a lookup miss returns `undefined` (not an error).
 */
/**
 * ⛔ THIS FAKE MODELS THE SHIPPED STORE'S ROW SEMANTICS, AND THAT IS LOAD-BEARING.
 *
 * `write_receipts` has a COMPOSITE PRIMARY KEY on `(targetSystem, canonicalObjectKey)`
 * and `put` is `onConflictDoUpdate` over that target, overwriting the row's
 * `idempotencyKey` (`packages/db/src/adapters/sqlite/index.ts` ~:1373-1391). So the
 * production store holds **exactly ONE row per object identity**, and writing a new
 * receipt for an object EVICTS the previous idempotencyKey from the index.
 *
 * This fake previously kept a separate `byIdem` map that ACCUMULATED every historical
 * key, so a replay of a superseded envelope still found its receipt here and never
 * would in production. A whole suite (918 tests) passed against that divergence while
 * a change that broke the §20.1 replay gate — the mechanism safety rule 3 IS — went
 * undetected. The suite was green because the fake was wrong.
 *
 * ⇒ There is now ONE authoritative map, keyed by object identity, and the
 * idempotency lookup SCANS it. That is O(n) and deliberately so: it makes
 * "one row per object" true BY CONSTRUCTION rather than by remembering to evict.
 * Do not reintroduce a second index.
 */
export class InMemoryReceiptStore implements ReceiptStore {
  private readonly byObject = new Map<string, ReceiptRecord>();
  // Uncommitted create-reservations keyed by object identity. A synchronous
  // check-and-set on this Set is the in-process atomicity primitive: because the
  // JS event loop is single-threaded and `reserve` awaits nothing, no two
  // dispatches can both observe the object un-reserved. The production adapter
  // backs this with a unique-constraint insert for cross-process atomicity.
  private readonly reserved = new Set<string>();

  private static objectKey(targetSystem: TargetSystem, k: string): string {
    return `${targetSystem}|${k}`;
  }

  async getByIdempotencyKey(k: string): Promise<ReceiptRecord | undefined> {
    // Scans the ONE map — mirrors `idempotencyKey` being a COLUMN on the single
    // per-object row, not an independent index. A key superseded by a later write
    // to the same object is GONE, exactly as in the shipped store.
    for (const rec of this.byObject.values()) {
      if (rec.idempotencyKey === k) return rec;
    }
    return undefined;
  }

  async getByCanonicalObjectKey(
    targetSystem: TargetSystem,
    k: string,
  ): Promise<ReceiptRecord | undefined> {
    return this.byObject.get(InMemoryReceiptStore.objectKey(targetSystem, k));
  }

  async reserve(
    targetSystem: TargetSystem,
    canonicalObjectKey: string,
  ): Promise<ReceiptReservation> {
    const key = InMemoryReceiptStore.objectKey(targetSystem, canonicalObjectKey);
    // A committed receipt supersedes any reservation — reuse it.
    const committed = this.byObject.get(key);
    if (committed !== undefined) {
      return { kind: "committed", record: committed };
    }
    // Another dispatch already holds the reservation and is mid-create.
    if (this.reserved.has(key)) {
      return { kind: "in_progress" };
    }
    // We win the reservation (synchronous set — no await between check and set).
    this.reserved.add(key);
    return { kind: "reserved" };
  }

  async release(targetSystem: TargetSystem, canonicalObjectKey: string): Promise<void> {
    this.reserved.delete(InMemoryReceiptStore.objectKey(targetSystem, canonicalObjectKey));
  }

  async put(r: ReceiptRecord): Promise<void> {
    const key = InMemoryReceiptStore.objectKey(r.targetSystem, r.canonicalObjectKey);
    // UPSERT on the object identity — the prior row for this object (and therefore
    // its idempotencyKey) is REPLACED, never kept alongside. This single `set` is
    // the whole `onConflictDoUpdate` semantic.
    this.byObject.set(key, r);
    // Committing the receipt clears any outstanding reservation for this object.
    this.reserved.delete(key);
  }

  /** Test helper: current ROW count — one per object identity, as in the store. */
  size(): number {
    return this.byObject.size;
  }
}

// --- Outbox ------------------------------------------------------------------

// Mirrors the sqlite adapter: an entry is "due" when its status is NOT terminal
// (receipt_recorded|rejected|expired) AND nextAttemptAt is absent or <= now.
const OUTBOX_TERMINAL: ReadonlySet<string> = new Set(["receipt_recorded", "rejected", "expired"]);

/**
 * Map-backed `OutboxRepository`. `get`/`getByIdempotencyKey` return a typed
 * `not_found` (never a thrown exception, never ok(undefined)) — matching the
 * sqlite adapter's replay-gate contract. `listDue` filters + orders by
 * (enqueuedAt, outboxId) and honors `limit`.
 */
export class InMemoryOutbox implements OutboxRepository {
  private readonly byId = new Map<string, OutboxEntry>();

  async enqueue(entry: OutboxEntry): DbResult<OutboxEntry> {
    if (this.byId.has(entry.outboxId)) {
      return err({ code: "conflict", message: `outbox ${entry.outboxId} exists` });
    }
    this.byId.set(entry.outboxId, entry);
    return ok(entry);
  }

  async get(outboxId: string): DbResult<OutboxEntry> {
    const found = this.byId.get(outboxId);
    return found ? ok(found) : err(notFound(`outbox ${outboxId}`));
  }

  async getByIdempotencyKey(idempotencyKey: string): DbResult<OutboxEntry> {
    for (const e of this.byId.values()) {
      if (e.idempotencyKey === idempotencyKey) return ok(e);
    }
    return err(notFound(`outbox idempotencyKey ${idempotencyKey}`));
  }

  async listDue(now: string, limit: number): DbResult<OutboxEntry[]> {
    const due = [...this.byId.values()]
      .filter(
        (e) =>
          !OUTBOX_TERMINAL.has(e.status) &&
          (e.nextAttemptAt === undefined || e.nextAttemptAt <= now),
      )
      .sort((a, b) =>
        a.enqueuedAt < b.enqueuedAt
          ? -1
          : a.enqueuedAt > b.enqueuedAt
            ? 1
            : a.outboxId < b.outboxId
              ? -1
              : a.outboxId > b.outboxId
                ? 1
                : 0,
      )
      .slice(0, limit);
    return ok(due);
  }

  async update(entry: OutboxEntry): DbResult<OutboxEntry> {
    if (!this.byId.has(entry.outboxId)) {
      return err(notFound(`outbox ${entry.outboxId}`));
    }
    this.byId.set(entry.outboxId, entry);
    return ok(entry);
  }
}

// --- ConnectorCursors --------------------------------------------------------

/**
 * Map-backed `ConnectorCursorRepository`, keyed by (connectorId, workspaceId).
 * `upsert` advances the single cursor; `get` returns `not_found` when absent.
 */
export class InMemoryConnectorCursors implements ConnectorCursorRepository {
  private readonly byKey = new Map<string, ConnectorCursorRecord>();

  private static key(connectorId: string, workspaceId: string): string {
    return `${connectorId}|${workspaceId}`;
  }

  async get(
    connectorId: string,
    workspaceId: string,
  ): DbResult<ConnectorCursorRecord> {
    const found = this.byKey.get(InMemoryConnectorCursors.key(connectorId, workspaceId));
    return found ? ok(found) : err(notFound(`cursor ${connectorId}/${workspaceId}`));
  }

  async upsert(
    record: ConnectorCursorRecord,
  ): DbResult<ConnectorCursorRecord> {
    this.byKey.set(
      InMemoryConnectorCursors.key(record.connectorId, record.workspaceId),
      record,
    );
    return ok(record);
  }

  async listByConnector(
    connectorId: string,
  ): DbResult<ConnectorCursorRecord[]> {
    const rows = [...this.byKey.values()].filter((r) => r.connectorId === connectorId);
    return ok(rows);
  }
}

// --- deterministic builders --------------------------------------------------

/** Build a valid `ProposedAction` (override any field via `partial`). */
export function makeProposedAction(partial: Partial<ProposedAction> = {}): ProposedAction {
  return {
    actionId: "action_1" as ProposedAction["actionId"],
    targetSystem: "drive",
    canonicalObjectKey: "cok_drive_abc",
    payload: { title: "x" },
    approvalPolicy: "requires_approval",
    idempotencyKey: "idem_abc",
    ...partial,
  };
}

/** Build a valid `ExternalWriteEnvelope` (override any field via `partial`). */
export function makeEnvelope(
  partial: Partial<ExternalWriteEnvelope> = {},
): ExternalWriteEnvelope {
  return {
    actionId: "action_1" as ExternalWriteEnvelope["actionId"],
    targetSystem: "drive",
    canonicalObjectKey: "cok_drive_abc",
    idempotencyKey: "idem_abc",
    preconditions: ["exists_check"],
    payloadHash: "sha256:deadbeef",
    ...partial,
  };
}

/** Build a valid `WriteReceipt` (override any field via `partial`). */
export function makeWriteReceipt(partial: Partial<WriteReceipt> = {}): WriteReceipt {
  return {
    externalObjectId: "ext_obj_1",
    recordedAt: "2026-06-30T00:00:00.000Z",
    ...partial,
  };
}

/** Build a `ReceiptRecord` wrapping a `WriteReceipt` (deterministic). */
export function makeReceiptRecord(partial: Partial<ReceiptRecord> = {}): ReceiptRecord {
  return {
    idempotencyKey: "idem_abc",
    canonicalObjectKey: "cok_drive_abc",
    targetSystem: "drive",
    payloadHash: "sha256:deadbeef",
    receipt: makeWriteReceipt(),
    recordedAt: "2026-06-30T00:00:00.000Z",
    ...partial,
  };
}

/** Build an `OutboxEntry` (deterministic; override any field via `partial`). */
export function makeOutboxEntry(partial: Partial<OutboxEntry> = {}): OutboxEntry {
  return {
    outboxId: "outbox_1",
    actionRef: "action_1",
    workspaceId: "employer-work",
    targetSystem: "drive",
    canonicalObjectKey: "cok_drive_abc",
    idempotencyKey: "idem_abc",
    payloadHash: "sha256:deadbeef",
    status: "proposed",
    attempts: 0,
    enqueuedAt: "2026-06-30T00:00:00.000Z",
    updatedAt: "2026-06-30T00:00:00.000Z",
    ...partial,
  };
}

/** Build a `ConnectorCursorRecord` (deterministic; override via `partial`). */
export function makeCursorRecord(
  partial: Partial<ConnectorCursorRecord> = {},
): ConnectorCursorRecord {
  return {
    connectorId: "todoist",
    workspaceId: "employer-work",
    status: "idle",
    updatedAt: "2026-06-30T00:00:00.000Z",
    ...partial,
  };
}
