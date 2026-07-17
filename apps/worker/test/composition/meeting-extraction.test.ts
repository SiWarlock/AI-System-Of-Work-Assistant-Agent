// 18.3 (B-rescoped) — the meeting extraction leg's TWO worker-only deliverables:
//   1. `mapAcceptedMeetingExtraction` — mapCandidate GATES on the accepted BrokerOutcome
//      (narrows `outcome.ok`, reads the accepted candidate — the run-leg output passed the
//      broker schema gate), instead of blindly echoing the injected extraction; a NON-accepted
//      outcome ⇒ an EMPTY extraction (which the downstream gate rejects → no commit).
//   2. `createMeetingExtractionSchemaGate` — a REAL structural candidate-data gate (rule 2 /
//      REQ-S-006) over the extraction's fields, replacing the `() => ok(undefined)` stub. Pure,
//      NEVER coerces. Composed with `validateNoInference` (REQ-F-017, already live) inside the
//      production-reachable `ValidateExtractionPort` (createValidateActivity).
//
// SAFE-BUILD: the run leg is 18.1's dormant stub — no real model/prompt executes here; the
// gates are pure deterministic validators. The faithful extraction-from-broker-outcome
// reconstruction (evidence-bearing) is deferred to the first-class `agent_extraction`
// candidate (task #18) — the accepted BrokerCandidate (KMP stand-in) discards `evidenceRef`.
import { describe, it, expect } from "vitest";
import { ok, err, isOk, isErr } from "@sow/contracts";
import { TBD, type ExtractionField } from "@sow/domain";
import { createValidateActivity } from "@sow/workflows";
import type { AgentExtraction } from "@sow/workflows";
import type { BrokerOutcome, BrokerAccepted, BrokerRejection } from "@sow/providers";
import {
  createMeetingExtractionSchemaGate,
  mapAcceptedMeetingExtraction,
} from "../../src/composition/meeting-extraction";

// ── fixtures ────────────────────────────────────────────────────────────────
const field = (value: unknown, evidenceRef?: string): ExtractionField<unknown> =>
  ({ value, ...(evidenceRef !== undefined ? { evidenceRef } : {}) }) as ExtractionField<unknown>;

// A well-formed, EVIDENCED extraction (concrete values carry an evidenceRef; TBD needs none).
const validExtraction: AgentExtraction = {
  fields: {
    title: field("Weekly Sync", "transcript:span:1"),
    owner: field(TBD),
    dueDate: field(TBD),
  },
};
// A concrete owner with NO evidenceRef — an INFERRED (invented) owner (REQ-F-017 reject).
const inferredOwnerExtraction: AgentExtraction = {
  fields: { title: field("Weekly Sync", "transcript:span:1"), owner: field("Alice") },
};
// Ambiguous/absent owner + dueDate → TBD (never invented).
const tbdExtraction: AgentExtraction = {
  fields: { title: field("Weekly Sync", "transcript:span:1"), owner: field(TBD), dueDate: field(TBD) },
};
// Structurally MALFORMED: a field value that is not a primitive/TBD (a nested object).
const malformedExtraction = {
  fields: { title: { value: { nested: "not-a-primitive" } } },
} as unknown as AgentExtraction;

const accepted: BrokerOutcome = ok({
  jobState: "accepted",
  route: {} as never,
  candidate: { kind: "knowledge_mutation_plan", plan: {} as never },
  usage: { runtimeSeconds: 1 },
  audits: [],
  replayed: false,
} as unknown as BrokerAccepted);
const rejected: BrokerOutcome = err({
  stage: "schema_gate",
  reason: "schema_rejected",
  message: "rejected",
  jobState: "running",
  branch: "rejected",
  retryable: false,
  audits: [],
} as unknown as BrokerRejection);

// ── 1. mapCandidate gates on the accepted outcome ──────────────────────────────
describe("mapAcceptedMeetingExtraction — gate on the accepted broker outcome (18.3 AC#1)", () => {
  it("map_gates_on_accepted_outcome_reads_candidate — accepted ⇒ the extraction; NON-accepted ⇒ empty, never a blind echo (spec §9)", () => {
    // Accepted (the run-leg output passed the broker schema gate) → the extraction traces through.
    expect(mapAcceptedMeetingExtraction(accepted, validExtraction)).toEqual(validExtraction);
    // A NON-accepted outcome is NOT blindly echoed as the injected extraction — it yields an
    // EMPTY extraction, which the downstream candidate-data gate rejects (no commit). This is the
    // tightening over today's `(_outcome) => params.meetingExtraction` blind-ignore.
    const onRejected = mapAcceptedMeetingExtraction(rejected, validExtraction);
    expect(onRejected.fields).toEqual({});
  });
});

// ── 2. the REAL structural schema gate (rule 2 / REQ-S-006) ────────────────────
describe("createMeetingExtractionSchemaGate — real structural candidate-data gate (18.3, rule 2)", () => {
  const gate = createMeetingExtractionSchemaGate();

  // Every reject branch is load-bearing for a rule-2 gate over untrusted model output — pin them
  // all, including the branches that guard the "PURE + total, never throws" contract (null fields).
  it.each([
    ["no fields map (null)", { fields: null } as unknown as AgentExtraction],
    ["empty fields", { fields: {} } as AgentExtraction],
    ["null field", { fields: { owner: null } } as unknown as AgentExtraction],
    ["field missing value", { fields: { owner: { evidenceRef: "x" } } } as unknown as AgentExtraction],
    ["non-ExtractionField (string field)", { fields: { owner: "Alice" } } as unknown as AgentExtraction],
    ["nested-object value", malformedExtraction],
    ["array value", { fields: { title: { value: ["a", "b"] } } } as unknown as AgentExtraction],
    ["null value (absence is TBD, not null)", { fields: { title: { value: null } } } as unknown as AgentExtraction],
    ["non-string evidenceRef", { fields: { title: { value: "T", evidenceRef: 7 } } } as unknown as AgentExtraction],
  ])("schema_gate_rejects_%s ⇒ schema_rejected, never throws (spec REQ-S-006)", (_label, extraction) => {
    const res = gate(extraction); // must not throw on hostile/malformed input
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("schema_rejected");
  });

  it("schema_gate_accepts_valid_extraction — a well-formed extraction ⇒ ok (spec §7 accept)", () => {
    expect(isOk(gate(validExtraction))).toBe(true);
  });

  it("safe_build_schema_gate_is_pure_no_model — deterministic, no I/O; identical input ⇒ identical result (spec SAFE-BUILD)", () => {
    expect(gate(validExtraction)).toEqual(gate(validExtraction));
  });
});

// ── 3. REQ-F-017 at the live ValidateExtractionPort (real gate composed with no-inference) ──
describe("createValidateActivity(realGate) — REQ-F-017 + structural gate composed (18.3 AC#3)", () => {
  const validate = createValidateActivity({ schemaGate: createMeetingExtractionSchemaGate() });

  it("validate_rejects_inferred_owner — concrete owner + NO evidenceRef ⇒ no_inference_violation (spec REQ-F-017)", () => {
    const res = validate.validate(inferredOwnerExtraction);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("no_inference_violation"); // never an invented owner
  });

  it("validate_tbd_owner_and_date_pass — ambiguous/absent owner+dueDate ⇒ TBD ⇒ ok, never invented (spec REQ-F-017)", () => {
    const res = validate.validate(tbdExtraction);
    expect(isOk(res)).toBe(true);
  });

  it("validate_never_coerces_short_circuits — an inferred field REJECTS (no partial, no coercion/default-fill) (spec REQ-F-017)", () => {
    // No-inference runs FIRST and short-circuits — the gate NEVER coerces an unstated field to
    // satisfy the schema. A malformed AND inferred extraction rejects on no-inference, not a
    // silently-fixed pass.
    const inferredAndMalformed = {
      fields: { owner: field("Bob"), title: { value: { nested: 1 } } },
    } as unknown as AgentExtraction;
    const res = validate.validate(inferredAndMalformed);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("no_inference_violation"); // no-inference short-circuits before the schema gate
  });

  it("validate_empty_evidenceRef_rejected_by_no_inference — structural gate accepts the well-formed empty string; no-inference rejects the unevidenced concrete (division of labor, REQ-F-017)", () => {
    const res = validate.validate({ fields: { title: field("Weekly Sync", "") } });
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("no_inference_violation"); // "" evidenceRef ⇒ missing evidence
  });

  it("validate_empty_fields_rejected_by_schema_gate — no-inference passes {} vacuously; the schema gate is the sole guard (REQ-S-006)", () => {
    const res = validate.validate({ fields: {} });
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("schema_rejected");
  });

  it("accept_path_valid_extraction_passes_real_gate — a well-formed evidenced extraction ⇒ ValidatedExtraction (spec AC#4 accept-path)", () => {
    const res = validate.validate(validExtraction);
    expect(isOk(res)).toBe(true);
    if (!isOk(res)) return;
    expect(res.value.validated).toBe(true);
  });
});

// ── 4. 18.17 / CP-7 — rule-7 reject-message FIELD-KEY redaction regression-pin ────────────────
// Every extraction/schema-gate reject message reports the field KEY + a STRUCTURAL reason — NEVER the
// field VALUE. Once a real model flows, a field value is untrusted raw content; a value in a reject
// message that reaches a log / HealthItem / the renderer is a rule-7 leak. The audit found NO
// worker-territory reject embeds a value (this gate is already key-only; validateNoInference is
// {code, field}; source-extraction forwards token-only upstream messages), so this PINS the invariant
// with a canary so a future value-embedding reject goes RED (L15 — assert UNCONDITIONALLY, not in a .catch).
const CANARY = "SECRET-LEAK-CANARY";
describe("18.17/CP-7 — schema-gate reject messages are field-KEY-only, never the value (rule 7)", () => {
  const gate = createMeetingExtractionSchemaGate();

  it("value_reject_message_carries_the_key_not_the_value — a non-primitive value carrying a secret-like canary ⇒ the reject names the KEY, never the value (rule 7)", () => {
    // The field KEY ("owner") is safe to surface; the VALUE (untrusted model content) must never reach it.
    const res = gate({ fields: { owner: { value: { leak: CANARY } } } } as unknown as AgentExtraction);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.message).toContain("owner"); // the KEY is named …
    expect(res.error.message).not.toContain(CANARY); // … the VALUE is NEVER surfaced (source-mutation: re-adding ${value} ⇒ RED)
  });

  it("evidenceRef_reject_message_carries_the_key_not_the_evidenceRef — a non-string evidenceRef carrying a canary ⇒ key-only (rule 7)", () => {
    const res = gate({ fields: { owner: { value: "T", evidenceRef: [CANARY] } } } as unknown as AgentExtraction);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.message).toContain("owner");
    expect(res.error.message).not.toContain(CANARY);
  });

  it("not_well_formed_field_reject_message_carries_the_key_not_the_field — a bare (non-object) field carrying a canary ⇒ key-only (rule 7)", () => {
    // For a bare-string field the VALUE is the whole field; the not-well-formed reject must still name only the KEY.
    const res = gate({ fields: { owner: CANARY } } as unknown as AgentExtraction);
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.message).toContain("owner");
    expect(res.error.message).not.toContain(CANARY);
  });

  it("validate_activity_reject_is_value_free — the composed ValidateExtractionPort reject (no-inference AND schema paths) never carries a field value (rule 7 / L25)", () => {
    const validate = createValidateActivity({ schemaGate: createMeetingExtractionSchemaGate() });
    // NO-INFERENCE path: a concrete value with NO evidenceRef ⇒ no_inference_violation; reject is field-KEY-keyed, value-free.
    const res = validate.validate({ fields: { owner: field(CANARY) } });
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("no_inference_violation"); // pin the path (no-inference runs first)
    expect(JSON.stringify(res.error)).not.toContain(CANARY);
    // SCHEMA path: an EVIDENCED non-primitive value ⇒ passes no-inference (concrete + evidenceRef), then the
    // schema gate rejects the non-primitive value ⇒ schema_rejected (the composed schema-reject path); value-free.
    const res2 = validate.validate({ fields: { owner: { value: { leak: CANARY }, evidenceRef: "e1" } } } as unknown as AgentExtraction);
    expect(isErr(res2)).toBe(true);
    if (!isErr(res2)) return;
    expect(res2.error.code).toBe("schema_rejected"); // pin: genuinely the composed schema path, not no-inference
    expect(JSON.stringify(res2.error)).not.toContain(CANARY);
  });
});
