// AgentExtractionCandidate seam model (CP-1 / task 18.11, §19.5/§7/§9 / Appendix A)
// — GATE-1, the REQ-F-017 hard gate of the real-model crossing. The first-class
// `agent_extraction` candidate surface: an evidence-bearing extraction field-map
// carrying per-field `evidenceRef`, so a real model's evidence survives the
// candidate-data gate (safety rule 2 / REQ-S-006) and reaches the domain
// no-inference validator (`validateNoInference`, REQ-F-017) FAITHFULLY.
//
// THE POINT (anti-KMP-stand-in): today the meeting/source legs ride a KMP
// stand-in (`sow:knowledge-mutation-plan`) that DISCARDS per-field `evidenceRef`.
// `validateNoInference` keys on `evidenceRef` (a concrete value with none is an
// invented owner/date → rejected), so arming a real model over the stand-in would
// silently defeat no-inference. This frozen schema preserves `evidenceRef` end to
// end; CP-2/CP-3 switch the meeting/source legs onto it + add the `agent_extraction`
// `BrokerCandidate` union member (providers) that carries this type.
//
// Named `AgentExtractionCandidate` (NOT `AgentExtraction`) to avoid a homonym with
// `@sow/workflows`'s existing `AgentExtraction` (a looser `value: unknown` shape) —
// CP-2/CP-3 wire in workflows/worker where that name is pervasive, so a distinct
// name makes the strict primitive-union contract un-mistakable at the import site.
//
// STRUCTURAL only: the schema pins the SHAPE ({ value: primitive | "TBD",
// evidenceRef? }). It does NOT enforce non-emptiness or a required field catalog
// (the §9 catalog is an arch_gap; non-emptiness is the worker meeting schema
// gate's job) — and it does NOT enforce the no-inference SEMANTIC (that the "TBD"
// sentinel needs no evidence, that a concrete value needs backing): that is
// `validateNoInference`'s job over this validated shape (candidate-data gate =
// this structural schema + the domain validator, LESSONS §3).
//
// Zod is the single source of truth: the TS type is `z.infer` (no branded ids ⇒
// no TS4023, so no explicit-interface workaround needed), the JSON Schema is
// generated via `emitJsonSchema`. PURE — imports only zod (contracts is the root
// of the §2.5 import DAG; it cannot import the domain `ExtractionField`, so the
// field shape is defined here and kept STRUCTURALLY compatible with
// `@sow/domain`'s `ExtractionField<primitive>`).
import { z } from "zod";

/** Stable JSON-Schema `$id` for the schema registry. */
export const AGENT_EXTRACTION_SCHEMA_ID = "sow:agent-extraction" as const;

// Field NAME guard — a catalog-INDEPENDENT dangerous-key BLOCKLIST. Prototype-
// pollution-shaped keys (`__proto__`/`prototype`/`constructor`) are rejected
// STRUCTURALLY (a negative-lookahead regex, so any OTHER name is allowed — the
// full field-name charset allowlist waits on the §9 field catalog). Emitted as
// `propertyNames.pattern` so ajv — the candidate-data gate's structural half —
// REJECTS such a key, rather than relying on Zod silently DROPPING `__proto__`
// (the L3 ajv↔Zod parity gap the security review found). Both legs reject all
// three: ajv via `propertyNames`, Zod via the key schema.
const FIELD_NAME = z
  .string()
  .regex(/^(?!(?:__proto__|prototype|constructor)$)/, "reserved prototype-pollution key");

// One extracted field. `value` is a primitive claim OR the "TBD" park sentinel
// (a plain string, so it rides `z.string()`); `null` is intentionally NOT a
// member — an unstated value is expressed as "TBD", never null (parity with the
// worker `createMeetingExtractionSchemaGate`'s `isPrimitiveOrTbd`). `evidenceRef`
// is OPTIONAL at the structural level (a "TBD" field legitimately has none); the
// concrete-value-needs-backing rule is enforced by `validateNoInference`, not
// here. Inner `.strict()` so a hostile model cannot smuggle extra keys into a
// field (which could then reach a log sink via a rejection message, rule 7).
//
// `number` is `.finite()`: a non-finite value (NaN / ±Infinity) is never a
// meaningful extraction value. This ALSO makes zod-to-json-schema emit the union
// as JSON-Schema `anyOf` rather than squashing bare primitives into a
// `type: ["string","number","boolean"]` array — the union-type keyword form ajv
// strict rejects without `allowUnionTypes`. Keeping the emission as `anyOf` lets
// the SHARED candidate-data-gate ajv stay in strict mode with no global config
// change (a smaller blast radius than loosening the shared registry). The frozen
// `agent-extraction.schema.json` + the registry-strict-compile test pin the
// `anyOf` form, so a regression back to a union-type array fails loudly.
const AgentExtractionCandidateFieldSchema = z
  .object({
    value: z.union([z.string(), z.number().finite(), z.boolean()]),
    evidenceRef: z.string().optional(),
  })
  .strict();

// The candidate extraction: an open field-map keyed by opaque field name (minus
// the reserved-key blocklist above). Outer `.strict()` ⇒ `fields` is the only
// top-level key (a smuggled sibling key is rejected). `fields` is a `z.record`
// (open key set — the §9 field catalog is an arch_gap), so an EMPTY map is
// structurally valid (non-emptiness is a downstream candidate-gate concern, L46).
export const AgentExtractionCandidateSchema = z
  .object({
    fields: z.record(FIELD_NAME, AgentExtractionCandidateFieldSchema),
  })
  .strict();

/** One evidence-bearing extraction field ({ value: primitive | "TBD", evidenceRef? }). */
export type AgentExtractionCandidateField = z.infer<typeof AgentExtractionCandidateFieldSchema>;

/** The first-class agent-extraction candidate (the `agent_extraction` payload). */
export type AgentExtractionCandidate = z.infer<typeof AgentExtractionCandidateSchema>;
