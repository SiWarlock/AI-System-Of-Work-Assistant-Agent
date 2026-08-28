// spec(safety rule 7 / task I3, restored R1 2026-08-27, REWRITTEN 2026-08-27) — SCOPE: the
// INCIDENTAL Broker rejection TEXT on the ERR arm of readOnlyAgentJob.ts's generic activity —
// reached by all four registered output-workflow families (dailyBriefRunAgent,
// periodReviewRunAgent, projectSyncSynthesizeNarrative, crossCalendarProposeWindowsAgent). Never
// the OK arm's mapped candidate PAYLOAD, which MUST cross unredacted (see readOnlyAgentJob.ts's own
// SCHEMA_REJECTED_MESSAGE doc comment + root CLAUDE.md's "THE SCOPE BOUNDARY").
//
// WHY THIS SUITE WAS REWRITTEN — identical to the runAgentJob sibling's: its predecessor cast
// `branch: branch as never` and fed BrokerStage values into the `JobBranch`-typed field, so it was
// GREEN over a production mapping that read the WRONG field. `defaultMapRejection` tested the
// `JobBranch` for the substrings "schema" / "egress" / "budget", which are `BrokerStage` concepts;
// no JobBranch member contains "schema" or "egress", so `schema_rejected` and `egress_vetoed` were
// UNREACHABLE and the SCHEMA_REJECTED_MESSAGE redaction was dead code. Every rejection below is a
// REALISTIC, fully-typed `BrokerRejection` with NO cast in its construction.
//
// This suite pins: (1) `schema_rejected` is reachable and drops the poisoned text; (2) every other
// stage forwards the Broker's real message; (3) the mapping is TOTAL over the closed BrokerStage
// union; (4) the old branch predicate is shown wrong on the same inputs; (5) the OK arm is intact.
//
// (5) IS DUPLICATED ON PURPOSE, AND THIS FILE IS NOT ITS DURABLE HOME. Until task C4 this suite
// held the ONLY pin repo-wide on `readOnlyAgentJob`'s ok-arm candidate payload — a payload pin
// living inside a REDACTION suite, i.e. inside exactly the kind of file a future hardening round
// rewrites or replaces (this rewrite is that risk realised, benignly). The durable home is
// `packages/workflows/test/payload-integrity-pins.test.ts` (pin 7/7), which is mutation-proved
// against the same production expression and is independent of this file. Keep (5) here anyway —
// it is what makes this suite's OWN scope claim (ERR-arm text only) self-evidencing — but do not
// treat it as the coverage.
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
import { createReadOnlyAgentJobActivity, BROKER_STAGE_FAILURE_CODE } from "../src/activities/readOnlyAgentJob";
import type {
  ReadOnlyAgentBroker,
  ReadOnlyAgentJobInputs,
  ReadOnlyAgentJobDeps,
} from "../src/activities/readOnlyAgentJob";

const POISON_FIELDS = "owner_PZN9F3A1BSECRET-leak";
const POISON_PATH = "/Users/x/vault/other-workspace/SECRETMARKER.md";
const POISONED = `no-inference rejection (REQ-F-017): unstated/unbacked fields not coerced [${POISON_FIELDS}] at ${POISON_PATH}`;
const FIXED_SCHEMA_MESSAGE = "read-only agent job output failed the candidate-data schema gate";

function jobInputs(overrides: Partial<ReadOnlyAgentJobInputs> = {}): ReadOnlyAgentJobInputs {
  return {
    workflowRunId: workflowId("wf-i3-2"),
    workspaceId: workspaceId("ws-personal"),
    capability: "daily_brief.synthesize",
    outputSchemaId: "sow:daily-brief-output",
    maxRuntimeSeconds: 60,
    idempotencyKey: "idem-i3-2",
    ...overrides,
  };
}

function brokerReturning(outcome: BrokerOutcome): ReadOnlyAgentBroker {
  return { runJob: () => Promise.resolve(outcome) };
}

// ── the realistic rejection fixture ─────────────────────────────────────────
// What the REAL broker stamps at each stage — read off its own call sites in
// packages/providers/src/broker/broker.ts + the gates it composes. Note egress_veto's branch is
// `failed_retryable` and schema_gate's is `rejected`: NEITHER carries the concept its stage names.
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

/** A REALISTIC `BrokerRejection`. Fully typed — no cast anywhere. */
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
      refs: ["ref:job:idem-i3-2"],
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

/** The mapping this fix REPLACED, reproduced verbatim so the before/after is provable. */
function legacyBranchSubstringMapping(outcome: BrokerOutcome): string {
  if (outcome.ok) return "provider_failed";
  const branch = String(outcome.error.branch);
  if (branch.includes("schema")) return "schema_rejected";
  if (branch.includes("egress")) return "egress_vetoed";
  if (branch.includes("budget")) return "budget_exceeded";
  return "provider_failed";
}

type Ctx = Record<string, never>;
interface Output {
  readonly fields: unknown;
}

function baseDeps(
  broker: ReadOnlyAgentBroker,
  mapCandidate: () => Output,
): ReadOnlyAgentJobDeps<Ctx, Output> {
  return {
    broker,
    inputs: jobInputs(),
    buildEgress: () => ({}) as never,
    buildMatrix: () => ({}) as never,
    buildWorkspace: () => ({ type: "personal_life" as never, dataOwner: "user" as never }),
    mapCandidate,
  };
}

function port(outcome: BrokerOutcome) {
  return createReadOnlyAgentJobActivity(
    baseDeps(brokerReturning(outcome), () => ({ fields: "unused" })),
  );
}

describe("spec(rule 7 / I3) readOnlyAgentJob — Broker rejection code is derived from the closed STAGE, and the schema-gate redaction actually fires", () => {
  it("no JobBranch member contains the substrings the old predicate searched — `schema_rejected` and `egress_vetoed` were structurally unreachable", () => {
    for (const branch of JOB_BRANCHES) {
      expect(branch.includes("schema")).toBe(false);
      expect(branch.includes("egress")).toBe(false);
    }
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
      const res = await port(outcome).run({});
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe(fixed);
      expect(res.error.code).not.toBe(legacy);
    }
  });

  it("schema_gate: the poisoned no-inference message NEVER crosses; the fixed sentence + the closed code do", async () => {
    const res = await port(rejection("schema_gate", POISONED)).run({});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("schema_rejected");
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(POISON_FIELDS);
    expect(serialized).not.toContain(POISON_PATH);
    expect(serialized).not.toContain("no-inference rejection");
    expect(res.error.message).toBe(FIXED_SCHEMA_MESSAGE);
  });

  it("the SAME poisoned message crossed VERBATIM under the old predicate — it produced `provider_failed`, whose message is forwarded untouched", async () => {
    expect(legacyBranchSubstringMapping(rejection("schema_gate", POISONED))).toBe("provider_failed");
    const asProviderFailure = await port(rejection("run", POISONED)).run({});
    expect(asProviderFailure.ok).toBe(false);
    if (asProviderFailure.ok) return;
    expect(asProviderFailure.error.code).toBe("provider_failed");
    expect(JSON.stringify(asProviderFailure)).toContain(POISON_FIELDS);
  });

  it("the exported table is TOTAL over the closed BrokerStage union — every stage has an entry, no stage falls into a default", () => {
    for (const stage of BrokerStage) {
      expect(BROKER_STAGE_FAILURE_CODE[stage]).toBeTypeOf("string");
    }
    expect(Object.keys(BROKER_STAGE_FAILURE_CODE).sort()).toEqual([...BrokerStage].sort());
  });

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
      const res = await port(rejection(stage, message)).run({});
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe(EXPECTED_CODE[stage]);
      expect(res.error.message).toBe(stage === "schema_gate" ? FIXED_SCHEMA_MESSAGE : message);
    });
  }

  it("the schema gate's OTHER denial — `tool_policy_violation` — is ALSO replaced here: this leg keys on the derived code, i.e. on the whole `schema_gate` STAGE", async () => {
    const toolPolicyMessage =
      "output implies a mutating external action but the job's ToolPolicy forbids mutation (read_only / !allowsMutating) — rejected, not coerced";
    const res = await port(
      rejection("schema_gate", toolPolicyMessage, { reason: "tool_policy_violation" }),
    ).run({});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("schema_rejected");
    // A deliberate, documented small over-reach (SCHEMA_REJECTED_MESSAGE's doc comment): the
    // sentence it replaces is SoW-authored and carries no model text, but keying on the STAGE
    // guarantees EVERY schema-gate message is replaced, including one from a custom SchemaGate
    // that stamps some other `reason`. The sibling source leg keys on `reason` and forwards this.
    expect(res.error.message).toBe(FIXED_SCHEMA_MESSAGE);
  });

  it("a cooperative provider cancel (stage `run`, branch `cancelled_budget`) is `provider_failed`, NOT `budget_exceeded` — the branch names a lifecycle state, not a budget gate", async () => {
    const cancelMessage = "provider run cancelled; output discarded before any hand-off";
    const outcome = rejection("run", cancelMessage, {
      branch: "cancelled_budget",
      reason: "provider_cancelled",
      jobState: "cancelled_budget",
    });
    expect(legacyBranchSubstringMapping(outcome)).toBe("budget_exceeded");
    const res = await port(outcome).run({});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("provider_failed");
    expect(res.error.message).toBe(cancelMessage);
  });

  it("a CONTRACT-VIOLATING rejection with no `stage` at all still yields a typed code — the boundary guard, not a type-level default", async () => {
    // A hand-rolled / foreign BrokerOutcome (this shape exists in the wild: see
    // test/output-activities/factory.test.ts's fake broker). It is NOT a legal BrokerRejection, so
    // the cast is the honest way to express "data that violates the contract" — unlike the cast
    // this suite removed, which was disguising a legal-looking value in the WRONG field.
    const malformed = err({ message: "fake broker rejection" } as unknown as BrokerRejection);
    const res = await port(malformed).run({});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // Never `undefined` — a workflow driver switches on this.
    expect(res.error.code).toBe("provider_failed");
    expect(typeof res.error.code).toBe("string");
    // And the message is forwarded, since nothing identifies it as a schema-gate rejection.
    expect(res.error.message).toBe("fake broker rejection");
  });

  it("a REAL budget breach (stage `budget_post`) still reports `budget_exceeded` — the budget signal is preserved where a budget gate actually denied", async () => {
    const breach =
      "budget cap breached — cost $0.42 > cap $0.25; job cancelled with no partial side effect";
    const res = await port(rejection("budget_post", breach)).run({});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("budget_exceeded");
    expect(res.error.message).toBe(breach);
  });

  it("provider_failed: two DIFFERENT real messages render DIFFERENTLY (a 401 vs a timeout are actionable, distinct diagnostics)", async () => {
    const authFailure = await port(
      rejection("run", "provider auth rejected: 401 Unauthorized"),
    ).run({});
    const timeout = await port(rejection("run", "provider run timed out after 60000ms")).run({});
    expect(authFailure.ok).toBe(false);
    expect(timeout.ok).toBe(false);
    if (authFailure.ok || timeout.ok) return;
    expect(authFailure.error.code).toBe("provider_failed");
    expect(timeout.error.code).toBe("provider_failed");
    // Mutation-provable: collapsing both onto one fixed string per code (the reverted behavior)
    // makes this assertion RED.
    expect(authFailure.error.message).not.toBe(timeout.error.message);
    expect(authFailure.error.message).toBe("provider auth rejected: 401 Unauthorized");
    expect(timeout.error.message).toBe("provider run timed out after 60000ms");
  });

  it("the OK arm's mapped candidate output still crosses INTACT — the ERR-arm redaction never touches the payload", async () => {
    const output: Output = { fields: { owner: "Erin" } };
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
    const activityPort = createReadOnlyAgentJobActivity(
      baseDeps(brokerReturning(ok(acceptedOutcome)), () => output),
    );
    const res = await activityPort.run({});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Reference-identical: mapCandidate's own return value crosses UNTOUCHED, never a redacted copy.
    expect(res.value).toBe(output);
  });
});
