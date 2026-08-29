// spec(§16) — task 24.72 Leg A: applyPlan must return a TYPED failure, never reject, when a
// post-commit recording fault occurs.
//
// MEASURED (24.67 probe, fully well-typed deps — no cast): `audit.append` async-reject,
// `audit.append` sync-throw, and `revisions.record` reject all THREW with the Markdown already
// durable. The docblock's "for well-typed deps" qualifier does not save it; the hole is entirely
// inside the qualified set.
//
// ⛔ THE COMMIT MUST STAND. `writer.ts` step 8 says a recording fault is a System-Health concern and
// NOT a rollback, and that is correct: the Markdown is durable and rolling it back would trade a §16
// defect for a worse one. Every test here pins the vault CONTENT surviving the fault — a "fix" that
// repaired the throw by discarding the write would pass a naive typed-error assertion.
//
// ⛔ NO TEST HERE PINS EITHER THROW AS INTENDED BEHAVIOUR. Doing so would encode the §16 violation as
// the contract and make it harder to close later.
import { describe, it, expect } from "vitest";
import {
  ok,
  isOk,
  validKnowledgeMutationPlan,
  workspaceId as wsId,
} from "@sow/contracts";
import type {
  KnowledgeMutationPlan,
  WorkflowRunRef,
  AuditRecord,
} from "@sow/contracts";
import {
  applyPlan,
  readVaultHeadRevision,
} from "../src/knowledge-writer/writer";
import type {
  KnowledgeWriteCommand,
  KnowledgeWriterDeps,
} from "../src/knowledge-writer/writer";
import { makeEnforceWorkspacePathScope } from "../src/knowledge-writer/workspace-path-guard";
import { MemoryAuditRepo, MemoryRevisionStore, MemoryVaultFs } from "./helpers";
import { asExemptWorkspaceId, type ExemptWorkspaceId } from "../src/knowledge-writer/workspace-path-guard";

/** Mint an `ExemptWorkspaceId` for a fixture. Uses the REAL constructor so these tests exercise
 *  the same validation production does — never a cast, which would hollow out the brand. */
function exempt(raw: string): ExemptWorkspaceId {
  const r = asExemptWorkspaceId(raw);
  if (!r.ok) throw new Error(`test fixture: not a legal exempt id`);
  return r.value;
}


const WS = "personal-business";
const guard = makeEnforceWorkspacePathScope(exempt(WS));
const PATH = "projects/acme.md";
const BODY = "the durable mutation";
const wf: WorkflowRunRef = {
  workflowId: "wf-24-72" as WorkflowRunRef["workflowId"],
  trigger: "manual",
  state: "running",
  idempotencyKey: "idem-24-72",
  auditRefs: [],
};
const plan: KnowledgeMutationPlan = {
  ...validKnowledgeMutationPlan,
  workspaceId: wsId(WS),
  creates: [{ path: PATH, body: BODY }],
};
const cmd = (base: string, key = "idem-24-72"): KnowledgeWriteCommand => ({
  plan,
  expectedBaseRevision: base as KnowledgeWriteCommand["expectedBaseRevision"],
  actor: "KnowledgeWriter",
  sourceEventRef: "evt-1",
  workflowRunRef: { ...wf, idempotencyKey: key },
  idempotencyKey: key,
});

class FaultingAudit extends MemoryAuditRepo {
  mode: "ok" | "reject" | "throw" = "ok";
  override async append(r: AuditRecord) {
    if (this.mode === "reject") throw new Error("audit store unreachable");
    if (this.mode === "throw") {
      // synchronous throw from an async method — a real adapter can do this before its first await
      throw new Error("audit store unreachable (sync)");
    }
    return super.append(r);
  }
}
class FaultingRevisions extends MemoryRevisionStore {
  failRecord = false;
  override async record(rev: Parameters<MemoryRevisionStore["record"]>[0]) {
    if (this.failRecord) throw new Error("revision store unreachable");
    return super.record(rev);
  }
}

async function run(
  configure: (a: FaultingAudit, r: FaultingRevisions) => void,
) {
  const vault = new MemoryVaultFs();
  const audit = new FaultingAudit();
  const revisions = new FaultingRevisions();
  configure(audit, revisions);
  const deps: KnowledgeWriterDeps = {
    vault,
    revisions,
    audit,
    now: () => "2026-08-14T00:00:00.000Z",
    ownershipCheck: () => ok(undefined),
    secretScan: () => ok(undefined),
    workspacePathCheck: guard,
  };
  const base = await readVaultHeadRevision(vault);
  // ⛔ NOT `.rejects` — the point of this slice is that it must NOT reject. If it does, this awaits a
  // rejected promise and the test fails loudly with the throw, which is the RED we want.
  const result = await applyPlan(cmd(base), deps);
  return { vault, audit, revisions, result };
}

describe("24.72 — a post-commit recording fault is a typed failure, not a rejection", () => {
  it("audit_append_async_rejection_returns_a_typed_failure", async () => {
    const { result, vault } = await run((a) => {
      a.mode = "reject";
    });

    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    // discriminate WHICH post-commit fault fired — the union also carries "revision_record_failed"
    expect(result.error.code).toBe("audit_record_failed");
    // ⛔ THE COMMIT STANDS — pinned on CONTENT, not merely presence, so a fix that wrote something
    // else would still red.
    expect(vault.snapshot()[PATH]).toContain(BODY);
  });

  it("audit_append_sync_throw_returns_a_typed_failure", async () => {
    const { result, vault } = await run((a) => {
      a.mode = "throw";
    });

    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    // discriminate WHICH post-commit fault fired — the union also carries "revision_record_failed"
    expect(result.error.code).toBe("audit_record_failed");
    expect(vault.snapshot()[PATH]).toContain(BODY);
  });

  it("revisions_record_rejection_returns_a_typed_failure", async () => {
    const { result, vault } = await run((_a, r) => {
      r.failRecord = true;
    });

    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    // discriminate WHICH post-commit fault fired — the union also carries "audit_record_failed"
    expect(result.error.code).toBe("revision_record_failed");
    expect(vault.snapshot()[PATH]).toContain(BODY);
  });

  it("the_two_recording_faults_are_DISTINGUISHABLE_from_each_other", async () => {
    // ⛔ THE LOAD-BEARING PIN. Folding both into one opaque member leaves a caller unable to tell
    // WHICH record is missing, and therefore unable to remediate either. One member would satisfy
    // every other test in this file.
    const auditFault = await run((a) => {
      a.mode = "reject";
    });
    const revisionFault = await run((_a, r) => {
      r.failRecord = true;
    });

    expect(isOk(auditFault.result)).toBe(false);
    expect(isOk(revisionFault.result)).toBe(false);
    if (isOk(auditFault.result) || isOk(revisionFault.result)) return;
    // pin each fault to ITS OWN code, not just "different from the other" — an inverted mapping
    // (audit fault reported as revision_record_failed and vice versa) would still pass a bare
    // `.not.toBe` check.
    expect(auditFault.result.error.code).toBe("audit_record_failed");
    expect(revisionFault.result.error.code).toBe("revision_record_failed");
    expect(auditFault.result.error.code).not.toBe(
      revisionFault.result.error.code,
    );
  });

  it("the_failure_carries_the_revision_that_DID_land", async () => {
    // Without this the caller knows a recording failed but not WHICH revision is durable — the
    // commit stands and is unidentifiable, which is most of the remediation problem left in place.
    const { result } = await run((a) => {
      a.mode = "reject";
    });
    expect(isOk(result)).toBe(false);
    if (isOk(result)) return;
    // discriminate WHICH post-commit fault fired before trusting its revisionId
    expect(result.error.code).toBe("audit_record_failed");
    expect(
      String((result.error as { revisionId?: string }).revisionId ?? ""),
    ).toMatch(/^rev:/);
  });

  it("neither_new_member_reuses_a_code_asserting_a_policy_verdict", async () => {
    // A config/infra fault must not be reported as a verdict it did not earn (#57's reasoning).
    // `commit_failed` is excluded too: the commit did NOT fail here, it succeeded and is durable —
    // reporting it would preserve the very inversion this task exists to remove.
    const forbidden = [
      "workspace_path_violation",
      "ownership_violation",
      "secret_found",
      "schema_rejected",
      "write_conflict",
      "commit_failed",
    ];
    for (const cfg of [
      (a: FaultingAudit) => {
        a.mode = "reject";
      },
      (_a: FaultingAudit, r: FaultingRevisions) => {
        r.failRecord = true;
      },
    ]) {
      const { result } = await run(
        cfg as (a: FaultingAudit, r: FaultingRevisions) => void,
      );
      expect(isOk(result)).toBe(false);
      if (isOk(result)) continue;
      expect(forbidden).not.toContain(result.error.code);
    }
  });

  it("honest_path_control_a_clean_commit_still_returns_ok", async () => {
    // ⛔ MANDATORY. Without it every test above passes against an applyPlan that fails everything
    // (contracts L80 — replace the gate with a constant and ask whether anything reds).
    const { result, vault } = await run(() => {});
    expect(isOk(result)).toBe(true);
    expect(vault.snapshot()[PATH]).toContain(BODY);
  });
});
