// 9.15 — recent_changes audit-projection producer (unit). A pure worker composition port over injected
// AuditRepository + ReadModelRepository + now: query workspace-scoped audit rows → projectRecentChanges →
// readModels.put the recent_changes read-model row. WS-8-safe by construction (scoped query AND the projector's
// fail-closed foreign/null-scope drop); fail-closed both directions; never-throws typed Result (§16).
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr } from "@sow/contracts";
import type { Result, AuditRecord } from "@sow/contracts";
import type { AuditQuery, AuditRepository, DbError, ReadModelRecord, ReadModelRepository } from "@sow/db";
import { READ_MODEL_KEYS } from "../../src/api/adapters/readModel";
import { refreshRecentChanges } from "../../src/composition/recentChangesProducer";

const NOW = "2026-07-24T12:00:00.000Z";
const WS_A = "personal-business";
const WS_B = "employer-work";

const commitAudit = (over: Partial<AuditRecord> = {}): AuditRecord => ({
  actor: "KnowledgeWriter",
  event: "knowledge_writer.commit", // the EXACT event the KW commit path emits (revision.ts)
  refs: ["rev:abc", "idem-1"],
  payloadHash: "sha256:aaa",
  beforeSummary: "no prior note",
  afterSummary: "note created",
  timestamps: { occurredAt: "2026-07-01T00:00:00.000Z" },
  workspaceId: WS_A,
  ...over,
});

interface Rig {
  readonly deps: { audit: AuditRepository; readModels: ReadModelRepository; now: () => string };
  readonly queries: { filter: AuditQuery; limit: number }[];
  readonly puts: ReadModelRecord[];
}
function rig(
  opts: {
    audit?: Result<AuditRecord[], DbError>;
    auditThrows?: boolean;
    put?: Result<ReadModelRecord, DbError>;
    putThrows?: boolean;
  } = {},
): Rig {
  const queries: { filter: AuditQuery; limit: number }[] = [];
  const puts: ReadModelRecord[] = [];
  const audit: AuditRepository = {
    append: () => Promise.resolve(ok(undefined)),
    query: (filter, limit) => {
      queries.push({ filter, limit });
      if (opts.auditThrows) throw new Error("audit boom");
      return Promise.resolve(opts.audit ?? ok([]));
    },
  };
  const readModels: ReadModelRepository = {
    get: () => Promise.resolve(err({ code: "not_found", message: "nf" })),
    put: (record) => {
      puts.push(record);
      if (opts.putThrows) throw new Error("put boom");
      return Promise.resolve(opts.put ?? ok(record));
    },
    clear: () => Promise.resolve(ok(undefined)),
  };
  return { deps: { audit, readModels, now: () => NOW }, queries, puts };
}

describe("refreshRecentChanges — audit → projector → recent_changes read-model producer", () => {
  it("produces_recent_changes_from_scoped_audit_rows — spec(§11)", async () => {
    const r = rig({
      audit: ok([commitAudit(), commitAudit({ refs: ["rev:def", "idem-2"], payloadHash: "sha256:bbb" })]),
    });
    const res = await refreshRecentChanges({ workspaceId: WS_A }, r.deps);
    expect(isOk(res)).toBe(true);
    expect(r.puts).toHaveLength(1);
    const rec = r.puts[0]!;
    expect(rec.readModelKey).toBe(READ_MODEL_KEYS.recentChanges);
    expect(rec.workspaceId).toBe(WS_A);
    expect(rec.rebuiltAt).toBe(NOW);
    const data = rec.data as { changes: { changeId: string }[] };
    expect(data.changes).toHaveLength(2); // both WS_A commit rows projected (distinct changeIds)
  });

  it("ws8_foreign_record_never_lands — spec(§5) SAFETY PIN", async () => {
    // a foreign-ws row AND a null-scope (global) row present in the query result must never reach the written
    // ws-A row — relies on the projector's fail-closed drop as defense-in-depth over the scoped query.
    const foreign = commitAudit({ workspaceId: WS_B, afterSummary: "EW note" });
    const globalRec = commitAudit();
    delete (globalRec as { workspaceId?: string }).workspaceId;
    const r = rig({ audit: ok([commitAudit(), foreign, globalRec]) });
    const res = await refreshRecentChanges({ workspaceId: WS_A }, r.deps);
    expect(isOk(res)).toBe(true);
    const rec = r.puts[0]!;
    expect(rec.workspaceId).toBe(WS_A); // the write key is the served ws, never a record-derived value
    const data = rec.data as { changes: unknown[] };
    expect(data.changes).toHaveLength(1); // only the WS_A row survives (foreign + null-scope dropped)
  });

  it("empty_audit_writes_empty_row — spec(§10)", async () => {
    const r = rig({ audit: ok([]) });
    const res = await refreshRecentChanges({ workspaceId: WS_A }, r.deps);
    expect(isOk(res)).toBe(true);
    expect(r.puts).toHaveLength(1); // unconditional put — a refresh writes the full (empty) projection + fresh rebuiltAt
    expect((r.puts[0]!.data as { changes: unknown[] }).changes).toEqual([]);
    expect(r.puts[0]!.rebuiltAt).toBe(NOW);
  });

  it("audit_query_fault_fails_closed — spec(§16)", async () => {
    // both a returned Err AND a thrown fault ⇒ typed Err, and NO read-model put (no partial/false write)
    for (const r of [rig({ audit: err({ code: "unavailable", message: "db down" }) }), rig({ auditThrows: true })]) {
      const res = await refreshRecentChanges({ workspaceId: WS_A }, r.deps);
      expect(isErr(res)).toBe(true);
      expect(r.puts).toHaveLength(0);
    }
  });

  it("readmodel_put_fault_propagates — spec(§16)", async () => {
    // both a returned Err AND a thrown put ⇒ typed Err; no throw escapes
    for (const r of [
      rig({ audit: ok([commitAudit()]), put: err({ code: "unavailable", message: "put down" }) }),
      rig({ audit: ok([commitAudit()]), putThrows: true }),
    ]) {
      const res = await refreshRecentChanges({ workspaceId: WS_A }, r.deps);
      expect(isErr(res)).toBe(true);
    }
  });

  it("scoped_query_uses_served_workspace — spec(§5)", async () => {
    const r = rig({ audit: ok([commitAudit()]) });
    await refreshRecentChanges({ workspaceId: WS_A }, r.deps);
    expect(r.queries).toHaveLength(1);
    expect(r.queries[0]!.filter).toEqual({ workspaceId: WS_A }); // scoped at the read boundary, never unscoped
    expect(r.queries[0]!.limit).toBeGreaterThan(0); // bounded
  });
});
