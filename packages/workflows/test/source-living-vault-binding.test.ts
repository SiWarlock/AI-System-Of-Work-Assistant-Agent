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
    // Withheld ≠ silently dropped (inv-5).
    expect(health.surfaced.some((f) => /withheld 1 approval-required/i.test(f.message))).toBe(true);
  });

  it("unknown_approval_flag_fails_closed — a plan with NO requiresApproval is withheld, not committed", async () => {
    // Strict `!== false`: only an explicitly auto-tier plan is auto-committed, so a malformed/older
    // plan shape can never be treated as pre-approved.
    const commit = new CapturingCommitPort();
    const noFlag = { ...livingVaultPlan("lv-unknown") } as Record<string, unknown>;
    delete noFlag.requiresApproval;
    const livingVault = new SpyLivingVaultPort({
      kind: "plans",
      plans: [noFlag as unknown as KnowledgeMutationPlan],
    });

    await runSourceIngestion(makeInput(), makeDeps({ commit, livingVault }));

    expect(commit.captured).toHaveLength(1); // the source note only
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
});
