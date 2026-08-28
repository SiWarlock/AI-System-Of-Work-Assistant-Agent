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
// EXTENDED 2026-08-27 (W3), after the redaction was narrowed from the whole `schema_gate` STAGE to
// the ONE no-inference denial. Added: (6) each of the schema gate's five OTHER `schema_rejected`
// denials forwards VERBATIM, with a mutation proof that all six render distinctly; (7) the
// previously-uncovered `schema_gate` × `lifecycle_fault` cell (broker.ts:383); (8) the residual the
// narrowing accepts, pinned so it is deliberate rather than unnoticed; and (9) an END-TO-END block
// at the bottom that wires the REAL `createBroker` over the REAL `createSchemaGate` — it is what
// anchors `NO_INFERENCE_REJECTION_PREFIX` to `schema-gate.ts`'s actual literal, which the compiler
// cannot do across the package boundary.
//
// ⚠ REACHABILITY, STATED HONESTLY: the only composition root that builds a schema gate
// (apps/worker/src/composition/backends.ts:866) wires `createSchemaGate({ modelSchemas })` with NO
// `noInference` view, so the no-inference denial is NOT reachable in production TODAY — its own
// comment says the view "binds with the real extraction leg (18.3/18.4)". This suite therefore
// pins what MUST hold when that view is bound; it is not evidence of a live leak being closed.
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
import {
  KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
  KnowledgeMutationPlanSchema,
  validAgentJob,
  validProviderRoute,
  validKnowledgeMutationPlan,
} from "@sow/contracts";
import { allowDecision, buildAuditSignal } from "@sow/policy";
import {
  BrokerStage,
  JOB_BRANCHES,
  createBroker,
  createSchemaGate,
  makeAgentResult,
} from "@sow/providers";
import type {
  BrokerOutcome,
  BrokerRejection,
  BrokerAccepted,
  JobBranch,
  AgentJobState,
  SchemaGate,
} from "@sow/providers";
import {
  createReadOnlyAgentJobActivity,
  BROKER_STAGE_FAILURE_CODE,
  brokerRejectionNeedsFixedMessage,
  NO_INFERENCE_REJECTION_PREFIX,
} from "../src/activities/readOnlyAgentJob";
import type {
  ReadOnlyAgentBroker,
  ReadOnlyAgentJobInputs,
  ReadOnlyAgentJobDeps,
} from "../src/activities/readOnlyAgentJob";

const POISON_FIELDS = "owner_PZN9F3A1BSECRET-leak";
const POISON_PATH = "/Users/x/vault/other-workspace/SECRETMARKER.md";
const POISONED = `no-inference rejection (REQ-F-017): unstated/unbacked fields not coerced [${POISON_FIELDS}] at ${POISON_PATH}`;
const FIXED_SCHEMA_MESSAGE =
  "read-only agent job output failed the candidate-data schema gate: REQ-F-017 no-inference rejection (unbacked field names withheld)";
/** `output-normalizer.ts:132-134`'s fixed literal, verbatim — the ONLY message `toolPolicyDeny`
 *  can ever carry, because `enforceToolPolicyOnCandidate` is a concrete function, not a seam. */
const TOOL_POLICY_MESSAGE =
  "output implies a mutating external action but the job's ToolPolicy forbids mutation (read_only / !allowsMutating) — rejected, not coerced";

/**
 * `schema-gate.ts` reaches `schemaDeny` from SIX call sites, all stamping the SAME closed
 * `reason: "schema_rejected"` at the SAME `stage: "schema_gate"`. Exactly ONE of them — the
 * no-inference branch — interpolates MODEL-CHOSEN text; the other five interpolate the job's own
 * schema id, a normalizer literal, or `universal-rules.ts`'s fixed domain field names. The round
 * before this one replaced FOUR of the five SoW-authored ones with the same fixed sentence, so an
 * ajv structural rejection and a no-inference rejection rendered BYTE-IDENTICALLY.
 */
const SCHEMA_GATE_SOW_AUTHORED_MESSAGES: readonly string[] = [
  "ajv structural gate rejected output against 'sow:daily-brief-output' (schema_violation)",
  "no model parser registered for 'sow:daily-brief-output'; refusing ajv-alone validation (LESSONS §3)",
  "model schema parse rejected output against 'sow:daily-brief-output' (Zod .refine/cross-field)",
  "output not normalizable to a candidate: no candidate mapping for outputSchemaId 'sow:daily-brief-output'",
  "§3 universal rule rejection (unscoped_mutation:workspaceId|sourceRefs)",
];

/** `broker.ts:383` — a lifecycle fault AT the schema-gate stage. A real, real-Broker-reachable
 *  `stage: "schema_gate"` rejection whose `reason` is NOT `schema_rejected`. No suite covered this
 *  cell before, and the three legs DISAGREED on it. */
const SCHEMA_GATE_LIFECYCLE_FAULT_MESSAGE = "broker lifecycle fault at schema_gate";

/** Every token that must never appear in a redacted result, however the message was assembled. */
function expectNoModelText(serialized: string): void {
  expect(serialized).not.toContain(POISON_FIELDS);
  expect(serialized).not.toContain(POISON_PATH);
  expect(serialized).not.toContain("not coerced [");
}

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
    expectNoModelText(JSON.stringify(res));
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

  // EVERY stage forwards a SoW-authored diagnostic verbatim — INCLUDING `schema_gate`. The
  // redaction is keyed on the ONE no-inference message, not on the stage, so a schema-gate
  // rejection carrying SoW-authored text keeps it. Before this change the `schema_gate` row here
  // expected FIXED_SCHEMA_MESSAGE, i.e. it pinned the collapse.
  for (const stage of BrokerStage) {
    it(`stage "${stage}" -> ${EXPECTED_CODE[stage]} (SoW-authored message forwarded VERBATIM)`, async () => {
      const message = `SoW-authored diagnostic for ${stage}`;
      const res = await port(rejection(stage, message)).run({});
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe(EXPECTED_CODE[stage]);
      expect(res.error.message).toBe(message);
    });
  }

  // ── the schema gate's OWN six branches no longer collapse (2026-08-27 (b)) ──
  for (const message of SCHEMA_GATE_SOW_AUTHORED_MESSAGES) {
    it(`schema_gate, SoW-authored denial forwards VERBATIM: ${message.slice(0, 44)}…`, async () => {
      const res = await port(rejection("schema_gate", message)).run({});
      expect(res.ok).toBe(false);
      if (res.ok) return;
      // Same closed code as the no-inference branch — the code cannot separate them…
      expect(res.error.code).toBe("schema_rejected");
      // …so the MESSAGE has to, and now does.
      expect(res.error.message).toBe(message);
      expect(res.error.message).not.toBe(FIXED_SCHEMA_MESSAGE);
    });
  }

  it("MUTATION PROOF of the carve-out: all six schema-gate denials render DISTINCTLY, and only the no-inference one is replaced", async () => {
    const all = [...SCHEMA_GATE_SOW_AUTHORED_MESSAGES, POISONED];
    const rendered: string[] = [];
    for (const message of all) {
      const res = await port(rejection("schema_gate", message)).run({});
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error.code).toBe("schema_rejected");
      rendered.push(res.error.message);
    }
    // Widening the predicate back to "the whole schema_gate stage" makes these six collapse to one
    // string and REDs this line — that is the mutation proof.
    expect(new Set(rendered).size).toBe(all.length);
    // Exactly one of the six was replaced, and it is the model-authored one.
    expect(rendered.filter((m) => m === FIXED_SCHEMA_MESSAGE)).toEqual([FIXED_SCHEMA_MESSAGE]);
    expect(rendered[rendered.length - 1]).toBe(FIXED_SCHEMA_MESSAGE);
    expectNoModelText(JSON.stringify(rendered));
  });

  it("NEW CELL, no suite covered it: `schema_gate` paired with a real-Broker reason that is NEITHER `schema_rejected` NOR `tool_policy_violation` — `lifecycle_fault` (broker.ts:383) — forwards", async () => {
    // `broker.ts:383` calls `lifecycleFault("schema_gate", …)` when the job cannot advance to
    // `schema_validated`. The previous rule ("derived code is schema_rejected AND reason is not
    // tool_policy_violation") REPLACED this SoW-authored diagnostic here, while the worker
    // source-extraction leg forwarded it — a real divergence on a real, reachable cell, produced by
    // a doc comment that asserted no such reason existed.
    const res = await port(
      rejection("schema_gate", SCHEMA_GATE_LIFECYCLE_FAULT_MESSAGE, {
        reason: "lifecycle_fault",
        branch: "failed_terminal",
      }),
    ).run({});
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
    ).run({});
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
    ).run({});
    const noInference = await port(rejection("schema_gate", POISONED)).run({});
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
    // NOT reachable through the real Broker's own schema gate (which stamps only `schema_rejected`
    // / `tool_policy_violation`) — the real `schema_gate` rejections it does NOT cover are
    // `lifecycle_fault` (broker.ts:383), pinned above as SoW-authored.
    //
    // The previous rule bought this backstop by collapsing five SoW-authored diagnostics onto one
    // sentence; that trade is the operator-blinding class root CLAUDE.md forbids, so the backstop
    // was dropped and the residual accepted. This test exists so the residual is a PINNED,
    // deliberate property rather than an unnoticed hole: if a future round wants the backstop back,
    // it must delete this test and re-argue the collapse it costs.
    const res = await port(rejection("schema_gate", POISONED, { reason: "provider_error" })).run({});
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("schema_rejected");
    expect(res.error.message).toBe(POISONED);
    // The STRUCTURAL fix (out of this leg's scope): a distinct `BrokerFailureReason` for the
    // no-inference branch in packages/providers, so this rule can key on a closed field alone.
  });

  it("the shared predicate is the ONE rule ALL THREE legs use, and every field it reads is a closed union or a SoW-authored anchor", () => {
    const at = (
      stage: BrokerStage,
      reason: BrokerRejection["reason"],
      message: string,
    ): BrokerRejection => {
      const outcome = rejection(stage, message, { reason });
      if (outcome.ok) throw new Error("fixture must be a rejection");
      return outcome.error;
    };
    // The ONE true cell: schema_gate + schema_rejected + the no-inference message.
    expect(brokerRejectionNeedsFixedMessage(at("schema_gate", "schema_rejected", POISONED))).toBe(true);
    // Same stage + reason, SoW-authored message → forwards (this is finding 3's fix).
    for (const message of SCHEMA_GATE_SOW_AUTHORED_MESSAGES) {
      expect(brokerRejectionNeedsFixedMessage(at("schema_gate", "schema_rejected", message))).toBe(false);
    }
    // Same stage, other real reasons → forwards.
    expect(
      brokerRejectionNeedsFixedMessage(at("schema_gate", "tool_policy_violation", TOOL_POLICY_MESSAGE)),
    ).toBe(false);
    expect(
      brokerRejectionNeedsFixedMessage(
        at("schema_gate", "lifecycle_fault", SCHEMA_GATE_LIFECYCLE_FAULT_MESSAGE),
      ),
    ).toBe(false);
    // The no-inference MESSAGE at any OTHER stage is not a schema-gate denial and forwards — a
    // stage a schema gate never runs at cannot have produced schema-gate text.
    for (const stage of BrokerStage) {
      if (stage === "schema_gate") continue;
      expect(brokerRejectionNeedsFixedMessage(at(stage, "schema_rejected", POISONED))).toBe(false);
    }
  });

  it("boundary guard: a contract-violating rejection with no `message` does not throw the predicate", () => {
    const malformed = { stage: "schema_gate", reason: "schema_rejected" } as unknown as BrokerRejection;
    expect(brokerRejectionNeedsFixedMessage(malformed)).toBe(false);
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

// ═══════════════════════════════════════════════════════════════════════════════════════════════
// THE END-TO-END DRIVE. Everything above builds `BrokerRejection` fixtures by hand — faithful, but
// still a READING of `broker.ts` + `schema-gate.ts`. This block builds NEITHER: it wires the REAL
// `createBroker` over the REAL `createSchemaGate` and lets the real pipeline stamp the real
// rejection, then feeds THAT outcome to the real activity.
//
// It is what anchors `NO_INFERENCE_REJECTION_PREFIX`. That constant duplicates a literal in
// `packages/providers`, which this package cannot type-bind to — so the compiler cannot catch a
// reword of `schema-gate.ts`'s no-inference template. THIS TEST CAN, and does: it asserts the
// prefix against the message the real gate actually produced.
// ═══════════════════════════════════════════════════════════════════════════════════════════════
describe("spec(rule 7 / I3) readOnlyAgentJob END-TO-END over the REAL broker + REAL schema gate", () => {
  const MODEL_CHOSEN_FIELDS = ["owner_PZN9F3A1BSECRET", "dueDate_LEAKMARKER"] as const;

  /** The REAL `createSchemaGate`, with a `NoInferenceView` that rejects the two model-chosen field
   *  names above — the ONLY injected seam. Everything else (ajv, the Zod parse, the normalizer,
   *  the §3 rules, the tool-policy check) is the production composition. */
  function realSchemaGate(reject: boolean): SchemaGate {
    return createSchemaGate({
      modelSchemas: { [KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID]: KnowledgeMutationPlanSchema },
      ...(reject
        ? {
            noInference: () =>
              err(MODEL_CHOSEN_FIELDS.map((field) => ({ field, code: "unbacked" }))),
          }
        : {}),
    });
  }

  const AUDIT = buildAuditSignal({
    actor: "test",
    event: "test.audit",
    refs: [],
    payloadHash: "test",
    beforeSummary: "b",
    afterSummary: "a",
  });

  /** The REAL broker over the real schema gate. Health / budget / run are trivial passthroughs (a
   *  provider is not what is under test); route resolution + egress veto are allow-seams, exactly
   *  as `packages/providers/test/broker.test.ts` wires them. ADMISSION IS THE REAL `admitJob`. */
  function realBroker(schema: SchemaGate, candidateOutput: unknown): ReadOnlyAgentBroker {
    return createBroker({
      health: () => ok({ value: undefined }),
      budget: {
        pre: (job) => ok({ value: { maxRuntimeSeconds: job.maxRuntimeSeconds } }),
        post: () => ok({ value: undefined }),
      },
      run: () =>
        Promise.resolve(
          ok({
            value: makeAgentResult({
              status: "completed",
              candidateOutput,
              usage: { runtimeSeconds: 1 },
              logs: [],
            }),
          }),
        ),
      schema,
      resolveRoute: () => allowDecision(validProviderRoute, AUDIT),
      egressVeto: (_job, route) => allowDecision(route, AUDIT),
    });
  }

  const KMP_VALID = { ...validKnowledgeMutationPlan, externalActionProposals: [] };

  function drive(schema: SchemaGate, candidateOutput: unknown) {
    return createReadOnlyAgentJobActivity({
      broker: realBroker(schema, candidateOutput),
      inputs: jobInputs({
        capability: "meeting.close",
        outputSchemaId: KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
      }),
      buildEgress: () => ({}) as never,
      buildMatrix: () => ({}) as never,
      buildWorkspace: () => ({ type: "personal_life" as never, dataOwner: "user" as never }),
      mapCandidate: () => ({ fields: "accepted" }) as Output,
    }).run({});
  }

  it("the REAL broker + REAL schema gate stamp stage `schema_gate` / reason `schema_rejected`, and the message really does open with NO_INFERENCE_REJECTION_PREFIX", async () => {
    let captured: BrokerRejection | undefined;
    const broker = realBroker(realSchemaGate(true), KMP_VALID);
    const outcome = await broker.runJob({
      job: {
        ...validAgentJob,
        outputSchemaId: KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
        toolPolicy: { mode: "read_only", allowedTools: [], deniedTools: [], allowsMutating: false },
      },
      matrix: {} as never,
      egress: {} as never,
      workspace: { type: "personal_life" as never, dataOwner: "user" as never },
    });
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    captured = outcome.error;
    // The anchor: this is the production literal, not a fixture.
    expect(captured.stage).toBe("schema_gate");
    expect(captured.reason).toBe("schema_rejected");
    expect(captured.message.startsWith(NO_INFERENCE_REJECTION_PREFIX)).toBe(true);
    // …and it really does quote the model-chosen names, which is why it is the one redacted.
    for (const field of MODEL_CHOSEN_FIELDS) expect(captured.message).toContain(field);
    // eslint-disable-next-line no-console
    console.log("[E2E] real broker no-inference message:", captured.message);
  });

  it("driven end-to-end, the activity DROPS the real gate's model-authored field names", async () => {
    const res = await drive(realSchemaGate(true), KMP_VALID);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("schema_rejected");
    expect(res.error.message).toBe(FIXED_SCHEMA_MESSAGE);
    for (const field of MODEL_CHOSEN_FIELDS) expect(JSON.stringify(res)).not.toContain(field);
    // eslint-disable-next-line no-console
    console.log("[E2E] activity result (no-inference):", JSON.stringify(res.error));
  });

  it("driven end-to-end, an ajv STRUCTURAL rejection from the SAME real gate FORWARDS its real diagnostic — the two no longer render identically", async () => {
    // Same gate, same stage, same reason, same derived code. Only the message separates them, and
    // before this change it did not: both rendered as FIXED_SCHEMA_MESSAGE.
    const structural = await drive(realSchemaGate(false), { not: "a knowledge mutation plan" });
    const noInference = await drive(realSchemaGate(true), KMP_VALID);
    expect(structural.ok).toBe(false);
    expect(noInference.ok).toBe(false);
    if (structural.ok || noInference.ok) return;
    expect(structural.error.code).toBe("schema_rejected");
    expect(noInference.error.code).toBe("schema_rejected");
    expect(structural.error.code).toBe(noInference.error.code);
    // The whole point of the round:
    expect(structural.error.message).not.toBe(noInference.error.message);
    expect(structural.error.message).not.toBe(FIXED_SCHEMA_MESSAGE);
    expect(structural.error.message).toContain("ajv structural gate rejected output");
    expect(noInference.error.message).toBe(FIXED_SCHEMA_MESSAGE);
    // eslint-disable-next-line no-console
    console.log("[E2E] activity result (ajv structural):", JSON.stringify(structural.error));
  });
});
