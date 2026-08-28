// spec(safety rule 7 / task I3, restored R1 2026-08-27) — SCOPE: the INCIDENTAL Broker
// rejection TEXT on the ERR arm of readOnlyAgentJob.ts's generic activity — reached by all four
// registered output-workflow families (dailyBriefRunAgent, periodReviewRunAgent,
// projectSyncSynthesizeNarrative, crossCalendarProposeWindowsAgent). Never the OK arm's mapped
// candidate PAYLOAD (the data the next step validates/commits, which MUST cross unredacted; see
// readOnlyAgentJob.ts's own SCHEMA_REJECTED_MESSAGE doc comment + root CLAUDE.md's "THE SCOPE
// BOUNDARY").
//
// An earlier pass replaced `outcome.error.message` with a FIXED sentence per failure code, for
// ALL FIVE codes — collapsing distinct failures onto the same string, so an operator could not
// tell them apart. The justification — the schema gate's no-inference branch quotes MODEL-OUTPUT
// FIELD NAMES drawn from the untrusted transcript (packages/providers/src/broker/schema-gate.ts:
// 124) — applies ONLY to the `schema_rejected` code. This suite now pins:
//   (1) `schema_rejected` still drops that poisoned text — never crosses — while the closed
//       `code` still crosses byte-identically;
//   (2) every OTHER reachable code (`egress_vetoed`, `budget_exceeded`, `provider_failed`)
//       RESTORES the Broker's real message — SoW-authored diagnostic text, never model-authored;
//   (3) two distinct real messages mapping to the SAME code render DISTINCTLY (mutation-
//       provable: a fixed literal per code would collapse them to one string, confirming RED);
//   (4) the OK arm's mapped candidate output still crosses INTACT, unredacted.
//
// (4) IS DUPLICATED ON PURPOSE, AND THIS FILE IS NOT ITS DURABLE HOME. Until task C4 this
// suite held the ONLY pin repo-wide on `readOnlyAgentJob`'s ok-arm candidate payload — a payload
// pin living inside a REDACTION suite, i.e. inside exactly the kind of file a future hardening
// round rewrites or replaces. The durable home is now
// `packages/workflows/test/payload-integrity-pins.test.ts` (pin 7/7), which is mutation-proved
// against the same production expression and is independent of this file. Keep (4) here anyway —
// it is what makes this suite's OWN scope claim (ERR-arm text only) self-evidencing — but do not
// treat it as the coverage.
import { describe, it, expect } from "vitest";
import { ok, err, workspaceId, workflowId } from "@sow/contracts";
import type { BrokerOutcome, BrokerAccepted } from "@sow/providers";
import { createReadOnlyAgentJobActivity } from "../src/activities/readOnlyAgentJob";
import type { ReadOnlyAgentBroker, ReadOnlyAgentJobInputs, ReadOnlyAgentJobDeps } from "../src/activities/readOnlyAgentJob";

const POISON_FIELDS = "PZN9F3A1BSECRET-leak_owner";
const POISON_PATH = "/Users/x/vault/other-workspace/SECRETMARKER.md";

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

/** A Broker rejection over a given `branch` (drives `defaultMapRejection`'s code mapping) and
 * `message` — see the runAgentJob sibling suite's identical helper doc for why `branch`/`reason`
 * are cast past the real unions. */
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

type Ctx = Record<string, never>;
interface Output {
  readonly fields: unknown;
}

function baseDeps(broker: ReadOnlyAgentBroker, mapCandidate: () => Output): ReadOnlyAgentJobDeps<Ctx, Output> {
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
  return createReadOnlyAgentJobActivity(baseDeps(brokerReturning(outcome), () => ({ fields: "unused" })));
}

describe("spec(rule 7 / I3) readOnlyAgentJob — Broker rejection TEXT: schema_rejected redacts, every other code restores", () => {
  it("schema_rejected: the schema gate's poisoned no-inference message never crosses; the code does", async () => {
    const poisoned = `no-inference rejection (REQ-F-017): unstated/unbacked fields not coerced [${POISON_FIELDS}] at ${POISON_PATH}`;
    const res = await port(rejectionOn("schema_gate", poisoned)).run({});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("schema_rejected");
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(POISON_FIELDS);
    expect(serialized).not.toContain(POISON_PATH);
    expect(serialized).not.toContain("no-inference rejection");
    expect(res.error.message).toBe("read-only agent job output failed the candidate-data schema gate");
  });

  const RESTORED_CASES: ReadonlyArray<{ branch: string; expectedCode: string; message: string }> = [
    { branch: "egress_veto", expectedCode: "egress_vetoed", message: "employer-work raw content vetoed: no local zero-egress route configured" },
    { branch: "budget_pre", expectedCode: "budget_exceeded", message: "job exceeded maxCostUsd cap ($0.42 > $0.25)" },
    { branch: "route_resolution", expectedCode: "provider_failed", message: "no eligible provider for route claude/opus" },
  ];

  for (const { branch, expectedCode, message } of RESTORED_CASES) {
    it(`${expectedCode}: the Broker's real diagnostic message is RESTORED byte-identical (branch "${branch}")`, async () => {
      const res = await port(rejectionOn(branch, message)).run({});
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe(expectedCode);
      expect(res.error.message).toBe(message);
    });
  }

  it("provider_failed: two DIFFERENT real messages render DIFFERENTLY (a 401 vs a timeout are actionable, distinct diagnostics)", async () => {
    const authFailure = await port(rejectionOn("run", "provider auth rejected: 401 Unauthorized")).run({});
    const timeout = await port(rejectionOn("run", "provider run timed out after 60000ms")).run({});
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
    const activityPort = createReadOnlyAgentJobActivity(baseDeps(brokerReturning(ok(acceptedOutcome)), () => output));
    const res = await activityPort.run({});
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    // Reference-identical: mapCandidate's own return value crosses UNTOUCHED, never a redacted copy.
    expect(res.value).toBe(output);
  });
});
