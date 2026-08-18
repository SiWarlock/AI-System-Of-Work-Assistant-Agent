// The shared issue-carrying refusal SHAPE (`### 24.103`, §16 / §6).
//
// ⭐ WHAT THIS MODULE IS FOR, IN ONE SENTENCE: four candidate-data gates each minted their own
// `{code, stage, issues}` refusal on their own local union with NO `AuditSignal`, and this makes
// that combination unrepresentable at all four at once.
//
// ⛔⛔ THE REQUIRED `audit` FIELD IS WHAT REPLACES THE COMPILER ENUMERATION ACROSS THE UNION
// BOUNDARY, AND THAT IS THE WHOLE MECHANISM — read this before changing `IssueCarryingRefusal`.
// `### 24.98` made `audit` required on the GCL union, so `tsc` enumerated every construction site of
// THAT union and found a third nobody had listed. ⚠ A SEPARATE local union inherits none of that:
// the enumeration stops dead at the union boundary, so a DUPLICATED SHAPE is invisible to exactly
// the instrument that secured the original. Every union whose issue-carrying member extends this
// interface gets the enumeration back — measured: 10 construction sites across 4 channels, all
// surfaced by the compiler the moment `audit` became required here.
// ⇒ ⛔ MAKING `audit` OPTIONAL — even "temporarily", even "just for the dormant channels" — does not
// weaken a check. IT DELETES THE ENUMERATION, and the four gates go back to being silently
// signal-less with the suite fully green, which is the exact state this task was filed about.
//
// ⛔⛔ AND THE SECOND ONE, BECAUSE THE WRONG EDIT HAPPENS AT A DIFFERENT LINE (`L187`):
// `structuralPathOnly` TAKES A SCHEMA ID, NOT A REGION ARRAY, AND THAT SIGNATURE IS THE GUARD.
// ⚠ THE REFACTOR THAT DESTROYS IT LOOKS LIKE A FAVOUR — *"let callers pass their own regions"* /
// *"decouple this from the schema-id table"* — and it is the natural next edit for anyone adding a
// fifth channel who finds the table inconvenient.
// ⇒ ***Taking the ARRAY lets a caller supply a region set WITHOUT EVER CONSULTING THE TABLE, so a
// channel can ship with an `audit` that compiles and a cut that matches nothing. Taking the ID makes
// consulting the table non-optional BY SIGNATURE.*** The hazard is not detected here; it is
// unrepresentable, and only while the parameter stays a `CandidateSchemaId`.
// ⚠ This is `### 24.104`'s protection-by-omission class — a guard whose whole strength is what the
// API does NOT accept — so it is named here with its consequence rather than left to be inferred.
import {
  KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
  GBRAIN_PROPOSED_FACT_SCHEMA_ID,
  SIGNED_PROVENANCE_STAMP_SCHEMA_ID,
  GCL_PROJECTION_SCHEMA_ID,
} from "@sow/contracts";
import { buildAuditSignal, type AuditSignal } from "@sow/policy";

/**
 * A single path-tagged validation issue, as every gate in this package already emits.
 * ⛔ `path` IS redaction-safe (after `structuralPathOnly`); `message` IS NOT, CATEGORICALLY.
 * MEASURED (`### 24.98` / `L192`): Zod's `invalid_enum_value` embeds the RECEIVED VALUE and
 * `unrecognized_keys` embeds a ROW-AUTHORED KEY. Never put `message` on an audit surface.
 */
export interface RefusalIssue {
  readonly path: string;
  readonly message: string;
}

/**
 * The shared shape. Any union member carrying validator `issues` extends this, which makes `audit`
 * structurally required at every construction site of every union that adopts it — see the
 * enumeration note in the module header.
 *
 * ⭐ THE UNIONS ARE DELIBERATELY *NOT* MERGED. Each keeps its own `code`/`stage` vocabulary
 * (`schema_rejected` / `plan_invalid` / `stamp_invalid`; two-stage, three-stage, and stage-less all
 * coexist). Merging the SHAPE restores the enumeration; merging the UNIONS would collapse four
 * layers' error vocabularies into one and lose information every consumer switches on.
 */
export interface IssueCarryingRefusal {
  readonly issues: readonly RefusalIssue[];
  readonly audit: AuditSignal;
}

/** The candidate schemas this package runs a validator against. Closed BY DESIGN — see below. */
export type CandidateSchemaId =
  | typeof KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID
  | typeof GBRAIN_PROPOSED_FACT_SCHEMA_ID
  | typeof SIGNED_PROVENANCE_STAMP_SCHEMA_ID
  | typeof GCL_PROJECTION_SCHEMA_ID;

/**
 * What a path becomes when the schema id is not in the table. Carries NO structural information —
 * failing closed means discarding the path, not passing it through.
 */
export const MAXIMAL_CUT = "#unknown-candidate-schema" as const;

/**
 * Free-form-key regions per candidate schema — the ONLY place a row author's chosen KEY can become a
 * path segment, so the only place a cut is needed.
 *
 * ⛔⛔ DERIVED PER SCHEMA, NEVER COPIED BETWEEN THEM, AND THAT IS THE POINT OF THE TABLE.
 * `### 24.98` cuts at `sanitizedPayload` — a GCL-PROJECTION field. ⚠ That token appears in NONE of
 * the other three schemas. ⇒ ***a copied regex compiles, passes review, runs on every rejection and
 * cuts NOTHING, while reading exactly like the construction that made the GCL channel safe.***
 * (A cut that cannot fire is the production-code form of the decorative assertion.)
 *
 * ⭐ ALSO NOTE THE KEYING: regions belong to the CANDIDATE SCHEMA, not to the channel. `writer.ts`
 * and `router.ts` validate the SAME schema and share a set; `generative-proposal-intake.ts` spans
 * TWO schemas across its three sites, so a per-channel cut would be wrong there BY CONSTRUCTION.
 *
 * **Method, so it can be re-run rather than trusted** (both surfaces, because either alone is half
 * an answer — ajv and Zod are separate implementations of the same constraint and could disagree):
 *   ajv — walk the schema JSON for `additionalProperties ∉ {false, absent}`, `patternProperties`,
 *         `propertyNames`, resolving `$ref`/`$defs`/`allOf|anyOf|oneOf`/`if|then|else`.
 *   Zod — walk the compiled schema's `_def` graph for `ZodRecord` and non-`never` `catchall`,
 *         through Optional/Default/Effects/Branded/Union/Array wrappers.
 * Both surfaces returned the same set for all four schemas. Instrument control: the same walk
 * recovers `sanitizedPayload` for `sow:gcl-projection` unaided — an instrument that cannot find the
 * one region already known to be real is not measuring anything.
 *
 * ⛔ `frontmatterUpdates[]` is NOT a region (measured `additionalProperties:false`): its
 * row-authored key is a VALUE (`key: string`), never a path segment. The `\b` boundary in the cut
 * keeps `frontmatter` from swallowing it — pinned, because over-cutting silently degrades every
 * reported path under it and no safety assertion would ever notice.
 * ⛔ `sow:signed-provenance-stamp` is EMPTY BY MEASUREMENT, not by omission: it has no free-form-key
 * region on either surface, so there is nothing to cut and no mutation could red a cut-pin for it.
 */
export const FREE_FORM_KEY_REGIONS: Readonly<Record<CandidateSchemaId, readonly string[]>> = {
  [KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID]: ["frontmatter", "payload"],
  [GBRAIN_PROPOSED_FACT_SCHEMA_ID]: ["proposedContent"],
  [SIGNED_PROVENANCE_STAMP_SCHEMA_ID]: [],
  [GCL_PROJECTION_SCHEMA_ID]: ["sanitizedPayload"],
};

// One precompiled alternation per schema; a schema with no regions gets no pattern (identity cut).
// ⚠ Handles BOTH path dialects deliberately: ajv emits `/a/b`, Zod emits `a.b`.
const REGION_PATTERNS: ReadonlyMap<CandidateSchemaId, RegExp> = new Map(
  (Object.entries(FREE_FORM_KEY_REGIONS) as [CandidateSchemaId, readonly string[]][])
    .filter(([, regions]) => regions.length > 0)
    .map(([id, regions]) => [id, new RegExp(`^(.*?\\b(?:${regions.join("|")})\\b)[./].*$`, "u")]),
);

/**
 * Truncate a validation issue path at the candidate schema's free-form-key region, so a key the ROW
 * author chose can never appear in an audit ref — EVEN IF a future schema gives that region a real
 * subschema and starts raising per-entry issues under it. Replaces an argument with a construction
 * (`L73`: make the unsafe content unrepresentable rather than detecting it — `isRedactionSafe`
 * provably cannot help here, since `audit-signal.ts` names an employer project codename as exactly
 * what its credential-shape heuristic misses).
 *
 * ⛔⛔ FAILS CLOSED ON AN UNKNOWN SCHEMA ID — it returns `MAXIMAL_CUT`, never the path. The closed
 * `CandidateSchemaId` union makes an unlisted id a compile error at the call site; this branch is
 * the second defence, for an id widened through a cast or an `unknown` boundary where the type
 * system is structurally blind. ⚠ THE TEMPTING IMPLEMENTATION IS `return path` — it looks like a
 * harmless pass-through and it is the fail-OPEN hole: the row-authored key reaches the signal with
 * no error and nothing to notice.
 * ⛔ AND IT MUST NOT THROW, WHICH IS A MEASURED CONSTRAINT AND NOT A STYLE CHOICE: `applyPlan`
 * contains NO `try` ANYWHERE (its own header documents this), so a throw here escapes uncaught on
 * the SOLE-WRITER PATH — safety rule 1, at the §16 never-throw boundary. That would convert a
 * silent-refusal defect into an uncaught throw on the one path this task exists to protect.
 */
export function structuralPathOnly(path: string, schemaId: CandidateSchemaId): string {
  const regions = FREE_FORM_KEY_REGIONS[schemaId];
  if (regions === undefined) {
    return MAXIMAL_CUT;
  }
  const pattern = REGION_PATTERNS.get(schemaId);
  if (pattern === undefined) {
    return path;
  }
  return pattern.exec(path)?.[1] ?? path;
}

// ⛔ THE ONE PROPERTY OF THIS SIGNAL A ROW AUTHOR CAN STILL INFLUENCE IS ITS LENGTH, so it is bounded
// (`### 24.98`, security review): ajv compiles with `allErrors: true`, so N malformed entries yield N
// issues and `AuditRecordSchema.refs` has no `.max`. ⚠ DEDUPE THEN CAP, AND THE DROP IS REPORTED — a
// silently truncated list reads as a complete one.
const MAX_ISSUE_PATH_REFS = 20;

/**
 * Build the `AuditSignal` for an issue-carrying refusal.
 *
 * ⛔⛔ ASSEMBLED FROM NON-ROW-DERIVED MATERIAL ONLY — THIS IS THE PREDICATE, STATED SO IT CAN BE
 * CHECKED RATHER THAN INFERRED: a field may cross into the signal iff it is (a) a closed literal
 * this codebase authored (`actor`, `event`, `payloadHash`, the summary prose), (b) an issue PATH cut
 * at the candidate schema's free-form-key region, or (c) a COUNT. Nothing else. In particular
 * `RefusalIssue.message` is excluded CATEGORICALLY and unconditionally.
 * ⚠ THIS IS THE LINE WHERE THE WRONG EDIT HAPPENS: `issues` is right there, it already holds
 * everything a debugger would want, and threading it wholesale routes validator-authored text —
 * measured to echo row content — onto a rule-7 surface. `isRedactionSafe` would then REFUSE the
 * write, reproducing the very silence this task removes, with the suite green.
 */
export function buildRefusalSignal(input: {
  /** Closed actor constant identifying the gate. */
  readonly actor: string;
  /** Closed event string, `<gate>.<code>[.<stage>]` — codes and stages are literals, never row data. */
  readonly event: string;
  /** Closed ref namespace, e.g. `gcl-issue-path`. */
  readonly refPrefix: string;
  /** A fixed decision marker — NEVER a hash of the candidate (the identity rides the refs). */
  readonly payloadHash: string;
  /** Authored prose naming the gate and stage; must not interpolate candidate data. */
  readonly beforeSummary: string;
  /** Selects the region set used to cut every issue path. */
  readonly schemaId: CandidateSchemaId;
  readonly issues: readonly RefusalIssue[];
}): AuditSignal {
  const paths = [
    ...new Set(input.issues.map((i) => `ref:${input.refPrefix}:${structuralPathOnly(i.path, input.schemaId)}`)),
  ];
  const omitted = Math.max(0, paths.length - MAX_ISSUE_PATH_REFS);
  return buildAuditSignal({
    actor: input.actor,
    event: input.event,
    refs: paths.slice(0, MAX_ISSUE_PATH_REFS),
    payloadHash: input.payloadHash,
    beforeSummary: input.beforeSummary,
    afterSummary:
      `${input.issues.length} issue(s), ${paths.length} distinct path(s)` +
      `${omitted > 0 ? `, ${omitted} path(s) not listed` : ""}; nothing admitted`,
  });
}
