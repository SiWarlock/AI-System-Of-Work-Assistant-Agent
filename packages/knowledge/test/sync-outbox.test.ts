// spec(§6) — GBrain sync outbox: deterministic (workspaceId, revisionId) key,
// entry factory (operational-truth record, status gbrain_sync_queued), and the
// in-memory store double honoring the @sow/db error convention (task 4.4)
import { describe, it, expect } from "vitest";
import { isOk } from "@sow/contracts";
import {
  gbrainSyncOutboxKey,
  buildSyncOutboxEntry,
} from "../src/knowledge-writer/sync-outbox";
import type { SyncOutboxEntryInput } from "../src/knowledge-writer/sync-outbox";

const input: SyncOutboxEntryInput = {
  workspaceId: "ws-employer",
  revisionId: "rev:abc",
  planId: "plan-1",
  auditRef: "audit-commit-1",
  sourceEventRef: "evt-1",
  enqueuedAt: "2026-07-01T00:00:00.000Z",
};

describe("gbrainSyncOutboxKey — idempotency identity", () => {
  it("is a pure deterministic function of (workspaceId, revisionId)", () => {
    expect(gbrainSyncOutboxKey("ws-employer", "rev:abc")).toBe(
      gbrainSyncOutboxKey("ws-employer", "rev:abc"),
    );
  });

  it("distinguishes different revisions and different workspaces", () => {
    const a = gbrainSyncOutboxKey("ws-employer", "rev:abc");
    expect(gbrainSyncOutboxKey("ws-employer", "rev:xyz")).not.toBe(a);
    expect(gbrainSyncOutboxKey("ws-personal", "rev:abc")).not.toBe(a);
  });
});

describe("buildSyncOutboxEntry — fresh enqueue record", () => {
  it("stamps outboxId from the key, status gbrain_sync_queued, attempts 0", () => {
    const entry = buildSyncOutboxEntry(input);
    expect(entry.outboxId).toBe(gbrainSyncOutboxKey("ws-employer", "rev:abc"));
    expect(entry.status).toBe("gbrain_sync_queued");
    expect(entry.attempts).toBe(0);
    expect(entry.revisionId).toBe("rev:abc");
    expect(entry.planId).toBe("plan-1");
    expect(entry.auditRef).toBe("audit-commit-1");
    expect(entry.sourceEventRef).toBe("evt-1");
    expect(entry.enqueuedAt).toBe("2026-07-01T00:00:00.000Z");
    expect(entry.lastAttemptAt).toBeUndefined();
  });

  it("is pure — same input yields an equal record", () => {
    expect(buildSyncOutboxEntry(input)).toEqual(buildSyncOutboxEntry(input));
  });

  it("omits sourceEventRef when not supplied", () => {
    const { sourceEventRef: _omit, ...rest } = input;
    void _omit;
    const entry = buildSyncOutboxEntry(rest);
    expect(entry.sourceEventRef).toBeUndefined();
  });
});

// The store is an injected PORT (interface only). This asserts a trivial fake
// satisfies the shape + @sow/db DbResult convention (never throws across it).
describe("GbrainSyncOutboxStore — shape via a minimal fake", () => {
  it("round-trips an entry through enqueue → getByKey", async () => {
    const { MemoryGbrainSyncOutbox } = await import("./sync-outbox-fake");
    const store = new MemoryGbrainSyncOutbox();
    const entry = buildSyncOutboxEntry(input);
    const enq = await store.enqueue(entry);
    expect(isOk(enq)).toBe(true);
    const got = await store.getByKey("ws-employer", "rev:abc");
    expect(isOk(got) && got.value?.outboxId).toBe(entry.outboxId);
  });
});
