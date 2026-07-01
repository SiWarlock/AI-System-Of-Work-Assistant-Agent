// spec(§6) — RemediationRouter (task 4.18): route a quarantined divergence to a
// terminal remediation directive. db_only (no Markdown counterpart) → materialize-
// via-plan (re-validated through the FULL pipeline) OR purge via a DELETE/PURGE-ONLY
// token that can NEVER write; content_mismatch/stale/md_only → resync-FROM-Markdown
// ONLY (Markdown wins; DB body NEVER materialized); unstamped/ambiguous → owner
// review (auto-purge requires POSITIVE proof of non-derivability, not merely an
// absent stamp). Pure/deterministic, typed Result — never throws across the boundary.
import { describe, it, expect } from "vitest";
import { isOk, isErr, DivergenceSchema } from "@sow/contracts";
import type { Divergence, DivergenceClass } from "@sow/contracts";
import {
  routeRemediation,
  type RemediationRequest,
  type RemediationDecision,
  type PurgeOnlyToken,
  type NonDerivabilityProof,
} from "../src/gbrain/remediation/router";

const WS = "ws-employer";
const SHA = "0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d";

function divergence(over: Partial<Record<string, unknown>> & { divergenceClass: DivergenceClass }): Divergence {
  const cls = over.divergenceClass;
  const hard = cls === "db_only" || cls === "unstamped";
  const draft = {
    factIdentity: over.factIdentity ?? "page:orphan",
    divergenceClass: cls,
    severityFloor: over.severityFloor ?? (hard ? "hard" : "soft"),
    remediation: over.remediation ?? (cls === "md_only" || cls === "content_mismatch" || cls === "stale_revision" || cls === "edge_md_only" ? "resync" : "review"),
    ...(over.mdContentSha ? { mdContentSha: over.mdContentSha } : {}),
    ...(over.dbContentHash ? { dbContentHash: over.dbContentHash } : {}),
  };
  return DivergenceSchema.parse(draft);
}

const positiveProof: NonDerivabilityProof = {
  reportRef: "report-1",
  derivedAbsent: true,
  attestedBy: "reconciler",
};

function validMaterializePlan(over: Record<string, unknown> = {}): unknown {
  return {
    planId: "plan-1",
    workspaceId: WS,
    sourceRefs: [{ sourceId: "src-1", span: "L1" }],
    creates: [{ path: "notes/x.md", body: "re-canonicalized body" }],
    patches: [],
    linkMutations: [],
    frontmatterUpdates: [],
    externalActionProposals: [],
    confidence: 0.9,
    requiresApproval: true,
    provenanceOrigin: "parity_remediation",
    ...over,
  };
}

function req(divClass: DivergenceClass, decision: RemediationDecision, over: Partial<RemediationRequest> = {}): RemediationRequest {
  return {
    divergence: over.divergence ?? divergence({ divergenceClass: divClass }),
    workspaceId: over.workspaceId ?? WS,
    decision,
  };
}

describe("RemediationRouter — db_only fork (materialize | purge | review)", () => {
  it("materialize: re-validates the plan through the full pipeline → routes a KnowledgeMutationPlan to KnowledgeWriter", () => {
    const r = routeRemediation(req("db_only", { action: "materialize", plan: validMaterializePlan() }));
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(r.value.kind).toBe("materialize");
    if (r.value.kind !== "materialize") return;
    expect(r.value.plan.provenanceOrigin).toBe("parity_remediation");
    expect(r.value.plan.workspaceId as string).toBe(WS);
  });

  it("materialize: a plan that is NOT provenanceOrigin='parity_remediation' is rejected (no laundering as human/ingestion)", () => {
    const r = routeRemediation(
      req("db_only", { action: "materialize", plan: validMaterializePlan({ provenanceOrigin: "human" }) }),
    );
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("plan_wrong_origin");
  });

  it("materialize: a schema-invalid plan (empty sourceRefs — REQ-F-006) is rejected through the gate, never written", () => {
    const r = routeRemediation(
      req("db_only", { action: "materialize", plan: validMaterializePlan({ sourceRefs: [] }) }),
    );
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("plan_invalid");
  });

  it("materialize: a plan for a DIFFERENT workspace is rejected (workspace isolation)", () => {
    const r = routeRemediation(
      req("db_only", { action: "materialize", plan: validMaterializePlan({ workspaceId: "ws-personal" }) }),
    );
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("workspace_mismatch");
  });

  it("purge: positive non-derivability proof mints a purge-ONLY token", () => {
    const r = routeRemediation(req("db_only", { action: "purge", proof: positiveProof }));
    expect(isOk(r)).toBe(true);
    if (!isOk(r) || r.value.kind !== "purge") return;
    const token: PurgeOnlyToken = r.value.token;
    expect(token.capability).toBe("purge_only");
    expect(token.op).toBe("purge");
    expect(token.workspaceId).toBe(WS);
    expect(token.factIdentity).toBe("page:orphan");
    expect(token.nonDerivabilityProofRef).toBe("report-1");
  });

  it("purge token is STRUCTURALLY incapable of a write — it carries only purge fields, no put/create/link key", () => {
    const r = routeRemediation(req("db_only", { action: "purge", proof: positiveProof }));
    if (!isOk(r) || r.value.kind !== "purge") throw new Error("expected purge");
    const keys = Object.keys(r.value.token).sort();
    expect(keys).toEqual(
      ["capability", "factIdentity", "nonDerivabilityProofRef", "op", "reason", "workspaceId"].sort(),
    );
    // No write-capable surface leaked onto the token.
    for (const k of keys) {
      expect(["put", "create", "add_link", "write", "patch"]).not.toContain(k);
    }
  });

  it("purge WITHOUT positive proof (derivedAbsent=false) is rejected — auto-purge needs positive proof, not absence", () => {
    const r = routeRemediation(
      req("db_only", { action: "purge", proof: { ...positiveProof, derivedAbsent: false } }),
    );
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("purge_requires_positive_proof");
  });

  it("defer: routes to owner review", () => {
    const r = routeRemediation(req("db_only", { action: "defer" }));
    expect(isOk(r)).toBe(true);
    if (!isOk(r) || r.value.kind !== "review") return;
    expect(r.value.factIdentity).toBe("page:orphan");
  });
});

describe("RemediationRouter — content_mismatch/stale/md_only: resync-FROM-Markdown ONLY", () => {
  it("content_mismatch → resync (Markdown wins), never materialize the DB body", () => {
    const d = divergence({ divergenceClass: "content_mismatch", factIdentity: "page:p", mdContentSha: SHA });
    const r = routeRemediation(req("content_mismatch", { action: "defer" }, { divergence: d }));
    expect(isOk(r)).toBe(true);
    if (!isOk(r) || r.value.kind !== "resync") return;
    expect(r.value.factIdentity).toBe("page:p");
    expect(r.value.mdContentSha).toBe(SHA);
  });

  it("content_mismatch + a materialize decision is REJECTED — DB body is NEVER materialized", () => {
    const d = divergence({ divergenceClass: "content_mismatch", factIdentity: "page:p", mdContentSha: SHA });
    const r = routeRemediation(
      req("content_mismatch", { action: "materialize", plan: validMaterializePlan() }, { divergence: d }),
    );
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("illegal_materialize_content_mismatch");
  });

  it("stale_revision and md_only also resync (benign, index behind)", () => {
    for (const cls of ["stale_revision", "md_only", "edge_md_only"] as const) {
      const d = divergence({ divergenceClass: cls, mdContentSha: SHA });
      const r = routeRemediation(req(cls, { action: "defer" }, { divergence: d }));
      expect(isOk(r)).toBe(true);
      if (isOk(r)) expect(r.value.kind).toBe("resync");
    }
  });
});

describe("RemediationRouter — unstamped: never auto-purge on merely-absent-stamp", () => {
  it("unstamped → owner review (present in both sides = derivable; absent stamp is not proof)", () => {
    const d = divergence({ divergenceClass: "unstamped", factIdentity: "page:p", mdContentSha: SHA });
    const r = routeRemediation(req("unstamped", { action: "defer" }, { divergence: d }));
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.kind).toBe("review");
  });

  it("unstamped + purge is REJECTED even with a 'proof' — an absent stamp can never justify auto-purge", () => {
    const d = divergence({ divergenceClass: "unstamped", factIdentity: "page:p", mdContentSha: SHA });
    const r = routeRemediation(req("unstamped", { action: "purge", proof: positiveProof }, { divergence: d }));
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("purge_requires_positive_proof");
  });
});
