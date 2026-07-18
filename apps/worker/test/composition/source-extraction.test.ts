// 18.4 — the source-ingestion extraction leg routed THROUGH the broker (+ ING-7), the SOURCE
// analog of 18.3's meeting leg. Today `sourceAgent.run` returns a fixed extraction and BYPASSES
// the broker — so the source never hits admission (ING-7) or the candidate-data gate. 18.4 makes
// it a `broker.runJob` over a source AgentJob (read_only / untrusted / carriesRawContent, workspace
// stamped from the ROUTING-BOUND ctx — WS-8), so:
//   • ING-7 (rule 6): a mutating untrusted-source job is REJECTED at admitJob;
//   • gate-on-outcome: mapCandidate reads the accepted BrokerOutcome (reuses mapAcceptedMeetingExtraction);
//   • the candidate-data gate = the reused createMeetingExtractionSchemaGate (structural) + validateNoInference (REQ-F-017).
// SAFE-BUILD: the run leg is 18.1's dormant stub — no real model; the faithful evidence-bearing
// reconstruction is deferred to #18 (the KMP stand-in discards evidenceRef).
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr } from "@sow/contracts";
import type { AgentJob, WorkspaceId, Capability } from "@sow/contracts";
import { TBD, type ExtractionField } from "@sow/domain";
import { createValidateActivity } from "@sow/workflows";
import type { AgentExtraction, SourceIngestionContext, RunSourceAgentJobPort } from "@sow/workflows";
import type { BrokerOutcome, BrokerAccepted, BrokerRejection } from "@sow/providers";
import { KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID, validSourceEnvelope } from "@sow/contracts";
import { createMeetingExtractionSchemaGate, mapAcceptedMeetingExtraction } from "../../src/composition/meeting-extraction";
import {
  createSourceAgentBrokerRouting,
  type SourceJobInputs,
} from "../../src/composition/source-extraction";
import { LOCAL_EXTRACTION_ROUTE } from "../../src/composition/extraction-route-gate";

// ── fixtures ────────────────────────────────────────────────────────────────
const WS_BOUND = "ws-routing-bound" as WorkspaceId;
const WS_SMUGGLED = "ws-smuggled-content" as WorkspaceId;
const field = (value: unknown, evidenceRef?: string): ExtractionField<unknown> =>
  ({ value, ...(evidenceRef !== undefined ? { evidenceRef } : {}) }) as ExtractionField<unknown>;

const sourceExtraction: AgentExtraction = {
  fields: { title: field("Design Doc", "source:span:1"), owner: field(TBD), dueDate: field(TBD) },
};

// ctx: the workspace is the ROUTING-BOUND value; the source CONTENT carries a DIFFERENT ws (smuggle).
const ctx = (over: Partial<SourceIngestionContext> = {}): SourceIngestionContext =>
  ({
    source: { ...validSourceEnvelope, workspaceId: WS_SMUGGLED },
    workspaceId: WS_BOUND,
    ...over,
  }) as unknown as SourceIngestionContext;

const READ_ONLY = { mode: "read_only", allowedTools: [], deniedTools: [], allowsMutating: false };
const MUTATING = { mode: "scoped_write", allowedTools: ["write"], deniedTools: [], allowsMutating: true };

const inputs = (toolPolicy: unknown = READ_ONLY): SourceJobInputs =>
  ({
    workflowRunId: "wf-src-1",
    capability: "source.process" as Capability,
    outputSchemaId: KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
    maxRuntimeSeconds: 30,
    idempotencyKey: "idem-src-1",
    contextRefs: [],
    toolPolicy,
  }) as unknown as SourceJobInputs;

const acceptedOutcome: BrokerOutcome = ok({
  jobState: "accepted",
  route: {} as never,
  // 18.12b: the source leg reconstructs from a first-class `agent_extraction` candidate (CP-2). The faithful
  // reconstruction of `sourceExtraction`'s fields (value + evidenceRef) round-trips to `sourceExtraction`.
  candidate: { kind: "agent_extraction", extraction: sourceExtraction },
  usage: { runtimeSeconds: 1 },
  audits: [],
  replayed: false,
} as unknown as BrokerAccepted);
const rejectedOutcome: BrokerOutcome = err({
  stage: "schema_gate",
  reason: "schema_rejected",
  message: "rejected",
  jobState: "running",
  branch: "rejected",
  retryable: false,
  audits: [],
} as unknown as BrokerRejection);

// A broker spy + the routing deps builder.
function brokerSpy(outcome: BrokerOutcome): { runJob: (req: unknown) => Promise<BrokerOutcome>; calls: unknown[] } {
  const calls: unknown[] = [];
  return { runJob: (req) => { calls.push(req); return Promise.resolve(outcome); }, calls };
}
const routing = (
  broker: { runJob: (req: unknown) => Promise<BrokerOutcome> },
  over: Partial<Parameters<typeof createSourceAgentBrokerRouting>[0]> = {},
): RunSourceAgentJobPort =>
  createSourceAgentBrokerRouting({
    broker: broker as never,
    inputs: inputs(),
    buildEgress: () => ({}) as never,
    buildMatrix: () => ({}) as never,
    buildWorkspace: () => ({ type: "personal_business", dataOwner: "user" }) as never,
    mapCandidate: (o) => mapAcceptedMeetingExtraction(o),
    ...over,
  });

// ── route-through-broker + ING-7 (rule 6) ──────────────────────────────────────
describe("createSourceAgentBrokerRouting — route the source through the broker + ING-7 (18.4)", () => {
  it("source_routed_through_broker_not_bypass — run() dispatches broker.runJob (not the fixed bypass) (spec §19.5)", async () => {
    const broker = brokerSpy(acceptedOutcome);
    const res = await routing(broker).run(ctx());
    expect(broker.calls).toHaveLength(1); // routed through the broker
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value).toEqual(sourceExtraction); // the accepted outcome maps to the extraction
  });

  it("ing7_source_mutating_tool_rejected_at_admission — untrusted source + mutating toolPolicy ⇒ admission deny, broker NOT reached (spec ING-7 rule 6)", async () => {
    const broker = brokerSpy(acceptedOutcome);
    const res = await routing(broker, { inputs: inputs(MUTATING) }).run(ctx());
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("admission_rejected"); // UNTRUSTED_CONTENT_MUTATING_TOOL
    expect(broker.calls).toHaveLength(0); // rejected at admission, before the broker
  });

  it("ing7_source_read_only_admitted — a read_only untrusted source job ⇒ admitted, broker reached (spec ING-7 accept)", async () => {
    const broker = brokerSpy(acceptedOutcome);
    const res = await routing(broker, { inputs: inputs(READ_ONLY) }).run(ctx());
    expect(isOk(res)).toBe(true);
    expect(broker.calls).toHaveLength(1);
  });

  it("source_job_workspaceId_from_ctx_not_content — WS-8: the job's workspaceId is the routing-bound ctx ws, a smuggled content ws is IGNORED (spec WS-8 rule 4 / L33)", async () => {
    let captured: AgentJob | undefined;
    const broker = brokerSpy(acceptedOutcome);
    await routing(broker, {
      admit: (job: AgentJob) => {
        captured = job;
        return { decision: "allow", value: job, audit: {} as never };
      },
    }).run(ctx()); // ctx.workspaceId = WS_BOUND, ctx.source.workspaceId = WS_SMUGGLED
    expect(captured?.workspaceId).toBe(WS_BOUND); // routing-bound, NEVER the smuggled content ws
    expect(captured?.workspaceId).not.toBe(WS_SMUGGLED);
    expect(captured?.trustLevel).toBe("untrusted"); // inv-2
    expect(captured?.carriesRawContent).toBe(true);
  });

  it("source_job_carries_supplied_contextrefs — 18.24: inputs.contextRefs reach the assembled job (the resolver dereferences them); a smuggled content ws is still ignored (spec §19.5 / WS-8 L33)", async () => {
    let captured: AgentJob | undefined;
    const broker = brokerSpy(acceptedOutcome);
    const REFS = [{ refKind: "source", ref: "src-77" }] as unknown as SourceJobInputs["contextRefs"];
    await routing(broker, {
      inputs: { ...inputs(READ_ONLY), contextRefs: REFS },
      admit: (job: AgentJob) => {
        captured = job;
        return { decision: "allow", value: job, audit: {} as never };
      },
    }).run(ctx()); // ctx.workspaceId = WS_BOUND (routing-bound), ctx.source.workspaceId = WS_SMUGGLED (content)
    // The supplied source ContextRef reaches the job (the 18.21 resolver derefs {refKind:"source", ref} to the body).
    expect(captured?.contextRefs).toStrictEqual([{ refKind: "source", ref: "src-77" }]);
    expect(captured?.workspaceId).toBe(WS_BOUND); // WS-8 unaffected — routing-bound ws, never the smuggled content ws
  });

  it("source_job_default_route_is_the_shared_local_constant — 18.24 item iv: an unset providerRoute ⇒ the job carries the SINGLE-SOURCED LOCAL_EXTRACTION_ROUTE (DEFAULT_ROUTE is no longer a hand-copy) (spec §19.5 / L5/L37)", async () => {
    let captured: AgentJob | undefined;
    const broker = brokerSpy(acceptedOutcome);
    await routing(broker, {
      // inputs() leaves providerRoute unset ⇒ the job falls back to DEFAULT_ROUTE (== LOCAL_EXTRACTION_ROUTE).
      admit: (job: AgentJob) => {
        captured = job;
        return { decision: "allow", value: job, audit: {} as never };
      },
    }).run(ctx());
    expect(captured?.providerRoute).toBe(LOCAL_EXTRACTION_ROUTE); // the exact shared frozen constant — no drift
  });

  it("source_job_unbound_workspace_fails_closed — an UNBOUND ctx.workspaceId (WS-2 precondition breach) is rejected BEFORE any admission/dispatch, no job built (spec WS-8 rule 4 / fail-closed)", async () => {
    const broker = brokerSpy(acceptedOutcome);
    const res = await routing(broker).run(ctx({ workspaceId: undefined }));
    expect(isErr(res)).toBe(true); // no job is built with an unbound workspace — fail closed
    expect(broker.calls).toHaveLength(0); // rejected before admission AND before the broker (no side effect)
  });

  it("source_mapCandidate_gates_on_outcome — a broker rejection propagates (no mapCandidate, no blind echo) (spec gate-on-outcome)", async () => {
    let mapped = false;
    const broker = brokerSpy(rejectedOutcome);
    const res = await routing(broker, {
      mapCandidate: (o) => {
        mapped = true;
        return mapAcceptedMeetingExtraction(o);
      },
    }).run(ctx());
    expect(isErr(res)).toBe(true); // the broker rejection propagates as a SourceAgentFailure
    expect(mapped).toBe(false); // mapCandidate is NOT reached on a rejection
  });

  it("safe_build_no_real_model — the extraction comes from the injected broker/mapCandidate; no real model/network (spec SAFE-BUILD)", async () => {
    const broker = brokerSpy(acceptedOutcome);
    const res = await routing(broker).run(ctx());
    expect(isOk(res)).toBe(true); // deterministic — the injected (stub) broker + mapCandidate, no model
  });
});

// ── the reused candidate-data gate over the SOURCE extraction (rule 2 + REQ-F-017) ──
describe("source extraction candidate-data gate — reused MeetingSchemaGate + validateNoInference (18.4)", () => {
  const gate = createMeetingExtractionSchemaGate();
  const validate = createValidateActivity({ schemaGate: gate });

  it("source_schema_gate_rejects_structurally_invalid — a malformed source field ⇒ schema_rejected (spec rule 2)", () => {
    const res = gate({ fields: { title: { value: { nested: "x" } } } } as unknown as AgentExtraction);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("schema_rejected");
  });

  it("source_noinference_inferred_owner_rejected — concrete owner + NO evidenceRef ⇒ no_inference_violation (spec REQ-F-017)", () => {
    const res = validate.validate({ fields: { title: field("Doc", "source:1"), owner: field("Alice") } });
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("no_inference_violation");
  });

  it("source_noinference_tbd_passes — TBD owner/dueDate ⇒ ok, never invented (spec REQ-F-017)", () => {
    expect(isOk(validate.validate({ fields: { title: field("Doc", "source:1"), owner: field(TBD), dueDate: field(TBD) } }))).toBe(true);
  });

  it("accept_path_source_passes_real_gate — the source fixture passes the real gate + no-inference ⇒ ValidatedExtraction (spec accept-path)", () => {
    const res = validate.validate(sourceExtraction);
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.validated).toBe(true);
  });

  // CP-3b/18.13b — the SOURCE leg's evidence-bearing reconstruction end-to-end: an ACCEPTED first-class
  // `agent_extraction` candidate carrying a CONCRETE (non-TBD) value + `evidenceRef` reconstructs FAITHFULLY through
  // the shared `mapAcceptedMeetingExtraction` (the mapper the source leg injects at buildActivities) so
  // `validateNoInference` (REQ-F-017) runs on the model's REAL evidence — WITH evidenceRef ⇒ ok, WITHOUT ⇒ rejected.
  // The 18.4/CP-2 fixtures above only carry TBD for owner/dueDate, so this pins the concrete-value evidence FLOW.
  const acceptedWith = (extraction: AgentExtraction): BrokerOutcome =>
    ok({
      jobState: "accepted",
      route: {} as never,
      candidate: { kind: "agent_extraction", extraction },
      usage: { runtimeSeconds: 1 },
      audits: [],
      replayed: false,
    } as unknown as BrokerAccepted);

  it("source_reconstructs_concrete_value_with_evidenceRef_faithful — concrete owner + evidenceRef round-trips → validate PASSES (spec REQ-F-017, source path)", () => {
    const reconstructed = mapAcceptedMeetingExtraction(
      acceptedWith({ fields: { title: field("Doc", "source:1"), owner: field("Alice", "source:span:7") } }),
    );
    expect(reconstructed.fields.owner).toEqual({ value: "Alice", evidenceRef: "source:span:7" }); // faithful
    expect(isOk(validate.validate(reconstructed))).toBe(true); // evidenceRef reached no-inference ⇒ authorized
  });

  it("source_reconstructs_concrete_value_without_evidenceRef_rejected — the SAME concrete owner MINUS evidenceRef ⇒ no_inference_violation (spec REQ-F-017)", () => {
    const reconstructed = mapAcceptedMeetingExtraction(
      acceptedWith({ fields: { title: field("Doc", "source:1"), owner: field("Alice") } }),
    );
    expect(reconstructed.fields.owner).toEqual({ value: "Alice" }); // no evidenceRef carried through
    const res = validate.validate(reconstructed);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("no_inference_violation"); // an inferred owner is rejected before any commit
  });
});
