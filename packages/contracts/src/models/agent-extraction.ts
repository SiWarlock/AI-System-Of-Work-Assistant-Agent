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
// STRUCTURAL only: the schema pins the SHAPE ({ value: primitive-or-declared-list |
// "TBD", evidenceRef? }). It does NOT enforce non-emptiness or a required field
// catalog (the §9 catalog is an arch_gap; non-emptiness is the worker meeting schema
// gate's job) — and it does NOT enforce the no-inference SEMANTIC (that the "TBD"
// sentinel needs no evidence, that a concrete value needs backing): that is
// `validateNoInference`'s job over this validated shape (candidate-data gate =
// this structural schema + the domain validator, LESSONS §3).
//
// Zod is the single source of truth: the TS type is `z.infer` (no branded ids ⇒
// no TS4023, so no explicit-interface workaround needed), the JSON Schema is
// generated via `emitJsonSchema`. PURE — imports only zod + this package's own
// `schema/emit` (contracts is the root of the §2.5 import DAG; it cannot import
// the domain `ExtractionField`, so the field shape is defined here). Kept
// STRUCTURALLY compatible with `@sow/domain`'s `ExtractionField<T>` — verified
// 13.8g-C: `ExtractionField<T>`/`validateNoInference` are fully generic over `T`
// (they branch only on `value === 'TBD'` vs. not, and on `evidenceRef`), so widening
// a field's `T` to admit a bounded string array needs no change on the domain side.
import { z } from "zod";
import { RESERVED_CATCHALL_KEY_PATTERN } from "../schema/emit";

/** Stable JSON-Schema `$id` for the schema registry. */
export const AGENT_EXTRACTION_SCHEMA_ID = "sow:agent-extraction" as const;

// Field NAME guard — a catalog-INDEPENDENT dangerous-key BLOCKLIST. Prototype-
// pollution-shaped keys (`__proto__`/`prototype`/`constructor`) are rejected
// STRUCTURALLY (a negative-lookahead regex, so any OTHER name is allowed — the
// full field-name charset allowlist waits on the §9 field catalog).
//
// 13.8g-C changed the MECHANISM, not the guarantee. Before this task, `fields`
// was a plain `z.record(FIELD_NAME, ...)`, whose KEY schema Zod itself enforced
// during `.parse()`, and whose emission carried `propertyNames.pattern` so ajv —
// the candidate-data gate's structural half — rejected the same three keys. This
// task needed PER-FIELD capability (only `attendees`/`decisions` may be list-
// valued) inside that same open key-set, which `z.object({...}).catchall(X)`
// gives for free via JSON Schema's own `properties`-wins-over-`additionalProperties`
// precedence — but `.catchall()` has NO key-schema slot the way `z.record` does,
// so switching containers naively would have dropped BOTH legs of this guard at
// once: ajv's `propertyNames` (restored below by a POLICY in `schema/emit.ts` —
// see that file — that merges it onto any object with a real catchall) AND Zod's
// own key check (restored here by `rejectReservedKeys`, a `z.preprocess` that
// walks the RAW input's own keys BEFORE Zod's object/catchall parsing touches
// them). The preprocess timing matters: `.catchall()`'s internal reconstruction
// SILENTLY DROPS a `__proto__` own-key rather than rejecting it (verified — the
// exact L3 ajv↔Zod parity gap this file's design has always meant to close), so a
// post-parse `.superRefine()` would already be too late; `preprocess` runs first.
const FIELD_NAME_RE = new RegExp(RESERVED_CATCHALL_KEY_PATTERN);

/**
 * Rejects a raw fields-map whose OWN enumerable keys include a reserved,
 * prototype-pollution-shaped name — run as a `z.preprocess` so it inspects the
 * INPUT before `.catchall()`'s own reconstruction can silently drop such a key
 * (see `FIELD_NAME_RE`'s comment). `ctx.addIssue` inside a preprocess callback
 * fails the parse; it does not merely transform. TOTAL — never throws.
 */
function rejectReservedKeys(value: unknown, ctx: z.RefinementCtx): unknown {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of Object.getOwnPropertyNames(value)) {
      if (!FIELD_NAME_RE.test(key)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, message: "reserved prototype-pollution key", path: [key] });
      }
    }
  }
  return value;
}

// One extracted field's `value` shared by BOTH the scalar-only and the list-
// capable shape below. `null` is intentionally NOT a member — an unstated value
// is expressed as "TBD", never null (parity with the worker
// `createMeetingExtractionSchemaGate`'s `isPrimitiveOrTbd`). `number` is
// `.finite()`: a non-finite value (NaN / ±Infinity) is never a meaningful
// extraction value. This ALSO makes zod-to-json-schema emit the union as
// JSON-Schema `anyOf` rather than squashing bare primitives into a
// `type: [...]` array — the union-type keyword form ajv strict rejects without
// `allowUnionTypes`. Keeping the emission as `anyOf` lets the SHARED
// candidate-data-gate ajv stay in strict mode with no global config change.
const PRIMITIVE_VALUE = z.union([z.string(), z.number().finite(), z.boolean()]);

// 13.8g-C — the element-cap on a declared list value. Bounds a HOSTILE OR
// MALFORMED candidate's per-field array length at the structural candidate-data
// gate — a different threat model from, and NOT shared with,
// `packages/knowledge`'s `MAX_ATTENDEE_ENTRIES` (that one bounds real-world
// attendee-string PARSING cost at the normalizer layer, downstream; per worker
// L88, a constant is shared only when both uses would change for the SAME
// reason — these wouldn't). Also structurally moot to share: contracts is the
// pure DAG root and cannot import `packages/knowledge` regardless of the
// threat-model question.
const LIST_VALUE_MAX_ITEMS = 200;

// 13.8g-C — the SINGLE SOURCE of list-ness. The schema DECLARES which fields may
// be list-valued; a candidate payload never does (a payload cannot add itself to
// a Zod object's declared keys) — that is how "can a candidate declare its own
// list-ness?" is answered STRUCTURALLY rather than by a runtime check. Leg B
// (worker) MUST import this rather than re-declaring the two names: a second
// consumer disagreeing with this list is exactly the defect this task exists to
// close (two independent authors already wrote array-handling branches against
// their OWN belief about which fields are list-shaped).
export const LIST_VALUED_EXTRACTION_FIELDS = ["attendees", "decisions"] as const;

// One extracted field, scalar-only. `evidenceRef` is OPTIONAL at the structural
// level (a "TBD" field legitimately has none); the concrete-value-needs-backing
// rule is enforced by `validateNoInference`, not here. Inner `.strict()` so a
// hostile model cannot smuggle extra keys into a field (which could then reach a
// log sink via a rejection message, rule 7). This is the CATCHALL value schema —
// every field name NOT in `LIST_VALUED_EXTRACTION_FIELDS` keeps exactly this
// shape, unchanged by 13.8g-C.
const AgentExtractionCandidateFieldSchema = z
  .object({
    value: PRIMITIVE_VALUE,
    evidenceRef: z.string().optional(),
  })
  .strict();

// One extracted field, list-CAPABLE (13.8g-C). ADDITIVE over the scalar shape —
// a declared field may STILL carry a scalar or "TBD"; a list is newly PERMITTED,
// never required. The list element type is `string` ONLY (no number/boolean/null
// elements) and NESTING is rejected (no array-of-array, no array-of-object) —
// `z.array(z.string())` structurally admits nothing else. Capped at
// `LIST_VALUE_MAX_ITEMS` so the bound is real, not documentary.
const AgentExtractionCandidateListFieldSchema = z
  .object({
    value: z.union([PRIMITIVE_VALUE, z.array(z.string()).max(LIST_VALUE_MAX_ITEMS)]),
    evidenceRef: z.string().optional(),
  })
  .strict();

// The candidate extraction: an open field-map keyed by opaque field name (minus
// the reserved-key blocklist), with PER-FIELD list capability for exactly
// `LIST_VALUED_EXTRACTION_FIELDS` (13.8g-C). `z.object({attendees, decisions}).
// catchall(scalarField)` gives DEFAULT-CLOSED semantics for free, in JSON
// Schema's own precedence rules — `properties` wins over `additionalProperties`
// for a named key, so a declared field may be a list while every OTHER field
// keeps today's scalar-only rejection; the declaration is structural, so a
// payload cannot add itself to `properties`. `rejectReservedKeys` (wrapped via
// `z.preprocess`) restores the Zod-side key guard `.catchall()` does not carry on
// its own (see `FIELD_NAME_RE`'s comment above). An EMPTY map is structurally
// valid (non-emptiness is a downstream candidate-gate concern, L46).
const fieldsObjectSchema = z
  .object({
    attendees: AgentExtractionCandidateListFieldSchema.optional(),
    decisions: AgentExtractionCandidateListFieldSchema.optional(),
  })
  .catchall(AgentExtractionCandidateFieldSchema);

const fieldsSchema = z.preprocess(rejectReservedKeys, fieldsObjectSchema);

// Outer `.strict()` ⇒ `fields` is the only top-level key (a smuggled sibling key
// is rejected).
export const AgentExtractionCandidateSchema = z
  .object({
    fields: fieldsSchema,
  })
  .strict();

/**
 * One evidence-bearing SCALAR extraction field ({ value: primitive | "TBD",
 * evidenceRef? }). Named `...ScalarField`, not `...Field` (13.8g-C) — this is
 * `z.infer` of the CATCHALL value schema specifically, which no longer
 * describes every field: `attendees`/`decisions` additionally admit a bounded
 * `string[]`. Do NOT rename this back to the generic form or add a
 * speculatively-widened sibling type "for completeness" — leg B (worker) is
 * the intended next consumer and has not yet stated what shape it needs;
 * export that when it exists, not before (zero consumers of this type today,
 * verified repo-wide).
 */
export type AgentExtractionCandidateScalarField = z.infer<typeof AgentExtractionCandidateFieldSchema>;

/** The first-class agent-extraction candidate (the `agent_extraction` payload). */
export type AgentExtractionCandidate = z.infer<typeof AgentExtractionCandidateSchema>;
