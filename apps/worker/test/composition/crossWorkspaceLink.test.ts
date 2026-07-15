// Task 14.7 — the cross-workspace-LINK owner-approval flow composition (worker leg). RED-first.
//
// SAFETY-CRITICAL (safety rule 4 / WS-8: the cross-workspace link is the SINGLE sanctioned
// cross-workspace read input; §5 isolation root). `createCrossWorkspaceLink` mints a PENDING
// link only between two 14.1-registered workspaces, rejects a self-link, and treats the
// (from,to,scope) authorization tuple as the IMMUTABLE isolation anchor (worker Lesson 30) — a
// re-create that changes it is rejected, never a silent rebind across the boundary. approve/revoke
// drive the status machine (a link owns its own `status` — NOT an Approval.subjectKind, so the
// frozen Appendix-A Approval enum is untouched). Owner-approved links ONLY (Level-3 / REQ-F-020).
//
// Unit-tested over a fake link repo + a fake 14.1 workspace registry.
import { describe, it, expect } from "vitest";
import { ok, err, isErr, isOk, type Result } from "@sow/contracts";
import type {
  CrossWorkspaceLinkRow,
  CrossWorkspaceLinkStatus,
  CrossWorkspaceLinkRepository,
  DbError,
  ReadModelRecord,
  ReadModelRepository,
} from "@sow/db";
import { READ_MODEL_KEYS } from "../../src/api/adapters/readModel";
import {
  createCrossWorkspaceLink,
  approveCrossWorkspaceLink,
  revokeCrossWorkspaceLink,
  type CreateCrossWorkspaceLinkInput,
} from "../../src/composition/crossWorkspaceLink";

const NOW = "2026-07-15T00:00:00.000Z";
const ws = (s: string): CrossWorkspaceLinkRow["fromWorkspaceId"] => s as CrossWorkspaceLinkRow["fromWorkspaceId"];

function createInput(over: Partial<CreateCrossWorkspaceLinkInput> = {}): CreateCrossWorkspaceLinkInput {
  return {
    linkId: "link-1",
    fromWorkspaceId: "ws-a", // the READER (A)
    toWorkspaceId: "ws-b", // the SOURCE (B)
    scopeProjectionType: "coordination",
    scopeVisibilityLevel: "coordination",
    ...over,
  };
}

class FakeLinkRepo implements CrossWorkspaceLinkRepository {
  rows = new Map<string, CrossWorkspaceLinkRow>();
  createCalls = 0;
  setStatusCalls = 0;
  faultOn: "get" | "create" | "setStatus" | "list" | null = null;
  seed(...rs: CrossWorkspaceLinkRow[]): this {
    for (const r of rs) this.rows.set(r.linkId, r);
    return this;
  }
  async create(row: CrossWorkspaceLinkRow): Promise<Result<CrossWorkspaceLinkRow, DbError>> {
    this.createCalls += 1;
    if (this.faultOn === "create") return err({ code: "unavailable", message: "x" });
    if (this.rows.has(row.linkId)) return err({ code: "conflict", message: "x" });
    this.rows.set(row.linkId, row);
    return ok(row);
  }
  async get(linkId: string): Promise<Result<CrossWorkspaceLinkRow, DbError>> {
    if (this.faultOn === "get") return err({ code: "unavailable", message: "x" });
    const r = this.rows.get(linkId);
    return r ? ok(r) : err({ code: "not_found", message: "x" });
  }
  async listApprovedForReader(fromWorkspaceId: CrossWorkspaceLinkRow["fromWorkspaceId"]): Promise<Result<CrossWorkspaceLinkRow[], DbError>> {
    if (this.faultOn === "list") return err({ code: "unavailable", message: "x" });
    return ok([...this.rows.values()].filter((r) => r.fromWorkspaceId === fromWorkspaceId && r.status === "approved"));
  }
  async setStatus(linkId: string, status: CrossWorkspaceLinkStatus, at: string): Promise<Result<CrossWorkspaceLinkRow, DbError>> {
    this.setStatusCalls += 1;
    if (this.faultOn === "setStatus") return err({ code: "unavailable", message: "x" });
    const r = this.rows.get(linkId);
    if (!r) return err({ code: "not_found", message: "x" });
    const next: CrossWorkspaceLinkRow = {
      ...r,
      status,
      approvedAt: status === "approved" ? at : r.approvedAt,
      revokedAt: status === "revoked" ? at : r.revokedAt,
    };
    this.rows.set(linkId, next);
    return ok(next);
  }
}

function fakeReadModels(opts: { registered?: readonly string[]; faultOnRegistry?: boolean } = {}): ReadModelRepository {
  return {
    async get(key: string): Promise<Result<ReadModelRecord, DbError>> {
      if (key === READ_MODEL_KEYS.registry) {
        if (opts.faultOnRegistry) return err({ code: "unavailable", message: "x" });
        return ok({ readModelKey: key, data: { workspaceIds: opts.registered ?? [] }, rebuiltAt: NOW } as ReadModelRecord);
      }
      return err({ code: "not_found", message: "x" });
    },
    async put(r: ReadModelRecord): Promise<Result<ReadModelRecord, DbError>> {
      return ok(r);
    },
    async clear(): Promise<Result<void, DbError>> {
      return ok(undefined);
    },
  };
}

const bothRegistered = () => fakeReadModels({ registered: ["ws-a", "ws-b"] });
const deps = (repo: FakeLinkRepo, readModels: ReadModelRepository) => ({ repo, readModels, now: () => NOW });

describe("createCrossWorkspaceLink (14.7 — owner-approval flow, safety rule 4)", () => {
  it("create_mints_pending_link_between_two_registered_workspaces: a fresh link lands PENDING (never pre-approved), with the directional (from=reader,to=source) pair + scope [spec(§5)]", async () => {
    const repo = new FakeLinkRepo();
    const res = await createCrossWorkspaceLink(deps(repo, bothRegistered()), createInput());
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value.linkId).toBe("link-1");
      expect(res.value.fromWorkspaceId).toBe("ws-a");
      expect(res.value.toWorkspaceId).toBe("ws-b");
      expect(res.value.scopeProjectionType).toBe("coordination");
      expect(res.value.scopeVisibilityLevel).toBe("coordination");
      expect(res.value.status).toBe("pending"); // NEVER pre-approved — owner approval is explicit
      expect(res.value.createdAt).toBe(NOW);
      expect(res.value.approvedAt).toBeNull();
      expect(res.value.revokedAt).toBeNull();
    }
  });

  it("create_rejects_unregistered_workspace: either endpoint ABSENT from the 14.1 registry ⇒ workspace_unknown, NO create (fail-closed, both directions) [spec(§5)]", async () => {
    const onlyA = fakeReadModels({ registered: ["ws-a"] });
    const onlyB = fakeReadModels({ registered: ["ws-b"] });
    const r1 = await createCrossWorkspaceLink(deps(new FakeLinkRepo(), onlyA), createInput()); // to=ws-b unknown
    const r2 = await createCrossWorkspaceLink(deps(new FakeLinkRepo(), onlyB), createInput()); // from=ws-a unknown
    expect(isErr(r1) && r1.error.code).toBe("workspace_unknown");
    expect(isErr(r2) && r2.error.code).toBe("workspace_unknown");
  });

  it("create_rejects_self_link: from === to ⇒ cross_workspace_link_self (a self-link is not a cross-workspace read; never persisted) [spec(§5)]", async () => {
    const repo = new FakeLinkRepo();
    const res = await createCrossWorkspaceLink(deps(repo, fakeReadModels({ registered: ["ws-a"] })), createInput({ fromWorkspaceId: "ws-a", toWorkspaceId: "ws-a" }));
    expect(isErr(res) && res.error.code).toBe("cross_workspace_link_self");
    expect(repo.createCalls).toBe(0);
  });

  it("recreate_changing_the_pair_or_scope_is_immutable: existing linkId + changed from/to/scope ⇒ cross_workspace_link_immutable; anchor preserved; identical re-create is idempotent (status preserved) [spec(§5)]", async () => {
    const repo = new FakeLinkRepo();
    const rm = fakeReadModels({ registered: ["ws-a", "ws-b", "ws-c"] });
    expect(isOk(await createCrossWorkspaceLink(deps(repo, rm), createInput()))).toBe(true);
    // approve it so we can prove an idempotent re-create does NOT reset an approved link.
    await approveCrossWorkspaceLink({ repo, now: () => NOW }, "link-1");
    // changed TARGET (isolation-boundary rebind) ⇒ immutable.
    const rebindTo = await createCrossWorkspaceLink(deps(repo, rm), createInput({ toWorkspaceId: "ws-c" }));
    expect(isErr(rebindTo) && rebindTo.error.code).toBe("cross_workspace_link_immutable");
    // changed SCOPE (silent widening) ⇒ immutable.
    const rescope = await createCrossWorkspaceLink(deps(repo, rm), createInput({ scopeProjectionType: "full-brief" }));
    expect(isErr(rescope) && rescope.error.code).toBe("cross_workspace_link_immutable");
    // anchor + approved status preserved throughout.
    const got = await repo.get("link-1");
    expect(isOk(got) && got.value.toWorkspaceId).toBe("ws-b");
    expect(isOk(got) && got.value.status).toBe("approved");
    // identical re-create ⇒ idempotent OK, status NOT reset to pending.
    const same = await createCrossWorkspaceLink(deps(repo, rm), createInput());
    expect(isOk(same) && same.value.status).toBe("approved");
  });

  it("create_rejects_scopeless_link: an empty scopeProjectionType OR a non-enum scopeVisibilityLevel ⇒ cross_workspace_link_invalid_scope — a scopeless link (which would read-match ALL of B) is UNREPRESENTABLE via the sanctioned path (fail-closed widening guard) [spec(§5)]", async () => {
    const repo = new FakeLinkRepo();
    const rm = bothRegistered();
    const emptyType = await createCrossWorkspaceLink(deps(repo, rm), createInput({ scopeProjectionType: "" }));
    expect(isErr(emptyType) && emptyType.error.code).toBe("cross_workspace_link_invalid_scope");
    const badVis = await createCrossWorkspaceLink(deps(repo, rm), createInput({ scopeVisibilityLevel: "not-a-level" as never }));
    expect(isErr(badVis) && badVis.error.code).toBe("cross_workspace_link_invalid_scope");
    expect(repo.createCalls).toBe(0);
  });

  it("create_registry_fault_and_get_fault_fail_closed: a WS-8 registry read fault OR the pre-create get fault ⇒ store_fault, NO create [spec(§16)]", async () => {
    const r1 = await createCrossWorkspaceLink(deps(new FakeLinkRepo(), fakeReadModels({ faultOnRegistry: true })), createInput());
    expect(isErr(r1) && r1.error.code).toBe("store_fault");
    const repo = new FakeLinkRepo();
    repo.faultOn = "get";
    const r2 = await createCrossWorkspaceLink(deps(repo, bothRegistered()), createInput());
    expect(isErr(r2) && r2.error.code).toBe("store_fault");
    expect(repo.createCalls).toBe(0);
  });
});

describe("approveCrossWorkspaceLink / revokeCrossWorkspaceLink (14.7 — the status machine)", () => {
  it("approve_moves_pending_to_approved_stamping_approvedAt: only a PENDING link approves [spec(§5)]", async () => {
    const repo = new FakeLinkRepo();
    await createCrossWorkspaceLink(deps(repo, bothRegistered()), createInput());
    const res = await approveCrossWorkspaceLink({ repo, now: () => NOW }, "link-1");
    expect(isOk(res) && res.value.status).toBe("approved");
    expect(isOk(res) && res.value.approvedAt).toBe(NOW);
  });

  it("approve_on_non_pending_is_rejected: approving an already-approved OR a revoked link ⇒ link_not_pending (a revoked link can NEVER be re-approved back into the cross-read path) [spec(§5)]", async () => {
    const repo = new FakeLinkRepo();
    await createCrossWorkspaceLink(deps(repo, bothRegistered()), createInput());
    await approveCrossWorkspaceLink({ repo, now: () => NOW }, "link-1");
    expect(isErr(await approveCrossWorkspaceLink({ repo, now: () => NOW }, "link-1")) && true).toBe(true);
    const reAppr = await approveCrossWorkspaceLink({ repo, now: () => NOW }, "link-1");
    expect(isErr(reAppr) && reAppr.error.code).toBe("link_not_pending");
    await revokeCrossWorkspaceLink({ repo, now: () => NOW }, "link-1");
    const reviveRevoked = await approveCrossWorkspaceLink({ repo, now: () => NOW }, "link-1");
    expect(isErr(reviveRevoked) && reviveRevoked.error.code).toBe("link_not_pending");
  });

  it("revoke_moves_to_revoked_stamping_revokedAt_and_is_idempotent: revoke from pending OR approved ⇒ revoked; re-revoke is an idempotent no-op [spec(§5)]", async () => {
    const repo = new FakeLinkRepo();
    await createCrossWorkspaceLink(deps(repo, bothRegistered()), createInput());
    await approveCrossWorkspaceLink({ repo, now: () => NOW }, "link-1");
    const res = await revokeCrossWorkspaceLink({ repo, now: () => NOW }, "link-1");
    expect(isOk(res) && res.value.status).toBe("revoked");
    expect(isOk(res) && res.value.revokedAt).toBe(NOW);
    const again = await revokeCrossWorkspaceLink({ repo, now: () => "2027-01-01T00:00:00.000Z" }, "link-1");
    expect(isOk(again) && again.value.status).toBe("revoked");
    expect(isOk(again) && again.value.revokedAt).toBe(NOW); // idempotent — original stamp preserved
  });

  it("approve_or_revoke_unknown_link_is_link_unknown: a missing link ⇒ link_unknown (fail-closed, never throws) [spec(§16)]", async () => {
    const repo = new FakeLinkRepo();
    expect(isErr(await approveCrossWorkspaceLink({ repo, now: () => NOW }, "nope")) && (await approveCrossWorkspaceLink({ repo, now: () => NOW }, "nope") as { error: { code: string } }).error.code).toBe("link_unknown");
    expect(isErr(await revokeCrossWorkspaceLink({ repo, now: () => NOW }, "nope")) && (await revokeCrossWorkspaceLink({ repo, now: () => NOW }, "nope") as { error: { code: string } }).error.code).toBe("link_unknown");
  });
});
