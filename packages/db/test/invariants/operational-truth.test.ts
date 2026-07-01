// Unit 2.5 — operational-truth invariants (RED-first), §4 boundary + DATA_MODEL.
//
// These tests PIN the four load-bearing §4/DATA_MODEL invariants the SQLite +
// Postgres adapters must uphold. This unit OWNS the invariant tests; the adapters
// WIRE the guards/predicates the tests pin. The guards are PURE (no driver, no
// I/O), so they can be exercised deterministically here:
//
//   1. Event log is APPEND-ONLY — no update/delete of a logged event.
//   2. Audit is IMMUTABLE / tombstone-only — no in-place mutation; a correction
//      is a NEW tombstone record, never an edit.
//   3. Approval transitions are EXACTLY-ONCE via atomic compare-and-set on
//      (id, expectedStatus) — a stale CAS loses (no double-apply), and replay of
//      the identical transition is an idempotent no-op (REQ-F-012, §9).
//   4. Read models are REBUILDABLE; the operational-truth set (event log / audit
//      / approvals / outboxes / connector cursors) is NOT rebuildable and is
//      EXCLUDED from any destructive rebuild (§4 Backup & Recovery).
import { describe, expect, it } from "vitest";
import { isErr, isOk, type ApprovalStatus } from "@sow/contracts";
import {
  OPERATIONAL_TRUTH_DOMAINS,
  DOMAIN_DURABILITY,
  TERMINAL_APPROVAL_STATUSES,
  durabilityOf,
  isRebuildable,
  isOperationalTruth,
  assertRebuildTarget,
  assertAppendOnly,
  assertAuditWrite,
  isTerminalApprovalStatus,
  decideApprovalCas,
  casVerdictToResult,
  invariantToDbErrorCode,
  type OperationalDomain,
  type InvariantViolation,
} from "../../src/invariants/operational-truth";

// --- Invariant 1: event log is APPEND-ONLY -----------------------------------

describe("Invariant 1 — event log append-only (§4 / DATA_MODEL)", () => {
  it("permits an append", () => {
    expect(isOk(assertAppendOnly("append"))).toBe(true);
  });

  it("rejects an in-place update with a typed append_only_violation on event_log", () => {
    const r = assertAppendOnly("update");
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.code).toBe("append_only_violation");
      expect(r.error.domain).toBe("event_log");
    }
  });

  it("rejects a hard delete with a typed append_only_violation", () => {
    const r = assertAppendOnly("delete");
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("append_only_violation");
  });
});

// --- Invariant 2: audit is IMMUTABLE / tombstone-only ------------------------

describe("Invariant 2 — audit immutable / tombstone-only (§4 / §16)", () => {
  it("permits appending a new audit record", () => {
    expect(isOk(assertAuditWrite("append"))).toBe(true);
  });

  it("permits a correction expressed as a NEW tombstone record", () => {
    expect(isOk(assertAuditWrite("tombstone"))).toBe(true);
  });

  it("rejects an in-place mutation with a typed immutable_violation on audit", () => {
    const r = assertAuditWrite("update");
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.code).toBe("immutable_violation");
      expect(r.error.domain).toBe("audit");
    }
  });

  it("rejects a hard delete with a typed immutable_violation", () => {
    const r = assertAuditWrite("delete");
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("immutable_violation");
  });
});

// --- Invariant 3: approval transitions are EXACTLY-ONCE via CAS --------------

describe("Invariant 3 — approval exactly-once compare-and-set (REQ-F-012, §9)", () => {
  it("classifies terminal vs non-terminal approval statuses", () => {
    expect(TERMINAL_APPROVAL_STATUSES).toEqual(
      expect.arrayContaining(["approved", "edited", "rejected", "expired"]),
    );
    expect(TERMINAL_APPROVAL_STATUSES).not.toContain("pending");
    expect(TERMINAL_APPROVAL_STATUSES).not.toContain("deferred");
    expect(isTerminalApprovalStatus("approved")).toBe(true);
    expect(isTerminalApprovalStatus("pending")).toBe(false);
    expect(isTerminalApprovalStatus("deferred")).toBe(false);
  });

  it("applies the transition when current === expectedFrom (the winner)", () => {
    expect(decideApprovalCas("pending", "pending", "approved")).toEqual({ kind: "apply" });
    expect(decideApprovalCas("deferred", "deferred", "approved")).toEqual({ kind: "apply" });
  });

  it("a concurrent contender for the SAME target is an idempotent no-op, not a 2nd apply", () => {
    // Mac wins pending→approved; Telegram (same target) arrives after: current is
    // already 'approved'. It must NOT apply a second time.
    expect(decideApprovalCas("approved", "pending", "approved")).toEqual({ kind: "idempotent_noop" });
  });

  it("replaying the identical winning transition is an idempotent no-op", () => {
    // The winner retries its own pending→approved after it already landed.
    expect(decideApprovalCas("approved", "pending", "approved")).toEqual({ kind: "idempotent_noop" });
  });

  it("a stale CAS for a DIFFERENT target loses (no double-apply)", () => {
    // Mac approved; Telegram tries to reject the same (already-approved) item.
    expect(decideApprovalCas("approved", "pending", "rejected")).toEqual({ kind: "stale_conflict" });
  });

  it("a non-terminal expectedFrom mismatch loses (the record moved meanwhile)", () => {
    // The record advanced pending→deferred; a pending-based CAS now loses.
    expect(decideApprovalCas("deferred", "pending", "approved")).toEqual({ kind: "stale_conflict" });
  });

  it("cannot transition OUT of a terminal/tombstoned approval", () => {
    expect(decideApprovalCas("rejected", "pending", "approved")).toEqual({ kind: "stale_conflict" });
    expect(decideApprovalCas("approved", "approved", "rejected")).toEqual({ kind: "stale_conflict" });
  });

  it("idempotent replay onto an already-terminal state stays a clean no-op", () => {
    expect(decideApprovalCas("rejected", "pending", "rejected")).toEqual({ kind: "idempotent_noop" });
  });

  it("casVerdictToResult maps apply→ok(applied), noop→ok(current), stale→typed conflict", () => {
    type Probe = { readonly tag: "applied" | "current" };
    const applied: Probe = { tag: "applied" };
    const current: Probe = { tag: "current" };

    const a = casVerdictToResult<Probe>({ kind: "apply" }, applied, current);
    expect(isOk(a)).toBe(true);
    if (isOk(a)) expect(a.value).toBe(applied);

    const n = casVerdictToResult<Probe>({ kind: "idempotent_noop" }, applied, current);
    expect(isOk(n)).toBe(true);
    if (isOk(n)) expect(n.value).toBe(current);

    const s = casVerdictToResult<Probe>({ kind: "stale_conflict" }, applied, current);
    expect(isErr(s)).toBe(true);
    if (isErr(s)) {
      expect(s.error.code).toBe("stale_transition");
      expect(s.error.domain).toBe("approvals");
    }
  });
});

// --- Invariant 4: read models REBUILDABLE; operational truth is NOT ----------

describe("Invariant 4 — read-model rebuildability vs operational truth (§4)", () => {
  it("names exactly the five §4 operational-truth domains", () => {
    expect([...OPERATIONAL_TRUTH_DOMAINS].sort()).toEqual(
      ["approvals", "audit", "connector_cursors", "event_log", "outboxes"].sort(),
    );
  });

  it("classifies read models as rebuildable and the operational-truth set as not", () => {
    expect(durabilityOf("read_models")).toBe("rebuildable");
    expect(isRebuildable("read_models")).toBe(true);
    expect(isRebuildable("gcl_projections")).toBe(true); // derived ⇒ re-derivable
    for (const d of OPERATIONAL_TRUTH_DOMAINS) {
      expect(durabilityOf(d)).toBe("operational_truth");
      expect(isRebuildable(d), d).toBe(false);
      expect(isOperationalTruth(d), d).toBe(true);
    }
  });

  it("every declared domain has a durability classification", () => {
    const declared = Object.keys(DOMAIN_DURABILITY) as OperationalDomain[];
    expect(declared.length).toBeGreaterThanOrEqual(10);
    for (const d of declared) expect(DOMAIN_DURABILITY[d]).toBeDefined();
  });

  it("a rebuild routine may target read models but NEVER operational truth", () => {
    expect(isOk(assertRebuildTarget("read_models"))).toBe(true);
    for (const d of OPERATIONAL_TRUTH_DOMAINS) {
      const r = assertRebuildTarget(d);
      expect(isErr(r), d).toBe(true);
      if (isErr(r)) {
        expect(r.error.code).toBe("rebuild_truth_excluded");
        expect(r.error.domain).toBe(d);
      }
    }
  });
});

// --- DbError mapping: adapters re-emit invariant violations as DbError -------

describe("invariantToDbErrorCode — adapter wiring to the §16 DbError taxonomy", () => {
  it("maps structural violations to constraint_violation and stale CAS to conflict", () => {
    expect(invariantToDbErrorCode("append_only_violation")).toBe("constraint_violation");
    expect(invariantToDbErrorCode("immutable_violation")).toBe("constraint_violation");
    expect(invariantToDbErrorCode("rebuild_truth_excluded")).toBe("constraint_violation");
    expect(invariantToDbErrorCode("stale_transition")).toBe("conflict");
  });

  it("a violation carries a non-empty human message", () => {
    const r = assertAppendOnly("delete");
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      const v: InvariantViolation = r.error;
      expect(v.message.length).toBeGreaterThan(0);
    }
  });
});

// Type-level smoke: ApprovalStatus is the contract enum the CAS helper accepts.
const _statusSmoke: ApprovalStatus = "pending";
void _statusSmoke;
