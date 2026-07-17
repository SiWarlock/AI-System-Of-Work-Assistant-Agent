// spec(§7) — 5.5 schema gate = the COMPOSED candidate-data gate.
// Provider/runtime output → ajv validate() (@sow/domain) + the model's Zod .parse
// + the §3 universal rules — NEVER ajv alone (LESSONS §3, ajv drops .refine) →
// normalize into the capability's output schema → emit ONLY a KnowledgeMutationPlan
// / ProposedAction CANDIDATE. Schema-invalid / tool-policy-violating output →
// typed deny (no side effect). No coercion (no-inference preserved). Never throws.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { ok, err, isOk, isErr } from "@sow/contracts";
import type { AgentJob, Result } from "@sow/contracts";
import {
  KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
  PROPOSED_ACTION_SCHEMA_ID,
  AGENT_EXTRACTION_SCHEMA_ID,
  KnowledgeMutationPlanSchema,
  ProposedActionSchema,
  AgentExtractionCandidateSchema,
} from "@sow/contracts";
import {
  validAgentJob,
  validKnowledgeMutationPlan,
  validProposedAction,
  validAgentExtractionCandidate,
  invalidKnowledgeMutationPlanEmptySourceRefs,
} from "@sow/contracts";
import { validate } from "@sow/domain";
import { isRedactionSafe } from "@sow/policy";
import { makeAgentResult } from "../src/ports/agent-result";
import type { SchemaGate } from "../src/broker/broker";
import { bySchemaIdNormalizer } from "../src/broker/output-normalizer";
import {
  createSchemaGate,
  type SchemaGateConfig,
  type ModelParser,
} from "../src/broker/schema-gate";
import { forbiddenImportSpecifiers, importSpecifiers } from "./output-normalizer.test";

const modelSchemas: Readonly<Record<string, ModelParser>> = {
  [KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID]: KnowledgeMutationPlanSchema,
  [PROPOSED_ACTION_SCHEMA_ID]: ProposedActionSchema,
};

function gate(overrides: Partial<SchemaGateConfig> = {}): SchemaGate {
  return createSchemaGate({ modelSchemas, normalizer: bySchemaIdNormalizer(), ...overrides });
}

const kmpNoExternal = { ...validKnowledgeMutationPlan, externalActionProposals: [] };
const kmpWithExternal = { ...validKnowledgeMutationPlan, externalActionProposals: [validProposedAction] };

const readOnlyKmpJob: AgentJob = {
  ...validAgentJob,
  outputSchemaId: KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
  toolPolicy: { mode: "read_only", allowedTools: [], deniedTools: [], allowsMutating: false },
};

const scopedWriteActionJob: AgentJob = {
  ...validAgentJob,
  outputSchemaId: PROPOSED_ACTION_SCHEMA_ID,
  toolPolicy: { mode: "scoped_write", allowedTools: [], deniedTools: [], allowsMutating: true },
};

function completed(candidateOutput: unknown) {
  return makeAgentResult({ status: "completed", candidateOutput, usage: { runtimeSeconds: 1 }, logs: [] });
}

// ── CP-2 (18.12a) — agent_extraction gate: the evidence-bearing candidate (GATE-1 payoff) ──
const extractionJob: AgentJob = { ...readOnlyKmpJob, outputSchemaId: AGENT_EXTRACTION_SCHEMA_ID };

function extractionGate(): SchemaGate {
  return gate({ modelSchemas: { ...modelSchemas, [AGENT_EXTRACTION_SCHEMA_ID]: AgentExtractionCandidateSchema } });
}

describe("schema gate — agent_extraction (CP-2 / GATE-1): evidence-bearing candidate", () => {
  it("valid extraction output → agent_extraction candidate (evidenceRef intact, Zod-parsed)", async () => {
    // spec(§19.5) — the gate emits the first-class agent_extraction candidate so the model's
    // evidenceRef reaches validateNoInference faithfully (anti-KMP-stand-in, GATE-1 payoff).
    const out = await extractionGate()(extractionJob, completed(validAgentExtractionCandidate));
    expect(isOk(out)).toBe(true);
    if (!isOk(out)) return;
    expect(out.value.value.kind).toBe("agent_extraction");
    if (out.value.value.kind !== "agent_extraction") return;
    expect(out.value.value.extraction.fields.owner?.evidenceRef).toBe("transcript#L12");
  });

  it("a smuggled extra top-level key → schema_rejected, NO candidate (strict / additionalProperties:false)", async () => {
    // spec(§7) / REQ-S-006 — the closed schema (outer .strict()) rejects a smuggled sibling key.
    const smuggled = { ...validAgentExtractionCandidate, injected: "x" };
    const out = await extractionGate()(extractionJob, completed(smuggled));
    expect(isErr(out)).toBe(true);
    if (!isErr(out)) return;
    expect(out.error.reason).toBe("schema_rejected");
    expect(out.error.branch).toBe("rejected");
  });
});

describe("schema gate — happy path: validated output → emitted candidate", () => {
  it("KMP-shaped output → knowledge_mutation_plan candidate, output unchanged", async () => {
    const out = await gate()(readOnlyKmpJob, completed(kmpNoExternal));
    expect(isOk(out)).toBe(true);
    if (!isOk(out)) return;
    expect(out.value.value.kind).toBe("knowledge_mutation_plan");
    if (out.value.value.kind !== "knowledge_mutation_plan") return;
    expect(out.value.value.plan).toEqual(kmpNoExternal);
  });

  it("ProposedAction-shaped output → proposed_action candidate", async () => {
    const out = await gate()(scopedWriteActionJob, completed(validProposedAction));
    expect(isOk(out)).toBe(true);
    if (!isOk(out)) return;
    expect(out.value.value.kind).toBe("proposed_action");
  });

  it("the accept audit is redaction-safe (carries refs/hashes only — no raw output)", async () => {
    const out = await gate()(readOnlyKmpJob, completed(kmpNoExternal));
    expect(isOk(out)).toBe(true);
    if (!isOk(out) || out.value.audit === undefined) return;
    expect(isRedactionSafe(out.value.audit)).toBe(true);
  });
});

describe("schema gate — COMPOSED, never ajv alone (LESSONS §3)", () => {
  it("ajv ALONE accepts empty-sourceRefs KMP (proves ajv is insufficient)", () => {
    const ajv = validate(invalidKnowledgeMutationPlanEmptySourceRefs, KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID);
    expect(isOk(ajv)).toBe(true); // ajv drops the .refine that forbids empty sourceRefs
  });

  it("the composed gate REJECTS empty-sourceRefs KMP (Zod .refine catches what ajv dropped)", async () => {
    const out = await gate()(readOnlyKmpJob, completed(invalidKnowledgeMutationPlanEmptySourceRefs));
    expect(isErr(out)).toBe(true);
    if (!isErr(out)) return;
    expect(out.error.reason).toBe("schema_rejected");
    expect(out.error.branch).toBe("rejected");
    expect(isRedactionSafe(out.error.audit)).toBe(true);
  });

  it("refuses to validate ajv-alone when no model parser is registered for the schema id", async () => {
    const out = await gate({ modelSchemas: {} })(readOnlyKmpJob, completed(kmpNoExternal));
    expect(isErr(out)).toBe(true);
    if (!isErr(out)) return;
    expect(out.error.reason).toBe("schema_rejected");
  });
});

describe("schema gate — schema-invalid output → rejected, no side effect", () => {
  it("output failing the ajv structural gate → schema_rejected", async () => {
    const out = await gate()(readOnlyKmpJob, completed({ not: "a plan" }));
    expect(isErr(out)).toBe(true);
    if (!isErr(out)) return;
    expect(out.error.reason).toBe("schema_rejected");
  });

  it("an unregistered outputSchemaId → schema_rejected (never throws)", async () => {
    const job: AgentJob = { ...readOnlyKmpJob, outputSchemaId: "sow:unregistered" };
    const out = await gate()(job, completed(kmpNoExternal));
    expect(isErr(out)).toBe(true);
    if (!isErr(out)) return;
    expect(out.error.reason).toBe("schema_rejected");
  });
});

describe("schema gate — tool-policy violation → rejected, not coerced (bullet 4)", () => {
  it("read_only job whose output implies a mutating external action → tool_policy_violation", async () => {
    // A read_only job that emits a KMP carrying an external ProposedAction.
    const out = await gate()(readOnlyKmpJob, completed(kmpWithExternal));
    expect(isErr(out)).toBe(true);
    if (!isErr(out)) return;
    expect(out.error.reason).toBe("tool_policy_violation");
    expect(out.error.branch).toBe("rejected");
  });

  it("read_only job emitting a ProposedAction directly → tool_policy_violation", async () => {
    const job: AgentJob = { ...readOnlyKmpJob, outputSchemaId: PROPOSED_ACTION_SCHEMA_ID };
    const out = await gate()(job, completed(validProposedAction));
    expect(isErr(out)).toBe(true);
    if (!isErr(out)) return;
    expect(out.error.reason).toBe("tool_policy_violation");
  });
});

describe("schema gate — no-inference preserved (REQ-F-017): the gate never coerces", () => {
  it("does not fabricate optional fields onto the emitted candidate", async () => {
    // kmpNoExternal has no gbrainProposalRef / signedProvenanceStamp — the gate must not add them.
    const out = await gate()(readOnlyKmpJob, completed(kmpNoExternal));
    expect(isOk(out)).toBe(true);
    if (!isOk(out) || out.value.value.kind !== "knowledge_mutation_plan") return;
    expect("gbrainProposalRef" in out.value.value.plan).toBe(false);
    expect("signedProvenanceStamp" in out.value.value.plan).toBe(false);
  });

  it("an injected no-inference view that rejects unbacked fields → rejected (not coerced to satisfy schema)", async () => {
    const rejectingNoInference: NonNullable<SchemaGateConfig["noInference"]> = () =>
      err([{ field: "owner", code: "inferred_owner_or_date" }]);
    const out = await gate({ noInference: rejectingNoInference })(readOnlyKmpJob, completed(kmpNoExternal));
    expect(isErr(out)).toBe(true);
    if (!isErr(out)) return;
    expect(out.error.reason).toBe("schema_rejected");
  });

  it("a passing no-inference view leaves the candidate untouched", async () => {
    const passNoInference: NonNullable<SchemaGateConfig["noInference"]> = (_job, v): Result<unknown, never[]> => ok(v);
    const out = await gate({ noInference: passNoInference })(readOnlyKmpJob, completed(kmpNoExternal));
    expect(isOk(out)).toBe(true);
  });
});

describe("schema gate — strict side-effect rule (structural)", () => {
  it("createSchemaGate is assignable to the broker's injected SchemaGate port", () => {
    const g: SchemaGate = gate();
    expect(typeof g).toBe("function");
  });

  it("schema-gate.ts imports NO write-adapter / I/O package (architectural import test)", () => {
    const src = readFileSync(
      fileURLToPath(new URL("../src/broker/schema-gate.ts", import.meta.url)),
      "utf8",
    );
    for (const spec of forbiddenImportSpecifiers) {
      expect(importSpecifiers(src)).not.toContain(spec);
    }
  });
});
