// spec(§6, task 24.64 knowledge leg) — the KnowledgeWriter commit-path AuditRecord sanitiser
// (`writer.ts:603`-area `deps.audit.append`). VALIDATE-OR-OMIT, never fail-closed-on-commit: the
// sole-writer commit path (safety rule 1) may never be BLOCKED by an audit redaction-safety check —
// see the doc comment on `sanitizeCommitAuditRecordForAppend` in `../src/knowledge-writer/writer.ts`.
import { describe, it, expect } from "vitest";
import { ok, isOk, validKnowledgeMutationPlan } from "@sow/contracts";
import type { KnowledgeMutationPlan, WorkflowRunRef, AuditRecord, PlanId } from "@sow/contracts";
import { isRedactionSafe } from "@sow/policy";
import { applyPlan } from "../src/knowledge-writer/writer";
import type { KnowledgeWriteCommand, KnowledgeWriterDeps } from "../src/knowledge-writer/writer";
import { computeRevisionId } from "../src/knowledge-writer/revision";
import { MemoryAuditRepo, MemoryRevisionStore, MemoryVaultFs } from "./helpers";

const wf: WorkflowRunRef = {
  workflowId: "wf-audit-gate" as WorkflowRunRef["workflowId"],
  trigger: "manual",
  state: "running",
  idempotencyKey: "idem-audit-gate",
  auditRefs: [],
};

const EMPTY_REV = computeRevisionId(new Map());

function deps(vault: MemoryVaultFs): KnowledgeWriterDeps & {
  revisions: MemoryRevisionStore;
  audit: MemoryAuditRepo;
} {
  return {
    vault,
    revisions: new MemoryRevisionStore(),
    audit: new MemoryAuditRepo(),
    now: () => "2026-08-24T00:00:00.000Z",
    workspacePathCheck: () => ok(undefined),
  };
}

function cmd(
  plan: unknown,
  sourceEventRef = "evt-audit-gate",
  base = EMPTY_REV,
  idempotencyKey = "idem-audit-gate-1",
): KnowledgeWriteCommand {
  return {
    plan,
    expectedBaseRevision: base,
    actor: "KnowledgeWriter",
    sourceEventRef,
    workflowRunRef: wf,
    idempotencyKey,
  };
}

/** The signal-subset fields `isRedactionSafe` scans — same six fields `AuditSignal` names. */
function recordSignal(record: AuditRecord): {
  actor: string;
  event: string;
  refs: readonly string[];
  payloadHash: string;
  beforeSummary: string;
  afterSummary: string;
} {
  return {
    actor: record.actor,
    event: record.event,
    refs: record.refs,
    payloadHash: record.payloadHash,
    beforeSummary: record.beforeSummary,
    afterSummary: record.afterSummary,
  };
}

describe("applyPlan — commit AuditRecord redaction sanitiser (24.64 knowledge leg)", () => {
  // Positive control: on the ORDINARY (non-credential-shaped) path, sanitisation must be a total
  // no-op. Proven by REFERENCE equality (not deep-equality) — the appended record is the very same
  // object `WriteSuccess.auditRecord` carries, never a reconstructed copy — so this control cannot
  // pass by accident (a sanitiser that always rebuilds an equal-by-value object would fail it).
  it("benign_commit_audit_record_is_unchanged", async () => {
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const plan: KnowledgeMutationPlan = {
      ...validKnowledgeMutationPlan,
      creates: [{ path: "notes/benign.md", body: "an ordinary note body" }],
    };
    const r = await applyPlan(cmd(plan), d);

    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(d.audit.records).toHaveLength(1);
    // Same object identity as the returned WriteSuccess.auditRecord — the append path did NOT
    // allocate a sanitised replacement, because there was nothing to sanitise.
    expect(d.audit.records[0]).toBe(r.value.auditRecord);
    expect(isRedactionSafe(recordSignal(d.audit.records[0]!))).toBe(true);
  });

  // Adversarial case: a schema-VALID plan (PlanIdSchema validates only non-emptiness, never content
  // shape) whose planId is itself credential-shaped. `buildCommitAuditRecord` folds `plan.planId`
  // into `refs`, so this is the representable violation the sanitiser exists to catch.
  it("commit_audit_record_is_redaction_safe", async () => {
    const vault = new MemoryVaultFs();
    const d = deps(vault);
    const credentialShapedPlanId = "sk-test1234567890abcdef" as PlanId;
    const plan: KnowledgeMutationPlan = {
      ...validKnowledgeMutationPlan,
      planId: credentialShapedPlanId,
      creates: [{ path: "notes/credential-plan.md", body: "an ordinary note body" }],
    };
    const r = await applyPlan(cmd(plan), d);

    // (a) the commit SUCCEEDS — safety rule 1: audit sanitisation never blocks the sole writer.
    expect(isOk(r)).toBe(true);
    if (!isOk(r)) return;
    expect(vault.snapshot()["notes/credential-plan.md"]).toBe("an ordinary note body");

    // (b) exactly one append occurred.
    expect(d.audit.records).toHaveLength(1);
    const appended = d.audit.records[0]!;

    // (c) isRedactionSafe over the appended record's signal fields is true.
    expect(isRedactionSafe(recordSignal(appended))).toBe(true);

    // (d) the offending substring appears nowhere on the appended record.
    const serialized = JSON.stringify(appended);
    expect(serialized).not.toContain(credentialShapedPlanId);
    expect(serialized.toLowerCase()).not.toContain("sk-test1234567890abcdef");

    // The unsanitised planId DID reach the pre-append record (sanity: the vector is real, the fix
    // sanitises rather than the value never having been credential-shaped in the first place) — the
    // in-process WriteSuccess.auditRecord (never a log/redaction sink, per the sanitiser's own scope
    // note) still carries it in refs.
    expect(r.value.auditRecord.refs).toContain(credentialShapedPlanId);
  });
});
