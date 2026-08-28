// R3 — spec(safety rule 7) — REWRITTEN 2026-08-27. SCOPE: the INCIDENTAL Broker rejection TEXT on
// the ERR arm of source-extraction.ts's `createSourceAgentBrokerRouting` (the SOURCE analog of
// runAgentJob.ts's meeting.close leg / readOnlyAgentJob.ts's read-only families) — never the OK
// arm's mapped candidate PAYLOAD, which MUST cross unredacted (root CLAUDE.md's "THE SCOPE
// BOUNDARY").
//
// WHY THIS SUITE WAS REWRITTEN. Its predecessor's `poisonedRejection(branch)` helper cast
// `branch: branch as never` and fed `BrokerStage` values ("schema_gate", "egress_veto",
// "budget_pre") into the `JobBranch`-typed field. The cast was the only reason it compiled, and it
// made the suite GREEN over a `defaultMapSourceRejection` that read the WRONG field: it tested the
// `JobBranch` (`accepted | rejected | cancelled_budget | failed_retryable | failed_terminal`) for
// the substrings "schema" / "egress" / "budget", which are `BrokerStage` concepts. No JobBranch
// member contains "schema" or "egress", so `schema_rejected` and `egress_vetoed` were UNREACHABLE
// in production and the suite's `branch "egress_veto" -> egress_vetoed` row could never happen.
//
// The LEAK this file exists to stop was not open here — `rejectionMessageFor` keys on the Broker's
// `reason`, not on the derived code, precisely because that mapper could not identify a schema-gate
// rejection. But the CODE was wrong, so the source workflow driver (which branches only on `.code`)
// saw `provider_failed` for every no-inference rejection. Both are fixed: the mapper now reads the
// closed `stage`, and every rejection below is a REALISTIC, fully-typed `BrokerRejection` — legal
// `BrokerStage` in `stage`, legal `JobBranch` in `branch`, NO `as never` / `as any` in its
// construction.
//
// This suite pins: (1) the poisoned text is DROPPED for a realistic schema-gate rejection while the
// closed code crosses byte-identically; (2) the code mapping is TOTAL over the closed BrokerStage
// union and matches the shared table; (3) the old branch predicate is shown wrong on the same
// inputs; (4) non-schema stages still forward the Broker's real message VERBATIM; (5) the OK arm's
// mapped candidate output still crosses INTACT — a pin in the OPPOSITE direction.
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr } from "@sow/contracts";
import type { WorkspaceId, Capability } from "@sow/contracts";
import { buildAuditSignal } from "@sow/policy";
import { TBD, type ExtractionField } from "@sow/domain";
import type { AgentExtraction, SourceIngestionContext } from "@sow/workflows";
import { BrokerStage, JOB_BRANCHES } from "@sow/providers";
import type {
  BrokerOutcome,
  BrokerAccepted,
  BrokerRejection,
  JobBranch,
  AgentJobState,
} from "@sow/providers";
import { KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID, validSourceEnvelope } from "@sow/contracts";
import { mapAcceptedMeetingExtraction } from "../../src/composition/meeting-extraction";
import {
  createSourceAgentBrokerRouting,
  type SourceJobInputs,
} from "../../src/composition/source-extraction";

const WS_BOUND = "ws-routing-bound" as WorkspaceId;
const POISON_FIELDS = "owner_PZN9F3A1BSECRET-leak";
const POISON_PATH = "/Users/x/vault/other-workspace/SECRETMARKER.md";
const POISONED = `no-inference rejection (REQ-F-017): unstated/unbacked fields not coerced [${POISON_FIELDS}] at ${POISON_PATH}`;
const FIXED_SCHEMA_MESSAGE = "source-processing broker output failed the candidate-data schema gate";

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
      refs: ["ref:job:idem-src-redaction-1"],
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

function routing(
  outcome: BrokerOutcome,
  over: Partial<Parameters<typeof createSourceAgentBrokerRouting>[0]> = {},
) {
  return createSourceAgentBrokerRouting({
    broker: brokerReturning(outcome),
    inputs,
    buildEgress: () => ({}) as never,
    buildMatrix: () => ({}) as never,
    buildWorkspace: () => ({ type: "personal_business", dataOwner: "user" }) as never,
    mapCandidate: (o) => mapAcceptedMeetingExtraction(o),
    ...over,
  });
}

describe("spec(rule 7 / R3) source-extraction — the rejection code is derived from the closed STAGE; the schema-gate text is redacted on the ERR arm only", () => {
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
      const res = await routing(outcome).run(ctx());
      expect(isErr(res)).toBe(true);
      if (!isErr(res)) return;
      expect(res.error.code).toBe(fixed);
      expect(res.error.code).not.toBe(legacy);
    }
  });

  it("schema_gate: the poisoned no-inference message NEVER crosses; the fixed sentence + the closed code do", async () => {
    const res = await routing(rejection("schema_gate", POISONED)).run(ctx());
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("schema_rejected");
    const serialized = JSON.stringify(res);
    expect(serialized).not.toContain(POISON_FIELDS);
    expect(serialized).not.toContain(POISON_PATH);
    expect(serialized).not.toContain("no-inference rejection");
    expect(res.error.message).toBe(FIXED_SCHEMA_MESSAGE);
  });

  it("the old predicate mis-coded that very rejection as `provider_failed` — the source workflow driver branches on `.code`, so a no-inference rejection was indistinguishable from a provider crash", async () => {
    expect(legacyBranchSubstringMapping(rejection("schema_gate", POISONED))).toBe("provider_failed");
    const res = await routing(rejection("schema_gate", POISONED)).run(ctx());
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("schema_rejected");
  });

  // ── the code mapping, total over the closed stage union ───────────────────
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
    const redacted = REAL_REJECTION[stage].reason === "schema_rejected";
    it(`stage "${stage}" -> ${EXPECTED_CODE[stage]}${redacted ? " (message replaced)" : " (SoW-authored message forwarded VERBATIM)"}`, async () => {
      const message = `SoW-authored diagnostic for ${stage}`;
      const res = await routing(rejection(stage, message)).run(ctx());
      expect(isErr(res)).toBe(true);
      if (!isErr(res)) return;
      expect(res.error.code).toBe(EXPECTED_CODE[stage]);
      expect(res.error.message).toBe(redacted ? FIXED_SCHEMA_MESSAGE : message);
      expect(res.error.message.length).toBeGreaterThan(0);
    });
  }

  it("NO OVER-REDACTION: the schema gate's OTHER denial — `tool_policy_violation`, a fixed SoW-authored sentence with no model text — still forwards VERBATIM, because this leg keys on `reason`, not on the derived code", async () => {
    const toolPolicyMessage =
      "output implies a mutating external action but the job's ToolPolicy forbids mutation (read_only / !allowsMutating) — rejected, not coerced";
    const res = await routing(
      rejection("schema_gate", toolPolicyMessage, { reason: "tool_policy_violation" }),
    ).run(ctx());
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    // Same STAGE, so the same derived code…
    expect(res.error.code).toBe("schema_rejected");
    // …but a different REASON, so the operator keeps the distinct diagnostic.
    expect(res.error.message).toBe(toolPolicyMessage);
  });

  it("a cooperative provider cancel (stage `run`, branch `cancelled_budget`) is `provider_failed`, NOT `budget_exceeded` — the branch names a lifecycle state, not a budget gate", async () => {
    const cancelMessage = "provider run cancelled; output discarded before any hand-off";
    const outcome = rejection("run", cancelMessage, {
      branch: "cancelled_budget",
      reason: "provider_cancelled",
      jobState: "cancelled_budget",
    });
    expect(legacyBranchSubstringMapping(outcome)).toBe("budget_exceeded");
    const res = await routing(outcome).run(ctx());
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("provider_failed");
    expect(res.error.message).toBe(cancelMessage);
  });

  it("a REAL budget breach (stage `budget_post`) still reports `budget_exceeded`", async () => {
    const breach =
      "budget cap breached — cost $0.42 > cap $0.25; job cancelled with no partial side effect";
    const res = await routing(rejection("budget_post", breach)).run(ctx());
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("budget_exceeded");
    expect(res.error.message).toBe(breach);
  });

  // These two codes are NOT derivable from a Broker rejection at all, but ARE part of the closed
  // SourceAgentFailureCode set a custom `mapRejection` override can return — the ERR arm must
  // handle them without producing an undefined/empty message.
  for (const code of ["injection_detected", "unsupported_type"] as const) {
    it(`custom mapRejection -> ${code}: still produces a non-empty message, and the schema-gate poison is still dropped`, async () => {
      const res = await routing(rejection("schema_gate", POISONED), {
        mapRejection: () => code,
      }).run(ctx());
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

  // R4 finding 1 — restore: `provider_failed` is the ONE code for five distinct Broker failures
  // (`no_eligible_provider` / `provider_unavailable` / `provider_error` / `provider_cancelled` /
  // `lifecycle_fault`), so `message` is the only remaining diagnostic separating them. This pins
  // that restore: each SoW-authored broker message crosses VERBATIM, not collapsed to one fixed
  // per-code literal — mutation-provable, since such a revert makes all five identical.
  const DISTINCT_PROVIDER_FAILED_REASONS: ReadonlyArray<{
    stage: BrokerStage;
    reason: BrokerRejection["reason"];
    message: string;
  }> = [
    { stage: "route_resolution", reason: "no_eligible_provider", message: "no eligible provider after the gate sequence (route_resolution): matrix has no candidates" },
    { stage: "health", reason: "provider_unavailable", message: "provider unavailable: circuit open for anthropic/claude-4" },
    { stage: "run", reason: "provider_error", message: "provider run failed: upstream returned 500" },
    { stage: "run", reason: "provider_cancelled", message: "provider run cancelled; output discarded before any hand-off" },
    { stage: "emit", reason: "lifecycle_fault", message: "broker lifecycle fault at emit" },
  ];

  it("five distinct broker rejections sharing the SAME derived code still render DISTINGUISHABLE messages — an operator can tell which failure occurred", async () => {
    const results: string[] = [];
    for (const { stage, reason, message } of DISTINCT_PROVIDER_FAILED_REASONS) {
      const res = await routing(rejection(stage, message, { reason })).run(ctx());
      expect(isErr(res)).toBe(true);
      if (!isErr(res)) continue;
      expect(res.error.code).toBe("provider_failed");
      expect(res.error.message).toBe(message);
      results.push(res.error.message);
    }
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
    const res = await routing(acceptedOutcome).run(ctx());
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    // The accepted candidate's fields cross byte-identical — no redaction on the payload.
    expect(res.value).toEqual(sourceExtraction);
  });
});
