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
import { brokerRejectionNeedsFixedMessage } from "../src/activities/readOnlyAgentJob";
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
const FIXED_SCHEMA_MESSAGE =
  "meeting.close broker output failed the candidate-data schema gate: REQ-F-017 no-inference rejection (unbacked field names withheld)";
/** `output-normalizer.ts:132-134`'s fixed literal, verbatim — the ONLY message `toolPolicyDeny`
 *  can ever carry, because `enforceToolPolicyOnCandidate` is a concrete function, not a seam. */
const TOOL_POLICY_MESSAGE =
  "output implies a mutating external action but the job's ToolPolicy forbids mutation (read_only / !allowsMutating) — rejected, not coerced";

/**
 * `schema-gate.ts` reaches `schemaDeny` from SIX call sites, all stamping the SAME closed
 * `reason: "schema_rejected"` at the SAME `stage: "schema_gate"`. Exactly ONE — the no-inference
 * branch — interpolates MODEL-CHOSEN text (`ni.error.map((r) => r.field)`); the other five
 * interpolate the job's own schema id, `output-normalizer.ts`'s literal, or `universal-rules.ts`'s
 * fixed domain field names. The round before this one replaced FOUR of the five SoW-authored ones.
 */
const SCHEMA_GATE_SOW_AUTHORED_MESSAGES: readonly string[] = [
  "ajv structural gate rejected output against 'sow:meeting-close-output' (schema_violation)",
  "no model parser registered for 'sow:meeting-close-output'; refusing ajv-alone validation (LESSONS §3)",
  "model schema parse rejected output against 'sow:meeting-close-output' (Zod .refine/cross-field)",
  "output not normalizable to a candidate: no candidate mapping for outputSchemaId 'sow:meeting-close-output'",
  "§3 universal rule rejection (missing_key:canonicalObjectKey|idempotencyKey)",
];

/** `broker.ts:383` — `lifecycleFault("schema_gate", …)`. A real, real-Broker-reachable
 *  `stage: "schema_gate"` rejection whose reason is NEITHER `schema_rejected` NOR
 *  `tool_policy_violation`. No suite covered this cell, and the three legs DISAGREED on it. */
const SCHEMA_GATE_LIFECYCLE_FAULT_MESSAGE = "broker lifecycle fault at schema_gate";

/** Every token that must never appear in a redacted result, however the message was assembled. */
function expectNoModelText(serialized: string): void {
  expect(serialized).not.toContain(POISON_FIELDS);
  expect(serialized).not.toContain(POISON_PATH);
  expect(serialized).not.toContain("not coerced [");
}

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
    expectNoModelText(JSON.stringify(res));
    expect(res.error.message).toBe(FIXED_SCHEMA_MESSAGE);
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

  // EVERY stage forwards a SoW-authored diagnostic verbatim — INCLUDING `schema_gate`. The
  // redaction is keyed on the ONE no-inference message, not on the stage, so a schema-gate
  // rejection carrying SoW-authored text keeps it. Before this change the `schema_gate` row here
  // expected the fixed sentence, i.e. it pinned the collapse.
  for (const stage of BrokerStage) {
    it(`stage "${stage}" -> ${EXPECTED_CODE[stage]} (SoW-authored message forwarded VERBATIM)`, async () => {
      const message = `SoW-authored diagnostic for ${stage}`;
      const res = await port(rejection(stage, message)).run(makeMeetingContext());
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe(EXPECTED_CODE[stage]);
      expect(res.error.message).toBe(message);
    });
  }

  // ── the schema gate's OWN six branches no longer collapse (2026-08-27 (b)) ──
  it("MUTATION PROOF of the carve-out: all six schema-gate denials render DISTINCTLY, and only the no-inference one is replaced", async () => {
    const all = [...SCHEMA_GATE_SOW_AUTHORED_MESSAGES, POISONED];
    const rendered: string[] = [];
    for (const message of all) {
      const res = await port(rejection("schema_gate", message)).run(makeMeetingContext());
      expect(res.ok).toBe(false);
      if (res.ok) return;
      // The closed code cannot separate them — all six are `schema_rejected`…
      expect(res.error.code).toBe("schema_rejected");
      rendered.push(res.error.message);
    }
    // …so the MESSAGE has to. Widening the predicate back to "the whole schema_gate stage"
    // collapses these six to one string and REDs this line — that is the mutation proof.
    expect(new Set(rendered).size).toBe(all.length);
    expect(rendered.filter((m) => m === FIXED_SCHEMA_MESSAGE)).toEqual([FIXED_SCHEMA_MESSAGE]);
    expect(rendered[rendered.length - 1]).toBe(FIXED_SCHEMA_MESSAGE);
    expectNoModelText(JSON.stringify(rendered));
  });

  it("NEW CELL, no suite covered it: `schema_gate` paired with a real-Broker reason that is NEITHER `schema_rejected` NOR `tool_policy_violation` — `lifecycle_fault` (broker.ts:383) — forwards", async () => {
    const res = await port(
      rejection("schema_gate", SCHEMA_GATE_LIFECYCLE_FAULT_MESSAGE, {
        reason: "lifecycle_fault",
        branch: "failed_terminal",
      }),
    ).run(makeMeetingContext());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("schema_rejected");
    expect(res.error.message).toBe(SCHEMA_GATE_LIFECYCLE_FAULT_MESSAGE);
    expect(res.error.message).not.toBe(FIXED_SCHEMA_MESSAGE);
  });

  // ── NO OVER-REDACTION at the schema_gate stage (restored 2026-08-27) ──────
  // This block replaces a test that pinned the OPPOSITE: it asserted the tool-policy sentence was
  // ALSO swapped for FIXED_SCHEMA_MESSAGE, described in its own comment as "a deliberate,
  // documented small over-reach". It was not defensible. `schema-gate.ts:143`'s
  // `toolPolicyDeny(job, tp.error.message)` can only ever carry `output-normalizer.ts:132-134`'s
  // fixed literal — `enforceToolPolicyOnCandidate` is a concrete function, not an injectable seam
  // — so the swapped-in sentence replaced SoW-authored text with SoW-authored text and, because
  // the derived code is `schema_rejected` either way, left the two denials BYTE-IDENTICAL.
  it("NO OVER-REDACTION: the schema gate's OTHER denial — `tool_policy_violation`, a fixed SoW-authored sentence with no model text — forwards VERBATIM", async () => {
    const res = await port(
      rejection("schema_gate", TOOL_POLICY_MESSAGE, { reason: "tool_policy_violation" }),
    ).run(makeMeetingContext());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    // Same STAGE, so the same derived code…
    expect(res.error.code).toBe("schema_rejected");
    // …but a different REASON, so the operator keeps the distinct diagnostic, byte for byte.
    expect(res.error.message).toBe(TOOL_POLICY_MESSAGE);
    expect(res.error.message).not.toBe(FIXED_SCHEMA_MESSAGE);
  });

  it("…and the no-inference message at the SAME stage is still DROPPED — the two schema-gate denials no longer render identically", async () => {
    const toolPolicy = await port(
      rejection("schema_gate", TOOL_POLICY_MESSAGE, { reason: "tool_policy_violation" }),
    ).run(makeMeetingContext());
    const noInference = await port(rejection("schema_gate", POISONED)).run(makeMeetingContext());
    expect(toolPolicy.ok).toBe(false);
    expect(noInference.ok).toBe(false);
    if (toolPolicy.ok || noInference.ok) return;
    // The redaction still fires where it must: no model text crosses.
    expect(noInference.error.message).toBe(FIXED_SCHEMA_MESSAGE);
    expectNoModelText(JSON.stringify(noInference));
    // Same code, DIFFERENT message — this is the assertion the old behavior made impossible.
    expect(toolPolicy.error.code).toBe(noInference.error.code);
    expect(toolPolicy.error.message).not.toBe(noInference.error.message);
  });

  it("THE RESIDUAL, PINNED HONESTLY: a custom injected SchemaGate stamping some OTHER `reason` at `schema_gate` now FORWARDS — the stage-level backstop is deliberately gone", async () => {
    // The previous rule bought that backstop by collapsing five SoW-authored diagnostics onto one
    // sentence — the operator-blinding trade root CLAUDE.md forbids — so it was dropped and this
    // residual accepted. Pinned so it is a deliberate property, not an unnoticed hole: a future
    // round that wants the backstop back must delete this test and re-argue the collapse it costs.
    // The STRUCTURAL fix lives in packages/providers: a distinct `BrokerFailureReason` for the
    // no-inference branch, so the rule could key on a closed field alone.
    const res = await port(
      rejection("schema_gate", POISONED, { reason: "provider_error" }),
    ).run(makeMeetingContext());
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("schema_rejected");
    expect(res.error.message).toBe(POISONED);
  });

  it("this leg, the read-only leg AND apps/worker's source-extraction leg share ONE predicate — `brokerRejectionNeedsFixedMessage`, imported, not copied", () => {
    // Three hand-written copies of the sibling `mapRejection` rule drifted into the same
    // wrong-field bug; the message rule then drifted the same way. Pin the single source.
    const at = (reason: BrokerRejection["reason"], message: string): BrokerRejection => {
      const outcome = rejection("schema_gate", message, { reason });
      if (outcome.ok) throw new Error("fixture must be a rejection");
      return outcome.error;
    };
    expect(brokerRejectionNeedsFixedMessage(at("schema_rejected", POISONED))).toBe(true);
    expect(brokerRejectionNeedsFixedMessage(at("tool_policy_violation", TOOL_POLICY_MESSAGE))).toBe(false);
    expect(
      brokerRejectionNeedsFixedMessage(at("lifecycle_fault", SCHEMA_GATE_LIFECYCLE_FAULT_MESSAGE)),
    ).toBe(false);
    for (const message of SCHEMA_GATE_SOW_AUTHORED_MESSAGES) {
      expect(brokerRejectionNeedsFixedMessage(at("schema_rejected", message))).toBe(false);
    }
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
