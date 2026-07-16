// Task 16.6 — the real persisted seenContentHash dedupe probe (worker composition). RED-first.
//
// Wires the 15.4 SeenContentHashRepository into registerSource's Flow-4 dedupe probe (REQ-F-010),
// replacing the hardwired always-miss `() => false`. WS-8-scoped `(workspaceId, contentHash)`;
// first-write-wins record on a miss. LOAD-BEARING (worker Lesson 34): a store `has`/`record` FAULT
// PROCEEDs (the probe returns not-seen so registerSource+dispatch run — the Temporal `src:ws:hash`
// AlreadyStarted dedupe is the real exactly-once backstop), NEVER a HOLD, NEVER a false dedupe-hit.
import { describe, it, expect } from "vitest";
import { ok, err, type Result } from "@sow/contracts";
import type { WorkspaceId } from "@sow/contracts";
import type { DbError, SeenContentHashKey, SeenContentHashRow, SeenContentHashRepository } from "@sow/db";
import { createSeenContentHashProbe } from "../../src/composition/seenContentHashProbe";

const NOW = "2026-07-16T00:00:00.000Z";

/** A fake WS-8-scoped seen-content-hash repo (first-write-wins) with fault + throw toggles. */
function fakeRepo(opts: { faultHas?: boolean; faultRecord?: boolean; throwHas?: boolean; throwRecord?: boolean } = {}): {
  repo: SeenContentHashRepository;
  records: SeenContentHashRow[];
  hasCalls: SeenContentHashKey[];
} {
  const store = new Map<string, SeenContentHashRow>();
  const records: SeenContentHashRow[] = [];
  const hasCalls: SeenContentHashKey[] = [];
  const k = (key: SeenContentHashKey): string => `${String(key.workspaceId)}::${key.contentHash}`;
  const repo: SeenContentHashRepository = {
    has: (key: SeenContentHashKey): Promise<Result<boolean, DbError>> => {
      hasCalls.push(key);
      if (opts.throwHas) throw new Error("contract-violating adapter throw"); // a repo that breaks the never-throw contract
      if (opts.faultHas) return Promise.resolve(err({ code: "unavailable", message: "store down" }));
      return Promise.resolve(ok(store.has(k(key))));
    },
    record: (row: SeenContentHashRow): Promise<Result<void, DbError>> => {
      records.push(row);
      if (opts.throwRecord) throw new Error("contract-violating adapter throw");
      if (opts.faultRecord) return Promise.resolve(err({ code: "unavailable", message: "store down" }));
      if (!store.has(k(row))) store.set(k(row), row); // first-write-wins (keeps original seenAt)
      return Promise.resolve(ok(undefined));
    },
  };
  return { repo, records, hasCalls };
}

describe("createSeenContentHashProbe (16.6 — real WS-8 dedupe probe over the 15.4 store)", () => {
  it("second_identical_import_is_deduped_first_still_ingests: probe(ws,h) miss ⇒ false (records); a 2nd identical probe ⇒ true (dedupe_hit) [spec(REQ-F-010)]", async () => {
    const { repo } = fakeRepo();
    const probe = createSeenContentHashProbe(repo, () => NOW);
    expect(await probe("ws-a", "h1")).toBe(false); // first import ingests (miss)
    expect(await probe("ws-a", "h1")).toBe(true); // second identical import is deduped
  });

  it("dedupe_is_workspace_scoped: a hash seen in ws A does NOT dedupe the same hash in ws B (WS-8) [spec(§4)]", async () => {
    const { repo } = fakeRepo();
    const probe = createSeenContentHashProbe(repo, () => NOW);
    expect(await probe("ws-a", "h1")).toBe(false); // records under ws-a
    expect(await probe("ws-b", "h1")).toBe(false); // a DIFFERENT workspace — not seen, still ingests
    expect(await probe("ws-a", "h1")).toBe(true); // ws-a is still deduped
  });

  it("probe_fault_proceeds_never_holds: a `has`-fault ⇒ probe PROCEEDs (false, not a hit, no throw); a `record`-fault on a miss ⇒ also PROCEEDs [spec(§16), L34]", async () => {
    // has-fault ⇒ never a false dedupe-hit, never a HOLD — return not-seen so registration proceeds.
    const hasFault = createSeenContentHashProbe(fakeRepo({ faultHas: true }).repo, () => NOW);
    expect(await hasFault("ws-a", "h1")).toBe(false);
    // record-fault on a miss ⇒ still proceeds (the record is best-effort; Temporal is the backstop).
    const recFault = createSeenContentHashProbe(fakeRepo({ faultRecord: true }).repo, () => NOW);
    expect(await recFault("ws-a", "h1")).toBe(false);
    // structural never-throws (L20/L24): a repo that THROWS (breaks the never-throw contract) — or a
    // throwing clock — must STILL resolve false (PROCEED), not reject up into the register activity (a HOLD).
    const throwHas = createSeenContentHashProbe(fakeRepo({ throwHas: true }).repo, () => NOW);
    expect(await throwHas("ws-a", "h1")).toBe(false);
    const throwRec = createSeenContentHashProbe(fakeRepo({ throwRecord: true }).repo, () => NOW);
    expect(await throwRec("ws-a", "h1")).toBe(false);
    const throwClock = createSeenContentHashProbe(fakeRepo().repo, () => { throw new Error("clock down"); });
    expect(await throwClock("ws-a", "h1")).toBe(false);
  });

  it("miss_records_then_a_hit_does_not_re_record: a miss records {workspaceId, contentHash, seenAt}; a subsequent hit short-circuits BEFORE record (no re-record) [spec(§4), L34]", async () => {
    const f = fakeRepo();
    const probe = createSeenContentHashProbe(f.repo, () => NOW);
    await probe("ws-a", "h1"); // miss ⇒ records
    expect(f.records).toHaveLength(1);
    expect(f.records[0]).toEqual({ workspaceId: "ws-a", contentHash: "h1", seenAt: NOW });
    await probe("ws-a", "h1"); // hit ⇒ does NOT record again (dedupe short-circuits before record)
    expect(f.records).toHaveLength(1);
  });
});
