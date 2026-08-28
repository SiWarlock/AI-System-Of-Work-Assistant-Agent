// spec(safety rule 7 / task I3, restored R1 2026-08-27, REWRITTEN 2026-08-27) — SCOPE: the
// INCIDENTAL Broker rejection TEXT on the ERR arm of runAgentJob.ts's meeting.close activity —
// never the OK arm's candidate PAYLOAD (the data the next step validates/commits, which MUST cross
// unredacted; see runAgentJob.ts's own SCHEMA_REJECTED_MESSAGE doc comment + root CLAUDE.md's "THE
// SCOPE BOUNDARY").
//
// WHY THIS SUITE WAS REWRITTEN. Its predecessor built every rejection through a helper that cast
// `branch: branch as never` and then fed it BrokerStage values ("schema_gate", "egress_veto",
// "budget_pre"). The cast was the only reason it compiled, and it made the suite GREEN over a
// production mapping that was DEAD: `defaultMapRejection` read `outcome.error.branch` — a
// `JobBranch` (`accepted | rejected | cancelled_budget | failed_retryable | failed_terminal`) — and
// tested it for the substrings "schema" / "egress" / "budget", which are `BrokerStage` concepts. No
// JobBranch member contains "schema" or "egress", so `schema_rejected` and `egress_vetoed` were
// UNREACHABLE in production, and with `schema_rejected` unreachable the SCHEMA_REJECTED_MESSAGE
// redaction was dead code: a schema-gate no-inference rejection quoting MODEL-AUTHORED FIELD NAMES
// (packages/providers/src/broker/schema-gate.ts:124) crossed VERBATIM out of `meetingRunAgentJob`.
//
// Every rejection below is now a REALISTIC, fully-typed `BrokerRejection` — legal `BrokerStage` in
// `stage`, legal `JobBranch` in `branch`, paired exactly as the real broker pairs them, with NO
// `as never` / `as any` anywhere in its construction. This suite pins:
//   (1) `schema_rejected` is REACHABLE from a realistic schema-gate rejection, and drops the
//       poisoned text — never crosses — while the closed `code` still crosses byte-identically;
//   (2) every OTHER stage RESTORES the Broker's real message — SoW-authored diagnostic text;
//   (3) the mapping is TOTAL over the closed BrokerStage union and matches the documented table;
//   (4) the OLD branch-substring predicate is shown, on the same realistic inputs, to produce the
//       WRONG answer — the before/after of this fix, pinned;
//   (5) the OK arm's mapped candidate output still crosses INTACT, unredacted.
import { describe, it, expect } from "vitest";
import { ok, err, workspaceId, workflowId } from "@sow/contracts";
import { buildAuditSignal } from "@sow/policy";
import { BrokerStage, JOB_BRANCHES } from "@sow/providers";
import type {
  BrokerOutcome,
  BrokerRejection,
  BrokerAccepted,
  JobBranch,
  AgentJobState,
} from "@sow/providers";
import { createRunAgentJobActivity } from "../src/activities/runAgentJob";
import type { MeetingBroker, MeetingJobInputs } from "../src/activities/runAgentJob";
import { makeMeetingContext, makeAgentExtraction } from "./support/meeting-fakes";

const POISON_FIELDS = "owner_PZN9F3A1BSECRET-leak";
const POISON_PATH = "/Users/x/vault/other-workspace/SECRETMARKER.md";

function meetingInputs(overrides: Partial<MeetingJobInputs> = {}): MeetingJobInputs {
  return {
    workflowRunId: workflowId("wf-i3-1"),
    workspaceId: workspaceId("ws-employer"),
    capability: "meeting.close",
    outputSchemaId: "sow:meeting-close-output",
    maxRuntimeSeconds: 120,
    idempotencyKey: "idem-i3-1",
    ...overrides,
  };
}

function brokerReturning(outcome: BrokerOutcome): MeetingBroker {
  return { runJob: () => Promise.resolve(outcome) };
}

// ── the realistic rejection fixture ─────────────────────────────────────────
//
// What the REAL broker stamps at each stage, read off its own call sites in
// packages/providers/src/broker/broker.ts:
//   admission        → reject(..., "rejected", ...)                  reason: a §5 DenialReason
//   route_resolution → failClosedNoProvider(...)  branch failed_retryable
//   egress_veto      → failClosedNoProvider(...)  branch failed_retryable   ← NOTHING says "egress"
//   health           → failClosedNoProvider(...)  branch failed_retryable
//   budget_pre       → the gate's own branch; budget-enforcer.ts:229 → failed_terminal
//   run              → the runner's branch, or "cancelled_budget" on a cooperative cancel
//   budget_post      → reject(..., "cancelled_budget", ...)          budget-enforcer.ts:255
//   schema_gate      → the gate's own branch; schema-gate.ts:202 → "rejected"  ← NOTHING says "schema"
//   emit             → lifecycleFault(...)        branch failed_terminal
interface RealRejectionShape {
  readonly branch: JobBranch;
  readonly reason: BrokerRejection["reason"];
  readonly jobState: AgentJobState;
}

const REAL_REJECTION: Readonly<Record<BrokerStage, RealRejectionShape>> = {
  admission: { branch: "rejected", reason: "UNTRUSTED_CONTENT_MUTATING_TOOL", jobState: "created" },
  route_resolution: { branch: "failed_retryable", reason: "NO_ROUTE_FOR_CAPABILITY", jobState: "admitted" },
  egress_veto: { branch: "failed_retryable", reason: "EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED", jobState: "admitted" },
  health: { branch: "failed_retryable", reason: "provider_unavailable", jobState: "admitted" },
  budget_pre: { branch: "failed_terminal", reason: "budget_exceeded", jobState: "provider_selected" },
  run: { branch: "failed_retryable", reason: "provider_error", jobState: "running" },
  budget_post: { branch: "cancelled_budget", reason: "budget_exceeded", jobState: "cancelled_budget" },
  schema_gate: { branch: "rejected", reason: "schema_rejected", jobState: "rejected" },
  emit: { branch: "failed_terminal", reason: "lifecycle_fault", jobState: "schema_validated" },
};

/** A REALISTIC `BrokerRejection`. Fully typed — no cast anywhere. `over` lets one field be varied
 * off the real pairing (used to prove the mapping keys on `stage`, not on `branch`). */
function rejection(
  stage: BrokerStage,
  message: string,
  over: Partial<RealRejectionShape> = {},
): BrokerOutcome {
  const real = REAL_REJECTION[stage];
  const rejected: BrokerRejection = {
    stage,
    reason: over.reason ?? real.reason,
    message,
    audit: buildAuditSignal({
      actor: "broker:test",
      event: `broker.${stage}.rejected`,
      refs: ["ref:job:idem-i3-1"],
      payloadHash: "sha256:deadbeef",
      beforeSummary: "running",
      afterSummary: `rejected at ${stage}`,
    }),
    jobState: over.jobState ?? real.jobState,
    branch: over.branch ?? real.branch,
    retryable: false,
    audits: [],
  };
  return err(rejected);
}

/** The mapping this fix REPLACED, reproduced verbatim so the before/after is provable on the same
 * realistic inputs rather than asserted in a comment. */
function legacyBranchSubstringMapping(outcome: BrokerOutcome): string {
  if (outcome.ok) return "provider_failed";
  const branch = String(outcome.error.branch);
  if (branch.includes("schema")) return "schema_rejected";
  if (branch.includes("egress")) return "egress_vetoed";
  if (branch.includes("budget")) return "budget_exceeded";
  return "provider_failed";
}

function port(outcome: BrokerOutcome) {
  return createRunAgentJobActivity({
    broker: brokerReturning(outcome),
    inputs: meetingInputs(),
    buildEgress: () => ({}) as never,
    buildMatrix: () => ({}) as never,
    buildWorkspace: () => ({ type: "employer" as never, dataOwner: "employer" as never }),
    mapCandidate: () => makeAgentExtraction(),
  });
}

const POISONED = `no-inference rejection (REQ-F-017): unstated/unbacked fields not coerced [${POISON_FIELDS}] at ${POISON_PATH}`;

describe("spec(rule 7 / I3) runAgentJob — Broker rejection code is derived from the closed STAGE, and the schema-gate redaction actually fires", () => {
  // ── (4) the defect itself: the branch NEVER carried these concepts ────────
  it("no JobBranch member contains the substrings the old predicate searched — `schema_rejected` and `egress_vetoed` were structurally unreachable", () => {
    for (const branch of JOB_BRANCHES) {
      expect(branch.includes("schema")).toBe(false);
      expect(branch.includes("egress")).toBe(false);
    }
    // Exactly one branch contains "budget" — and it names a CANCEL, not a budget gate.
    expect(JOB_BRANCHES.filter((b) => b.includes("budget"))).toEqual(["cancelled_budget"]);
  });

  it("BEFORE/AFTER on the same realistic rejections: the old branch predicate answers wrong where the new stage mapping answers right", async () => {
    const cases: ReadonlyArray<{ stage: BrokerStage; legacy: string; fixed: string }> = [
      { stage: "schema_gate", legacy: "provider_failed", fixed: "schema_rejected" },
      { stage: "egress_veto", legacy: "provider_failed", fixed: "egress_vetoed" },
      { stage: "budget_pre", legacy: "provider_failed", fixed: "budget_exceeded" },
    ];
    for (const { stage, legacy, fixed } of cases) {
      const outcome = rejection(stage, "diagnostic text");
      expect(legacyBranchSubstringMapping(outcome)).toBe(legacy);
      const res = await port(outcome).run(makeMeetingContext());
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe(fixed);
      expect(res.error.code).not.toBe(legacy);
    }
  });

  // ── (1) the redaction now fires ───────────────────────────────────────────
  it("schema_gate: the poisoned no-inference message NEVER crosses; the fixed sentence + the closed code do", async () => {
    const res = await port(rejection("schema_gate", POISONED)).run(makeMeetingContext());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("schema_rejected");
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(POISON_FIELDS);
    expect(serialized).not.toContain(POISON_PATH);
    expect(serialized).not.toContain("no-inference rejection");
    expect(res.error.message).toBe(
      "meeting.close broker output failed the candidate-data schema gate",
    );
  });

  it("the SAME poisoned message crossed VERBATIM under the old predicate — that mapping produced `provider_failed`, which the redaction never matched", async () => {
    const outcome = rejection("schema_gate", POISONED);
    // The old code's answer for this exact realistic rejection.
    expect(legacyBranchSubstringMapping(outcome)).toBe("provider_failed");
    // And `provider_failed` is a code whose message is forwarded untouched — as it is here, today,
    // for a genuinely non-schema failure. So under the old mapping the poison reached the caller.
    const asProviderFailure = await port(rejection("run", POISONED)).run(makeMeetingContext());
    expect(asProviderFailure.ok).toBe(false);
    if (asProviderFailure.ok) return;
    expect(asProviderFailure.error.code).toBe("provider_failed");
    expect(JSON.stringify(asProviderFailure)).toContain(POISON_FIELDS);
  });

  // ── (2) + (3) no over-redaction; the mapping is total and matches the table ─
  const EXPECTED_CODE: Readonly<Record<BrokerStage, string>> = {
    admission: "provider_failed",
    route_resolution: "provider_failed",
    egress_veto: "egress_vetoed",
    health: "provider_failed",
    budget_pre: "budget_exceeded",
    run: "provider_failed",
    budget_post: "budget_exceeded",
    schema_gate: "schema_rejected",
    emit: "provider_failed",
  };

  for (const stage of BrokerStage) {
    it(`stage "${stage}" -> ${EXPECTED_CODE[stage]}${stage === "schema_gate" ? " (message replaced)" : " (message forwarded VERBATIM)"}`, async () => {
      const message = `SoW-authored diagnostic for ${stage}`;
      const res = await port(rejection(stage, message)).run(makeMeetingContext());
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe(EXPECTED_CODE[stage]);
      if (stage === "schema_gate") {
        expect(res.error.message).toBe(
          "meeting.close broker output failed the candidate-data schema gate",
        );
      } else {
        expect(res.error.message).toBe(message);
      }
    });
  }

  it("the schema gate's OTHER denial — `tool_policy_violation` — is ALSO replaced here: this leg keys on the derived code, i.e. on the whole `schema_gate` STAGE", async () => {
    const toolPolicyMessage =
      "output implies a mutating external action but the job's ToolPolicy forbids mutation (read_only / !allowsMutating) — rejected, not coerced";
    const res = await port(
      rejection("schema_gate", toolPolicyMessage, { reason: "tool_policy_violation" }),
    ).run(makeMeetingContext());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("schema_rejected");
    // A deliberate, documented small over-reach (SCHEMA_REJECTED_MESSAGE's doc comment): the
    // sentence it replaces is SoW-authored and carries no model text, but keying on the STAGE
    // guarantees EVERY schema-gate message is replaced, including one from a custom SchemaGate
    // that stamps some other `reason`. The sibling source leg keys on `reason` and forwards this.
    expect(res.error.message).toBe(
      "meeting.close broker output failed the candidate-data schema gate",
    );
  });

  // ── the cancelled_budget decision, pinned ─────────────────────────────────
  it("a cooperative provider cancel (stage `run`, branch `cancelled_budget`) is `provider_failed`, NOT `budget_exceeded` — the branch names a lifecycle state, not a budget gate", async () => {
    const cancelMessage = "provider run cancelled; output discarded before any hand-off";
    const outcome = rejection("run", cancelMessage, {
      branch: "cancelled_budget",
      reason: "provider_cancelled",
      jobState: "cancelled_budget",
    });
    // The old predicate read the branch and claimed a budget breach that no budget gate found.
    expect(legacyBranchSubstringMapping(outcome)).toBe("budget_exceeded");
    const res = await port(outcome).run(makeMeetingContext());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("provider_failed");
    // Nothing is lost: the broker's own message says exactly what happened.
    expect(res.error.message).toBe(cancelMessage);
  });

  it("a REAL budget breach (stage `budget_post`) still reports `budget_exceeded` — the budget signal is preserved where a budget gate actually denied", async () => {
    const breach = "budget cap breached — cost $0.42 > cap $0.25; job cancelled with no partial side effect";
    const res = await port(rejection("budget_post", breach)).run(makeMeetingContext());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("budget_exceeded");
    expect(res.error.message).toBe(breach);
  });

  it("provider_failed: two DIFFERENT real messages render DIFFERENTLY (a 401 vs a timeout are actionable, distinct diagnostics)", async () => {
    const authFailure = await port(
      rejection("run", "provider auth rejected: 401 Unauthorized"),
    ).run(makeMeetingContext());
    const timeout = await port(rejection("run", "provider run timed out after 120000ms")).run(
      makeMeetingContext(),
    );
    expect(authFailure.ok).toBe(false);
    expect(timeout.ok).toBe(false);
    if (authFailure.ok || timeout.ok) return;
    expect(authFailure.error.code).toBe("provider_failed");
    expect(timeout.error.code).toBe("provider_failed");
    // Mutation-provable: collapsing both onto one fixed string per code (the reverted behavior)
    // makes this assertion RED.
    expect(authFailure.error.message).not.toBe(timeout.error.message);
    expect(authFailure.error.message).toBe("provider auth rejected: 401 Unauthorized");
    expect(timeout.error.message).toBe("provider run timed out after 120000ms");
  });

  // ── (5) the payload boundary ──────────────────────────────────────────────
  it("the OK arm's mapped candidate output still crosses INTACT — the ERR-arm redaction never touches the payload", async () => {
    const extraction = makeAgentExtraction();
    const acceptedOutcome: BrokerAccepted = {
      jobState: "accepted",
      route: {
        provider: "claude",
        model: "claude-x",
        endpoint: "local",
        egressClass: "local_zero_egress",
      } as unknown as BrokerAccepted["route"],
      candidate: { kind: "knowledge_mutation_plan", plan: {} as never },
      usage: {} as unknown as BrokerAccepted["usage"],
      audits: [],
      replayed: false,
    };
    const activityPort = createRunAgentJobActivity({
      broker: brokerReturning(ok(acceptedOutcome)),
      inputs: meetingInputs(),
      buildEgress: () => ({}) as never,
      buildMatrix: () => ({}) as never,
      buildWorkspace: () => ({ type: "employer" as never, dataOwner: "employer" as never }),
      mapCandidate: () => extraction,
    });
    const res = await activityPort.run(makeMeetingContext());
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Reference-identical: mapCandidate's own return value crosses UNTOUCHED, never a redacted copy.
    expect(res.value).toBe(extraction);
  });
});
