// spec(§6) — QuarantineLedger (task 4.17): the do-not-serve enforcement gbrain has
// no concept of. ABSENCE model keyed on content-INDEPENDENT factIdentity (one-byte
// change → same identity, so a purge can't be evaded by re-introduction —
// "no resurrection"). Workspace-scoped (safety rule 4). Deterministic → strict TDD.
import { describe, it, expect } from "vitest";
import type {
  QuarantineRecord,
  FactIdentity,
  WorkspaceId,
  AuditId,
  RemediationState,
} from "@sow/contracts";
import { createQuarantineLedger } from "../src/gbrain/serving/quarantine-ledger";

const WS_A = "ws-emp" as WorkspaceId;
const WS_B = "ws-personal" as WorkspaceId;
const ID_AUTH = "page:acme/auth" as FactIdentity;
const ID_OTHER = "page:acme/other" as FactIdentity;

function record(over: Partial<QuarantineRecord> = {}): QuarantineRecord {
  return {
    factIdentity: ID_AUTH,
    workspaceId: WS_A,
    divergenceRef: "div-001",
    divergenceClass: "db_only",
    capturedDbDigest: "db-digest-abc",
    remediationState: "pending",
    healthItemId: "health-001",
    auditRef: "aud-001" as AuditId,
    ...over,
  };
}

describe("QuarantineLedger — absence model + no resurrection", () => {
  it("an empty ledger quarantines nothing", () => {
    const ledger = createQuarantineLedger();
    expect(ledger.isQuarantined(WS_A, ID_AUTH)).toBe(false);
    expect(ledger.list()).toEqual([]);
    expect(ledger.get(WS_A, ID_AUTH)).toBeUndefined();
  });

  it("quarantines a pending record and reports it do-not-serve", () => {
    const ledger = createQuarantineLedger();
    const r = record();
    ledger.quarantine(r);
    expect(ledger.isQuarantined(WS_A, ID_AUTH)).toBe(true);
    expect(ledger.get(WS_A, ID_AUTH)).toEqual(r);
    expect(ledger.list()).toEqual([r]);
  });

  it("is keyed on the content-INDEPENDENT factIdentity, so a re-introduced fact (same identity, any content) stays blocked", () => {
    const ledger = createQuarantineLedger();
    // The record's identity pins the LOCATION, never a content hash — the ledger
    // never stores content, so a byte-changed re-introduction hits the same key.
    ledger.quarantine(record({ capturedDbDigest: "first-capture" }));
    expect(ledger.isQuarantined(WS_A, ID_AUTH)).toBe(true);
    // Re-quarantining the same identity with a DIFFERENT captured digest upserts;
    // the identity remains a single ledger entry (no phantom second record).
    ledger.quarantine(record({ capturedDbDigest: "second-capture" }));
    expect(ledger.isQuarantined(WS_A, ID_AUTH)).toBe(true);
    expect(ledger.list()).toHaveLength(1);
    expect(ledger.get(WS_A, ID_AUTH)?.capturedDbDigest).toBe("second-capture");
  });

  it("a purged record stays blocked — a destroyed fact must not resurrect on re-introduction", () => {
    const ledger = createQuarantineLedger([record({ remediationState: "purged" })]);
    expect(ledger.isQuarantined(WS_A, ID_AUTH)).toBe(true);
  });

  it("a materializing record is still blocked (remediation in flight)", () => {
    const ledger = createQuarantineLedger([record({ remediationState: "materializing" })]);
    expect(ledger.isQuarantined(WS_A, ID_AUTH)).toBe(true);
  });

  it("a materialized record clears the block (re-canonicalized through the full KW pipeline)", () => {
    const ledger = createQuarantineLedger([record({ remediationState: "materialized" })]);
    expect(ledger.isQuarantined(WS_A, ID_AUTH)).toBe(false);
    // it is still RETRIEVABLE for audit — cleared for serving, not forgotten.
    expect(ledger.get(WS_A, ID_AUTH)?.remediationState).toBe("materialized");
  });

  it("a dismissed record clears the block (the divergence was reviewed as benign)", () => {
    const ledger = createQuarantineLedger([record({ remediationState: "dismissed" })]);
    expect(ledger.isQuarantined(WS_A, ID_AUTH)).toBe(false);
  });

  it("blocks every active state and clears every resolved state", () => {
    const blocked: RemediationState[] = ["pending", "materializing", "purged"];
    const cleared: RemediationState[] = ["materialized", "dismissed"];
    for (const s of blocked) {
      const ledger = createQuarantineLedger([record({ remediationState: s })]);
      expect(ledger.isQuarantined(WS_A, ID_AUTH), `state ${s} must block`).toBe(true);
    }
    for (const s of cleared) {
      const ledger = createQuarantineLedger([record({ remediationState: s })]);
      expect(ledger.isQuarantined(WS_A, ID_AUTH), `state ${s} must clear`).toBe(false);
    }
  });

  it("is workspace-scoped — a quarantine in one workspace never blocks the same identity in another (safety rule 4)", () => {
    const ledger = createQuarantineLedger([record({ workspaceId: WS_A })]);
    expect(ledger.isQuarantined(WS_A, ID_AUTH)).toBe(true);
    expect(ledger.isQuarantined(WS_B, ID_AUTH)).toBe(false);
  });

  it("upsert transitions state on the same key (pending → materialized clears the block)", () => {
    const ledger = createQuarantineLedger();
    ledger.quarantine(record({ remediationState: "pending" }));
    expect(ledger.isQuarantined(WS_A, ID_AUTH)).toBe(true);
    ledger.quarantine(record({ remediationState: "materialized" }));
    expect(ledger.isQuarantined(WS_A, ID_AUTH)).toBe(false);
    expect(ledger.list()).toHaveLength(1);
  });

  it("tracks independent identities separately", () => {
    const ledger = createQuarantineLedger([
      record({ factIdentity: ID_AUTH, remediationState: "pending" }),
      record({ factIdentity: ID_OTHER, remediationState: "materialized" }),
    ]);
    expect(ledger.isQuarantined(WS_A, ID_AUTH)).toBe(true);
    expect(ledger.isQuarantined(WS_A, ID_OTHER)).toBe(false);
    expect(ledger.list()).toHaveLength(2);
  });
});
