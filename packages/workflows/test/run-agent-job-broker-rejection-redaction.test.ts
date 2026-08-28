// spec(safety rule 7 / task I3, restored R1 2026-08-27) — SCOPE: the INCIDENTAL Broker
// rejection TEXT on the ERR arm of runAgentJob.ts's meeting.close activity — never the OK arm's
// candidate PAYLOAD (the data the next step validates/commits, which MUST cross unredacted; see
// runAgentJob.ts's own SCHEMA_REJECTED_MESSAGE doc comment + root CLAUDE.md's "THE SCOPE
// BOUNDARY").
//
// An earlier pass replaced `outcome.error.message` with a FIXED sentence per failure code, for
// ALL FIVE codes — collapsing distinct failures (e.g. "no eligible provider for route
// claude/opus" and a provider timeout) onto the same string, so an operator could not tell them
// apart. The justification — the schema gate's no-inference branch quotes MODEL-OUTPUT FIELD
// NAMES drawn from the untrusted transcript (packages/providers/src/broker/schema-gate.ts:124) —
// applies ONLY to the `schema_rejected` code. This suite now pins:
//   (1) `schema_rejected` still drops that poisoned text — never crosses — while the closed
//       `code` still crosses byte-identically;
//   (2) every OTHER reachable code (`egress_vetoed`, `budget_exceeded`, `provider_failed`)
//       RESTORES the Broker's real message — SoW-authored diagnostic text, never model-authored;
//   (3) two distinct real messages mapping to the SAME code render DISTINCTLY (mutation-
//       provable: a fixed literal per code would collapse them to one string, confirming RED);
//   (4) the OK arm's mapped candidate output still crosses INTACT, unredacted.
import { describe, it, expect } from "vitest";
import { ok, err, workspaceId, workflowId } from "@sow/contracts";
import type { BrokerOutcome, BrokerAccepted } from "@sow/providers";
import { createRunAgentJobActivity } from "../src/activities/runAgentJob";
import type { MeetingBroker, MeetingJobInputs } from "../src/activities/runAgentJob";
import { makeMeetingContext, makeAgentExtraction } from "./support/meeting-fakes";

const POISON_FIELDS = "PZN9F3A1BSECRET-leak_owner";
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

/** A Broker rejection over a given `branch` (drives `defaultMapRejection`'s code mapping) and
 * `message`. `branch`/`reason` are cast past the real `JobBranch`/`BrokerFailureReason` unions —
 * `defaultMapRejection` (runAgentJob.ts, untouched by this fix) dispatches on `branch` substring
 * membership, not on the type; these values exercise every reachable code the same way the prior
 * suite did. */
function rejectionOn(branch: string, message: string): BrokerOutcome {
  return err({
    stage: "schema_gate" as never,
    reason: "schema_rejected" as never,
    message,
    audit: {} as never,
    jobState: "schema_rejected" as never,
    branch: branch as never,
    retryable: false,
    audits: [],
  });
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

describe("spec(rule 7 / I3) runAgentJob — Broker rejection TEXT: schema_rejected redacts, every other code restores", () => {
  it('schema_rejected: the schema gate\'s poisoned no-inference message never crosses; the code does', async () => {
    const poisoned = `no-inference rejection (REQ-F-017): unstated/unbacked fields not coerced [${POISON_FIELDS}] at ${POISON_PATH}`;
    const res = await port(rejectionOn("schema_gate", poisoned)).run(makeMeetingContext());
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

  const RESTORED_CASES: ReadonlyArray<{ branch: string; expectedCode: string; message: string }> = [
    { branch: "egress_veto", expectedCode: "egress_vetoed", message: "employer-work raw content vetoed: no local zero-egress route configured" },
    { branch: "budget_pre", expectedCode: "budget_exceeded", message: "job exceeded maxCostUsd cap ($0.42 > $0.25)" },
    { branch: "route_resolution", expectedCode: "provider_failed", message: "no eligible provider for route claude/opus" },
  ];

  for (const { branch, expectedCode, message } of RESTORED_CASES) {
    it(`${expectedCode}: the Broker's real diagnostic message is RESTORED byte-identical (branch "${branch}")`, async () => {
      const res = await port(rejectionOn(branch, message)).run(makeMeetingContext());
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe(expectedCode);
      expect(res.error.message).toBe(message);
    });
  }

  it("provider_failed: two DIFFERENT real messages render DIFFERENTLY (a 401 vs a timeout are actionable, distinct diagnostics)", async () => {
    const authFailure = await port(
      rejectionOn("run", "provider auth rejected: 401 Unauthorized"),
    ).run(makeMeetingContext());
    const timeout = await port(
      rejectionOn("run", "provider run timed out after 120000ms"),
    ).run(makeMeetingContext());
    expect(authFailure.ok).toBe(false);
    expect(timeout.ok).toBe(false);
    if (authFailure.ok || timeout.ok) return;
    expect(authFailure.error.code).toBe("provider_failed");
    expect(timeout.error.code).toBe("provider_failed");
    // Mutation-provable: collapsing both onto one fixed string per code (the reverted behavior)
    // makes this assertion RED — the two messages are the same object identity's worth of text.
    expect(authFailure.error.message).not.toBe(timeout.error.message);
    expect(authFailure.error.message).toBe("provider auth rejected: 401 Unauthorized");
    expect(timeout.error.message).toBe("provider run timed out after 120000ms");
  });

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
