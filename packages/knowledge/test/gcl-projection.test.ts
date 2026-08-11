// spec(§6) — GCL projection persistence + serve, both gated by the Visibility
// Gate. GCL DB is the queryable master (persist via the repository INTERFACE, no
// concrete driver); a raw / over-visibility candidate is HARD-rejected and NEVER
// upserted; a tampered stored row is re-gated on serve (defense in depth).
import { describe, it, expect } from "vitest";
import { ok, err, defaultWorkspace } from "@sow/contracts";
import type { GclProjection, Workspace } from "@sow/contracts";
import type { DbError, DbResult } from "@sow/db";
import type { ProjectionTypeVisibilityTaxonomy } from "@sow/policy";
import { admitAndPersistProjection, serveProjection } from "../src/gcl/projection";

// ── in-memory GclProjectionRepository fake (interface-only; no concrete driver) ──
class FakeGclProjectionRepo {
  readonly rows: GclProjection[] = [];
  upsertCalls = 0;
  failNext: DbError | undefined;

  async get(): DbResult<GclProjection> {
    return err({ code: "not_found", message: "n/a" });
  }
  async upsert(projection: GclProjection): DbResult<GclProjection> {
    this.upsertCalls += 1;
    if (this.failNext) {
      const e = this.failNext;
      this.failNext = undefined;
      return err(e);
    }
    this.rows.push(projection);
    return ok(projection);
  }
  async listByWorkspace(): DbResult<GclProjection[]> {
    return ok(this.rows);
  }
  async listByVisibility(): DbResult<GclProjection[]> {
    return ok(this.rows);
  }
}

function ws(level: Workspace["defaultVisibility"]): Workspace {
  return defaultWorkspace({
    id: "ws-001",
    name: "Acme",
    type: "personal_business",
    markdownRepoPath: "/vault/acme",
    gbrainBrainId: "brain-acme",
    defaultVisibility: level,
  });
}

const validCandidate: GclProjection = {
  workspaceId: "ws-001" as GclProjection["workspaceId"],
  visibilityLevel: "coordination",
  projectionType: "calendar_busy",
  sanitizedPayload: { busySlots: 3 },
  sourceRefs: [{ sourceId: "src-001" as GclProjection["sourceRefs"][number]["sourceId"] }],
};

describe("admitAndPersistProjection", () => {
  it("gates then upserts a clean projection through the repository interface", async () => {
    const repo = new FakeGclProjectionRepo();
    const r = await admitAndPersistProjection(validCandidate, ws("sanitized"), repo);
    expect(r.ok).toBe(true);
    expect(repo.upsertCalls).toBe(1);
    expect(repo.rows).toEqual([validCandidate]);
  });

  it("HARD-rejects a raw-content-bearing candidate and NEVER calls upsert", async () => {
    const repo = new FakeGclProjectionRepo();
    const rawBearing = { ...validCandidate, sanitizedPayload: { content: "raw text" } };
    const r = await admitAndPersistProjection(rawBearing, ws("full"), repo);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("rejected");
      if (r.error.code === "rejected") expect(r.error.reason.code).toBe("raw_content_present");
    }
    expect(repo.upsertCalls).toBe(0);
    expect(repo.rows).toEqual([]);
  });

  it("HARD-rejects an over-visibility candidate and NEVER calls upsert (no downgrade-and-store)", async () => {
    const repo = new FakeGclProjectionRepo();
    const r = await admitAndPersistProjection(validCandidate, ws("isolated"), repo);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === "rejected") {
      expect(r.error.reason.code).toBe("visibility_exceeds_source");
    }
    expect(repo.upsertCalls).toBe(0);
  });

  // task 24.18 (WS-1/F14): the projectionType-derivation taxonomy threads through
  // to this real entry point too (not only `admitProjection` directly) — an
  // injected taxonomy activates the same way through the persist path.
  it("HARD-rejects (and never upserts) a projectionType/visibilityLevel mismatch when an injected taxonomy is in effect (task 24.18)", async () => {
    const repo = new FakeGclProjectionRepo();
    const taxonomy: ProjectionTypeVisibilityTaxonomy = { calendar_busy: ["isolated"] };
    const r = await admitAndPersistProjection(validCandidate, ws("full"), repo, undefined, taxonomy);
    expect(r.ok).toBe(false);
    if (!r.ok && r.error.code === "rejected") {
      expect(r.error.reason.code).toBe("visibility_type_mismatch");
    }
    expect(repo.upsertCalls).toBe(0);
  });

  it("surfaces a repository write failure as a typed persist error (never throws)", async () => {
    const repo = new FakeGclProjectionRepo();
    repo.failNext = { code: "unavailable", message: "db down" };
    const r = await admitAndPersistProjection(validCandidate, ws("sanitized"), repo);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("persist_failed");
      if (r.error.code === "persist_failed") expect(r.error.dbError.code).toBe("unavailable");
    }
  });
});

describe("serveProjection — re-gate a stored row before it crosses a workspace boundary", () => {
  it("serves a clean stored row unchanged", () => {
    const r = serveProjection(validCandidate, ws("sanitized"));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual(validCandidate);
  });

  it("refuses a tampered stored row that now carries raw content", () => {
    const tampered = { ...validCandidate, sanitizedPayload: { body: "leaked raw" } } as GclProjection;
    const r = serveProjection(tampered, ws("full"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("raw_content_present");
  });

  it("refuses a stored row whose visibility now exceeds the source default", () => {
    const r = serveProjection(validCandidate, ws("isolated"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("visibility_exceeds_source");
  });

  // task 24.18 (WS-1/F14): `serveProjection` is the LIVE cross-workspace read gate
  // (`apps/worker/src/composition/crossWorkspaceRead.ts` calls it, per task
  // 24.17) — the projectionType derivation must be reachable HERE, not only
  // through `admitProjection` in isolation, for "wired to fire" to be true of
  // the path that actually runs today.
  it("refuses a re-served stored row whose visibility level is inconsistent with its projectionType under an injected taxonomy (task 24.18)", () => {
    const taxonomy: ProjectionTypeVisibilityTaxonomy = { calendar_busy: ["isolated"] };
    const r = serveProjection(validCandidate, ws("full"), undefined, taxonomy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("visibility_type_mismatch");
  });
});
