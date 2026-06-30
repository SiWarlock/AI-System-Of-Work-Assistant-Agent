// 1.15 — shared seam contract-test fixtures META-TEST (in @sow/domain).
//
// The fixtures themselves are DATA in @sow/contracts (contracts must NOT depend
// on @sow/domain). This meta-test lives here because it needs BOTH the contracts
// fixtures AND the @sow/domain schema-gate `validate()` (1.2) + `validateNoInference`
// (1.11) — it pins every fixture's CLAIMED validity label against what the gate
// actually says, so a dishonest fixture can never enter the seam.
//
// arch_gap (interpretation of the 1.15 meta-test bullet). The bullet says
// "validate(instance, SCHEMA_ID) is ok iff valid===true", but several pinned
// invalid rules (read_only⇒!allowsMutating, egress-ack coupling, KMP non-empty
// sourceRefs, route⊆allowedProviders) are cross-field `.refine()`s that the
// generated JSON Schema does NOT carry — so the bare ajv `validate()` PASSES them.
// We therefore state the label==verdict biconditional against the FULL contract
// gate (ajv structural + Zod parse) and additionally assert the per-tier behavior,
// surfacing the structural-only nature of the ajv gate rather than hiding it.
//
// TWO-TIER GATE (load-bearing finding). The 1.2 candidate-data gate `validate()`
// runs the GENERATED JSON Schema through ajv. `zod-to-json-schema` does NOT
// translate cross-field `.refine()` rules (read_only⇒!allowsMutating,
// egress-ack⇔acknowledgedAt, sourceRefs non-empty, route⊆allowedProviders, …),
// so those rules are NOT in the JSON Schema — the ajv gate is STRUCTURAL-ONLY.
// The authoritative contract is the model's Zod schema (the JSON Schema is
// generated from it). So a fixture that violates only a refine PASSES the ajv
// gate but FAILS the Zod parse. The "full contract gate" = ajv structural gate
// AND Zod parse; the biconditional below is stated against that full gate, and
// each invalid fixture additionally declares which tier rejects it.
import { describe, it, expect } from "vitest";
import type { ZodTypeAny } from "zod";
import { validate } from "../../src/validation/schema-gate";
import { validateNoInference } from "../../src/validation/no-inference";
import type { ExtractionField } from "../../src/validation/no-inference";
import { FIXTURES } from "@sow/contracts/fixtures/index";
import type { FixtureEntry } from "@sow/contracts/fixtures/index";
import { defaultSchemaRegistry } from "@sow/contracts/schema/registry";
import {
  ToolPolicySchema,
  EgressPolicySchema,
  ProviderRouteSchema,
  ProviderProfileSchema,
  ProviderMatrixSchema,
  WorkspaceSchema,
  AgentJobSchema,
  KnowledgeMutationPlanSchema,
  ProposedActionSchema,
  ExternalWriteEnvelopeSchema,
  WriteReceiptSchema,
  SourceEnvelopeSchema,
  GclProjectionSchema,
  ApprovalSchema,
  AuditRecordSchema,
  WorkflowRunRefSchema,
  HealthItemSchema,
  NotebookMappingSchema,
  SemanticFactSchema,
  FactProvenanceSchema,
  SignedProvenanceStampSchema,
  ParityReportSchema,
  DivergenceSchema,
  QuarantineRecordSchema,
  GBrainProposedFactSchema,
  GbrainReadGrantSchema,
  GbrainPinSchema,
} from "@sow/contracts";

// schemaId ($id) -> the AUTHORITATIVE Zod schema (refines included). Keyed by the
// frozen `sow:*` ids so a refine-tier fixture can be parsed by the real contract.
const ZOD_BY_ID: Record<string, ZodTypeAny> = {
  "sow:tool-policy": ToolPolicySchema,
  "sow:egress-policy": EgressPolicySchema,
  "sow:provider-route": ProviderRouteSchema,
  "sow:provider-profile": ProviderProfileSchema,
  "sow:provider-matrix": ProviderMatrixSchema,
  "sow:workspace": WorkspaceSchema,
  "sow:agent-job": AgentJobSchema,
  "sow:knowledge-mutation-plan": KnowledgeMutationPlanSchema,
  "sow:proposed-action": ProposedActionSchema,
  "sow:external-write-envelope": ExternalWriteEnvelopeSchema,
  "sow:write-receipt": WriteReceiptSchema,
  "sow:source-envelope": SourceEnvelopeSchema,
  "sow:gcl-projection": GclProjectionSchema,
  "sow:approval": ApprovalSchema,
  "sow:audit-record": AuditRecordSchema,
  "sow:workflow-run-ref": WorkflowRunRefSchema,
  "sow:health-item": HealthItemSchema,
  "sow:notebook-mapping": NotebookMappingSchema,
  "sow:semantic-fact": SemanticFactSchema,
  "sow:fact-provenance": FactProvenanceSchema,
  "sow:signed-provenance-stamp": SignedProvenanceStampSchema,
  "sow:parity-report": ParityReportSchema,
  "sow:divergence": DivergenceSchema,
  "sow:quarantine-record": QuarantineRecordSchema,
  "sow:gbrain-proposed-fact": GBrainProposedFactSchema,
  "sow:gbrain-read-grant": GbrainReadGrantSchema,
  "sow:gbrain-pin": GbrainPinSchema,
};

const zodFor = (schemaId: string): ZodTypeAny => {
  const zs = ZOD_BY_ID[schemaId];
  if (zs === undefined) {
    throw new Error(`fixtures.test: no Zod schema mapped for ${schemaId}`);
  }
  return zs;
};

// Full contract gate = ajv structural gate (1.2 validate) AND the authoritative
// Zod parse (refines). This is what the candidate-data pipeline actually enforces.
const fullGateAccepts = (schemaId: string, instance: unknown): boolean =>
  validate(instance, schemaId).ok && zodFor(schemaId).safeParse(instance).success;

const schemaBacked = FIXTURES.filter((f): f is FixtureEntry & { schemaId: string } => f.schemaId !== null);

describe("seam fixtures registry (1.15)", () => {
  it("exposes a non-empty FIXTURES registry with both valid and invalid entries", () => {
    expect(FIXTURES.length).toBeGreaterThan(0);
    expect(FIXTURES.some((f) => f.valid)).toBe(true);
    expect(FIXTURES.some((f) => !f.valid)).toBe(true);
  });

  it("provides exactly one VALID fixture for every registered Appendix-A schema (all 27)", () => {
    const registered = [...defaultSchemaRegistry.ids()].sort();
    const validCovered = FIXTURES.filter((f) => f.valid && f.schemaId !== null).map(
      (f) => f.schemaId as string,
    );
    // Coverage: every registered schema has a valid fixture.
    expect([...new Set(validCovered)].sort()).toEqual(registered);
    // No duplicate valid fixture per schema.
    expect(validCovered.length).toBe(registered.length);
  });

  it("every invalid fixture declares the gate tier that rejects it", () => {
    for (const f of FIXTURES) {
      if (!f.valid) {
        expect(f.rejectedBy).toBeDefined();
      }
    }
  });
});

describe("claimed label === full-contract-gate verdict (1.15 honesty pin)", () => {
  it.each(schemaBacked.map((f) => [f.model + ":" + (f.valid ? "valid" : "invalid"), f] as const))(
    "%s — fullGateAccepts === valid",
    (_name, f) => {
      expect(fullGateAccepts(f.schemaId, f.instance)).toBe(f.valid);
    },
  );
});

describe("per-tier behavior against the 1.2 ajv gate (structural-only)", () => {
  it("every VALID fixture passes the bare 1.2 candidate-data gate", () => {
    for (const f of schemaBacked) {
      if (f.valid) {
        const r = validate(f.instance, f.schemaId);
        expect(r.ok, `${f.model} should pass validate()`).toBe(true);
      }
    }
  });

  it("schema_gate invalids are caught by the 1.2 ajv gate (structural)", () => {
    const structural = schemaBacked.filter((f) => !f.valid && f.rejectedBy === "schema_gate");
    expect(structural.length).toBeGreaterThan(0);
    for (const f of structural) {
      const r = validate(f.instance, f.schemaId);
      expect(r.ok, `${f.model} should be rejected by validate()`).toBe(false);
    }
  });

  it("refine invalids PASS the ajv gate but FAIL the authoritative Zod parse (arch gap: refines not in JSON Schema)", () => {
    const refine = schemaBacked.filter((f) => !f.valid && f.rejectedBy === "refine");
    expect(refine.length).toBeGreaterThan(0);
    for (const f of refine) {
      // The structural-only ajv gate cannot see the cross-field refine.
      expect(validate(f.instance, f.schemaId).ok, `${f.model}: ajv gate is structural-only`).toBe(
        true,
      );
      // The authoritative Zod schema DOES reject it.
      expect(zodFor(f.schemaId).safeParse(f.instance).success, `${f.model}: Zod rejects`).toBe(
        false,
      );
    }
  });
});

describe("no-inference fixture (REQ-F-017, validated by 1.11 not the schema gate)", () => {
  it("the no-inference fixture is rejected by validateNoInference", () => {
    const ni = FIXTURES.filter((f) => f.rejectedBy === "no_inference");
    expect(ni.length).toBeGreaterThan(0);
    for (const f of ni) {
      const fields = f.instance as Record<string, ExtractionField<unknown>>;
      const r = validateNoInference(fields);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        // At least one offending field flagged with an enumerable code.
        expect(r.error.length).toBeGreaterThan(0);
        for (const rej of r.error) {
          expect(["missing_evidence", "inferred_owner_or_date"]).toContain(rej.code);
        }
      }
    }
  });
});
