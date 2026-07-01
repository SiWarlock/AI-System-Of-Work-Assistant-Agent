// spec(§6) — CrashRecoveryReconciler (task 4.20, §6/§13; write-through amendment
// invariant (vii) + §13 / 12.23). On restart the revision-scoped serving allow-set
// is rebuilt from `CanonicalFactDeriver(current Markdown)` — the gbrain-INDEPENDENT
// parser — so a crash NEVER strands a true (Markdown-derivable) fact un-served, and
// NEVER resurrects a quarantined one: an ACTIVE quarantine (pending/materializing/
// purged) on a derived identity keeps it blocked, and a `purged` identity that
// reappears in committed Markdown is caught + surfaced (content-independent, so a
// one-byte re-introduction cannot evade the block). A derive failure fails closed.
import { describe, it, expect } from "vitest";
import type { QuarantineRecord, AuditId, FactIdentity, WorkspaceId } from "@sow/contracts";
import { factIdentity, HealthItemSchema } from "@sow/contracts";
import { createQuarantineLedger } from "../src/gbrain/serving/quarantine-ledger";
import type { CanonicalVaultSnapshot } from "../src/gbrain/derive/canonical-fact-deriver";
import { deriveCanonicalFacts } from "../src/gbrain/derive/canonical-fact-deriver";
import {
  recoverServingState,
  type CrashRecoveryDeps,
} from "../src/gbrain/enablement/crash-recovery-reconciler";

const WS = "ws-employer";

function snapshot(files: Record<string, string>): CanonicalVaultSnapshot {
  return {
    workspaceId: WS as WorkspaceId,
    revisionId: "rev-current" as CanonicalVaultSnapshot["revisionId"],
    files: new Map(Object.entries(files)),
  };
}

let idn = 0;
const deps: CrashRecoveryDeps = {
  now: () => "2026-07-01T00:00:00.000Z",
  newHealthItemId: () => `health-${(idn += 1)}`,
  newAuditId: () => `audit-${(idn += 1)}`,
};

function quarantineRecord(
  id: string,
  remediationState: QuarantineRecord["remediationState"],
): QuarantineRecord {
  return {
    factIdentity: id as FactIdentity,
    workspaceId: WS as WorkspaceId,
    divergenceRef: "div-1",
    divergenceClass: "db_only",
    capturedDbDigest: "digest-abc",
    remediationState,
    healthItemId: "health-seed",
    auditRef: "audit-seed" as AuditId,
  };
}

const NOTES = {
  "alpha.md": "---\nslug: alpha\ntags: work\n---\nAlpha body [[beta]].\n",
  "beta.md": "---\nslug: beta\n---\nBeta body.\n",
};

describe("recoverServingState — rebuild the allow-set from current Markdown", () => {
  it("rebuilds the allow-set as CanonicalFactDeriver(current Markdown) verbatim", () => {
    const snap = snapshot(NOTES);
    const derived = deriveCanonicalFacts(snap);
    expect(derived.ok).toBe(true);
    if (!derived.ok) return;

    const r = recoverServingState({ snapshot: snap, quarantine: createQuarantineLedger() }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // The recovered allow-set IS the gbrain-independent derived set (same members).
    expect(r.value.allowSet.facts.map((f) => f.fact.factIdentity)).toEqual(
      derived.value.facts.map((f) => f.fact.factIdentity),
    );
    expect(r.value.revisionId).toBe("rev-current");
  });

  it("never strands a true fact un-served: with an empty ledger, every derived fact is servable", () => {
    const snap = snapshot(NOTES);
    const r = recoverServingState({ snapshot: snap, quarantine: createQuarantineLedger() }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.servable.length).toBe(r.value.allowSet.facts.length);
    expect(r.value.quarantineBlocked).toEqual([]);
    expect(r.value.resurrectionBlocked).toEqual([]);
    expect(r.value.healthItems).toEqual([]);
  });
});

describe("recoverServingState — never resurrects a quarantined fact", () => {
  it("a PENDING quarantine on a derived identity keeps it blocked (in-flight; no HealthItem)", () => {
    const snap = snapshot(NOTES);
    const alphaPage = factIdentity({ kind: "page", slug: "alpha" }) as string;
    const ledger = createQuarantineLedger([quarantineRecord(alphaPage, "pending")]);

    const r = recoverServingState({ snapshot: snap, quarantine: ledger }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.servable).not.toContain(alphaPage);
    expect(r.value.quarantineBlocked).toContain(alphaPage);
    expect(r.value.resurrectionBlocked).not.toContain(alphaPage);
    expect(r.value.healthItems).toEqual([]);
  });

  it("a PURGED identity that REAPPEARS in Markdown is kept blocked + surfaced (resurrection caught)", () => {
    const snap = snapshot(NOTES);
    const betaPage = factIdentity({ kind: "page", slug: "beta" }) as string;
    const ledger = createQuarantineLedger([quarantineRecord(betaPage, "purged")]);

    const r = recoverServingState({ snapshot: snap, quarantine: ledger }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.servable).not.toContain(betaPage);
    expect(r.value.quarantineBlocked).toContain(betaPage);
    expect(r.value.resurrectionBlocked).toContain(betaPage);
    expect(r.value.healthItems.length).toBe(1);
    expect(r.value.healthItems[0]?.factIdentity).toBe(betaPage);
    expect(() => HealthItemSchema.parse(r.value.healthItems[0])).not.toThrow();
  });

  it("a RESOLVED quarantine (materialized/dismissed) does NOT block a derived fact", () => {
    const snap = snapshot(NOTES);
    const alphaPage = factIdentity({ kind: "page", slug: "alpha" }) as string;
    const betaPage = factIdentity({ kind: "page", slug: "beta" }) as string;
    const ledger = createQuarantineLedger([
      quarantineRecord(alphaPage, "materialized"),
      quarantineRecord(betaPage, "dismissed"),
    ]);

    const r = recoverServingState({ snapshot: snap, quarantine: ledger }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.servable).toContain(alphaPage);
    expect(r.value.servable).toContain(betaPage);
    expect(r.value.quarantineBlocked).toEqual([]);
  });

  it("a one-byte re-introduction cannot evade a purge — quarantine is content-independent", () => {
    // Same slug (=> same page factIdentity) but different body bytes.
    const snap = snapshot({ "beta.md": "---\nslug: beta\n---\nBeta body EDITED.\n" });
    const betaPage = factIdentity({ kind: "page", slug: "beta" }) as string;
    const ledger = createQuarantineLedger([quarantineRecord(betaPage, "purged")]);

    const r = recoverServingState({ snapshot: snap, quarantine: ledger }, deps);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.servable).not.toContain(betaPage);
    expect(r.value.resurrectionBlocked).toContain(betaPage);
  });

  it("a quarantine scoped to a DIFFERENT workspace does not block this workspace's identity", () => {
    const snap = snapshot(NOTES);
    const alphaPage = factIdentity({ kind: "page", slug: "alpha" }) as string;
    const foreign: QuarantineRecord = {
      ...quarantineRecord(alphaPage, "purged"),
      workspaceId: "ws-personal" as WorkspaceId,
    };
    const r = recoverServingState(
      { snapshot: snap, quarantine: createQuarantineLedger([foreign]) },
      deps,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.servable).toContain(alphaPage);
  });
});

describe("recoverServingState — fail-closed on a derive failure", () => {
  it("a cross-page identity collision (deriver err) fails closed with a typed error + HealthItem", () => {
    // Two files with the SAME frontmatter slug collide on the page factIdentity.
    const snap = snapshot({
      "one.md": "---\nslug: dup\n---\nOne.\n",
      "two.md": "---\nslug: dup\n---\nTwo.\n",
    });
    const r = recoverServingState({ snapshot: snap, quarantine: createQuarantineLedger() }, deps);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("derive_failed");
    expect(r.error.healthItem.failureClass).toBe("write_through_failed");
    expect(() => HealthItemSchema.parse(r.error.healthItem)).not.toThrow();
  });
});
