// In-memory GbrainSyncOutboxStore double for task 4.4 tests. It is an injected
// PORT, not a behavior mock: a real map keyed by (workspaceId, revisionId) that
// exercises enqueue / getByKey / update / listDue, plus opt-in fault injection to
// prove the trigger surfaces sync_lagging + keeps the commit durable when the
// operational store is unavailable. Every method returns a typed @sow/db
// DbResult and NEVER throws across the boundary (§16).
import { ok, err } from "@sow/contracts";
import type { DbResult } from "@sow/db";
import {
  gbrainSyncOutboxKey,
  type GbrainSyncOutboxEntry,
  type GbrainSyncOutboxStore,
} from "../src/knowledge-writer/sync-outbox";

export class MemoryGbrainSyncOutbox implements GbrainSyncOutboxStore {
  readonly byId = new Map<string, GbrainSyncOutboxEntry>();
  enqueueCalls = 0;
  updateCalls = 0;

  /** Opt-in faults: return an `unavailable` DbError from the named op. */
  failGetByKey = false;
  failEnqueue = false;
  failUpdate = false;
  failIndexedHighWater = false;

  async getByKey(
    workspaceId: string,
    revisionId: string,
  ): DbResult<GbrainSyncOutboxEntry | undefined> {
    if (this.failGetByKey) {
      return err({ code: "unavailable", message: "outbox getByKey unavailable" });
    }
    return ok(this.byId.get(gbrainSyncOutboxKey(workspaceId, revisionId)));
  }

  async enqueue(entry: GbrainSyncOutboxEntry): DbResult<GbrainSyncOutboxEntry> {
    this.enqueueCalls += 1;
    if (this.failEnqueue) {
      return err({ code: "unavailable", message: "outbox enqueue unavailable" });
    }
    this.byId.set(entry.outboxId, entry);
    return ok(entry);
  }

  async update(entry: GbrainSyncOutboxEntry): DbResult<GbrainSyncOutboxEntry> {
    this.updateCalls += 1;
    if (this.failUpdate) {
      return err({ code: "unavailable", message: "outbox update unavailable" });
    }
    this.byId.set(entry.outboxId, entry);
    return ok(entry);
  }

  async listDue(_now: string, limit: number): DbResult<GbrainSyncOutboxEntry[]> {
    const due = [...this.byId.values()]
      .filter((e) => e.status !== "indexed")
      .slice(0, limit);
    return ok(due);
  }

  async indexedHighWater(
    workspaceId: string,
  ): DbResult<GbrainSyncOutboxEntry | undefined> {
    if (this.failIndexedHighWater) {
      return err({ code: "unavailable", message: "outbox indexedHighWater unavailable" });
    }
    let hw: GbrainSyncOutboxEntry | undefined;
    for (const e of this.byId.values()) {
      if (e.status !== "indexed" || e.workspaceId !== workspaceId) continue;
      // ISO-8601 timestamps compare correctly as strings (max enqueuedAt = high-water).
      if (hw === undefined || e.enqueuedAt > hw.enqueuedAt) hw = e;
    }
    return ok(hw);
  }
}
