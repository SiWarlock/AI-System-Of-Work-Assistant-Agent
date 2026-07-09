// §13.10a G4a — buildSemanticApprovalDispatch: the composition that wires the on-approval semantic branch
// (gate-1 reader + existence probe over the vault → head-at-commit KnowledgeWriter commit port → executor).
// Uses a RECORDING fake applyPlan (injected) so this proves the WIRING + head-at-commit resolution without a
// full KnowledgeWriter setup; the real writer is exercised by the knowledge suite, and the resolver semantics
// by the workflows commit-activity suite.
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr } from "@sow/contracts";
import type { Approval } from "@sow/contracts";
import type { DbError, DbResult, PendingKnowledgeMutation, PendingKnowledgeMutationRepository } from "@sow/db";
import type { ApplyPlanFn } from "@sow/workflows";
import type { WriteSuccess, VaultFs } from "@sow/knowledge";
import { readVaultHeadRevision } from "@sow/knowledge";
import { payloadHash } from "@sow/integrations";
import { buildSemanticApprovalDispatch } from "../../src/composition/semanticApprovalDispatch";

const NOW = "2026-07-09T00:00:00.000Z";

/** A schema-valid create KMP (passes the executor's candidate re-gate). Target: the canonical WS-8 note path. */
const validPlan: Record<string, unknown> = {
  planId: "plan-g4-1",
  workspaceId: "personal-business",
  sourceRefs: [{ sourceId: "src-1" }],
  creates: [{ path: "projects/personal-business/acme.md", title: "Acme", body: "# Acme", frontmatter: { projectId: "acme" } }],
  patches: [],
  linkMutations: [],
  frontmatterUpdates: [],
  externalActionProposals: [],
  confidence: 0.5,
  requiresApproval: true,
  provenanceOrigin: "copilot_propose",
  expectedProjectId: "acme",
};
const HASH = payloadHash(validPlan);
const roundTrip = <T,>(v: T): unknown => JSON.parse(JSON.stringify(v));

function mkRow(over: Partial<PendingKnowledgeMutation> = {}): PendingKnowledgeMutation {
  return { planId: "plan-g4-1", workspaceId: "personal-business", plan: validPlan, payloadHash: HASH, status: "pending", recordedAt: "2026-07-08T00:00:00.000Z", ...over };
}
function mkApproval(over: Record<string, unknown> = {}): Approval {
  return { id: "appr-1", planRef: "plan-g4-1", subjectKind: "semantic_mutation", workspaceId: "personal-business", status: "approved", actor: "copilot", channel: "mac", payloadHash: HASH, ...over } as unknown as Approval;
}
function fakePendingKmp(seed: PendingKnowledgeMutation): { repo: PendingKnowledgeMutationRepository; store: Map<string, PendingKnowledgeMutation> } {
  const store = new Map<string, PendingKnowledgeMutation>([[seed.planId, { ...seed, plan: roundTrip(seed.plan) }]]);
  const repo: PendingKnowledgeMutationRepository = {
    record: (e) => Promise.resolve(ok(e)),
    get: (planId) => Promise.resolve(store.has(planId) ? ok(store.get(planId)!) : err({ code: "not_found", message: "nf" } satisfies DbError)) as DbResult<PendingKnowledgeMutation>,
    update: (e) => { store.set(e.planId, e); return Promise.resolve(ok(e)); },
  };
  return { repo, store };
}
function memVault(files: Record<string, string>): VaultFs {
  const m = new Map(Object.entries(files));
  return {
    list: async () => [...m.keys()],
    read: async (p) => m.get(p),
    write: async (p, c) => { m.set(p, c); },
    rename: async (from, to) => { const v = m.get(from); if (v !== undefined) { m.set(to, v); m.delete(from); } },
    remove: async (p) => { m.delete(p); },
  };
}
function recordingApplyPlan(): { fn: ApplyPlanFn; calls: { expectedBaseRevision: string; planId: string; sourceEventRef: string }[] } {
  const calls: { expectedBaseRevision: string; planId: string; sourceEventRef: string }[] = [];
  const fn: ApplyPlanFn = (command) => {
    // `command.plan` is candidate data (typed `unknown` at the writer boundary) — narrow it just to read planId.
    const planId = String((command.plan as { planId?: unknown }).planId);
    // sourceEventRef is what the writer stamps into the AuditRecord + CommittedRevision — capture it to prove
    // the authorizing approval id was folded in.
    calls.push({ expectedBaseRevision: String(command.expectedBaseRevision), planId, sourceEventRef: command.sourceEventRef });
    return Promise.resolve(ok({ revisionId: "rev-new" as WriteSuccess["revisionId"], auditRecord: {} as WriteSuccess["auditRecord"], replayed: false } as WriteSuccess));
  };
  return { fn, calls };
}

function build(vault: VaultFs, applyPlan: ApplyPlanFn, seed = mkRow()): { dispatch: ReturnType<typeof buildSemanticApprovalDispatch>; kmp: ReturnType<typeof fakePendingKmp> } {
  const kmp = fakePendingKmp(seed);
  const dispatch = buildSemanticApprovalDispatch({
    vault,
    pendingKmp: kmp.repo,
    revisions: {} as never, // unused by the recording fake applyPlan
    audit: {} as never,
    now: () => NOW,
    commit: { actor: "copilot-approval", sourceEventRef: "copilot.propose_knowledge", workflowRunRef: "run-1" as never },
    applyPlan,
  });
  return { dispatch, kmp };
}

describe("buildSemanticApprovalDispatch", () => {
  it("commits an approved create card whose target path is FREE, resolving the base revision to the live head", async () => {
    const vault = memVault({}); // empty ⇒ Projects/acme.md is free
    const applied = recordingApplyPlan();
    const { dispatch, kmp } = build(vault, applied.fn);
    const r = await dispatch(mkApproval());
    expect(isOk(r)).toBe(true);
    expect(applied.calls).toHaveLength(1);
    expect(applied.calls[0]?.planId).toBe("plan-g4-1");
    // Head-at-commit: the base revision handed to the writer is the CURRENT live head (not a fixed value).
    expect(applied.calls[0]?.expectedBaseRevision).toBe(await readVaultHeadRevision(vault));
    // Audit-trail linkage: the authorizing approval id is folded into the sourceEventRef the writer records.
    expect(applied.calls[0]?.sourceEventRef).toBe("copilot.propose_knowledge#approval:appr-1");
    expect(kmp.store.get("plan-g4-1")?.status).toBe("committed");
  });

  it("head-at-commit reflects an UNRELATED vault change since propose (would spuriously conflict on a fixed base)", async () => {
    // A note added between propose and approve moves the whole-vault head. A FIXED base would clash here; the
    // resolver picks up the current head, so the commit proceeds (the target Projects/acme.md is still free).
    const vault = memVault({ "notes/added-after-propose.md": "hi\n" });
    const applied = recordingApplyPlan();
    const { dispatch } = build(vault, applied.fn);
    const r = await dispatch(mkApproval());
    expect(isOk(r)).toBe(true);
    expect(applied.calls[0]?.expectedBaseRevision).toBe(await readVaultHeadRevision(vault)); // head includes the new note
  });

  it("REJECTS a create whose target path is OCCUPIED (gate-1 existence probe over the vault) — no commit", async () => {
    const vault = memVault({ "projects/personal-business/acme.md": "---\nprojectId: someone-else\n---\n# Other\n" });
    const applied = recordingApplyPlan();
    const { dispatch, kmp } = build(vault, applied.fn);
    const r = await dispatch(mkApproval());
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.cause?.code).toBe("SEMANTIC_DISPATCH_CREATE_TARGET_EXISTS");
    expect(applied.calls).toHaveLength(0); // fail-closed BEFORE the writer
    expect(kmp.store.get("plan-g4-1")?.status).toBe("pending"); // unchanged
  });

  it("settles a REJECTED card without committing (marks the row rejected)", async () => {
    const vault = memVault({});
    const applied = recordingApplyPlan();
    const { dispatch, kmp } = build(vault, applied.fn);
    const r = await dispatch(mkApproval({ status: "rejected" }));
    expect(isOk(r)).toBe(true);
    expect(applied.calls).toHaveLength(0);
    expect(kmp.store.get("plan-g4-1")?.status).toBe("rejected");
  });
});
