// spec(§6, §16) — task 24.77 (fix leg for the 24.76 measurement).
//
// 24.76 EXECUTED and REPRODUCED: after a post-commit fault leaves the Markdown durable but the
// revision record unwritten, a retry re-enters with the SAME idempotency key, finds the idempotency
// lookup empty, passes compare-revision against the MOVED head, diffs to ZERO changes, and records an
// AuditRecord claiming `revision-applied: 0 file(s) changed` for a plan that declares mutations —
// against a base that ALREADY CONTAINS them.
//
// ⛔ THE GUARD MUST NOT REST ON THE TWO MECHANISMS THAT BLOCK THIS IN PRODUCTION TODAY (the
// exactly-once approval CAS, and `createCommitActivity`'s try/catch) — 24.72's natural remedy removes
// the second. ⭐ THESE TESTS DEMONSTRATE THAT STRUCTURALLY RATHER THAN ASSERTING IT: they call
// `applyPlan` DIRECTLY, so neither mechanism is in the picture at all. The guard closing the defect
// here IS the proof that it holds with both gone.
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
const KEY = "idem-24-77";
const wf: WorkflowRunRef = {
  workflowId: "wf-24-77" as WorkflowRunRef["workflowId"],
  trigger: "manual",
  state: "running",
  idempotencyKey: KEY,
  auditRefs: [],
};
const mutatingPlan: KnowledgeMutationPlan = {
  ...validKnowledgeMutationPlan,
  workspaceId: wsId(WS),
  creates: [{ path: "projects/acme.md", body: "the real mutation" }],
};
const cmd = (
  plan: KnowledgeMutationPlan,
  base: string,
  key = KEY,
): KnowledgeWriteCommand => ({
  plan,
  expectedBaseRevision: base as KnowledgeWriteCommand["expectedBaseRevision"],
  actor: "KnowledgeWriter",
  sourceEventRef: "evt-1",
  workflowRunRef: { ...wf, idempotencyKey: key },
  idempotencyKey: key,
});

/** Records what the idempotency lookup returned, and can fault its own `record` leg. */
class TracingRevisions extends MemoryRevisionStore {
  lookups: ("hit" | "empty")[] = [];
  failRecord = false;
  recordFaultFired = 0;
  override async getByIdempotencyKey(k: string) {
    const r = await super.getByIdempotencyKey(k);
    this.lookups.push(r === undefined ? "empty" : "hit");
    return r;
  }
  override async record(rev: Parameters<MemoryRevisionStore["record"]>[0]) {
    if (this.failRecord) {
      this.recordFaultFired += 1;
      throw new Error("revisions.record: store down");
    }
    return super.record(rev);
  }
}
class TracingAudit extends MemoryAuditRepo {
  failAppend = false;
  appendFaultFired = 0;
  override async append(r: AuditRecord) {
    if (this.failAppend) {
      this.appendFaultFired += 1;
      throw new Error("audit.append: store down");
    }
    return super.append(r);
  }
}

// `afterSummary` is a REQUIRED field on `AuditRecord` (`audit-record.ts`), so no cast is needed —
// an earlier draft double-cast through `unknown`, which would have hidden a real type change.
const summaryOf = (r: AuditRecord): string => r.afterSummary;

/**
 * ⛔ THE RETRY-INDEPENDENT PREDICATE — the whole point of 24.77's chosen guard. It needs NO knowledge
 * of retries, faults, or call order: it reads ONE row and asks whether that row contradicts itself by
 * claiming an APPLIED revision that changed nothing while naming a non-zero declared mutation count.
 * ⚠ `already-present:` (not `already-applied:`) is the truthful prefix — the guard establishes the
 * vault STATE, never that THIS plan applied it earlier (reviewer-caught).
 */
// ⚠ COUPLED TO THE LITERAL PREFIX `revision-applied:` — if `summarize`'s prefix is ever renamed this
// returns false unconditionally, making pins 1-2 vacuously green. BACKSTOP: the two control tests
// assert their literals directly (`revision-applied: 1 file(s) changed` / `: 0 file(s) changed`), so a
// prefix rename reds THEM. Bounded, not unguarded — recorded rather than rewritten.
const isSelfContradictory = (summary: string): boolean => {
  if (!summary.startsWith("revision-applied:")) return false;
  const changed = /^revision-applied: (\d+) file\(s\) changed/.exec(
    summary,
  )?.[1];
  const declared = [
    ...summary.matchAll(
      /(\d+) (?:create|patch|link|frontmatter update)\(?e?s?\)?/g,
    ),
  ].map((m) => Number(m[1]));
  return changed === "0" && declared.some((n) => n > 0);
};

/** Drive attempt-1-faults-post-commit → retry, returning everything the assertions need. */
async function faultThenRetry(
  faultAt: "audit.append" | "revisions.record",
  plan: KnowledgeMutationPlan = mutatingPlan,
) {
  const vault = new MemoryVaultFs();
  const revisions = new TracingRevisions();
  const audit = new TracingAudit();
  const deps: KnowledgeWriterDeps = {
    vault,
    revisions,
    audit,
    now: () => "2026-08-14T00:00:00.000Z",
    ownershipCheck: () => ok(undefined),
    secretScan: () => ok(undefined),
    workspacePathCheck: guard,
  };
  if (faultAt === "audit.append") audit.failAppend = true;
  else revisions.failRecord = true;

  const base1 = await readVaultHeadRevision(vault);
  // ⚠ UPDATED BY 24.72, AND THE CHANGE IS THE POINT: this line used to be
  // `await expect(...).rejects.toThrow(/store down/)` — it used the §16 THROW as its mechanism for
  // reaching the post-fault state. 24.72 replaced that throw with a typed failure, so the harness now
  // asserts the typed failure instead. The SCENARIO is unchanged (Markdown durable, revision record
  // absent, same key re-entered); only attempt 1's REPORTING changed.
  // ⭐ This is strictly stronger: the setup now pins a contract rather than depending on a defect.
  const attempt1 = await applyPlan(cmd(plan, String(base1)), deps);
  expect(isOk(attempt1)).toBe(false);
  if (!isOk(attempt1)) {
    expect(["audit_record_failed", "revision_record_failed"]).toContain(
      attempt1.error.code,
    );
  }

  audit.failAppend = false;
  revisions.failRecord = false;
  const lookupsBefore = revisions.lookups.length;
  const base2 = await readVaultHeadRevision(vault); // the MOVED head — the live-head-resolver mode
  const retry = await applyPlan(cmd(plan, String(base2)), deps);

  return {
    vault,
    audit,
    retry,
    faultFired:
      faultAt === "audit.append"
        ? audit.appendFaultFired
        : revisions.recordFaultFired,
    lookupOnRetry: revisions.lookups[lookupsBefore] ?? "(never called)",
  };
}

describe("24.77 — a retry must not record an AuditRecord describing a diff against a post-mutation base", () => {
  it("retry_after_audit_append_fault_records_no_misdescribing_row", async () => {
    const s = await faultThenRetry("audit.append");

    // ⛔ PRECONDITIONS FIRST. A pin that silently stops reaching the scenario is byte-indistinguishable
    // from one that passes honestly (contracts L75/L79) — and the injected fault is exactly the kind
    // that can short-circuit the path this test means to drive.
    expect(s.faultFired).toBe(1); // the fault actually fired
    expect(s.lookupOnRetry).toBe("empty"); // getByIdempotencyKey empty on re-entry (writer.ts step 1)
    expect(isOk(s.retry)).toBe(true); // compare-revision PASSED (else write_conflict)
    expect(Object.keys(s.vault.snapshot())).toHaveLength(1); // the mutation really is durable

    // Shape (A): this is the ONLY row that exists for the mutation. It must not misdescribe it.
    expect(s.audit.records).toHaveLength(1);
    expect(isSelfContradictory(summaryOf(s.audit.records[0]!))).toBe(false);
  });

  it("retry_after_revisions_record_fault_records_no_misdescribing_row", async () => {
    const s = await faultThenRetry("revisions.record");

    expect(s.faultFired).toBe(1);
    expect(s.lookupOnRetry).toBe("empty");
    expect(isOk(s.retry)).toBe(true);

    // Shape (B): attempt 1 already wrote a TRUTHFUL row; the retry adds a second.
    // ⛔ Pinned separately from (A) — one guard closes both, but only THIS shape can catch a
    // regression that clobbers or reorders the earlier truthful row, which shape (A) would pass forever.
    expect(s.audit.records).toHaveLength(2);
    expect(summaryOf(s.audit.records[0]!)).toContain("1 file(s) changed"); // the true row, untouched
    expect(isSelfContradictory(summaryOf(s.audit.records[1]!))).toBe(false); // the later row is not false
  });

  it("a_truthful_row_is_recorded_instead_of_none", async () => {
    // ⛔ A correction owes a REPLACEMENT. Suppressing the row would trade a wrong row for an absent
    // one, and 24.72 is separately about restoring observability — so pin what REPLACES it, not just
    // the absence of the false claim.
    const s = await faultThenRetry("audit.append");
    expect(summaryOf(s.audit.records[0]!)).toContain("already-present");
  });

  it("honest_path_control_a_normal_commit_still_records_a_truthful_applied_row", async () => {
    // ⛔ MANDATORY, AND IT IS WHAT STOPS THE GUARD WIDENING. Without it every test above passes
    // against an `applyPlan` that writes NO audit rows at all, or that marks every row already-applied
    // (contracts L80 — replace the gate with a constant and ask whether anything reds).
    const vault = new MemoryVaultFs();
    const audit = new TracingAudit();
    const deps: KnowledgeWriterDeps = {
      vault,
      revisions: new TracingRevisions(),
      audit,
      now: () => "2026-08-14T00:00:00.000Z",
      ownershipCheck: () => ok(undefined),
      secretScan: () => ok(undefined),
      workspacePathCheck: guard,
    };
    const base = await readVaultHeadRevision(vault);
    const r = await applyPlan(
      cmd(mutatingPlan, String(base), "idem-honest"),
      deps,
    );

    expect(isOk(r)).toBe(true);
    expect(audit.records).toHaveLength(1);
    const s = summaryOf(audit.records[0]!);
    expect(s).toContain("revision-applied: 1 file(s) changed");
    expect(s).not.toContain("already-present");
  });

  it("a_legitimately_empty_plan_keeps_its_ordinary_applied_row", async () => {
    // ⛔ THE DISCRIMINATOR BOUNDARY, pinned so the guard cannot widen from "plan declares mutations
    // AND diff is empty" into "diff is empty". A plan that declares NOTHING is not already-applied —
    // it is an honest zero-change commit, and it must keep saying so.
    const vault = new MemoryVaultFs();
    const audit = new TracingAudit();
    const deps: KnowledgeWriterDeps = {
      vault,
      revisions: new TracingRevisions(),
      audit,
      now: () => "2026-08-14T00:00:00.000Z",
      ownershipCheck: () => ok(undefined),
      secretScan: () => ok(undefined),
      workspacePathCheck: guard,
    };
    const emptyPlan: KnowledgeMutationPlan = {
      ...validKnowledgeMutationPlan,
      workspaceId: wsId(WS),
      // ⛔ ALL FOUR spelled out, not inherited: the boundary this pins is "declares NOTHING", and
      // leaving `linkMutations`/`frontmatterUpdates` to another package's fixture puts this pin's
      // precondition outside this suite.
      creates: [],
      patches: [],
      linkMutations: [],
      frontmatterUpdates: [],
    };
    const base = await readVaultHeadRevision(vault);
    const r = await applyPlan(
      cmd(emptyPlan, String(base), "idem-empty-plan"),
      deps,
    );

    expect(isOk(r)).toBe(true);
    const s = summaryOf(audit.records[0]!);
    expect(s).toContain("revision-applied: 0 file(s) changed");
    expect(s).not.toContain("already-present");
    expect(isSelfContradictory(s)).toBe(false); // 0 changed + 0 declared is consistent, not a defect
  });

  it("the_mutation_kind_SET_is_closed_and_a_fifth_array_reds_HERE", () => {
    // ⛔⛔ THE ONLY PATH BY WHICH 24.76's DEFECT RETURNS, AND IT RETURNS GREEN (security-reviewer).
    // `planDeclaresMutations`, `summarize`, `summarizeAlreadyApplied` and `projectPlan` each HAND-LIST
    // the same four mutation arrays. Today drift is symmetric and harmless — a fifth array `projectPlan`
    // ignores writes no bytes. The hazard is ASYMMETRIC: a contracts slice adds a fifth array AND wires
    // it into `projectPlan` but NOT into `planDeclaresMutations`. That is COMPILE-CLEAN (no
    // `assertNever`, no exhaustiveness surface) and silently re-opens the false
    // `revision-applied: 0 file(s) changed` row for that kind alone.
    // ⇒ This is an ENUMERATION MIRROR (worker L72's shape), and it is BELT, not the mechanism
    // (contracts L103): it cannot prove the four are handled, only that the SET has not grown behind
    // our backs. A fifth array reds THIS test, which routes the author to the four call sites.
    const arrayKeys = Object.entries(validKnowledgeMutationPlan)
      .filter(([, v]) => Array.isArray(v))
      .map(([k]) => k)
      .sort();
    expect(arrayKeys).toEqual([
      "creates",
      "externalActionProposals", // NOT a Markdown mutation — applyPlan performs no external writes
      "frontmatterUpdates",
      "linkMutations",
      "patches",
      "sourceRefs", // provenance, not a mutation
    ]);
  });

  it("retry_with_the_stale_pre_mutation_base_hits_write_conflict_not_a_misdescribing_row", async () => {
    // ⛔ REACH-PROOF #2, DIRECT — closes the 2026-08-17 gap finding on `### 24.76`'s Done-when.
    // `expect(isOk(s.retry)).toBe(true)` above (the pre-existing pins) is a PROXY for "compare-revision
    // passed against the moved head" (`contracts L176` — a condition names the most OBSERVABLE proxy
    // for its event, not the event itself): it would stay green even if `applyPlan` reached `ok` some
    // OTHER way. This test proves compare-revision is the actual, discriminating gate at this exact
    // call: retrying with the STALE pre-mutation base (the one attempt 1 STARTED from, never the one it
    // left behind) must hit `write_conflict` — the only way this stage can fail. Paired with the
    // existing pins (which retry against the MOVED head and get `ok`), this is a positive/negative
    // control on the SAME predicate, not an inferred proxy on one side of it alone.
    const vault = new MemoryVaultFs();
    const revisions = new TracingRevisions();
    const audit = new TracingAudit();
    const deps: KnowledgeWriterDeps = {
      vault,
      revisions,
      audit,
      now: () => "2026-08-14T00:00:00.000Z",
      ownershipCheck: () => ok(undefined),
      secretScan: () => ok(undefined),
      workspacePathCheck: guard,
    };
    audit.failAppend = true;
    const key = "idem-stale-base";
    const base1 = await readVaultHeadRevision(vault); // the PRE-mutation head
    const attempt1 = await applyPlan(cmd(mutatingPlan, String(base1), key), deps);
    expect(isOk(attempt1)).toBe(false); // fault fired, Markdown is durable, no audit row landed
    // discriminate WHICH post-commit fault fired — the union also carries "revision_record_failed"
    if (!isOk(attempt1)) expect(attempt1.error.code).toBe("audit_record_failed");

    audit.failAppend = false;
    // Deliberately re-submit against `base1` — the STALE base, not the moved head the existing pins
    // use. Same idempotency key, so step 1's lookup is still empty (attempt 1 never reached
    // `revisions.record`); this isolates step 3 (compare-revision) as the only remaining gate.
    const staleRetry = await applyPlan(cmd(mutatingPlan, String(base1), key), deps);

    expect(isOk(staleRetry)).toBe(false);
    if (!isOk(staleRetry)) {
      expect(staleRetry.error.code).toBe("write_conflict");
    }
    // No audit row for the stale retry — the failure happened AT compare-revision (step 3), before
    // step 8's audit write, never after it.
    expect(audit.records).toHaveLength(0);
  });

  it("the_discriminator_covers_a_NON_creates_mutation_kind", async () => {
    // ⛔⛔ REVIEWER-FOUND VACUITY GAP IN THIS SUITE'S OWN COVERAGE, and it is the one that mattered:
    // every other plan here declares mutations ONLY via `creates`, so narrowing
    // `planDeclaresMutations` to `plan.creates.length > 0` would have left ALL the pins above GREEN
    // while the guard was wrong. It is not a hypothetical narrowing either — every projector is
    // idempotent (`applyFrontmatter` re-sets the same key, `applyRegionPatch` re-writes the same
    // region, `applyLink` returns content unchanged when the wikilink is present), so a
    // frontmatter-only / patch-only / link-only retry reaches the SAME already-applied state and
    // would still have produced the false `revision-applied: 0 file(s) changed; … 1 …` row.
    // ⇒ This pin is what makes the four-kind discriminator load-bearing rather than decorative.
    const frontmatterOnlyPlan: KnowledgeMutationPlan = {
      ...validKnowledgeMutationPlan,
      workspaceId: wsId(WS),
      creates: [],
      patches: [],
      linkMutations: [],
      frontmatterUpdates: [
        { path: "projects/acme.md", key: "owner", value: "TBD" },
      ],
    };
    const s = await faultThenRetry("audit.append", frontmatterOnlyPlan);

    expect(s.faultFired).toBe(1);
    expect(s.lookupOnRetry).toBe("empty");
    expect(isOk(s.retry)).toBe(true);
    expect(Object.keys(s.vault.snapshot())).toHaveLength(1); // the frontmatter write really landed

    const summary = summaryOf(s.audit.records[0]!);
    expect(isSelfContradictory(summary)).toBe(false);
    expect(summary).toContain("already-present"); // and it says so truthfully
    expect(summary).toContain("1 frontmatter update(s)"); // the declared kind is still reported
  });
});
