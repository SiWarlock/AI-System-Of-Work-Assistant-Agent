// R3 — spec(safety rule 7) — SCOPE: the INCIDENTAL Broker rejection TEXT on the ERR arm of
// source-extraction.ts's `createSourceAgentBrokerRouting` (the SOURCE analog of runAgentJob.ts's
// meeting.close leg / readOnlyAgentJob.ts's read-only families) — never the OK arm's mapped
// candidate PAYLOAD, which MUST cross unredacted (root CLAUDE.md's "THE SCOPE BOUNDARY").
//
// With the REAL Broker bound (apps/worker/src/composition/buildActivities.ts:1838), a schema-gate
// no-inference rejection (packages/providers/src/broker/schema-gate.ts:124) folds MODEL-OUTPUT
// FIELD NAMES drawn from the untrusted imported source into `outcome.error.message` as
// `no-inference rejection (REQ-F-017): unstated/unbacked fields not coerced [<fields>]` — exactly
// the "raw content" rule 7 exists to stop, on an ERROR arm nothing downstream consumes (confirmed:
// the sourceIngestion workflow driver branches ONLY on `.code`, never `.message` — L46). This
// mirrors the ALREADY-FIXED sibling legs' own redaction test files
// (`packages/workflows/test/run-agent-job-broker-rejection-redaction.test.ts` +
// `read-only-agent-job-broker-rejection-redaction.test.ts`) — this source leg was the one those
// two fixes never reached. This suite pins:
//   (1) the poisoned text is DROPPED — never crosses — for every reachable rejection code
//       (incl. the two codes only a custom `mapRejection` override can reach), while the closed
//       `code` still crosses byte-identically;
//   (2) the OK arm's mapped candidate output still crosses INTACT, unredacted — a pin in the
//       OPPOSITE direction proving the fix stayed inside the ERR arm and never touched the payload.
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr } from "@sow/contracts";
import type { WorkspaceId, Capability } from "@sow/contracts";
import { TBD, type ExtractionField } from "@sow/domain";
import type { AgentExtraction, SourceIngestionContext } from "@sow/workflows";
import type { BrokerOutcome, BrokerAccepted, BrokerRejection } from "@sow/providers";
import { KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID, validSourceEnvelope } from "@sow/contracts";
import { mapAcceptedMeetingExtraction } from "../../src/composition/meeting-extraction";
import {
  createSourceAgentBrokerRouting,
  type SourceJobInputs,
} from "../../src/composition/source-extraction";

const WS_BOUND = "ws-routing-bound" as WorkspaceId;
const POISON_FIELDS = "owner_PZN9F3A1BSECRET-leak";
const POISON_PATH = "/Users/x/vault/other-workspace/SECRETMARKER.md";

const field = (value: unknown, evidenceRef?: string): ExtractionField<unknown> =>
  ({ value, ...(evidenceRef !== undefined ? { evidenceRef } : {}) }) as ExtractionField<unknown>;

const sourceExtraction: AgentExtraction = {
  fields: { title: field("Design Doc", "source:span:1"), owner: field(TBD), dueDate: field(TBD) },
};

const ctx = (): SourceIngestionContext =>
  ({
    source: { ...validSourceEnvelope, workspaceId: WS_BOUND },
    workspaceId: WS_BOUND,
  }) as unknown as SourceIngestionContext;

const inputs: SourceJobInputs = {
  workflowRunId: "wf-src-redaction-1",
  capability: "source.process" as Capability,
  outputSchemaId: KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
  maxRuntimeSeconds: 30,
  idempotencyKey: "idem-src-redaction-1",
  contextRefs: [],
  toolPolicy: { mode: "read_only", allowedTools: [], deniedTools: [], allowsMutating: false },
} as unknown as SourceJobInputs;

function brokerReturning(outcome: BrokerOutcome): { runJob: () => Promise<BrokerOutcome> } {
  return { runJob: () => Promise.resolve(outcome) };
}

/** The exact reachable poison shape schema-gate.ts's no-inference rejection produces. `branch` is
 * varied to drive every reachable {@link SourceAgentFailureCode} through the SAME poisoned
 * message, proving the redaction is unconditional on the code, not a lucky one-code fix. */
function poisonedRejection(branch: string): BrokerOutcome {
  return err({
    stage: "schema_gate" as never,
    reason: "schema_rejected" as never,
    message: `no-inference rejection (REQ-F-017): unstated/unbacked fields not coerced [${POISON_FIELDS}] at ${POISON_PATH}`,
    audit: {} as never,
    jobState: "schema_rejected" as never,
    branch: branch as never,
    retryable: false,
    audits: [],
  } as unknown as BrokerRejection);
}

const REACHABLE_BROKER_BRANCHES: ReadonlyArray<{ branch: string; expectedCode: string }> = [
  { branch: "schema_gate", expectedCode: "schema_rejected" },
  { branch: "egress_veto", expectedCode: "egress_vetoed" },
  { branch: "budget_pre", expectedCode: "budget_exceeded" },
  { branch: "provider_failed", expectedCode: "provider_failed" },
];

describe("spec(rule 7 / R3) source-extraction — Broker rejection TEXT is redacted on the ERR arm only", () => {
  for (const { branch, expectedCode } of REACHABLE_BROKER_BRANCHES) {
    it(`branch "${branch}" -> code ${expectedCode}: the Broker's poisoned message never crosses, the code does`, async () => {
      const port = createSourceAgentBrokerRouting({
        broker: brokerReturning(poisonedRejection(branch)),
        inputs,
        buildEgress: () => ({}) as never,
        buildMatrix: () => ({}) as never,
        buildWorkspace: () => ({ type: "personal_business", dataOwner: "user" }) as never,
        mapCandidate: (o) => mapAcceptedMeetingExtraction(o),
      });
      const res = await port.run(ctx());
      expect(isErr(res)).toBe(true);
      if (!isErr(res)) return;
      expect(res.error.code).toBe(expectedCode);
      const serialized = JSON.stringify(res);
      expect(serialized).not.toContain(POISON_FIELDS);
      expect(serialized).not.toContain(POISON_PATH);
      expect(serialized).not.toContain("no-inference rejection");
      // The message is a FIXED, non-empty generic string — never undefined/empty (guards the
      // "unknown code -> undefined message" shape defect the exhaustive switch's `never` catches).
      expect(typeof res.error.message).toBe("string");
      expect(res.error.message.length).toBeGreaterThan(0);
    });
  }

  // These two codes are unreachable through defaultMapSourceRejection's own branch-string
  // matching, but ARE part of the closed SourceAgentFailureCode set a custom `mapRejection`
  // override can return — the exhaustive switch must cover them too (never fall through to
  // `undefined`), so drive them explicitly.
  for (const code of ["injection_detected", "unsupported_type"] as const) {
    it(`custom mapRejection -> ${code}: still produces a fixed non-empty generic message, poison text dropped`, async () => {
      const port = createSourceAgentBrokerRouting({
        broker: brokerReturning(poisonedRejection("provider_failed")),
        inputs,
        buildEgress: () => ({}) as never,
        buildMatrix: () => ({}) as never,
        buildWorkspace: () => ({ type: "personal_business", dataOwner: "user" }) as never,
        mapCandidate: (o) => mapAcceptedMeetingExtraction(o),
        mapRejection: () => code,
      });
      const res = await port.run(ctx());
      expect(isErr(res)).toBe(true);
      if (!isErr(res)) return;
      expect(res.error.code).toBe(code);
      const serialized = JSON.stringify(res);
      expect(serialized).not.toContain(POISON_FIELDS);
      expect(serialized).not.toContain(POISON_PATH);
      expect(typeof res.error.message).toBe("string");
      expect(res.error.message.length).toBeGreaterThan(0);
    });
  }

  // R4 finding 1 — restore: `defaultMapSourceRejection` collapses every non-schema/egress/budget
  // branch to the SAME `provider_failed` code (a real no-inference/tool-policy rejection carries
  // `branch: "rejected"`, matched by none of its substring checks — see rejectionMessageFor's own
  // doc comment). With `code` alone identical across all of them, `message` is the ONLY remaining
  // diagnostic distinguishing "no eligible provider", "provider unavailable", "provider crashed",
  // and "read_only policy admitted a mutating tool" from one another. This pins that restore:
  // each SoW-authored broker message crosses VERBATIM (not collapsed to one fixed per-code
  // literal) — mutation-provable, since a revert to a fixed literal keyed on `code` would make
  // every one of these five messages identical.
  const DISTINCT_PROVIDER_FAILED_REASONS: ReadonlyArray<{ reason: string; message: string }> = [
    { reason: "no_eligible_provider", message: "no eligible provider after the gate sequence (route): matrix has no candidates" },
    { reason: "provider_unavailable", message: "provider unavailable: circuit open for anthropic/claude-4" },
    { reason: "provider_error", message: "provider run cancelled; output discarded before any hand-off" },
    { reason: "tool_policy_violation", message: "tool_policy_violation: read_only ToolPolicy admits mutation (inconsistent)" },
    { reason: "lifecycle_fault", message: "broker lifecycle fault at run" },
  ];

  it("five distinct non-schema broker rejections sharing the SAME derived code still render DISTINGUISHABLE messages — an operator can tell which failure occurred", async () => {
    const results: string[] = [];
    for (const { reason, message } of DISTINCT_PROVIDER_FAILED_REASONS) {
      const outcome: BrokerOutcome = err({
        stage: "run" as never,
        reason: reason as never,
        message,
        audit: {} as never,
        jobState: "failed_retryable" as never,
        branch: "rejected" as never, // matches NONE of the schema/egress/budget substring checks
        retryable: true,
        audits: [],
      } as unknown as BrokerRejection);
      const port = createSourceAgentBrokerRouting({
        broker: brokerReturning(outcome),
        inputs,
        buildEgress: () => ({}) as never,
        buildMatrix: () => ({}) as never,
        buildWorkspace: () => ({ type: "personal_business", dataOwner: "user" }) as never,
        mapCandidate: (o) => mapAcceptedMeetingExtraction(o),
      });
      const res = await port.run(ctx());
      expect(isErr(res)).toBe(true);
      if (!isErr(res)) continue;
      // Every one of these five collapses to the SAME closed code (the whole point of the finding).
      expect(res.error.code).toBe("provider_failed");
      // The message is forwarded VERBATIM — the real broker text, not a per-code fixed literal.
      expect(res.error.message).toBe(message);
      results.push(res.error.message);
    }
    // The proof: five same-code failures still produce five DIFFERENT messages.
    expect(new Set(results).size).toBe(DISTINCT_PROVIDER_FAILED_REASONS.length);
  });

  it("the OK arm's mapped candidate output still crosses INTACT — the ERR-arm redaction never touches the payload", async () => {
    const acceptedOutcome: BrokerOutcome = ok({
      jobState: "accepted",
      route: {} as never,
      candidate: { kind: "agent_extraction", extraction: sourceExtraction },
      usage: { runtimeSeconds: 1 },
      audits: [],
      replayed: false,
    } as unknown as BrokerAccepted);
    const port = createSourceAgentBrokerRouting({
      broker: brokerReturning(acceptedOutcome),
      inputs,
      buildEgress: () => ({}) as never,
      buildMatrix: () => ({}) as never,
      buildWorkspace: () => ({ type: "personal_business", dataOwner: "user" }) as never,
      mapCandidate: (o) => mapAcceptedMeetingExtraction(o),
    });
    const res = await port.run(ctx());
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    // The accepted candidate's fields cross byte-identical — no redaction on the payload.
    expect(res.value).toEqual(sourceExtraction);
  });
});
