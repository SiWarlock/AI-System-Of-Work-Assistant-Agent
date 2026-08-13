// spec(§6 KN-10 / §9 step-6) — 13.8d worker-binding: the living-vault rewrite seam on the source path.
//
// §6 KN-10 says the vault REWRITES ITSELF on ingest: one ingested source yields not just its own note but
// the entity/index/op-log mutations that keep the rest of the vault true. `rewriteVaultForSource`
// (@sow/knowledge, landed 3d2d24f9) produces that ≤2-plan set; this slice binds it onto the source
// pipeline WITHOUT arming it.
//
// The seam is an OPTIONAL dep on `SourceIngestionDeps` rather than a swapped-in `SourceBuildOutputsPort`
// implementation: `MeetingBuiltOutputs` carries a SINGLE `plan` and is shared with meeting-closeout +
// hermes, so routing a ≤2-plan set through it would mean widening a shared contract seam (Step-2.5 Q2,
// orchestrator-approved). Unbound ⇒ the pipeline is byte-equivalent to pre-13.8d.
//
// The pins here are the DRIVER-side half (pure, in-memory). The realpath containment half is a worker
// test over a real tmpdir + symlink — `runSourceIngestion` is Temporal workflow-sandbox code, so it must
// never touch `fs`; the adapter that does the containment check lives at the composition root.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ok, err, workflowId, planId } from "@sow/contracts";
import type { WorkspaceId, KnowledgeMutationPlan, Result } from "@sow/contracts";
import { runSourceIngestion } from "../src/workflows/sourceIngestion";
import type {
  SourceIngestionInput,
  SourceIngestionDeps,
} from "../src/workflows/sourceIngestion";
import type {
  SourceLivingVaultPort,
  LivingVaultFailure,
  SourceNoteIdentity,
  ValidatedExtraction,
  CommitKnowledgePort,
  KnowledgeCommitSuccess,
  KnowledgeCommitFailure,
  KnowledgeCommitFailureCode,
} from "../src/ports/sourceIngestion";
import {
  FakeRegisterSourcePort,
  FakeRouteSourcePort,
  FakeSourceAgentJobPort,
  FakeValidatePort,
  FakeBuildOutputsPort,
  FakeCommitPort,
  FakeProposePort,
  FakeIndexGbrainPort,
  FakeSourceHealthSink,
  makeSourceContext,
} from "./support/source-fakes";
import { FakeClock, InMemoryWorkflowRunRepo } from "./support/fakes";

const WS = "ws-employer" as WorkspaceId;

function makeInput(): SourceIngestionInput {
  return {
    run: {
      workflowId: workflowId("wf-lv-1"),
      trigger: "connector_event",
      idempotencyKey: "idem-run-lv-1",
      workspaceId: WS,
    },
    context: makeSourceContext(),
  };
}

function makeDeps(overrides: Partial<SourceIngestionDeps> = {}): SourceIngestionDeps {
  return {
    register: new FakeRegisterSourcePort({ result: "registered" }),
    route: new FakeRouteSourcePort({ confidence: "high", workspaceId: WS }),
    agent: new FakeSourceAgentJobPort({ result: "accepted" }),
    validate: new FakeValidatePort(),
    buildOutputs: new FakeBuildOutputsPort(),
    commit: new FakeCommitPort(),
    propose: new FakeProposePort(),
    index: new FakeIndexGbrainPort(),
    health: new FakeSourceHealthSink(),
    runs: new InMemoryWorkflowRunRepo(),
    clock: new FakeClock(),
    ...overrides,
  };
}

/**
 * A living-vault plan the fake rewrite emits (the entity/index/op-log parity mutations).
 * `requiresApproval` defaults to the AUTO tier; pass `true` for the planner's human-gated PROPOSE plan.
 */
function livingVaultPlan(id: string, requiresApproval = false): KnowledgeMutationPlan {
  return {
    planId: planId(id),
    workspaceId: WS,
    creates: [],
    patches: [],
    linkMutations: [],
    frontmatterUpdates: [],
    sourceRefs: [],
    requiresApproval,
  } as unknown as KnowledgeMutationPlan;
}

/** Records every call + returns a configured outcome (or throws, to pin the never-throws contract). */
class SpyLivingVaultPort implements SourceLivingVaultPort {
  calls: { readonly workspaceId: WorkspaceId; readonly source: SourceNoteIdentity }[] = [];
  constructor(
    private readonly outcome:
      | { readonly kind: "plans"; readonly plans: readonly KnowledgeMutationPlan[] }
      | { readonly kind: "err"; readonly failure: LivingVaultFailure }
      | { readonly kind: "throws" },
  ) {}
  rewrite(
    _validated: ValidatedExtraction,
    workspaceId: WorkspaceId,
    source: SourceNoteIdentity,
  ): Promise<Result<readonly KnowledgeMutationPlan[], LivingVaultFailure>> {
    this.calls.push({ workspaceId, source });
    if (this.outcome.kind === "throws") throw new Error("rewrite exploded");
    if (this.outcome.kind === "err") return Promise.resolve(err(this.outcome.failure));
    return Promise.resolve(ok(this.outcome.plans));
  }
}

/** Captures the ORDERED plans the driver hands the commit port (the sole Markdown write path). */
class CapturingCommitPort implements CommitKnowledgePort {
  readonly captured: KnowledgeMutationPlan[] = [];
  private n = 0;
  commit(plan: KnowledgeMutationPlan): Promise<Result<KnowledgeCommitSuccess, KnowledgeCommitFailure>> {
    this.captured.push(plan);
    this.n += 1;
    return Promise.resolve(ok({ revisionId: `rev-lv-${this.n}`, replayed: false }));
  }
}

// 13.8i — the propose-knowledge-approval port shape does not exist in ../src/ports/sourceIngestion yet
// (Step 4 adds it); this local shape is what the driver is expected to call. Kept type-only so nothing
// production is touched before GREEN — a plain fake class needs no `implements` clause to be usable.
interface FakeProposeKnowledgeApprovalResult {
  readonly approvalRef: string;
  readonly created: boolean;
}
interface FakeProposeKnowledgeApprovalError {
  // 13.8i-B — widened from the sole "mint_failed" (an ATTEMPT that errored) to add "not_armed" (a
  // PRECONDITION that was never satisfied — no port bound at all). Distinct production consumer: the
  // driver routes each to a different FailureClass (write_through_failed vs write_through_blocked).
  readonly code: "mint_failed" | "not_armed";
  readonly message: string;
}

/** Records every call + returns a configured outcome (or throws, to pin the never-throws contract). */
class SpyProposeKnowledgePort {
  calls: { readonly plan: KnowledgeMutationPlan; readonly workspaceId: WorkspaceId }[] = [];
  constructor(
    private readonly outcome:
      | { readonly kind: "ok"; readonly approvalRef?: string; readonly created?: boolean }
      | { readonly kind: "err" }
      | { readonly kind: "not_armed" }
      | { readonly kind: "throws" } = { kind: "ok" },
  ) {}
  propose(
    plan: KnowledgeMutationPlan,
    workspaceId: WorkspaceId,
  ): Promise<Result<FakeProposeKnowledgeApprovalResult, FakeProposeKnowledgeApprovalError>> {
    this.calls.push({ plan, workspaceId });
    if (this.outcome.kind === "throws") throw new Error("propose exploded");
    if (this.outcome.kind === "not_armed") {
      return Promise.resolve(err({ code: "not_armed", message: "fake: no port bound" }));
    }
    if (this.outcome.kind === "err") {
      return Promise.resolve(err({ code: "mint_failed", message: "fake mint failure" }));
    }
    return Promise.resolve(
      ok({
        approvalRef: this.outcome.approvalRef ?? "apr_fake",
        created: this.outcome.created ?? true,
      }),
    );
  }
}

describe("runSourceIngestion — living-vault seam DORMANT by default (13.8d)", () => {
  it("default_off_is_byte_equivalent — dep UNBOUND ⇒ exactly ONE commit, applied, nothing surfaced", async () => {
    const commit = new FakeCommitPort();
    const health = new FakeSourceHealthSink();
    // The shipped default: `livingVault` is simply absent from the dep set.
    const outcome = await runSourceIngestion(makeInput(), makeDeps({ commit, health }));

    expect(outcome.state).toBe("applied");
    // Pre-13.8d contract: the source note is the ONLY thing committed.
    expect(commit.writeCount).toBe(1);
    expect(outcome.surfaced).toBeUndefined();
  });

  it("armed_routes_through_rewrite — dep BOUND ⇒ the rewrite's plans reach the EXISTING commit path, in order", async () => {
    const commit = new CapturingCommitPort();
    const livingVault = new SpyLivingVaultPort({
      kind: "plans",
      plans: [livingVaultPlan("lv-plan-auto"), livingVaultPlan("lv-plan-propose")],
    });
    const outcome = await runSourceIngestion(makeInput(), makeDeps({ commit, livingVault }));

    expect(outcome.state).toBe("applied");
    // The source note FIRST (unchanged step-7 semantics), then the living-vault plans in receipt order.
    expect(commit.captured).toHaveLength(3);
    expect(commit.captured.slice(1).map((p) => String(p.planId))).toEqual([
      "lv-plan-auto",
      "lv-plan-propose",
    ]);
    // WS-2: the rewrite is handed the ROUTING-BOUND workspace, never a caller value.
    expect(livingVault.calls).toHaveLength(1);
    expect(String(livingVault.calls[0]?.workspaceId)).toBe(String(WS));
  });

  it("approval_tier_is_never_auto_committed — a requiresApproval plan is WITHHELD and surfaced (§9.8)", async () => {
    // The planner emits up to two plans: AUTO (additive/derived/reversible) and PROPOSE (the
    // human-relevant edits). Auto-committing the PROPOSE plan would apply, with no human in the loop,
    // exactly the class of edit the Approvals surface exists to hold — so it must never reach commit.
    const commit = new CapturingCommitPort();
    const health = new FakeSourceHealthSink();
    const livingVault = new SpyLivingVaultPort({
      kind: "plans",
      plans: [livingVaultPlan("lv-auto"), livingVaultPlan("lv-propose", true)],
    });

    const outcome = await runSourceIngestion(makeInput(), makeDeps({ commit, health, livingVault }));

    expect(outcome.state).toBe("applied");
    // The source note + the AUTO plan only — the PROPOSE plan is absent from the commit path.
    expect(commit.captured.slice(1).map((p) => String(p.planId))).toEqual(["lv-auto"]);
    // Withheld ≠ silently dropped — but 13.8i changes WHAT happens instead (routed to Approvals, not
    // just counted), so with no propose port bound the mint attempt fails and IS surfaced as such.
    expect(
      health.surfaced.some((f) => /could not be queued for approval/i.test(f.message)),
    ).toBe(true);
  });

  it("a_withheld_propose_plan_mints_exactly_one_pending_approval — 13.8i core contract", async () => {
    const commit = new CapturingCommitPort();
    const health = new FakeSourceHealthSink();
    const propose = new SpyProposeKnowledgePort({ kind: "ok" });
    const livingVault = new SpyLivingVaultPort({
      kind: "plans",
      plans: [livingVaultPlan("lv-auto"), livingVaultPlan("lv-propose", true)],
    });

    const outcome = await runSourceIngestion(
      makeInput(),
      makeDeps({ commit, health, livingVault, proposeKnowledgeApproval: propose } as never),
    );

    expect(outcome.state).toBe("applied");
    // Still never committed.
    expect(commit.captured.slice(1).map((p) => String(p.planId))).toEqual(["lv-auto"]);
    // Exactly ONE mint attempt, for the PROPOSE plan, at the routing-bound workspace.
    expect(propose.calls).toHaveLength(1);
    expect(String(propose.calls[0]?.plan.planId)).toBe("lv-propose");
    expect(String(propose.calls[0]?.workspaceId)).toBe(String(WS));
    // A successful queue is surfaced too (operator-visible, distinct wording from a mint failure).
    expect(health.surfaced.some((f) => /queued 1 plan\(s\) for §9\.8 approval/i.test(f.message))).toBe(
      true,
    );
  });

  it("a_mint_failure_leaves_the_plan_withheld_and_surfaces — never a downgrade to auto-commit", async () => {
    const commit = new CapturingCommitPort();
    const health = new FakeSourceHealthSink();
    const propose = new SpyProposeKnowledgePort({ kind: "err" });
    const livingVault = new SpyLivingVaultPort({
      kind: "plans",
      plans: [livingVaultPlan("lv-propose-fails", true)],
    });

    const outcome = await runSourceIngestion(
      makeInput(),
      makeDeps({ commit, health, livingVault, proposeKnowledgeApproval: propose } as never),
    );

    expect(outcome.state).toBe("applied");
    // A mint FAILURE must never fall through to commit — the safe direction is "not committed."
    expect(commit.captured.map((p) => String(p.planId))).not.toContain("lv-propose-fails");
    expect(
      health.surfaced.some((f) => /could not be queued for approval.*mint_failed/i.test(f.message)),
    ).toBe(true);
    // No false "queued" claim alongside the failure.
    expect(health.surfaced.some((f) => /queued 1 plan\(s\)/i.test(f.message))).toBe(false);
  });

  it("a_propose_port_that_throws_never_auto_commits_either", async () => {
    const commit = new CapturingCommitPort();
    const health = new FakeSourceHealthSink();
    const propose = new SpyProposeKnowledgePort({ kind: "throws" });
    const livingVault = new SpyLivingVaultPort({
      kind: "plans",
      plans: [livingVaultPlan("lv-propose-throws", true)],
    });

    const outcome = await runSourceIngestion(
      makeInput(),
      makeDeps({ commit, health, livingVault, proposeKnowledgeApproval: propose } as never),
    );

    expect(outcome.state).toBe("applied");
    expect(commit.captured.map((p) => String(p.planId))).not.toContain("lv-propose-throws");
    expect(propose.calls).toHaveLength(1); // non-vacuity — the port really was consulted
    expect(health.surfaced.some((f) => /could not be queued for approval/i.test(f.message))).toBe(
      true,
    );
  });

  it("a_benign_run_with_no_propose_plans_mints_zero_approvals — non-vacuity control (L80)", async () => {
    const commit = new CapturingCommitPort();
    const health = new FakeSourceHealthSink();
    const propose = new SpyProposeKnowledgePort({ kind: "ok" });
    const livingVault = new SpyLivingVaultPort({
      kind: "plans",
      plans: [livingVaultPlan("lv-auto-only")], // AUTO tier only — nothing withheld
    });

    await runSourceIngestion(
      makeInput(),
      makeDeps({ commit, health, livingVault, proposeKnowledgeApproval: propose } as never),
    );

    expect(propose.calls).toHaveLength(0);
    expect(health.surfaced.some((f) => /queued .* plan\(s\) for §9\.8 approval/i.test(f.message))).toBe(
      false,
    );
  });

  it("the_auto_tier_still_commits_unchanged — explicit re-assertion, not assumed (L79)", async () => {
    const commit = new CapturingCommitPort();
    const propose = new SpyProposeKnowledgePort({ kind: "ok" });
    const livingVault = new SpyLivingVaultPort({
      kind: "plans",
      plans: [livingVaultPlan("lv-auto-1"), livingVaultPlan("lv-auto-2")],
    });

    const outcome = await runSourceIngestion(
      makeInput(),
      makeDeps({ commit, livingVault, proposeKnowledgeApproval: propose } as never),
    );

    expect(outcome.state).toBe("applied");
    expect(commit.captured.slice(1).map((p) => String(p.planId))).toEqual(["lv-auto-1", "lv-auto-2"]);
    // The propose port is never consulted for AUTO-tier plans.
    expect(propose.calls).toHaveLength(0);
  });

  it("a_propose_tier_plan_never_reaches_commit — the load-bearing safety pin", async () => {
    // MUTATION-VERIFIED (not merely asserted): sourceIngestion.ts's `if (livingVaultPlan.requiresApproval
    // !== false)` was temporarily inverted to `=== false` — this THIS test failed (AssertionError:
    // 'lv-propose-only' found in the committed set), confirming it genuinely discriminates a regression
    // that lets a PROPOSE-tier plan reach commit. A separate, milder mutation (relaxing to a truthy
    // check, `if (livingVaultPlan.requiresApproval)`) does NOT red this test (an explicit `true` stays
    // truthy either way) — that mutation is instead caught by the sibling
    // `unknown_approval_flag_fails_closed` test (an absent flag becomes falsy under it and wrongly
    // commits). Both mutations were reverted; `git diff --stat` confirmed no leftover.
    const commit = new CapturingCommitPort();
    const propose = new SpyProposeKnowledgePort({ kind: "ok" });
    const livingVault = new SpyLivingVaultPort({
      kind: "plans",
      plans: [livingVaultPlan("lv-propose-only", true)],
    });

    await runSourceIngestion(
      makeInput(),
      makeDeps({ commit, livingVault, proposeKnowledgeApproval: propose } as never),
    );

    expect(commit.captured.map((p) => String(p.planId))).not.toContain("lv-propose-only");
  });

  it("planIds_survive_the_worker_seam_in_order — (b) the batch-undo unit reflects COMMITTED plans only", async () => {
    // Deliberately includes a PROPOSE plan between two AUTO plans: the batch-undo unit must carry
    // only what actually committed (order preserved), never an uncommitted/withheld plan's id —
    // there is nothing to undo for a plan that was never written.
    const commit = new CapturingCommitPort();
    const propose = new SpyProposeKnowledgePort({ kind: "ok" });
    const livingVault = new SpyLivingVaultPort({
      kind: "plans",
      plans: [
        livingVaultPlan("lv-auto-first"),
        livingVaultPlan("lv-propose-mid", true),
        livingVaultPlan("lv-auto-last"),
      ],
    });

    const outcome = await runSourceIngestion(
      makeInput(),
      makeDeps({ commit, livingVault, proposeKnowledgeApproval: propose } as never),
    );

    expect((outcome as unknown as { livingVaultPlanIds: readonly string[] }).livingVaultPlanIds).toEqual([
      "lv-auto-first",
      "lv-auto-last",
    ]);
  });

  it("unknown_approval_flag_fails_closed — a plan with NO requiresApproval is withheld, not committed, AND MINTED (13.8i)", async () => {
    // Strict `!== false`: only an explicitly auto-tier plan is auto-committed, so a malformed/older
    // plan shape can never be treated as pre-approved. 13.8i sharpens what "withheld" now means: after
    // this slice, withheld ⇒ queued for a human, not dropped — so an absent-flag plan must ALSO mint an
    // Approval, not merely stay uncommitted. Both branches (withhold-from-commit, attempt-to-mint) key
    // on the SAME `!== false` predicate — a second, divergent condition for the mint would be the bug.
    const commit = new CapturingCommitPort();
    const propose = new SpyProposeKnowledgePort({ kind: "ok" });
    const noFlag = { ...livingVaultPlan("lv-unknown") } as Record<string, unknown>;
    delete noFlag.requiresApproval;
    const livingVault = new SpyLivingVaultPort({
      kind: "plans",
      plans: [noFlag as unknown as KnowledgeMutationPlan],
    });

    await runSourceIngestion(
      makeInput(),
      makeDeps({ commit, livingVault, proposeKnowledgeApproval: propose } as never),
    );

    expect(commit.captured).toHaveLength(1); // the source note only — never auto-committed
    expect(propose.calls).toHaveLength(1); // AND minted — not silently dropped
    expect(String(propose.calls[0]?.plan.planId)).toBe("lv-unknown");
  });

  it("rewrite_fault_never_partial_commits — a FAULTING rewrite ⇒ fail-safe single-note commit + surfaced", async () => {
    const commit = new CapturingCommitPort();
    const health = new FakeSourceHealthSink();
    const livingVault = new SpyLivingVaultPort({
      kind: "err",
      failure: { code: "rewrite_failed", message: "synthesis unavailable" },
    });
    const outcome = await runSourceIngestion(makeInput(), makeDeps({ commit, health, livingVault }));

    // NON-VACUITY: the port must actually have been consulted — otherwise this test would pass
    // identically against a driver that ignores the dep entirely (which is exactly today's state).
    expect(livingVault.calls).toHaveLength(1);
    // The ingest still lands its own note (the pre-13.8d guarantee) — the living vault is best-effort.
    expect(outcome.state).toBe("applied");
    expect(commit.captured).toHaveLength(1);
    // inv-5: the degrade is never silent.
    expect(health.surfaced.some((f) => /living[- ]?vault/i.test(f.message))).toBe(true);
  });

  it("rewrite_throw_never_propagates — a THROWING rewrite ⇒ same fail-safe path, driver never throws", async () => {
    const commit = new CapturingCommitPort();
    const health = new FakeSourceHealthSink();
    const livingVault = new SpyLivingVaultPort({ kind: "throws" });

    // A port is contractually never-throws (§16), but a THROWN error here must not take the pipeline
    // down with it — the source note is already derived and must still commit.
    const outcome = await runSourceIngestion(makeInput(), makeDeps({ commit, health, livingVault }));

    expect(livingVault.calls).toHaveLength(1); // non-vacuity, as above
    expect(outcome.state).toBe("applied");
    expect(commit.captured).toHaveLength(1);
    expect(health.surfaced.some((f) => /living[- ]?vault/i.test(f.message))).toBe(true);
  });

  it("no_second_writer — every emitted mutation reaches Markdown ONLY via the commit port (safety rule 1)", async () => {
    const commit = new CapturingCommitPort();
    const plans = [livingVaultPlan("lv-a"), livingVaultPlan("lv-b")];
    const livingVault = new SpyLivingVaultPort({ kind: "plans", plans });
    await runSourceIngestion(makeInput(), makeDeps({ commit, livingVault }));

    // Nothing the rewrite produced bypassed the commit port: the captured set is exactly
    // {the derived source note} ∪ {the rewrite's plans}, with no extra and none missing.
    expect(commit.captured.slice(1).map((p) => String(p.planId))).toEqual(["lv-a", "lv-b"]);

    // …and the driver introduces NO direct write path of its own (it is workflow-sandbox code:
    // an `fs` call here would be a determinism bug as well as a one-writer breach).
    const driver = readFileSync(
      resolve(dirname(fileURLToPath(import.meta.url)), "../src/workflows/sourceIngestion.ts"),
      "utf8",
    );
    expect(driver).not.toMatch(/writeFile|appendFile|mkdir|node:fs/);
  });

  it("not_armed_and_mint_failed_route_to_distinct_failureClasses — 13.8i-B: a precondition-HELD blocked mint reads differently from an ATTEMPT-errored one", async () => {
    const health = new FakeSourceHealthSink();
    const notArmed = new SpyProposeKnowledgePort({ kind: "not_armed" });
    const livingVaultA = new SpyLivingVaultPort({
      kind: "plans",
      plans: [livingVaultPlan("lv-not-armed", true)],
    });
    await runSourceIngestion(
      makeInput(),
      makeDeps({ health, livingVault: livingVaultA, proposeKnowledgeApproval: notArmed } as never),
    );

    const mintFailed = new SpyProposeKnowledgePort({ kind: "err" });
    const health2 = new FakeSourceHealthSink();
    const livingVaultB = new SpyLivingVaultPort({
      kind: "plans",
      plans: [livingVaultPlan("lv-mint-failed", true)],
    });
    await runSourceIngestion(
      makeInput(),
      makeDeps({ health: health2, livingVault: livingVaultB, proposeKnowledgeApproval: mintFailed } as never),
    );

    expect(health.surfaced.some((f) => f.failureClass === "write_through_blocked")).toBe(true);
    expect(health.surfaced.some((f) => f.failureClass === "write_through_failed")).toBe(false);
    expect(health2.surfaced.some((f) => f.failureClass === "write_through_failed")).toBe(true);
    expect(health2.surfaced.some((f) => f.failureClass === "write_through_blocked")).toBe(false);
  });

  it("zero_cards_rests_on_empty_plans_not_on_port_absence — the SAME bound port mints 0 when plans are empty and 1 when they are not", async () => {
    // ⭐ 13.8i-B: the default-boot zero-cards guarantee rests on livingVault staying dormant (empty plan
    // sets), NOT on this port being absent — proven here by holding the port instance CONSTANT and
    // varying only the plan set, so the port's presence cannot be what explains either outcome.
    const boundPort = new SpyProposeKnowledgePort({ kind: "ok" });

    const emptyLivingVault = new SpyLivingVaultPort({ kind: "plans", plans: [] });
    await runSourceIngestion(
      makeInput(),
      makeDeps({ livingVault: emptyLivingVault, proposeKnowledgeApproval: boundPort } as never),
    );
    expect(boundPort.calls).toHaveLength(0);

    const nonEmptyLivingVault = new SpyLivingVaultPort({
      kind: "plans",
      plans: [livingVaultPlan("lv-contrast", true)],
    });
    await runSourceIngestion(
      makeInput(),
      makeDeps({ livingVault: nonEmptyLivingVault, proposeKnowledgeApproval: boundPort } as never),
    );
    expect(boundPort.calls).toHaveLength(1); // the SAME port instance — only the plan set changed
  });
});

// --- 24.58: per-plan health identity inside the commit loop ------------------

/** Fails the commit for the named planIds with the given code; every other plan succeeds. */
class PerPlanFailingCommitPort implements CommitKnowledgePort {
  private n = 0;
  constructor(private readonly failures: Readonly<Record<string, KnowledgeCommitFailureCode>>) {}
  commit(
    plan: KnowledgeMutationPlan,
  ): Promise<Result<KnowledgeCommitSuccess, KnowledgeCommitFailure>> {
    const code = this.failures[String(plan.planId)];
    if (code !== undefined) {
      return Promise.resolve(err({ code, message: `fake per-plan failure: ${code}` }));
    }
    this.n += 1;
    return Promise.resolve(ok({ revisionId: `rev-pp-${this.n}`, replayed: false }));
  }
}

describe("runSourceIngestion — per-plan health identity in the living-vault commit loop (24.58)", () => {
  it("two plans failing with the SAME FailureClass do not collapse onto one health item", async () => {
    // `ownership_violation` and `workspace_path_violation` BOTH map to `isolation_breach`
    // (commitFailureClass). The dedupe key is `failureClass|subjectRef` AND is used as the
    // item's `id`, so while the loop surfaced a per-RUN subjectRef both plans produced the
    // IDENTICAL key `isolation_breach|<workflowId>` — the second UPSERTED the first and the
    // first breach's message was lost. The failure is per-PLAN, so the identity must be too.
    const health = new FakeSourceHealthSink();
    const commit = new PerPlanFailingCommitPort({
      "lv-a": "ownership_violation",
      "lv-b": "workspace_path_violation",
    });
    const livingVault = new SpyLivingVaultPort({
      kind: "plans",
      plans: [livingVaultPlan("lv-a"), livingVaultPlan("lv-b")],
    });

    await runSourceIngestion(makeInput(), makeDeps({ health, commit, livingVault }));

    const breaches = health.surfaced.filter((f) => f.failureClass === "isolation_breach");
    expect(breaches).toHaveLength(2);
    // THE ASSERTION THAT MATTERS: distinct dedupe identity per plan. Two items with the same
    // (failureClass, subjectRef) are ONE item downstream however many times they are surfaced.
    expect(new Set(breaches.map((f) => f.subjectRef)).size).toBe(2);
  });

  it("the SAME plan failing twice still shares one identity (the dedupe control)", async () => {
    // The over-broad-fix control (L80): dedupe exists for a reason. A subjectRef widened to
    // uniqueness would pass the test above happily and flood the operator surface. Two runs
    // of the SAME plan under the SAME run must still coalesce.
    const mk = (): { health: FakeSourceHealthSink; run: () => Promise<unknown> } => {
      const health = new FakeSourceHealthSink();
      const commit = new PerPlanFailingCommitPort({ "lv-dup": "ownership_violation" });
      const livingVault = new SpyLivingVaultPort({
        kind: "plans",
        plans: [livingVaultPlan("lv-dup")],
      });
      return {
        health,
        run: () => runSourceIngestion(makeInput(), makeDeps({ health, commit, livingVault })),
      };
    };
    const a = mk();
    await a.run();
    const b = mk();
    await b.run();

    const subjA = a.health.surfaced.find((f) => f.failureClass === "isolation_breach")?.subjectRef;
    const subjB = b.health.surfaced.find((f) => f.failureClass === "isolation_breach")?.subjectRef;
    expect(subjA).toBeDefined();
    // Same plan, same run identity ⇒ same dedupe subject. This is what must NOT become unique.
    expect(subjA).toBe(subjB);
  });
});
