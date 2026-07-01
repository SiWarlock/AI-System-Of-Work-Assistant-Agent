// spec(§6) — Post-commit GBrain sync trigger (task 4.4): fires ONLY after the
// Markdown commit, async + idempotent, NEVER rolls back the commit. Duplicate
// triggers for the same revision collapse to one effective index; a sync failure
// leaves a durable outbox entry + a distinct sync_lagging System Health item.
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr } from "@sow/contracts";
import { triggerGbrainSync } from "../src/knowledge-writer/gbrain-sync-trigger";
import type {
  GbrainSyncTriggerInput,
  GbrainSyncTriggerDeps,
  GbrainIndexDispatcher,
} from "../src/knowledge-writer/gbrain-sync-trigger";
import { MemoryGbrainSyncOutbox } from "./sync-outbox-fake";

const NOW = "2026-07-01T00:00:00.000Z";

const input: GbrainSyncTriggerInput = {
  workspaceId: "ws-employer",
  committedRevisionId: "rev:abc",
  planId: "plan-1",
  auditRef: "audit-commit-1",
  sourceEventRef: "evt-1",
};

function deps(
  outbox: MemoryGbrainSyncOutbox,
  dispatchIndex?: GbrainIndexDispatcher,
): GbrainSyncTriggerDeps {
  let n = 0;
  return {
    outbox,
    now: () => NOW,
    newHealthItemId: () => `health-sync-${(n += 1)}`,
    ...(dispatchIndex ? { dispatchIndex } : {}),
  };
}

describe("triggerGbrainSync — enqueue (no dispatcher)", () => {
  it("enqueues an index job keyed by (workspaceId, revision) and advances state to gbrain_sync_queued", async () => {
    const outbox = new MemoryGbrainSyncOutbox();
    const r = await triggerGbrainSync(input, deps(outbox));

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.kind).toBe("queued");
    expect(r.value.mutationState).toBe("gbrain_sync_queued");
    expect(r.value.entry.status).toBe("gbrain_sync_queued");
    // durable outbox entry persisted exactly once
    expect(outbox.enqueueCalls).toBe(1);
    expect(outbox.byId.size).toBe(1);
    expect(r.value.healthItem).toBeUndefined();
  });
});

describe("triggerGbrainSync — idempotent collapse", () => {
  it("collapses a duplicate trigger for the same revision to one effective index (no second enqueue/dispatch)", async () => {
    const outbox = new MemoryGbrainSyncOutbox();
    const dispatched: string[] = [];
    const dispatchIndex: GbrainIndexDispatcher = async (e) => {
      dispatched.push(e.revisionId);
      return ok(undefined);
    };

    const first = await triggerGbrainSync(input, deps(outbox, dispatchIndex));
    expect(isOk(first) && first.value.kind).toBe("dispatched");

    const second = await triggerGbrainSync(input, deps(outbox, dispatchIndex));
    expect(isOk(second)).toBe(true);
    if (isOk(second)) expect(second.value.kind).toBe("already_queued");

    // exactly one enqueue and one dispatch across both triggers
    expect(outbox.enqueueCalls).toBe(1);
    expect(dispatched).toEqual(["rev:abc"]);
    expect(outbox.byId.size).toBe(1);
  });
});

describe("triggerGbrainSync — async dispatch succeeds", () => {
  it("kicks the re-index and reports dispatched", async () => {
    const outbox = new MemoryGbrainSyncOutbox();
    const dispatchIndex: GbrainIndexDispatcher = async () => ok(undefined);
    const r = await triggerGbrainSync(input, deps(outbox, dispatchIndex));

    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.kind).toBe("dispatched");
      expect(r.value.healthItem).toBeUndefined();
    }
  });
});

describe("triggerGbrainSync — sync failure never rolls back; surfaces sync_lagging", () => {
  it("keeps the durable outbox entry and returns a distinct sync_lagging HealthItem when dispatch fails", async () => {
    const outbox = new MemoryGbrainSyncOutbox();
    const dispatchIndex: GbrainIndexDispatcher = async () =>
      err({ code: "gbrain_unavailable", message: "sidecar down" });
    const r = await triggerGbrainSync(input, deps(outbox, dispatchIndex));

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.kind).toBe("lagging");
    expect(r.value.mutationState).toBe("sync_lagging");
    // commit durable: the outbox entry survives for retry
    expect(outbox.byId.size).toBe(1);
    // distinct System Health item, failureClass sync_lagging (§16)
    const hi = r.value.healthItem;
    expect(hi).toBeDefined();
    expect(hi?.failureClass).toBe("sync_lagging");
    expect(hi?.state).toBe("open");
    expect(hi?.auditRef).toBe("audit-commit-1");
    // entry advanced to sync_lagging + one recorded attempt
    expect(r.value.entry.status).toBe("sync_lagging");
    expect(r.value.entry.attempts).toBe(1);
    expect(outbox.updateCalls).toBe(1);
  });

  it("never throws even when the injected dispatcher throws — degrades to sync_lagging", async () => {
    const outbox = new MemoryGbrainSyncOutbox();
    const dispatchIndex: GbrainIndexDispatcher = async () => {
      throw new Error("boom");
    };
    const r = await triggerGbrainSync(input, deps(outbox, dispatchIndex));
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.kind).toBe("lagging");
      expect(r.value.healthItem?.failureClass).toBe("sync_lagging");
    }
    // still durable
    expect(outbox.byId.size).toBe(1);
  });
});

describe("triggerGbrainSync — outbox store unavailable", () => {
  it("returns a typed outbox_unavailable fault WITH a sync_lagging HealthItem when getByKey fails (commit never rolled back)", async () => {
    const outbox = new MemoryGbrainSyncOutbox();
    outbox.failGetByKey = true;
    const r = await triggerGbrainSync(input, deps(outbox));

    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.code).toBe("outbox_unavailable");
      expect(r.error.healthItem.failureClass).toBe("sync_lagging");
    }
    // nothing enqueued, but the commit is untouched (the trigger has no vault handle)
    expect(outbox.byId.size).toBe(0);
  });

  it("returns outbox_unavailable + sync_lagging when the enqueue itself fails", async () => {
    const outbox = new MemoryGbrainSyncOutbox();
    outbox.failEnqueue = true;
    const r = await triggerGbrainSync(input, deps(outbox));

    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.code).toBe("outbox_unavailable");
      expect(r.error.healthItem.failureClass).toBe("sync_lagging");
    }
    expect(outbox.byId.size).toBe(0);
  });
});
