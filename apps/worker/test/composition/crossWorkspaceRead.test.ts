// Task 14.7 — THE cross-workspace READ GATE (worker leg). RED-first. HIGHEST safety bar.
//
// SAFETY rule 4 / WS-8 (§5/§6): `resolveApprovedCrossWorkspaceSlice` is the ONLY path by which
// reader-workspace A sees any of source-workspace B's content — and only the APPROVED, DIRECTIONAL,
// SCOPED, SANITIZED slice. The load-bearing invariants pinned here (each NON-VACUOUS):
//   1. absent/unapproved link  ⇒ ZERO of B crosses (fail-closed default; seed B non-empty first).
//   2. approved link           ⇒ ONLY B's projections matching the link's scope cross.
//   3. every crossing row goes through the GclProjection sanitizer — a raw-content-shaped B row
//      fails CLOSED (never raw bytes), even under an approved link.
//   4. revoke closes the path immediately (approve→see→revoke→empty).
//   5. directional: an A→B link never lets B read A.
//
// The consumers that BLEND this slice into a coordination/global brief are Phase 25.2/25.4 (deferred,
// Lesson 11) — this gate is the reachable unit they will call; it is NOT wired into the dormant
// empty global producer here. Unit-tested over a fake link repo + a fake GCL-projection repo.
import { describe, it, expect } from "vitest";
import { ok, err, isErr, isOk, type Result } from "@sow/contracts";
import type { GclProjection } from "@sow/contracts";
import type {
  CrossWorkspaceLinkRow,
  CrossWorkspaceLinkStatus,
  CrossWorkspaceLinkRepository,
  GclProjectionRepository,
  DbError,
} from "@sow/db";
import { resolveApprovedCrossWorkspaceSlice } from "../../src/composition/crossWorkspaceRead";

const NOW = "2026-07-15T00:00:00.000Z";
const wsp = (s: string): GclProjection["workspaceId"] => s as GclProjection["workspaceId"];

/** A valid, sanitized GclProjection (single-line short summary — passes the §6 refine gate). */
function gclProj(over: Partial<GclProjection> = {}): GclProjection {
  return {
    workspaceId: wsp("ws-b"),
    visibilityLevel: "coordination",
    projectionType: "coordination",
    sanitizedPayload: { headline: "Q3 launch on track" },
    sourceRefs: [],
    ...over,
  } as GclProjection;
}

function link(over: Partial<CrossWorkspaceLinkRow> = {}): CrossWorkspaceLinkRow {
  return {
    linkId: "link-1",
    fromWorkspaceId: "ws-a" as CrossWorkspaceLinkRow["fromWorkspaceId"],
    toWorkspaceId: "ws-b" as CrossWorkspaceLinkRow["toWorkspaceId"],
    scopeProjectionType: "coordination",
    scopeVisibilityLevel: "coordination",
    status: "approved",
    createdAt: NOW,
    approvedAt: NOW,
    revokedAt: null,
    ...over,
  };
}

class FakeLinkRepo implements CrossWorkspaceLinkRepository {
  rows = new Map<string, CrossWorkspaceLinkRow>();
  faultOnList = false;
  seed(...rs: CrossWorkspaceLinkRow[]): this {
    for (const r of rs) this.rows.set(r.linkId, r);
    return this;
  }
  async create(row: CrossWorkspaceLinkRow): Promise<Result<CrossWorkspaceLinkRow, DbError>> {
    this.rows.set(row.linkId, row);
    return ok(row);
  }
  async get(linkId: string): Promise<Result<CrossWorkspaceLinkRow, DbError>> {
    const r = this.rows.get(linkId);
    return r ? ok(r) : err({ code: "not_found", message: "x" });
  }
  async listApprovedForReader(fromWorkspaceId: CrossWorkspaceLinkRow["fromWorkspaceId"]): Promise<Result<CrossWorkspaceLinkRow[], DbError>> {
    if (this.faultOnList) return err({ code: "unavailable", message: "x" });
    return ok([...this.rows.values()].filter((r) => r.fromWorkspaceId === fromWorkspaceId && r.status === "approved"));
  }
  async setStatus(linkId: string, status: CrossWorkspaceLinkStatus, at: string): Promise<Result<CrossWorkspaceLinkRow, DbError>> {
    const r = this.rows.get(linkId);
    if (!r) return err({ code: "not_found", message: "x" });
    const next: CrossWorkspaceLinkRow = { ...r, status, approvedAt: status === "approved" ? at : r.approvedAt, revokedAt: status === "revoked" ? at : r.revokedAt };
    this.rows.set(linkId, next);
    return ok(next);
  }
}

class FakeGclRepo implements GclProjectionRepository {
  byWorkspace = new Map<string, GclProjection[]>();
  faultOnList = false;
  seed(workspaceId: string, ...ps: GclProjection[]): this {
    this.byWorkspace.set(workspaceId, [...(this.byWorkspace.get(workspaceId) ?? []), ...ps]);
    return this;
  }
  async listByWorkspace(workspaceId: GclProjection["workspaceId"]): Promise<Result<GclProjection[], DbError>> {
    if (this.faultOnList) return err({ code: "unavailable", message: "x" });
    return ok(this.byWorkspace.get(workspaceId) ?? []);
  }
  async listByVisibility(): Promise<Result<GclProjection[], DbError>> {
    return ok([]);
  }
  async get(): Promise<Result<GclProjection, DbError>> {
    return err({ code: "not_found", message: "x" });
  }
  async upsert(p: GclProjection): Promise<Result<GclProjection, DbError>> {
    return ok(p);
  }
}

describe("resolveApprovedCrossWorkspaceSlice (14.7 — the WS-8 cross-workspace read gate)", () => {
  it("absent_link_yields_zero_bleed_even_though_B_has_content: NO approved A→B link ⇒ A's cross-read is EMPTY, though B is seeded (NON-VACUOUS positive control) [spec(§5)]", async () => {
    const links = new FakeLinkRepo(); // no links at all
    const gcl = new FakeGclRepo().seed("ws-b", gclProj(), gclProj({ projectionType: "other" }));
    // positive control: B genuinely HAS content in the store.
    const bHas = await gcl.listByWorkspace(wsp("ws-b"));
    expect(isOk(bHas) && bHas.value.length).toBe(2);
    // the gate: A reads ZERO of B (fail-closed default — WS-8 stays fully isolating).
    const res = await resolveApprovedCrossWorkspaceSlice({ links, gclProjections: gcl }, "ws-a");
    expect(isOk(res) && res.value.length).toBe(0);
  });

  it("pending_or_revoked_link_yields_zero_bleed: a NON-approved (pending/revoked) A→B link surfaces ZERO of B [spec(§5)]", async () => {
    const gcl = new FakeGclRepo().seed("ws-b", gclProj());
    const pending = new FakeLinkRepo().seed(link({ status: "pending" }));
    const revoked = new FakeLinkRepo().seed(link({ linkId: "l2", status: "revoked" }));
    expect(isOk(await resolveApprovedCrossWorkspaceSlice({ links: pending, gclProjections: gcl }, "ws-a")) && (await resolveApprovedCrossWorkspaceSlice({ links: pending, gclProjections: gcl }, "ws-a") as { value: readonly GclProjection[] }).value.length).toBe(0);
    expect(isOk(await resolveApprovedCrossWorkspaceSlice({ links: revoked, gclProjections: gcl }, "ws-a")) && (await resolveApprovedCrossWorkspaceSlice({ links: revoked, gclProjections: gcl }, "ws-a") as { value: readonly GclProjection[] }).value.length).toBe(0);
  });

  it("approved_link_crosses_only_the_scoped_slice: only B rows matching the link's scope (projectionType+visibilityLevel) cross; out-of-scope rows do NOT [spec(§6)]", async () => {
    const links = new FakeLinkRepo().seed(link()); // scope = coordination/coordination, approved
    const gcl = new FakeGclRepo().seed(
      "ws-b",
      gclProj({ sanitizedPayload: { headline: "in scope" } }), // matches scope
      gclProj({ projectionType: "private-notes", sanitizedPayload: { headline: "wrong type" } }), // out of scope
      gclProj({ visibilityLevel: "isolated", sanitizedPayload: { headline: "wrong visibility" } }), // out of scope
    );
    const res = await resolveApprovedCrossWorkspaceSlice({ links, gclProjections: gcl }, "ws-a");
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.length).toBe(1); // ONLY the in-scope row
      expect(res.value[0]?.sanitizedPayload).toEqual({ headline: "in scope" });
    }
  });

  it("raw_content_shaped_row_fails_closed_even_under_approved_link: a B projection carrying a multi-line/raw value is withheld — the read fails CLOSED (never raw bytes cross), safety rule 4 [spec(§6)]", async () => {
    const links = new FakeLinkRepo().seed(link());
    // A poisoned projection (bypasses the write gate) whose payload carries verbatim raw content.
    const poisoned = gclProj({ sanitizedPayload: { body: "line one\nline two — a full transcript body that is NOT a sanitized single-line summary" } });
    const gcl = new FakeGclRepo().seed("ws-b", poisoned);
    const res = await resolveApprovedCrossWorkspaceSlice({ links, gclProjections: gcl }, "ws-a");
    expect(isErr(res)).toBe(true); // withhold ALL — a raw-content-shaped row never crosses, not even sanitized
    if (isErr(res)) expect(res.error.code).toBe("sanitization_rejected");
  });

  it("read_back_identity_regate_excludes_a_foreign_workspace_row: a scope-matching row whose workspaceId != the link's SOURCE (B) does NOT cross — a mis-filtered/tampered store row never surfaces cross-workspace (worker Lesson 12, WS-8) [spec(§5)]", async () => {
    const links = new FakeLinkRepo().seed(link()); // A→B approved, scope coordination/coordination
    // The B bucket returns a genuine B row PLUS a foreign (ws-c) row that matches the scope shape —
    // simulating a looser/tampered store filter. Only the true-B row may cross.
    const gcl = new FakeGclRepo().seed(
      "ws-b",
      gclProj({ workspaceId: wsp("ws-b"), sanitizedPayload: { headline: "real B" } }),
      gclProj({ workspaceId: wsp("ws-c"), sanitizedPayload: { headline: "foreign C row" } }),
    );
    const res = await resolveApprovedCrossWorkspaceSlice({ links, gclProjections: gcl }, "ws-a");
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.length).toBe(1);
      expect(res.value[0]?.sanitizedPayload).toEqual({ headline: "real B" });
    }
  });

  it("scopeless_link_crosses_nothing: a persisted approved link with a DEGENERATE (empty) scope crosses ZERO of B — never all-of-B (fail-closed widening guard, defense-in-depth) [spec(§6)]", async () => {
    const links = new FakeLinkRepo().seed(link({ scopeProjectionType: "" }));
    const gcl = new FakeGclRepo().seed("ws-b", gclProj(), gclProj({ projectionType: "other" }));
    const res = await resolveApprovedCrossWorkspaceSlice({ links, gclProjections: gcl }, "ws-a");
    expect(isOk(res) && res.value.length).toBe(0);
  });

  it("revoke_closes_the_path_immediately: approve→A sees the slice→revoke→A's cross-read returns EMPTY [spec(§5)]", async () => {
    const links = new FakeLinkRepo().seed(link({ status: "approved" }));
    const gcl = new FakeGclRepo().seed("ws-b", gclProj());
    const before = await resolveApprovedCrossWorkspaceSlice({ links, gclProjections: gcl }, "ws-a");
    expect(isOk(before) && before.value.length).toBe(1); // approved ⇒ visible
    await links.setStatus("link-1", "revoked", NOW); // owner revokes
    const after = await resolveApprovedCrossWorkspaceSlice({ links, gclProjections: gcl }, "ws-a");
    expect(isOk(after) && after.value.length).toBe(0); // revoked ⇒ path closed immediately
  });

  it("directional_A_to_B_does_not_let_B_read_A: an approved A→B link authorizes A reading B, NOT B reading A [spec(§5)]", async () => {
    const links = new FakeLinkRepo().seed(link()); // A(ws-a) → B(ws-b), approved
    const gcl = new FakeGclRepo().seed("ws-a", gclProj({ workspaceId: wsp("ws-a") })); // A has content
    // B reads: no approved link with from=ws-b exists ⇒ ZERO of A crosses to B.
    const res = await resolveApprovedCrossWorkspaceSlice({ links, gclProjections: gcl }, "ws-b");
    expect(isOk(res) && res.value.length).toBe(0);
  });

  it("store_fault_fails_closed: a link-list OR a gcl-list fault ⇒ typed store_fault (never a partial/leaky read, never throws) [spec(§16)]", async () => {
    const gcl = new FakeGclRepo().seed("ws-b", gclProj());
    const linkFault = new FakeLinkRepo().seed(link());
    linkFault.faultOnList = true;
    const r1 = await resolveApprovedCrossWorkspaceSlice({ links: linkFault, gclProjections: gcl }, "ws-a");
    expect(isErr(r1) && r1.error.code).toBe("store_fault");
    const gclFault = new FakeGclRepo().seed("ws-b", gclProj());
    gclFault.faultOnList = true;
    const r2 = await resolveApprovedCrossWorkspaceSlice({ links: new FakeLinkRepo().seed(link()), gclProjections: gclFault }, "ws-a");
    expect(isErr(r2) && r2.error.code).toBe("store_fault");
  });
});
