// spec(§6) — GCL projection persistence + serve, both gated by the Visibility
// Gate. GCL DB is the queryable master (persist via the repository INTERFACE, no
// concrete driver); a raw / over-visibility candidate is HARD-rejected and NEVER
// upserted; a tampered stored row is re-gated on serve (defense in depth).
import { describe, it, expect } from "vitest";
import { ok, err, defaultWorkspace } from "@sow/contracts";
import type { GclProjection, Workspace } from "@sow/contracts";
import type { DbError, DbResult } from "@sow/db";
import type { ProjectionTypeVisibilityTaxonomy, AuditSignal } from "@sow/policy";
import { buildAuditSignal } from "@sow/policy";
import {
  admitAndPersistProjection,
  serveProjection,
  persistDenialAudit,
  type GclAuditPersistPort,
} from "../src/gcl/projection";

// ── in-memory GclAuditPersistPort fake (task 24.33 — spy, records every call) ──
class FakeAuditPersistPort implements GclAuditPersistPort {
  readonly calls: { signal: AuditSignal; workspaceId: string }[] = [];
  async persistDenial(signal: AuditSignal, workspaceId: string): Promise<void> {
    this.calls.push({ signal, workspaceId });
  }
}

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

  // task 24.33 — MOVE THE STATE (24.7's precedent): drive a real denial through the real
  // admitProjection → admitAndPersistProjection chain, faking only the repository seam (as
  // this suite already does) + the injected auditPersist port, and assert a durable record
  // lands. A construction-side test can't distinguish "built and dropped" from a fix.
  it("gcl_denial_lands_a_durable_audit_record_end_to_end: a real denial through admitAndPersistProjection calls the injected persist port with the signal + workspaceId", async () => {
    const repo = new FakeGclProjectionRepo();
    const auditPersist = new FakeAuditPersistPort();
    const workspace = ws("isolated");
    const r = await admitAndPersistProjection(validCandidate, workspace, repo, undefined, undefined, auditPersist);
    expect(r.ok).toBe(false);
    expect(auditPersist.calls).toHaveLength(1);
    expect(auditPersist.calls[0]?.workspaceId).toBe(workspace.id);
    expect(auditPersist.calls[0]?.signal.denialCode).toBe("VISIBILITY_EXCEEDS_SOURCE");
  });

  // task 24.33 / contracts L86 — a channel that fires on every path carries no information; the ALLOW
  // path must persist nothing for the deny channel to mean anything.
  it("allow_path_persists_nothing: a clean admission calls the injected persist port zero times", async () => {
    const repo = new FakeGclProjectionRepo();
    const auditPersist = new FakeAuditPersistPort();
    const r = await admitAndPersistProjection(validCandidate, ws("sanitized"), repo, undefined, undefined, auditPersist);
    expect(r.ok).toBe(true);
    expect(auditPersist.calls).toHaveLength(0);
  });

  it("with no auditPersist port injected, a denial still resolves normally (port is optional, byte-equivalent when absent)", async () => {
    const repo = new FakeGclProjectionRepo();
    const r = await admitAndPersistProjection(validCandidate, ws("isolated"), repo);
    expect(r.ok).toBe(false);
  });

  // task 24.33 (code-quality review) — a schema/raw-content denial has no PolicyDecision behind
  // it (auditOf returns undefined for these two variants), so the injected port must never be
  // called for them either, not just for the ALLOW path.
  it("a raw-content denial (no PolicyDecision, no AuditSignal to persist) calls the injected persist port zero times", async () => {
    const repo = new FakeGclProjectionRepo();
    const auditPersist = new FakeAuditPersistPort();
    const rawBearing = { ...validCandidate, sanitizedPayload: { content: "raw text" } };
    const r = await admitAndPersistProjection(rawBearing, ws("full"), repo, undefined, undefined, auditPersist);
    expect(r.ok).toBe(false);
    expect(auditPersist.calls).toHaveLength(0);
  });
});

// task 24.33 — the redaction-safety gate lives HERE (packages/knowledge), not inside the
// injected port, because the real port binding is deferred to Phase 25.2/25.4 and the safety
// property must hold regardless of what that future adapter does. Every real GCL-produced
// AuditSignal is safe by construction (policy-authored refs/codes only — mirrors
// isRedactionSafe's own documented invariant), so the refusal case is pinned directly against
// a hand-built unsafe signal, the same convention this file's sibling (denialToGateError)
// already uses for cases the real chain can't produce.
describe("persistDenialAudit — the fail-closed redaction-safety gate before any persist (task 24.33)", () => {
  const safeSignal = buildAuditSignal({
    actor: "policy",
    event: "gcl.denied",
    refs: ["ref:workspace:ws-001"],
    payloadHash: "sha256:cafe",
    beforeSummary: "not evaluated",
    afterSummary: "denied",
  });

  it("persists a redaction-safe signal", async () => {
    const auditPersist = new FakeAuditPersistPort();
    await persistDenialAudit(safeSignal, "ws-001", auditPersist);
    expect(auditPersist.calls).toHaveLength(1);
  });

  it("redaction_unsafe_signal_is_refused_not_persisted: a credential-shaped signal is refused, never persisted", async () => {
    const leaky = buildAuditSignal({
      actor: "policy",
      event: "gcl.denied",
      refs: ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH"],
      payloadHash: "sha256:cafe",
      beforeSummary: "not evaluated",
      afterSummary: "denied",
    });
    const auditPersist = new FakeAuditPersistPort();
    await persistDenialAudit(leaky, "ws-001", auditPersist);
    expect(auditPersist.calls).toHaveLength(0);
  });

  it("a missing signal (allow path) or a missing port is a no-op, never throws", async () => {
    const auditPersist = new FakeAuditPersistPort();
    await expect(persistDenialAudit(undefined, "ws-001", auditPersist)).resolves.toBeUndefined();
    expect(auditPersist.calls).toHaveLength(0);
    await expect(persistDenialAudit(safeSignal, "ws-001", undefined)).resolves.toBeUndefined();
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

  // task 24.18 (WS-1/F14), corrected 2026-08-12 (24.33's own finding, session 155): worker's
  // `crossWorkspaceRead.ts`'s `resolveApprovedCrossWorkspaceSlice` calls `serveProjection` — a
  // real call site (`crossWorkspaceRead.ts:139`), accurate at the source level — but that
  // function itself has ZERO production callers today; every real caller is in a test file.
  // The projectionType derivation must still be reachable HERE, not only through
  // `admitProjection` in isolation, so it is already correct the moment that chain is wired
  // (Phase 25.2/25.4) — not because it runs today.
  it("refuses a re-served stored row whose visibility level is inconsistent with its projectionType under an injected taxonomy (task 24.18)", () => {
    const taxonomy: ProjectionTypeVisibilityTaxonomy = { calendar_busy: ["isolated"] };
    const r = serveProjection(validCandidate, ws("full"), undefined, taxonomy);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("visibility_type_mismatch");
  });
});
