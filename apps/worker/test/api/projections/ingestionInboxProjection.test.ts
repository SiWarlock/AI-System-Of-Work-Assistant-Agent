// Task 9.7-B — the write-time ingestion-inbox PRODUCER core (dormant). Upserts the ingestion_inbox
// read_models row on park (drop-rules AT WRITE, dedup-by-sourceId) and removes an entry on disposition.
// WS-8-keyed per (workspaceId, key); §16 never-throws; stores only already-dropped UiSafeIngestionItem
// items (raw refs never persisted at rest). Mirrors projectDashboardUpdate.test.ts (fakeReadModels).
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr, UiSafeIngestionItemSchema } from "@sow/contracts";
import type { SourceEnvelope, UiSafeIngestionItem } from "@sow/contracts";
import type { ReadModelRecord, ReadModelRepository, DbResult, DbError } from "@sow/db";
import { READ_MODEL_KEYS } from "../../../src/api/adapters/readModel";
import { createIngestionInboxProjectionPort } from "../../../src/api/projections/ingestionInboxProjection";

const NOW = "2026-07-10T12:00:00.000Z";

/** In-memory ReadModelRepository keyed by (readModelKey, workspaceId), with optional fault injection. */
function fakeReadModels(
  opts: { failGet?: DbError; failPut?: DbError } = {},
): ReadModelRepository & { rows: Map<string, ReadModelRecord> } {
  const rows = new Map<string, ReadModelRecord>();
  const k = (key: string, ws: string | null) => `${key}::${ws ?? ""}`;
  return {
    rows,
    get(readModelKey, workspaceId): DbResult<ReadModelRecord> {
      if (opts.failGet) return Promise.resolve(err(opts.failGet));
      const r = rows.get(k(readModelKey, workspaceId));
      return Promise.resolve(r ? ok(r) : err({ code: "not_found", message: "no row" }));
    },
    put(record): DbResult<ReadModelRecord> {
      if (opts.failPut) return Promise.resolve(err(opts.failPut));
      rows.set(k(record.readModelKey, record.workspaceId ?? null), record);
      return Promise.resolve(ok(record));
    },
    clear(): DbResult<void> {
      return Promise.resolve(ok(undefined));
    },
  };
}

/** A base VALID SourceEnvelope with raw refs set — the producer is PROVEN to drop them at write. */
function sourceEnvelope(overrides: Partial<SourceEnvelope> = {}): SourceEnvelope {
  return {
    sourceId: "src_1" as SourceEnvelope["sourceId"],
    workspaceId: "ws-A" as SourceEnvelope["workspaceId"],
    origin: "https://youtu.be/abc123?t=42",
    contentHash: "sha256:deadbeef",
    type: "youtube_video",
    sensitivity: "personal",
    routingHints: { project: "p-1", notePath: "/Users/x/vault/n.md" },
    ...overrides,
  };
}

const itemsOf = (repo: ReturnType<typeof fakeReadModels>, ws: string): UiSafeIngestionItem[] => {
  const row = repo.rows.get(`${READ_MODEL_KEYS.ingestion}::${ws}`);
  return (row?.data as { items?: UiSafeIngestionItem[] })?.items ?? [];
};

describe("createIngestionInboxProjectionPort — recordPark", () => {
  it("creates the row when absent, storing ONLY the allowlisted UiSafeIngestionItem fields", async () => {
    const repo = fakeReadModels();
    const port = createIngestionInboxProjectionPort({ readModels: repo, now: () => NOW });
    const r = await port.recordPark({ workspaceId: "ws-A", source: sourceEnvelope() });
    expect(isOk(r)).toBe(true);
    const items = itemsOf(repo, "ws-A");
    expect(items.map((i) => i.sourceId)).toEqual(["src_1"]);
    expect(Object.keys(items[0]!).sort()).toEqual(["sensitivity", "sourceId", "summary", "type"]);
    expect(repo.rows.get(`${READ_MODEL_KEYS.ingestion}::ws-A`)?.rebuiltAt).toBe(NOW);
  });

  it("DROPS raw refs AT WRITE — the stored blob carries NO origin/contentHash/routingHints/workspaceId", async () => {
    const repo = fakeReadModels();
    const port = createIngestionInboxProjectionPort({ readModels: repo, now: () => NOW });
    await port.recordPark({ workspaceId: "ws-A", source: sourceEnvelope() });
    const stored = itemsOf(repo, "ws-A")[0]! as unknown as Record<string, unknown>;
    expect(stored).not.toHaveProperty("origin");
    expect(stored).not.toHaveProperty("contentHash");
    expect(stored).not.toHaveProperty("routingHints");
    expect(stored).not.toHaveProperty("workspaceId");
    // Belt-and-suspenders: the raw origin/hash/path strings are nowhere in the serialized blob AT REST.
    const blob = JSON.stringify(repo.rows.get(`${READ_MODEL_KEYS.ingestion}::ws-A`)!.data);
    expect(blob).not.toContain("youtu.be");
    expect(blob).not.toContain("deadbeef");
    expect(blob).not.toContain("notePath");
  });

  it("is IDEMPOTENT by sourceId — re-parking the same source keeps ONE entry (updated, not duplicated)", async () => {
    const repo = fakeReadModels();
    const port = createIngestionInboxProjectionPort({ readModels: repo, now: () => NOW });
    await port.recordPark({ workspaceId: "ws-A", source: sourceEnvelope({ type: "youtube_video" }) });
    await port.recordPark({ workspaceId: "ws-A", source: sourceEnvelope({ type: "podcast" }) }); // same sourceId
    const items = itemsOf(repo, "ws-A");
    expect(items.length).toBe(1);
    expect(items[0]!.type).toBe("podcast");
  });

  it("APPENDS a distinct sourceId, preserving prior entries", async () => {
    const repo = fakeReadModels();
    const port = createIngestionInboxProjectionPort({ readModels: repo, now: () => NOW });
    await port.recordPark({ workspaceId: "ws-A", source: sourceEnvelope({ sourceId: "src_1" as SourceEnvelope["sourceId"] }) });
    await port.recordPark({ workspaceId: "ws-A", source: sourceEnvelope({ sourceId: "src_2" as SourceEnvelope["sourceId"] }) });
    expect(itemsOf(repo, "ws-A").map((i) => i.sourceId).sort()).toEqual(["src_1", "src_2"]);
  });

  it("the produced row satisfies the 9.7-A read contract (UiSafeIngestionItemSchema) — no write/read drift", async () => {
    const repo = fakeReadModels();
    const port = createIngestionInboxProjectionPort({ readModels: repo, now: () => NOW });
    await port.recordPark({ workspaceId: "ws-A", source: sourceEnvelope() });
    const parsed = UiSafeIngestionItemSchema.array().safeParse(itemsOf(repo, "ws-A"));
    expect(parsed.success).toBe(true);
  });

  it("WS-8: a park writes UNDER (ingestion_inbox, ws-A) specifically — not a (key, null) global — and B stays empty", async () => {
    const repo = fakeReadModels();
    const port = createIngestionInboxProjectionPort({ readModels: repo, now: () => NOW });
    await port.recordPark({ workspaceId: "ws-A", source: sourceEnvelope({ sourceId: "A-secret" as SourceEnvelope["sourceId"] }) });

    // POSITIVE leg — the row is keyed per (ingestion_inbox, ws-A); a `get(key, ws-A)` reads it back.
    expect(repo.rows.has(`${READ_MODEL_KEYS.ingestion}::ws-A`)).toBe(true);
    const readBack = await repo.get(READ_MODEL_KEYS.ingestion, "ws-A");
    expect(isOk(readBack)).toBe(true);
    if (isOk(readBack)) {
      expect((readBack.value.data as { items: UiSafeIngestionItem[] }).items.map((i) => i.sourceId)).toEqual(["A-secret"]);
    }
    // It is NOT written to a workspace-less GLOBAL row (the `(key, null)` bug) — that key stays absent.
    expect(repo.rows.has(`${READ_MODEL_KEYS.ingestion}::`)).toBe(false);
    // NEGATIVE leg — workspace B reads its own (empty) row, never A's.
    expect(itemsOf(repo, "ws-B")).toEqual([]);
    expect(itemsOf(repo, "ws-A").map((i) => i.sourceId)).toEqual(["A-secret"]);
  });

  it("a NON-not_found readModels.get fault ⇒ typed err (never silently empty; §16 never throws)", async () => {
    const repo = fakeReadModels({ failGet: { code: "unavailable", message: "db down" } });
    const port = createIngestionInboxProjectionPort({ readModels: repo, now: () => NOW });
    const r = await port.recordPark({ workspaceId: "ws-A", source: sourceEnvelope() });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("ingestion_inbox_write_failed");
  });

  it("a readModels.put fault ⇒ typed err (§16)", async () => {
    const repo = fakeReadModels({ failPut: { code: "unavailable", message: "db down" } });
    const port = createIngestionInboxProjectionPort({ readModels: repo, now: () => NOW });
    const r = await port.recordPark({ workspaceId: "ws-A", source: sourceEnvelope() });
    expect(isErr(r)).toBe(true);
  });

  it("rejects a park with an empty workspaceId (fail-closed, no write)", async () => {
    const repo = fakeReadModels();
    const port = createIngestionInboxProjectionPort({ readModels: repo, now: () => NOW });
    const r = await port.recordPark({ workspaceId: "", source: sourceEnvelope() });
    expect(isErr(r)).toBe(true);
    expect(repo.rows.size).toBe(0);
  });

  it("WS-8 write-key authority: rejects a park whose explicit workspaceId ≠ source.workspaceId (mis-attribution unrepresentable)", async () => {
    const repo = fakeReadModels();
    const port = createIngestionInboxProjectionPort({ readModels: repo, now: () => NOW });
    // The explicit write key AND the source's own scope disagree — a routing bug. Fail closed; no write
    // to EITHER workspace (the item is never mis-attributed to the wrong inbox).
    const r = await port.recordPark({
      workspaceId: "ws-A",
      source: sourceEnvelope({ workspaceId: "ws-OTHER" as SourceEnvelope["workspaceId"] }),
    });
    expect(isErr(r)).toBe(true);
    expect(repo.rows.size).toBe(0);
  });
});

describe("createIngestionInboxProjectionPort — recordDisposition", () => {
  it("removes the disposed sourceId, leaving siblings untouched", async () => {
    const repo = fakeReadModels();
    const port = createIngestionInboxProjectionPort({ readModels: repo, now: () => NOW });
    await port.recordPark({ workspaceId: "ws-A", source: sourceEnvelope({ sourceId: "src_1" as SourceEnvelope["sourceId"] }) });
    await port.recordPark({ workspaceId: "ws-A", source: sourceEnvelope({ sourceId: "src_2" as SourceEnvelope["sourceId"] }) });
    const r = await port.recordDisposition("ws-A", "src_1");
    expect(isOk(r)).toBe(true);
    expect(itemsOf(repo, "ws-A").map((i) => i.sourceId)).toEqual(["src_2"]);
  });

  it("an ABSENT row ⇒ ok no-op (no error, no throw, no write)", async () => {
    const repo = fakeReadModels();
    const port = createIngestionInboxProjectionPort({ readModels: repo, now: () => NOW });
    const r = await port.recordDisposition("ws-A", "src_nope");
    expect(isOk(r)).toBe(true);
    expect(repo.rows.size).toBe(0);
  });

  it("a MISSING sourceId on an existing row ⇒ ok no-op (row unchanged)", async () => {
    const repo = fakeReadModels();
    const port = createIngestionInboxProjectionPort({ readModels: repo, now: () => NOW });
    await port.recordPark({ workspaceId: "ws-A", source: sourceEnvelope({ sourceId: "src_1" as SourceEnvelope["sourceId"] }) });
    const r = await port.recordDisposition("ws-A", "src_absent");
    expect(isOk(r)).toBe(true);
    expect(itemsOf(repo, "ws-A").map((i) => i.sourceId)).toEqual(["src_1"]);
  });

  it("a NON-not_found readModels.get fault ⇒ typed err (§16)", async () => {
    const repo = fakeReadModels({ failGet: { code: "unavailable", message: "db down" } });
    const port = createIngestionInboxProjectionPort({ readModels: repo, now: () => NOW });
    const r = await port.recordDisposition("ws-A", "src_1");
    expect(isErr(r)).toBe(true);
  });

  it("a readModels.put fault while REMOVING an item ⇒ typed err (§16 symmetry — dispose writes on removal)", async () => {
    // failPut fails every put, so seed the row DIRECTLY (bypass recordPark) — dispose then removes src_1
    // (a genuine change ⇒ a put), and that put fault must surface as a typed err, never a throw.
    const repo = fakeReadModels({ failPut: { code: "unavailable", message: "db down" } });
    repo.rows.set(`${READ_MODEL_KEYS.ingestion}::ws-A`, {
      readModelKey: READ_MODEL_KEYS.ingestion,
      workspaceId: "ws-A",
      data: { items: [{ sourceId: "src_1", type: "youtube_video", sensitivity: "personal", summary: "youtube_video" }] },
      rebuiltAt: NOW,
    });
    const port = createIngestionInboxProjectionPort({ readModels: repo, now: () => NOW });
    const r = await port.recordDisposition("ws-A", "src_1");
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("ingestion_inbox_write_failed");
  });

  it("WS-8: disposition on workspace A does not touch workspace B's identical sourceId", async () => {
    const repo = fakeReadModels();
    const port = createIngestionInboxProjectionPort({ readModels: repo, now: () => NOW });
    await port.recordPark({ workspaceId: "ws-A", source: sourceEnvelope({ sourceId: "src_1" as SourceEnvelope["sourceId"] }) });
    await port.recordPark({
      workspaceId: "ws-B",
      source: sourceEnvelope({ sourceId: "src_1" as SourceEnvelope["sourceId"], workspaceId: "ws-B" as SourceEnvelope["workspaceId"] }),
    });
    await port.recordDisposition("ws-A", "src_1");
    expect(itemsOf(repo, "ws-A")).toEqual([]);
    expect(itemsOf(repo, "ws-B").map((i) => i.sourceId)).toEqual(["src_1"]);
  });
});
