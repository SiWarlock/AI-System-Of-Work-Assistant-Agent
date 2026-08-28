// spec(safety rule 7 / W3) — THE THREE-LEG AGREEMENT ENUMERATION.
//
// Three legs map a `BrokerRejection` onto a closed failure code + an ERR-arm message:
//   • packages/workflows/src/activities/readOnlyAgentJob.ts   (the four output-workflow families)
//   • packages/workflows/src/activities/runAgentJob.ts        (meeting.close)
//   • apps/worker/src/composition/source-extraction.ts        (source ingestion)
//
// They kept THREE hand-written copies of the code mapping, which drifted into one wrong-field bug.
// The mapping was then unified (`brokerRejectionFailureCode`) but the MESSAGE rule was not: the two
// workflow legs keyed on the derived code minus a `tool_policy_violation` carve-out, while the
// worker leg keyed on the raw `reason`. Their docs asserted the two rules agreed. THEY DID NOT —
// `broker.ts:383` calls `lifecycleFault("schema_gate", …)`, producing `stage: "schema_gate"` with
// `reason: "lifecycle_fault"`, on which the two rules give opposite answers.
//
// This file exists so that claim is never made again without evidence. It enumerates ALL 72 cells
// of the closed `BrokerStage` (9) × `BrokerFailureReason` (8) product, drives each cell through all
// three real legs with three different message shapes, and asserts the three answers are IDENTICAL
// — same code, same message, byte for byte. 216 comparisons. It is the standing proof that the
// legs share one rule, not three that happen to agree today.
//
// SCOPE: the ERR arm only. `branch` / `jobState` are set to one legal pairing throughout and are
// deliberately NOT varied — neither the code mapping nor the message rule reads them, and that is
// itself the fix (the bug this whole arc corrects was a rule that read `branch`).
import { describe, it, expect } from "vitest";
import { err } from "@sow/contracts";
import type { WorkspaceId, Capability, Result } from "@sow/contracts";
import { buildAuditSignal } from "@sow/policy";
import { BrokerStage, BrokerFailureReason } from "@sow/providers";
import type { BrokerOutcome, BrokerRejection } from "@sow/providers";
import {
  createReadOnlyAgentJobActivity,
  createRunAgentJobActivity,
} from "@sow/workflows";
import type {
  MeetingCloseoutContext,
  SourceIngestionContext,
  AgentExtraction,
} from "@sow/workflows";
import { KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID, validSourceEnvelope } from "@sow/contracts";
import {
  createSourceAgentBrokerRouting,
  type SourceJobInputs,
} from "../../src/composition/source-extraction";

const WS = "ws-three-leg" as WorkspaceId;

// The three message shapes that separate the legs' rules, if anything can.
const POISON_FIELDS = "owner_PZN9F3A1BSECRET-leak";
/** `schema-gate.ts`'s no-inference template — the ONE denial that folds model-chosen names in. */
const NO_INFERENCE_MESSAGE = `no-inference rejection (REQ-F-017): unstated/unbacked fields not coerced [${POISON_FIELDS}]`;
/** `output-normalizer.ts:132-134`'s fixed literal — SoW-authored, zero model text. */
const TOOL_POLICY_MESSAGE =
  "output implies a mutating external action but the job's ToolPolicy forbids mutation (read_only / !allowsMutating) — rejected, not coerced";
/** A stand-in for every other SoW-authored broker/gate diagnostic. */
const GENERIC_MESSAGE = "SoW-authored broker diagnostic";

const MESSAGE_SHAPES: readonly string[] = [
  NO_INFERENCE_MESSAGE,
  TOOL_POLICY_MESSAGE,
  GENERIC_MESSAGE,
];

const AUDIT = buildAuditSignal({
  actor: "broker:test",
  event: "broker.rejected",
  refs: [],
  payloadHash: "sha256:deadbeef",
  beforeSummary: "running",
  afterSummary: "rejected",
});

/** A fully-typed `BrokerRejection` for one (stage, reason) cell. No cast anywhere. */
function cell(
  stage: (typeof BrokerStage)[number],
  reason: (typeof BrokerFailureReason)[number],
  message: string,
): BrokerOutcome {
  const rejection: BrokerRejection = {
    stage,
    reason,
    message,
    audit: AUDIT,
    jobState: "created",
    branch: "rejected",
    retryable: false,
    audits: [],
  };
  return err(rejection);
}

const brokerReturning = (outcome: BrokerOutcome) => ({
  runJob: (): Promise<BrokerOutcome> => Promise.resolve(outcome),
});

const stubs = {
  buildEgress: () => ({}) as never,
  buildMatrix: () => ({}) as never,
  buildWorkspace: () => ({ type: "personal_business", dataOwner: "user" }) as never,
};

// ── leg 1: the generic read-only activity ──────────────────────────────────
async function readOnlyLeg(outcome: BrokerOutcome): Promise<{ code: string; message: string }> {
  const res = await createReadOnlyAgentJobActivity<Record<string, never>, unknown>({
    broker: brokerReturning(outcome),
    inputs: {
      workflowRunId: "wf-agree" as never,
      workspaceId: WS,
      capability: "daily_brief.synthesize",
      outputSchemaId: KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
      maxRuntimeSeconds: 60,
      idempotencyKey: "idem-agree-ro",
    },
    ...stubs,
    mapCandidate: () => ({}),
  }).run({});
  return unwrap(res);
}

// ── leg 2: the meeting.close activity ──────────────────────────────────────
async function meetingLeg(outcome: BrokerOutcome): Promise<{ code: string; message: string }> {
  const res = await createRunAgentJobActivity({
    broker: brokerReturning(outcome),
    inputs: {
      workflowRunId: "wf-agree" as never,
      workspaceId: WS,
      capability: "meeting.close" as Capability,
      outputSchemaId: KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
      maxRuntimeSeconds: 60,
      idempotencyKey: "idem-agree-mtg",
      toolPolicy: { mode: "read_only", allowedTools: [], deniedTools: [], allowsMutating: false },
    },
    ...stubs,
    mapCandidate: () => ({ fields: {} }) as AgentExtraction,
  }).run({} as MeetingCloseoutContext);
  return unwrap(res);
}

// ── leg 3: the worker source-ingestion leg ─────────────────────────────────
const sourceInputs: SourceJobInputs = {
  workflowRunId: "wf-agree" as never,
  capability: "source.process" as Capability,
  outputSchemaId: KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
  maxRuntimeSeconds: 60,
  idempotencyKey: "idem-agree-src",
  contextRefs: [],
  toolPolicy: { mode: "read_only", allowedTools: [], deniedTools: [], allowsMutating: false },
} as unknown as SourceJobInputs;

async function sourceLeg(outcome: BrokerOutcome): Promise<{ code: string; message: string }> {
  const ctx = {
    source: { ...validSourceEnvelope, workspaceId: WS },
    workspaceId: WS,
  } as unknown as SourceIngestionContext;
  const res = await createSourceAgentBrokerRouting({
    broker: brokerReturning(outcome),
    inputs: sourceInputs,
    ...stubs,
    mapCandidate: () => ({ fields: {} }) as AgentExtraction,
  }).run(ctx);
  return unwrap(res);
}

function unwrap(res: Result<unknown, { code: string; message: string }>): {
  code: string;
  message: string;
} {
  if (res.ok) throw new Error("every cell here is a rejection; the OK arm must not be reached");
  return { code: res.error.code, message: res.error.message };
}

/** Each leg's own fixed sentence for the ONE redacted denial — deliberately leg-specific, so an
 *  operator can tell WHICH leg failed from the message alone. Agreement is on the DECISION (was it
 *  replaced?), not on the literal. */
const FIXED: Readonly<Record<"readOnly" | "meeting" | "source", string>> = {
  readOnly:
    "read-only agent job output failed the candidate-data schema gate: REQ-F-017 no-inference rejection (unbacked field names withheld)",
  meeting:
    "meeting.close broker output failed the candidate-data schema gate: REQ-F-017 no-inference rejection (unbacked field names withheld)",
  source:
    "source-processing broker output failed the candidate-data schema gate: REQ-F-017 no-inference rejection (unbacked field names withheld)",
};

/** THE ONE CELL, stated as data: the only (stage, reason, message) triple that gets replaced. */
function expectedReplaced(
  stage: (typeof BrokerStage)[number],
  reason: (typeof BrokerFailureReason)[number],
  message: string,
): boolean {
  return stage === "schema_gate" && reason === "schema_rejected" && message === NO_INFERENCE_MESSAGE;
}

describe("spec(rule 7 / W3) the three Broker-rejection legs agree on ALL 72 stage × reason cells", () => {
  it("the enumeration really is 9 × 8 = 72 closed cells — no stage or reason is skipped", () => {
    expect(BrokerStage.length).toBe(9);
    expect(BrokerFailureReason.length).toBe(8);
    expect(BrokerStage.length * BrokerFailureReason.length).toBe(72);
  });

  for (const stage of BrokerStage) {
    it(`stage "${stage}" — all 8 reasons × 3 message shapes: the three legs give the SAME code and the SAME replace/forward decision`, async () => {
      for (const reason of BrokerFailureReason) {
        for (const message of MESSAGE_SHAPES) {
          const outcome = cell(stage, reason, message);
          const ro = await readOnlyLeg(outcome);
          const mtg = await meetingLeg(outcome);
          const src = await sourceLeg(outcome);
          const where = `${stage}/${reason}/${message.slice(0, 24)}`;

          // (a) the CODE is byte-identical across all three — this is what a workflow driver
          //     switches on, and all three derive it from the same `brokerRejectionFailureCode`.
          expect(`${where}: ${ro.code}`).toBe(`${where}: ${mtg.code}`);
          expect(`${where}: ${ro.code}`).toBe(`${where}: ${src.code}`);

          // (b) the DECISION — replaced or forwarded — is identical across all three, and matches
          //     the single documented rule. This is the assertion the old three-way split failed.
          const replaced = expectedReplaced(stage, reason, message);
          expect(`${where}: ${ro.message === FIXED.readOnly}`).toBe(`${where}: ${replaced}`);
          expect(`${where}: ${mtg.message === FIXED.meeting}`).toBe(`${where}: ${replaced}`);
          expect(`${where}: ${src.message === FIXED.source}`).toBe(`${where}: ${replaced}`);

          // (c) when NOT replaced, all three forward the Broker's real message VERBATIM — the
          //     restore. A leg that quietly substituted its own text would RED here.
          if (!replaced) {
            expect(`${where}: ${ro.message}`).toBe(`${where}: ${message}`);
            expect(`${where}: ${mtg.message}`).toBe(`${where}: ${message}`);
            expect(`${where}: ${src.message}`).toBe(`${where}: ${message}`);
          } else {
            // (d) and when replaced, NO model-authored text survives on any leg.
            for (const out of [ro, mtg, src]) {
              expect(out.message).not.toContain(POISON_FIELDS);
              expect(out.message).not.toContain("not coerced [");
            }
          }
        }
      }
    });
  }

  it("THE CELL THE OLD RULES DISAGREED ON, isolated: schema_gate × lifecycle_fault (broker.ts:383)", async () => {
    // Old workflow-leg rule: code === "schema_rejected" && reason !== "tool_policy_violation" → REPLACE.
    // Old worker-leg rule:   reason === "schema_rejected"                                     → FORWARD.
    // The removed doc comment claimed the real Broker never stamps such a reason at this stage.
    // It does — `lifecycleFault("schema_gate", life.state, audits)`.
    const message = "broker lifecycle fault at schema_gate";
    const outcome = cell("schema_gate", "lifecycle_fault", message);
    // The two REMOVED rules, reproduced verbatim as functions so the divergence is executable
    // rather than asserted in prose. `code` is what `brokerRejectionFailureCode` derives from
    // stage `schema_gate`; `reason` is what `broker.ts:383` stamps.
    const oldWorkflowRule = (code: string, reason: string): boolean =>
      code === "schema_rejected" && reason !== "tool_policy_violation";
    const oldWorkerRule = (reason: string): boolean => reason === "schema_rejected";
    expect(oldWorkflowRule("schema_rejected", "lifecycle_fault")).toBe(true); // REPLACE
    expect(oldWorkerRule("lifecycle_fault")).toBe(false); // FORWARD ← the divergence, executed

    const [ro, mtg, src] = await Promise.all([
      readOnlyLeg(outcome),
      meetingLeg(outcome),
      sourceLeg(outcome),
    ]);
    // All three now FORWARD the SoW-authored lifecycle diagnostic.
    for (const out of [ro, mtg, src]) {
      expect(out.code).toBe("schema_rejected");
      expect(out.message).toBe(message);
    }
  });

  it("THE CELL THAT MUST STILL BE REDACTED, isolated: schema_gate × schema_rejected × the no-inference message", async () => {
    const outcome = cell("schema_gate", "schema_rejected", NO_INFERENCE_MESSAGE);
    const [ro, mtg, src] = await Promise.all([
      readOnlyLeg(outcome),
      meetingLeg(outcome),
      sourceLeg(outcome),
    ]);
    expect(ro.message).toBe(FIXED.readOnly);
    expect(mtg.message).toBe(FIXED.meeting);
    expect(src.message).toBe(FIXED.source);
    for (const out of [ro, mtg, src]) {
      expect(out.code).toBe("schema_rejected");
      expect(out.message).not.toContain(POISON_FIELDS);
    }
  });
});
