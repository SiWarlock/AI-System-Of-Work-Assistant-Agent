// Task 13.10 — reconcile-TRIGGER arc, piece B: buildReconcilerDbProjection. spec(§6) spec(§12)
//
// buildReconcilerDbProjection(adapter, params?) reads the injected read-only GbrainReadAdapter (the
// grant-verified, structurally write-free gbrain read surface), maps the `graph` read → DbFact[] and the
// `schemaRead` → gbrainSchemaVersion, and returns the ReconcilerDbProjection that piece A's runReconcilePass
// consumes as req.dbProjection. FAIL-CLOSED on coverage: `complete=true` ONLY on a clean, fully-consumed,
// well-formed read with a readable schema version; ANY of {read err, truncation/open cursor, a malformed row,
// an absent/unreadable schema version} ⇒ `complete=false` (degrade — the reconciler can't claim full coverage
// ⇒ serving degrades). NEVER throws, NEVER a false-complete. `stamped` is conservative (absent signal ⇒ false)
// so an unstamped db_only HARD parity defect stays visible to quarantine (safety rule 1). DORMANT + fakes only;
// the REAL GbrainReadGrant HTTP transport stays OWNER-GATED/unbound (the injected adapter is a fake here).
import { describe, it, expect } from "vitest";
import { ok, err, WorkspaceIdSchema, type WorkspaceId, type BrainId } from "@sow/contracts";
import type { GbrainReadAdapter, GbrainReadResult, GbrainReadError } from "@sow/knowledge";
import { buildReconcilerDbProjection } from "../../src/composition/reconcilerDbProjection";

const WS: WorkspaceId = WorkspaceIdSchema.parse("ws-employer");

/** A fake read-only adapter — only `graph` + `schemaRead` matter to the builder; the rest are inert. */
function fakeAdapter(over: { workspaceId?: WorkspaceId; graph?: GbrainReadResult; schema?: GbrainReadResult } = {}): GbrainReadAdapter {
  const inert: GbrainReadResult = ok({});
  return {
    workspaceId: over.workspaceId ?? WS,
    brainId: "brain-1" as BrainId,
    pinnedSha: "sha-pinned",
    allowedOps: [],
    search: () => Promise.resolve(inert),
    graph: () => Promise.resolve(over.graph ?? inert),
    timeline: () => Promise.resolve(inert),
    schemaRead: () => Promise.resolve(over.schema ?? ok({ schemaVersion: 3 })),
    health: () => Promise.resolve(inert),
    containedSynthesis: () => Promise.resolve(inert),
  };
}

const ROW_P = { factIdentity: "page:p", factKind: "page", contentHash: "ab".repeat(32), stamped: true, revisionId: "rev:1" };
const ROW_Q = { factIdentity: "page:q", factKind: "link", contentHash: "cd".repeat(32), stamped: true, revisionId: "rev:1" };
const readErr = (e: GbrainReadError): GbrainReadResult => err(e);

describe("buildReconcilerDbProjection — the gbrain-read → DbFact projection (spec §6)", () => {
  it("maps_clean_read_to_complete_projection", async () => {
    const adapter = fakeAdapter({ graph: ok({ facts: [ROW_P, ROW_Q] }), schema: ok({ schemaVersion: 7 }) });
    const p = await buildReconcilerDbProjection(adapter);
    expect(p.workspaceId).toBe("ws-employer"); // sourced from the grant-bound adapter, not a caller param
    expect(p.gbrainSchemaVersion).toBe(7);
    expect(p.complete).toBe(true); // the ONLY complete=true case in this suite
    // each response row round-trips faithfully to a DbFact (contentHash → dbContentHash)
    expect(p.facts).toEqual([
      { factIdentity: "page:p", factKind: "page", dbContentHash: "ab".repeat(32), stamped: true, revisionId: "rev:1" },
      { factIdentity: "page:q", factKind: "link", dbContentHash: "cd".repeat(32), stamped: true, revisionId: "rev:1" },
    ]);
  });
});

describe("buildReconcilerDbProjection — fail-closed coverage (spec §12)", () => {
  it("read_fault_degrades_to_incomplete", async () => {
    // a transport fault on the graph read ⇒ complete=false, no throw, no facts (never a false-complete)
    const adapter = fakeAdapter({ graph: readErr({ code: "transport_fault", op: "graph", cause: "boom" }) });
    const p = await buildReconcilerDbProjection(adapter);
    expect(p.complete).toBe(false);
    expect(p.facts).toHaveLength(0);
  });

  it("op_not_allowed_degrades_to_incomplete", async () => {
    // a gated-off op can't claim coverage ⇒ complete=false
    const adapter = fakeAdapter({ graph: readErr({ code: "op_not_allowed", op: "graph", allowedOps: [] }) });
    const p = await buildReconcilerDbProjection(adapter);
    expect(p.complete).toBe(false);
  });

  it("truncated_read_is_incomplete", async () => {
    // rows are well-formed but the read signals truncation ⇒ complete=false (an incomplete read can't claim full coverage)
    const adapter = fakeAdapter({ graph: ok({ facts: [ROW_P], truncated: true }) });
    const p = await buildReconcilerDbProjection(adapter);
    expect(p.complete).toBe(false);
    expect(p.facts).toHaveLength(1); // what WAS read is still collected
  });

  it("open_cursor_read_is_incomplete", async () => {
    // an unconsumed paging cursor ⇒ more rows exist ⇒ complete=false
    const adapter = fakeAdapter({ graph: ok({ facts: [ROW_P], cursor: "next-page" }) });
    const p = await buildReconcilerDbProjection(adapter);
    expect(p.complete).toBe(false);
  });

  it("malformed_row_degrades_not_throws", async () => {
    // one row does not parse into a DbFact (invalid factKind) ⇒ complete=false, the parseable facts collected, no throw
    const badRow = { factIdentity: "page:bad", factKind: "not_a_kind", contentHash: "ef".repeat(32), revisionId: "rev:1" };
    const adapter = fakeAdapter({ graph: ok({ facts: [ROW_P, badRow] }) });
    const p = await buildReconcilerDbProjection(adapter);
    expect(p.complete).toBe(false);
    expect(p.facts).toHaveLength(1); // ROW_P survives; the malformed row is dropped, not thrown on
    expect(p.facts[0]?.factIdentity).toBe("page:p");
  });

  it("malformed_graph_envelope_degrades", async () => {
    // the graph response is not the expected { facts: [...] } envelope ⇒ complete=false, facts=[], no throw
    const adapter = fakeAdapter({ graph: ok({ nonsense: true }) });
    const p = await buildReconcilerDbProjection(adapter);
    expect(p.complete).toBe(false);
    expect(p.facts).toHaveLength(0);
  });
});

describe("buildReconcilerDbProjection — stamped fidelity (safety rule 1 / spec §12)", () => {
  it("absent_stamp_signal_is_unstamped", async () => {
    // a row with NO explicit stamped signal maps to stamped=false — a false stamped=true would hide a db_only
    // unstamped HARD parity defect (the reconciler must SEE the unstamped fact to quarantine it)
    const noStamp = { factIdentity: "page:u", factKind: "page", contentHash: "12".repeat(32), revisionId: "rev:1" };
    const explicitTrue = { factIdentity: "page:s", factKind: "page", contentHash: "34".repeat(32), stamped: true, revisionId: "rev:1" };
    const nonBool = { factIdentity: "page:x", factKind: "page", contentHash: "56".repeat(32), stamped: "yes", revisionId: "rev:1" };
    const adapter = fakeAdapter({ graph: ok({ facts: [noStamp, explicitTrue, nonBool] }) });
    const p = await buildReconcilerDbProjection(adapter);
    const byId = new Map(p.facts.map((f) => [f.factIdentity, f]));
    expect(byId.get("page:u")?.stamped).toBe(false); // absent ⇒ false
    expect(byId.get("page:s")?.stamped).toBe(true); // explicit true ⇒ true
    expect(byId.get("page:x")?.stamped).toBe(false); // non-boolean-true ⇒ false (fail-closed)
  });
});

describe("buildReconcilerDbProjection — schema version sourced, not invented (spec §6)", () => {
  it("schema_version_sourced_from_read", async () => {
    const adapter = fakeAdapter({ graph: ok({ facts: [ROW_P] }), schema: ok({ schemaVersion: 42 }) });
    const p = await buildReconcilerDbProjection(adapter);
    expect(p.gbrainSchemaVersion).toBe(42); // reflects the read, not a hardcoded constant
    expect(p.complete).toBe(true);
  });

  it("empty_facts_clean_read_is_complete", async () => {
    // a legitimately empty workspace, fully read, is a VALID complete read — clean-but-empty ≠ degrade
    const adapter = fakeAdapter({ graph: ok({ facts: [] }), schema: ok({ schemaVersion: 5 }) });
    const p = await buildReconcilerDbProjection(adapter);
    expect(p.complete).toBe(true);
    expect(p.facts).toHaveLength(0);
  });

  it("absent_schema_version_degrades_to_incomplete", async () => {
    // an unreadable/absent schema version ⇒ complete=false (can't corroborate the index version) — even with clean facts
    const faulted = fakeAdapter({ graph: ok({ facts: [ROW_P] }), schema: readErr({ code: "transport_fault", op: "schema_read", cause: "boom" }) });
    const pFaulted = await buildReconcilerDbProjection(faulted);
    expect(pFaulted.complete).toBe(false);

    const missing = fakeAdapter({ graph: ok({ facts: [ROW_P] }), schema: ok({ notTheVersion: true }) });
    const pMissing = await buildReconcilerDbProjection(missing);
    expect(pMissing.complete).toBe(false);
  });

  // A readable version is a positive integer; 0/negative/NaN/Infinity/non-number are all unreadable ⇒ degrade
  // (0 is the UNKNOWN_SCHEMA_VERSION degrade sentinel — a real read of 0 must NOT ship complete=true).
  it.each([
    ["zero", 0],
    ["negative", -1],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["string", "7"],
    ["null", null],
  ])("non_positive_or_non_number_schema_version_degrades (%s)", async (_label, schemaVersion) => {
    const adapter = fakeAdapter({ graph: ok({ facts: [ROW_P] }), schema: ok({ schemaVersion }) });
    const p = await buildReconcilerDbProjection(adapter);
    expect(p.complete).toBe(false);
    expect(p.gbrainSchemaVersion).toBe(0); // the degrade sentinel, never a trusted version
  });
});

describe("buildReconcilerDbProjection — type-robust incompleteness + never-throws hardening (spec §12)", () => {
  // A missed "more results" signal is the dangerous value on the coverage axis, so any present non-`false`
  // truncated / any present non-empty cursor of ANY type must degrade (a false-complete = trust-gate defeat).
  it.each([
    ["numeric cursor", { facts: [ROW_P], cursor: 42 }],
    ["object cursor", { facts: [ROW_P], cursor: { next: "x" } }],
    ["truthy-non-boolean truncated", { facts: [ROW_P], truncated: 1 }],
    ["string truncated", { facts: [ROW_P], truncated: "true" }],
  ])("non_conforming_pagination_signal_is_incomplete (%s)", async (_label, graphBody) => {
    const adapter = fakeAdapter({ graph: ok(graphBody) });
    const p = await buildReconcilerDbProjection(adapter);
    expect(p.complete).toBe(false);
  });

  it("explicit_not_truncated_and_empty_cursor_stay_complete", async () => {
    // the benign "no more pages" sentinels — truncated:false + empty/null cursor — do NOT degrade
    const adapter = fakeAdapter({ graph: ok({ facts: [ROW_P], truncated: false, cursor: "" }), schema: ok({ schemaVersion: 3 }) });
    const p = await buildReconcilerDbProjection(adapter);
    expect(p.complete).toBe(true);
  });

  it("adapter_rejection_degrades_not_throws", async () => {
    // a port-violating adapter that REJECTS (instead of returning a Result err) must still degrade, never propagate
    const rejecting: GbrainReadAdapter = { ...fakeAdapter(), graph: () => Promise.reject(new Error("socket died")) };
    const p = await buildReconcilerDbProjection(rejecting);
    expect(p.complete).toBe(false);
    expect(p.facts).toHaveLength(0);
  });

  it("adapter_resolving_non_result_degrades_not_throws", async () => {
    // a port-violating adapter that RESOLVES to a non-Result (undefined/garbage) must degrade, not throw
    // downstream at isOk — honors the never-throws promise regardless of adapter behavior
    const garbage: GbrainReadAdapter = {
      ...fakeAdapter(),
      graph: () => Promise.resolve(undefined as unknown as GbrainReadResult),
    };
    const p = await buildReconcilerDbProjection(garbage);
    expect(p.complete).toBe(false);
    expect(p.facts).toHaveLength(0);
  });

  it("forwards_read_payloads_to_the_adapter", async () => {
    // the opaque revision/paging payloads reach the gbrain reads (load-bearing for piece-D paging)
    const seen: unknown[] = [];
    const adapter: GbrainReadAdapter = {
      ...fakeAdapter({ schema: ok({ schemaVersion: 3 }) }),
      graph: (payload) => { seen.push(payload); return Promise.resolve(ok({ facts: [] })); },
      schemaRead: (payload) => { seen.push(payload); return Promise.resolve(ok({ schemaVersion: 3 })); },
    };
    await buildReconcilerDbProjection(adapter, { graphPayload: { rev: "r1" }, schemaPayload: { probe: 1 } });
    expect(seen).toEqual([{ rev: "r1" }, { probe: 1 }]);
  });
});

describe("buildReconcilerDbProjection — parseRow rejects every malformed shape (safety rule 1)", () => {
  // Each reject branch is a place a malformed row could sneak through as a DbFact, or a valid row get dropped,
  // if the guard regressed. All degrade (complete=false) + drop the bad row — never throw.
  it.each([
    ["non-record row", "not-an-object"],
    ["null row", null],
    ["missing factIdentity", { factKind: "page", contentHash: "ab".repeat(32), revisionId: "rev:1" }],
    ["empty factIdentity", { factIdentity: "", factKind: "page", contentHash: "ab".repeat(32), revisionId: "rev:1" }],
    ["missing contentHash", { factIdentity: "page:x", factKind: "page", revisionId: "rev:1" }],
    ["empty contentHash", { factIdentity: "page:x", factKind: "page", contentHash: "", revisionId: "rev:1" }],
    ["missing revisionId", { factIdentity: "page:x", factKind: "page", contentHash: "ab".repeat(32) }],
    ["non-FactKind kind", { factIdentity: "page:x", factKind: "widget", contentHash: "ab".repeat(32), revisionId: "rev:1" }],
  ])("malformed_row_dropped_and_incomplete (%s)", async (_label, badRow) => {
    const adapter = fakeAdapter({ graph: ok({ facts: [ROW_P, badRow] }), schema: ok({ schemaVersion: 3 }) });
    const p = await buildReconcilerDbProjection(adapter);
    expect(p.complete).toBe(false); // a dropped row ⇒ not fully well-formed ⇒ degrade
    expect(p.facts).toHaveLength(1); // only the well-formed ROW_P survives; the bad row is dropped, not thrown on
    expect(p.facts[0]?.factIdentity).toBe("page:p");
  });
});
