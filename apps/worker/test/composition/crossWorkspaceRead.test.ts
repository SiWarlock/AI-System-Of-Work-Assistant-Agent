// Task 14.7 — THE cross-workspace READ GATE (worker leg). RED-first. HIGHEST safety bar.
// Task 24.17 — closes the ceiling gap: the read now re-derives against the SOURCE workspace's LIVE
// defaultVisibility (via the real @sow/knowledge GCL Visibility Gate, `serveProjection`), never the
// link's frozen scope alone.
//
// SAFETY rule 4 / WS-8 (§5/§6): `resolveApprovedCrossWorkspaceSlice` is the ONLY path by which
// reader-workspace A sees any of source-workspace B's content — and only the APPROVED, DIRECTIONAL,
// SCOPED, gate-re-validated slice. The load-bearing invariants pinned here (each NON-VACUOUS):
//   1. absent/unapproved link  ⇒ ZERO of B crosses (fail-closed default; seed B non-empty first).
//   2. approved link           ⇒ ONLY B's projections matching the link's scope cross.
//   3. every crossing row goes through the REAL GCL Visibility Gate — a raw-content-shaped B row
//      fails CLOSED (never raw bytes), even under an approved link.
//   4. revoke closes the path immediately (approve→see→revoke→empty).
//   5. directional: an A→B link never lets B read A.
//   6. (24.17) the source workspace's LIVE defaultVisibility ceiling is re-derived PER READ, not
//      frozen on the link — tightening it stops a previously-crossing row from crossing.
//   7. (24.17) a ceiling-exceeded row and a ceiling-unavailable link are COUNTED, never silently
//      folded into "nothing qualified".
//
// The consumers that BLEND this slice into a coordination/global brief are Phase 25.2/25.4 (deferred,
// Lesson 11) — this gate is the reachable unit they will call; it is NOT wired into the dormant
// empty global producer here. Unit-tested over fake link/GCL-projection/workspace-config repos.
import { describe, it, expect } from "vitest";
import { ok, err, isErr, isOk, type Result } from "@sow/contracts";
import type { GclProjection, Workspace, VisibilityLevel } from "@sow/contracts";
import type {
  CrossWorkspaceLinkRow,
  CrossWorkspaceLinkStatus,
  CrossWorkspaceLinkRepository,
  GclProjectionRepository,
  WorkspaceConfigRepository,
  DbError,
} from "@sow/db";
import {
  resolveApprovedCrossWorkspaceSlice,
  type CrossWorkspaceReadOutcome,
} from "../../src/composition/crossWorkspaceRead";

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

/** A minimal, valid Workspace row — only `id` + `defaultVisibility` matter to this gate. */
function workspace(id: string, defaultVisibility: VisibilityLevel): Workspace {
  return { id, defaultVisibility } as unknown as Workspace;
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

/** A fake WorkspaceConfigRepository — 24.17's live-ceiling source. `get` is the only method this
 *  gate calls; the others throw to prove they're never touched. */
class FakeWorkspaceConfigRepo implements WorkspaceConfigRepository {
  rows = new Map<string, Workspace>();
  faultOnGet = false;
  seed(ws: Workspace): this {
    this.rows.set(String(ws.id), ws);
    return this;
  }
  async get(id: Workspace["id"]): Promise<Result<Workspace, DbError>> {
    if (this.faultOnGet) return err({ code: "unavailable", message: "x" });
    const r = this.rows.get(String(id));
    return r ? ok(r) : err({ code: "not_found", message: "x" });
  }
  list(): never {
    throw new Error("must not be called by this gate");
  }
  upsert(): never {
    throw new Error("must not be called by this gate");
  }
  updateProvisioningFields(): never {
    throw new Error("must not be called by this gate");
  }
  insertIfAbsent(): never {
    throw new Error("must not be called by this gate");
  }
}

/** Default: B's own default visibility is "coordination" — matches the seeded projections/links'
 *  scope in the existing test fixtures below, so pre-24.17 tests are unaffected by the new gate. */
function defaultWorkspaceConfig(): FakeWorkspaceConfigRepo {
  return new FakeWorkspaceConfigRepo().seed(workspace("ws-b", "coordination"));
}

/** Unwraps a successful outcome's projections, or fails the assertion loudly. */
function projectionsOf(res: Result<CrossWorkspaceReadOutcome, unknown>): readonly GclProjection[] {
  if (!isOk(res)) throw new Error(`expected ok, got err: ${JSON.stringify(res)}`);
  return res.value.projections;
}

describe("resolveApprovedCrossWorkspaceSlice (14.7 / 24.17 — the WS-8 cross-workspace read gate)", () => {
  it("absent_link_yields_zero_bleed_even_though_B_has_content: NO approved A→B link ⇒ A's cross-read is EMPTY, though B is seeded (NON-VACUOUS positive control) [spec(§5)]", async () => {
    const links = new FakeLinkRepo(); // no links at all
    const gcl = new FakeGclRepo().seed("ws-b", gclProj(), gclProj({ projectionType: "other" }));
    // positive control: B genuinely HAS content in the store.
    const bHas = await gcl.listByWorkspace(wsp("ws-b"));
    expect(isOk(bHas) && bHas.value.length).toBe(2);
    // the gate: A reads ZERO of B (fail-closed default — WS-8 stays fully isolating).
    const res = await resolveApprovedCrossWorkspaceSlice(
      { links, gclProjections: gcl, workspaceConfig: defaultWorkspaceConfig() },
      "ws-a",
    );
    expect(projectionsOf(res).length).toBe(0);
  });

  it("pending_or_revoked_link_yields_zero_bleed: a NON-approved (pending/revoked) A→B link surfaces ZERO of B [spec(§5)]", async () => {
    const gcl = new FakeGclRepo().seed("ws-b", gclProj());
    const pending = new FakeLinkRepo().seed(link({ status: "pending" }));
    const revoked = new FakeLinkRepo().seed(link({ linkId: "l2", status: "revoked" }));
    expect(
      projectionsOf(
        await resolveApprovedCrossWorkspaceSlice(
          { links: pending, gclProjections: gcl, workspaceConfig: defaultWorkspaceConfig() },
          "ws-a",
        ),
      ).length,
    ).toBe(0);
    expect(
      projectionsOf(
        await resolveApprovedCrossWorkspaceSlice(
          { links: revoked, gclProjections: gcl, workspaceConfig: defaultWorkspaceConfig() },
          "ws-a",
        ),
      ).length,
    ).toBe(0);
  });

  it("approved_link_crosses_only_the_scoped_slice: only B rows matching the link's scope (projectionType+visibilityLevel) cross; out-of-scope rows do NOT [spec(§6)]", async () => {
    const links = new FakeLinkRepo().seed(link()); // scope = coordination/coordination, approved
    const gcl = new FakeGclRepo().seed(
      "ws-b",
      gclProj({ sanitizedPayload: { headline: "in scope" } }), // matches scope
      gclProj({ projectionType: "private-notes", sanitizedPayload: { headline: "wrong type" } }), // out of scope
      gclProj({ visibilityLevel: "isolated", sanitizedPayload: { headline: "wrong visibility" } }), // out of scope
    );
    const res = await resolveApprovedCrossWorkspaceSlice(
      { links, gclProjections: gcl, workspaceConfig: defaultWorkspaceConfig() },
      "ws-a",
    );
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.projections.length).toBe(1); // ONLY the in-scope row
      expect(res.value.projections[0]?.sanitizedPayload).toEqual({ headline: "in scope" });
      expect(res.value.visibilityExceededCount).toBe(0);
      expect(res.value.workspaceCeilingUnavailableCount).toBe(0);
    }
  });

  it("raw_content_shaped_row_fails_closed_even_under_approved_link: a B projection carrying a multi-line/raw value is withheld — the read fails CLOSED (never raw bytes cross), safety rule 4 [spec(§6)]", async () => {
    const links = new FakeLinkRepo().seed(link());
    // A poisoned projection (bypasses the write gate) whose payload carries verbatim raw content.
    const poisoned = gclProj({ sanitizedPayload: { body: "line one\nline two — a full transcript body that is NOT a sanitized single-line summary" } });
    const gcl = new FakeGclRepo().seed("ws-b", poisoned);
    const res = await resolveApprovedCrossWorkspaceSlice(
      { links, gclProjections: gcl, workspaceConfig: defaultWorkspaceConfig() },
      "ws-a",
    );
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
    const res = await resolveApprovedCrossWorkspaceSlice(
      { links, gclProjections: gcl, workspaceConfig: defaultWorkspaceConfig() },
      "ws-a",
    );
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.projections.length).toBe(1);
      expect(res.value.projections[0]?.sanitizedPayload).toEqual({ headline: "real B" });
    }
  });

  it("scopeless_link_crosses_nothing: a persisted approved link with a DEGENERATE (empty) scope crosses ZERO of B — never all-of-B (fail-closed widening guard, defense-in-depth) [spec(§6)]", async () => {
    const links = new FakeLinkRepo().seed(link({ scopeProjectionType: "" }));
    const gcl = new FakeGclRepo().seed("ws-b", gclProj(), gclProj({ projectionType: "other" }));
    const res = await resolveApprovedCrossWorkspaceSlice(
      { links, gclProjections: gcl, workspaceConfig: defaultWorkspaceConfig() },
      "ws-a",
    );
    expect(projectionsOf(res).length).toBe(0);
  });

  it("revoke_closes_the_path_immediately: approve→A sees the slice→revoke→A's cross-read returns EMPTY [spec(§5)]", async () => {
    const links = new FakeLinkRepo().seed(link({ status: "approved" }));
    const gcl = new FakeGclRepo().seed("ws-b", gclProj());
    const workspaceConfig = defaultWorkspaceConfig();
    const before = await resolveApprovedCrossWorkspaceSlice({ links, gclProjections: gcl, workspaceConfig }, "ws-a");
    expect(projectionsOf(before).length).toBe(1); // approved ⇒ visible
    await links.setStatus("link-1", "revoked", NOW); // owner revokes
    const after = await resolveApprovedCrossWorkspaceSlice({ links, gclProjections: gcl, workspaceConfig }, "ws-a");
    expect(projectionsOf(after).length).toBe(0); // revoked ⇒ path closed immediately
  });

  it("directional_A_to_B_does_not_let_B_read_A: an approved A→B link authorizes A reading B, NOT B reading A [spec(§5)]", async () => {
    const links = new FakeLinkRepo().seed(link()); // A(ws-a) → B(ws-b), approved
    const gcl = new FakeGclRepo().seed("ws-a", gclProj({ workspaceId: wsp("ws-a") })); // A has content
    // B reads: no approved link with from=ws-b exists ⇒ ZERO of A crosses to B.
    const res = await resolveApprovedCrossWorkspaceSlice(
      { links, gclProjections: gcl, workspaceConfig: new FakeWorkspaceConfigRepo().seed(workspace("ws-a", "coordination")) },
      "ws-b",
    );
    expect(projectionsOf(res).length).toBe(0);
  });

  it("store_fault_fails_closed: a link-list OR a gcl-list fault ⇒ typed store_fault (never a partial/leaky read, never throws) [spec(§16)]", async () => {
    const gcl = new FakeGclRepo().seed("ws-b", gclProj());
    const linkFault = new FakeLinkRepo().seed(link());
    linkFault.faultOnList = true;
    const r1 = await resolveApprovedCrossWorkspaceSlice(
      { links: linkFault, gclProjections: gcl, workspaceConfig: defaultWorkspaceConfig() },
      "ws-a",
    );
    expect(isErr(r1) && r1.error.code).toBe("store_fault");
    const gclFault = new FakeGclRepo().seed("ws-b", gclProj());
    gclFault.faultOnList = true;
    const r2 = await resolveApprovedCrossWorkspaceSlice(
      { links: new FakeLinkRepo().seed(link()), gclProjections: gclFault, workspaceConfig: defaultWorkspaceConfig() },
      "ws-a",
    );
    expect(isErr(r2) && r2.error.code).toBe("store_fault");
  });

  // ── 24.17 — the live §5 ceiling re-derivation ──────────────────────────────────────────────────

  it("tightening_the_source_workspace_default_stops_a_previously_crossing_row — THE LOAD-BEARING TEST: moves the GOVERNING STATE, not just the input [spec(§5), acceptance bullet 1]", async () => {
    const links = new FakeLinkRepo().seed(link()); // scope: coordination/coordination, approved
    const gcl = new FakeGclRepo().seed("ws-b", gclProj()); // a coordination-level projection
    const workspaceConfig = new FakeWorkspaceConfigRepo().seed(workspace("ws-b", "coordination"));

    // BEFORE: B's default permits "coordination" ⇒ the row crosses.
    const before = await resolveApprovedCrossWorkspaceSlice({ links, gclProjections: gcl, workspaceConfig }, "ws-a");
    expect(projectionsOf(before).length).toBe(1);

    // The owner tightens B's default visibility below the row's level — the SAME link, the SAME
    // projection; only the governing workspace state moves.
    workspaceConfig.seed(workspace("ws-b", "isolated"));

    const after = await resolveApprovedCrossWorkspaceSlice({ links, gclProjections: gcl, workspaceConfig }, "ws-a");
    expect(isOk(after)).toBe(true);
    if (isOk(after)) {
      expect(after.value.projections.length).toBe(0); // stopped crossing — the claim MOVED with the state
      expect(after.value.visibilityExceededCount).toBe(1); // withheld, not silently dropped
    }
  });

  it("a_row_within_the_tightened_ceiling_still_crosses — non-vacuity partner: both directions, or neither is a control [spec(§5), acceptance bullet 2]", async () => {
    const links = new FakeLinkRepo().seed(link({ scopeProjectionType: "coordination", scopeVisibilityLevel: "coordination" }));
    // B's default is tightened to "isolated" BEFORE the read — one row already exceeds it (frozen
    // scope says "coordination"), a SECOND row is genuinely within the tightened ceiling.
    const gcl = new FakeGclRepo().seed(
      "ws-b",
      gclProj({ sanitizedPayload: { headline: "exceeds the tightened ceiling" } }),
    );
    const workspaceConfig = new FakeWorkspaceConfigRepo().seed(workspace("ws-b", "isolated"));
    const res = await resolveApprovedCrossWorkspaceSlice({ links, gclProjections: gcl, workspaceConfig }, "ws-a");
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.projections.length).toBe(0);
      expect(res.value.visibilityExceededCount).toBe(1);
    }
    // The positive control, same fixture family: an "isolated"-level projection (both the link's own
    // scope AND the tightened workspace default permit "isolated") still crosses.
    const linksIsolated = new FakeLinkRepo().seed(link({ scopeVisibilityLevel: "isolated" }));
    const gclIsolated = new FakeGclRepo().seed("ws-b", gclProj({ visibilityLevel: "isolated" }));
    const res2 = await resolveApprovedCrossWorkspaceSlice(
      { links: linksIsolated, gclProjections: gclIsolated, workspaceConfig },
      "ws-a",
    );
    expect(isOk(res2)).toBe(true);
    if (isOk(res2)) {
      expect(res2.value.projections.length).toBe(1); // within ceiling ⇒ still crosses
      expect(res2.value.visibilityExceededCount).toBe(0);
    }
  });

  it("mutation_verify__reverting_to_the_frozen_scope_comparison_alone_would_hide_the_defect: the discriminating power of the load-bearing test, not merely its presence", async () => {
    // Simulates the PRE-24.17 defect directly (never touches production code): a check against ONLY
    // the link's frozen scopeVisibilityLevel, with no live-workspace re-derivation, is exactly what
    // shipped before this fix and exactly what the load-bearing test above must catch going forward.
    const l = link();
    const projection = gclProj();
    const frozenOnlyCheck = projection.visibilityLevel === l.scopeVisibilityLevel; // the old, sole gate
    expect(frozenOnlyCheck).toBe(true); // the OLD check does not move even though...
    const tightenedWorkspaceDefault: VisibilityLevel = "isolated";
    // ...the live ceiling this fix adds WOULD now reject it — proving the old check alone is blind to
    // exactly the state this task's acceptance criterion requires moving.
    const rankOf: Record<VisibilityLevel, number> = { isolated: 0, coordination: 1, sanitized: 2, full: 3 };
    const withinLiveCeiling = rankOf[projection.visibilityLevel] <= rankOf[tightenedWorkspaceDefault];
    expect(withinLiveCeiling).toBe(false); // the NEW gate (exercised via serveProjection above) catches it
  });

  // ── 24.17 — the workspace-ceiling-unavailable signal, distinct from a genuine empty result ──────

  it("a_workspace_lookup_fault_withholds_that_links_rows_and_is_counted__not_folded_into_zero_qualified [spec(§16), the ADD]", async () => {
    const links = new FakeLinkRepo().seed(link());
    const gcl = new FakeGclRepo().seed("ws-b", gclProj()); // B genuinely has a matching row
    const workspaceConfig = new FakeWorkspaceConfigRepo();
    workspaceConfig.faultOnGet = true; // the ceiling cannot be evaluated
    const res = await resolveApprovedCrossWorkspaceSlice({ links, gclProjections: gcl, workspaceConfig }, "ws-a");
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.projections.length).toBe(0);
      expect(res.value.workspaceCeilingUnavailableCount).toBe(1); // "could not evaluate", not "nothing qualified"
      expect(res.value.visibilityExceededCount).toBe(0);
    }
  });

  it("a_genuinely_empty_result_reads_differently_from_a_lookup_fault — the pair that makes the counter non-vacuous [spec(§16), the ADD]", async () => {
    // Same link, workspace resolves FINE, but B has no content at all — a genuine empty result, zero
    // signals raised. Paired with the fault test above: "I could not evaluate" vs "nothing qualified"
    // must be distinguishable, and this test proves the counter is silent when nothing went wrong.
    const links = new FakeLinkRepo().seed(link());
    const gcl = new FakeGclRepo(); // B has nothing seeded
    const res = await resolveApprovedCrossWorkspaceSlice(
      { links, gclProjections: gcl, workspaceConfig: defaultWorkspaceConfig() },
      "ws-a",
    );
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.projections.length).toBe(0);
      expect(res.value.workspaceCeilingUnavailableCount).toBe(0); // no fault occurred
      expect(res.value.visibilityExceededCount).toBe(0);
    }
  });

  it("a_returned_workspace_with_a_mismatched_id_is_treated_as_ceiling_unavailable — worker Lesson 55: verify the RETURNED id, never trust it unread", async () => {
    const links = new FakeLinkRepo().seed(link());
    const gcl = new FakeGclRepo().seed("ws-b", gclProj());
    // A repo bug/tamper: querying for "ws-b" returns a row claiming to be "ws-other".
    const workspaceConfig = new FakeWorkspaceConfigRepo().seed(workspace("ws-other", "coordination"));
    // Re-key the seeded row under "ws-b" so `.get("ws-b")` resolves it, while its OWN `.id` still says
    // "ws-other" — exactly the mismatch this pin exists to catch.
    workspaceConfig.rows.set("ws-b", workspace("ws-other", "coordination"));
    const res = await resolveApprovedCrossWorkspaceSlice({ links, gclProjections: gcl, workspaceConfig }, "ws-a");
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.projections.length).toBe(0);
      expect(res.value.workspaceCeilingUnavailableCount).toBe(1);
    }
  });

  it("the_links_own_scope_and_the_live_ceiling_are_INDEPENDENT_gates — a link-scope mismatch still excludes a row that is well within the live ceiling [spec(§6)]", async () => {
    // The workspace default is wide open ("full" — the top of the lattice), so the live ceiling alone
    // would admit anything; only the link's OWN frozen scope excludes this row. Proves the scope gate
    // was not silently replaced by the ceiling gate.
    const links = new FakeLinkRepo().seed(link({ scopeVisibilityLevel: "isolated" })); // link approved for "isolated" only
    const gcl = new FakeGclRepo().seed("ws-b", gclProj({ visibilityLevel: "coordination" })); // above the link's own grant
    const workspaceConfig = new FakeWorkspaceConfigRepo().seed(workspace("ws-b", "full")); // ceiling would allow it
    const res = await resolveApprovedCrossWorkspaceSlice({ links, gclProjections: gcl, workspaceConfig }, "ws-a");
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.projections.length).toBe(0); // the link's own scope still excludes it
      expect(res.value.visibilityExceededCount).toBe(0); // excluded by SCOPE, not by the ceiling gate
    }
  });

  // ── composed cases: one call, multiple links / multiple rows — a per-link or per-row `continue`
  // mistakenly written as a `break` would silently drop everything AFTER the first skip; these prove
  // it does not. Added per code-quality review of 24.17. ────────────────────────────────────────────

  it("a_ceiling_unavailable_link_does_not_block_a_LATER_approved_links_admissions — ONE call, two links", async () => {
    const links = new FakeLinkRepo().seed(
      link({ linkId: "l-b", toWorkspaceId: "ws-b" as CrossWorkspaceLinkRow["toWorkspaceId"] }),
      link({ linkId: "l-c", toWorkspaceId: "ws-c" as CrossWorkspaceLinkRow["toWorkspaceId"], scopeVisibilityLevel: "isolated" }),
    );
    const gcl = new FakeGclRepo()
      .seed("ws-b", gclProj({ workspaceId: wsp("ws-b") })) // would cross IF ws-b's ceiling resolved
      .seed("ws-c", gclProj({ workspaceId: wsp("ws-c"), visibilityLevel: "isolated" }));
    // "ws-b" is NEVER seeded in workspaceConfig ⇒ its link's ceiling lookup fails (not_found).
    // "ws-c" IS seeded ⇒ its link's ceiling resolves and its row is within scope + ceiling.
    const workspaceConfig = new FakeWorkspaceConfigRepo().seed(workspace("ws-c", "isolated"));
    const res = await resolveApprovedCrossWorkspaceSlice({ links, gclProjections: gcl, workspaceConfig }, "ws-a");
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      // The FIRST link's failure must not short-circuit the loop — the SECOND link's row still crosses.
      expect(res.value.projections.length).toBe(1);
      expect(res.value.projections[0]?.workspaceId).toBe(wsp("ws-c"));
      expect(res.value.workspaceCeilingUnavailableCount).toBe(1); // exactly the failed link, not both
    }
  });

  it("two_ceiling_exceeding_rows_in_one_link_are_BOTH_withheld_and_counted — proves the per-row skip is continue, not break", async () => {
    // Both rows share the link's scope-matching visibilityLevel (required to reach the ceiling check
    // at all — see the module header: scope requires EXACT equality, so every row reaching the ceiling
    // check within one link is ceiling-homogeneous). A `break` in place of `continue` would stop after
    // the first and undercount.
    const links = new FakeLinkRepo().seed(link()); // scope: coordination/coordination
    const gcl = new FakeGclRepo().seed(
      "ws-b",
      gclProj({ sanitizedPayload: { headline: "row one" } }),
      gclProj({ sanitizedPayload: { headline: "row two" } }),
    );
    const workspaceConfig = new FakeWorkspaceConfigRepo().seed(workspace("ws-b", "isolated")); // below "coordination"
    const res = await resolveApprovedCrossWorkspaceSlice({ links, gclProjections: gcl, workspaceConfig }, "ws-a");
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.projections.length).toBe(0);
      expect(res.value.visibilityExceededCount).toBe(2); // BOTH counted — a `break` would report 1
    }
  });
});
