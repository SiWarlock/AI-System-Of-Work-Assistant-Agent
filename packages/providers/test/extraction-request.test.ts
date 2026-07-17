// spec(§19.5) — CP-2 (18.12a): the Claude meeting-extraction REQUEST leg.
// Builds the structured-output config (Anthropic `output_config.format` json_schema,
// grounded on Context7 /llmstxt/platform_claude_llms_txt) keyed off the JOB's
// `outputSchemaId` (locked decision #2 — schema id from the job, NEVER the candidate).
//
// Anthropic structured outputs REJECT reference keywords ($ref/$def/definitions) and
// require the schema INLINED (Context7 structured-outputs) — a bare {$id} carries NO
// constraint, so the leg RESOLVES the id → the full inline schema and FAILS CLOSED on
// an unresolved id (never a schemaless/unconstrained request). SAFE-BUILD: this pins the
// request SHAPE; the model's actual output (evidenceRef faithfulness) is eval-at-flip.
import { describe, it, expect } from "vitest";
import type { AgentJob } from "@sow/contracts";
import {
  isOk,
  isErr,
  AGENT_EXTRACTION_SCHEMA_ID,
  validAgentJob,
  validAgentExtractionCandidate,
} from "@sow/contracts";
import { admitJob, isDeny, isAllow } from "@sow/policy";
import {
  buildMeetingExtractionRequest,
  buildSourceExtractionRequest,
  buildClaudeExtractionOutputConfig,
  registrySchemaResolver,
  MEETING_EXTRACTION_PROMPT,
  SOURCE_EXTRACTION_PROMPT,
  type SchemaResolver,
} from "../src/model/extraction-request";
import { bySchemaIdNormalizer } from "../src/broker/output-normalizer";

const extractionJob: AgentJob = { ...validAgentJob, outputSchemaId: AGENT_EXTRACTION_SCHEMA_ID };

// A deterministic fake resolver returning a minimal CLOSED inline schema (never a bare $id ref).
const fakeClosedSchema: Record<string, unknown> = {
  type: "object",
  properties: { fields: { type: "object" } },
  required: ["fields"],
  additionalProperties: false,
};
const fakeResolver: SchemaResolver = (id) => (id === AGENT_EXTRACTION_SCHEMA_ID ? fakeClosedSchema : undefined);

describe("meeting extraction request — INLINE json_schema resolved from the job (CP-2 / GATE-1)", () => {
  it("inlines the full RESOLVED schema (not a bare $id ref) keyed off AgentJob.outputSchemaId", () => {
    // spec(§19.5) — Anthropic rejects $ref and requires the schema inlined; the armed
    // request must carry the real closed schema, resolved from the job's id.
    const out = buildMeetingExtractionRequest(extractionJob, fakeResolver);
    expect(isOk(out)).toBe(true);
    if (!isOk(out)) return;
    expect(out.value.outputConfig.format.type).toBe("json_schema");
    expect(out.value.outputConfig.format.schema).toEqual(fakeClosedSchema); // inlined, resolved from the id
    expect(out.value.outputConfig.format.schema).not.toBe(fakeClosedSchema); // COPIED — never aliases the live registry schema
    expect(out.value.outputConfig.format.schema.additionalProperties).toBe(false);
    // Provably NOT a bare {$id} reference:
    expect(Object.keys(out.value.outputConfig.format.schema)).not.toEqual(["$id"]);
  });

  it("buildMeetingExtractionRequest propagates the schema_unresolved fail-closed fault (wrapper leg)", () => {
    // spec(§7)/REQ-S-006 — the wrapper must fail closed too, never emit a request with no config.
    const out = buildMeetingExtractionRequest(extractionJob, () => undefined);
    expect(isErr(out)).toBe(true);
    if (!isErr(out)) return;
    expect(out.error.code).toBe("schema_unresolved");
    expect(out.error.schemaId).toBe(AGENT_EXTRACTION_SCHEMA_ID);
  });

  it("resolves off WHATEVER schema id the job carries (locked #2) — never a hardcoded/candidate id", () => {
    const seen: string[] = [];
    const spy: SchemaResolver = (id) => {
      seen.push(id);
      return fakeClosedSchema;
    };
    buildClaudeExtractionOutputConfig("sow:some-other-extraction", spy);
    expect(seen).toEqual(["sow:some-other-extraction"]);
  });

  it("FAILS CLOSED on an unresolved schema id — never emits a schemaless/unconstrained request", () => {
    // spec(§7)/REQ-S-006 — a bare {$id} carries no constraint; an unknown id must fail closed.
    const out = buildClaudeExtractionOutputConfig("sow:unknown", fakeResolver);
    expect(isErr(out)).toBe(true);
    if (!isErr(out)) return;
    expect(out.error.code).toBe("schema_unresolved");
    expect(out.error.schemaId).toBe("sow:unknown");
  });

  it("carries the deterministic extraction prompt (REQ-F-017: TBD for unstated, evidenceRef for concrete)", () => {
    const out = buildMeetingExtractionRequest(extractionJob, fakeResolver);
    expect(isOk(out)).toBe(true);
    if (!isOk(out)) return;
    expect(out.value.prompt).toBe(MEETING_EXTRACTION_PROMPT);
    expect(out.value.prompt).toMatch(/evidenceRef/);
    expect(out.value.prompt).toMatch(/TBD/);
  });

  it("the DEFAULT registry resolver resolves AGENT_EXTRACTION_SCHEMA_ID to the real CP-1 closed schema", () => {
    // Proves the seam is wired to the real contracts registry (@sow/contracts/schema/registry),
    // not just a test fake — so the armed request provably carries the CP-1 schema, not an id.
    const schema = registrySchemaResolver(AGENT_EXTRACTION_SCHEMA_ID);
    expect(schema).toBeDefined();
    expect(schema?.type).toBe("object");
    expect(schema?.additionalProperties).toBe(false);
    expect((schema?.properties as Record<string, unknown> | undefined)?.fields).toBeDefined();
  });

  it("the DEFAULT registry resolver returns undefined for an unknown id (fail-closed, never throws)", () => {
    // pins the REAL resolver's no-throw/undefined contract (Map.get + registry never-throw),
    // so the fail-closed path is proven end-to-end, not only via the fake resolver.
    expect(registrySchemaResolver("sow:definitely-not-registered")).toBeUndefined();
  });
});

// ── CP-3 (18.13a) — source extraction leg over agent_extraction (ING-7 preserved) ──
describe("source extraction request — reuses the resolve→inline config; source-appropriate prompt (CP-3)", () => {
  it("carries the INLINE json_schema resolved from AgentJob.outputSchemaId (reuses CP-2's config leg)", () => {
    // spec(§19.5) — same resolve→inline→copy leg as the meeting request (buildClaudeExtractionOutputConfig).
    const out = buildSourceExtractionRequest(extractionJob, fakeResolver);
    expect(isOk(out)).toBe(true);
    if (!isOk(out)) return;
    expect(out.value.outputConfig.format.type).toBe("json_schema");
    expect(out.value.outputConfig.format.schema).toEqual(fakeClosedSchema);
    expect(out.value.outputConfig.format.schema).not.toBe(fakeClosedSchema); // copied — no registry alias
  });

  it("carries a SOURCE-appropriate prompt, distinct from the meeting prompt (REQ-F-017: TBD/evidenceRef)", () => {
    // spec(§9) — the source leg differs only in the prompt (WHAT is extracted), never the gate/admission.
    const out = buildSourceExtractionRequest(extractionJob, fakeResolver);
    expect(isOk(out)).toBe(true);
    if (!isOk(out)) return;
    expect(out.value.prompt).toBe(SOURCE_EXTRACTION_PROMPT);
    expect(out.value.prompt).not.toBe(MEETING_EXTRACTION_PROMPT);
    expect(out.value.prompt).toMatch(/source/i);
    expect(out.value.prompt).toMatch(/evidenceRef/);
    expect(out.value.prompt).toMatch(/TBD/);
  });

  it("fails closed (schema_unresolved) on an unresolved id — same must-carry guarantee as the meeting leg", () => {
    const out = buildSourceExtractionRequest(extractionJob, () => undefined);
    expect(isErr(out)).toBe(true);
    if (!isErr(out)) return;
    expect(out.error.code).toBe("schema_unresolved");
  });

  it("the CP-2 normalizer is schema-keyed (source/meeting-agnostic) — the source leg reuses it unchanged: agent_extraction, evidenceRef round-trips", () => {
    // spec(§19.5) — bySchemaIdNormalizer keys ONLY on outputSchemaId (not a source/meeting flag),
    // so a source extraction output normalizes to the SAME agent_extraction candidate the meeting
    // leg does, evidenceRef intact (REQ-F-017). This schema-agnosticism IS the reuse CP-3 depends
    // on — there is no source-specific normalizer.
    const out = bySchemaIdNormalizer()(extractionJob, validAgentExtractionCandidate);
    expect(isOk(out)).toBe(true);
    if (!isOk(out)) return;
    expect(out.value.kind).toBe("agent_extraction");
    if (out.value.kind !== "agent_extraction") return;
    expect(out.value.extraction).toBe(validAgentExtractionCandidate); // same reference — no coercion
    expect(out.value.extraction.fields.owner?.evidenceRef).toBe("transcript#L12");
  });
});

describe("ING-7 preserved — the source extraction switch does not weaken admission (CP-3, rule 6)", () => {
  const untrustedMutating: AgentJob = {
    ...validAgentJob,
    trustLevel: "untrusted" as const,
    toolPolicy: { mode: "scoped_write", allowedTools: [], deniedTools: [], allowsMutating: true },
  };

  it("an untrusted source job carrying a mutating tool policy still DENIES at admitJob", () => {
    // spec(§6) — ING-7 admission (admitJob, broker step 1) is ORTHOGONAL to the extraction-request
    // change; an untrusted+mutating job still fails closed (regression guard for the source switch).
    const d = admitJob(untrustedMutating);
    expect(isDeny(d)).toBe(true);
    if (!isDeny(d)) return;
    expect(d.reason).toBe("UNTRUSTED_CONTENT_MUTATING_TOOL");
  });

  it("POSITIVE anchor — an untrusted READ-ONLY source job is admitted (grant machinery works, L7)", () => {
    const readOnly: AgentJob = {
      ...untrustedMutating,
      toolPolicy: { mode: "read_only", allowedTools: [], deniedTools: [], allowsMutating: false },
    };
    expect(isAllow(admitJob(readOnly))).toBe(true);
  });
});
