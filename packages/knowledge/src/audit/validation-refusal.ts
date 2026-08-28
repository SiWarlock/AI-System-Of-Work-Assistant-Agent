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
// ⛔⛔ COVERED ≠ LIVE — THE REACHABILITY SPLIT, BECAUSE "all four channels now emit a signal" READS
// AS "all four channels are live" AND TWO OF THEM ARE NOT (`### 24.115`).
// RE-MEASURED 2026-08-28 at HEAD — ⚠ re-MEASURED, not re-read: `### 24.109` has landed since the
// split was first recorded, and a dormancy fact is a claim about the day it was taken (`L143`).
// Instrument: `rg` for each channel's entry symbol across `--type ts` excluding test files, with a
// positive control on the total reference count so an empty result is distinguishable from a
// mis-typed pattern.
//   LIVE (2):
//     * `writer.ts` `SchemaRejected` — `applyPlan`, reached from
//       `packages/workflows/src/activities/commitKnowledge.ts:161` and
//       `apps/worker/src/composition/living-vault-synthesis.ts:189`.
//     * `provenance-stamp.ts` `StampInvalid` — `stampProvenance`, reached from `writer.ts:960`.
//   DORMANT (2):
//     * `gbrain/remediation/router.ts` — `routeRemediation` has NO production caller. 20 references
//       repo-wide, ALL of them in `router.ts` itself plus two of its own suites.
//     * `gbrain/remediation/generative-proposal-intake.ts` — `intakeGenerativeProposal` and
//       `runGenerativeProposal` likewise. The one non-test hit is a COMMENT in
//       `packages/domain/src/validation/block-provenance.ts:9` saying exactly this.
// ⇒ the split is UNCHANGED by `### 24.109`, which bound a consumer for the SIGNAL — a different
// question from whether the CHANNEL runs.
// ⭐ `L106`: a capability is not a guarantee, and a signal on a dormant channel is a capability
// twice over. Re-measure this block rather than trusting it whenever either dormant channel gains a
// caller; the shape of the mistake is reading a dated measurement as a standing fact.
//
// ⛔⛔ AND THE SECOND ONE, BECAUSE THE WRONG EDIT HAPPENS AT A DIFFERENT SITE (`contracts L187`):
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
 * MEASURED (`### 24.98` / `contracts L192`): Zod's `invalid_enum_value` embeds the RECEIVED VALUE and
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
// ⛔⛔ THE `s` (dotAll) FLAG IS A SAFETY CONTROL, NOT A STYLE FLAG — DO NOT DROP IT. Without it, `.`
// does not match a LINE TERMINATOR (`\n`, `\r`, `U+2028`, `U+2029`), and `$` without `m` matches only
// at end of input ⇒ a row-authored key CONTAINING ONE makes the whole pattern fail to match, and the
// `?? path` fallback below then returns the path VERBATIM — the row key reaches `refs` uncut.
// ⭐ MEASURED, NOT THEORISED (security review built the input and ran it): every channel leaked,
// INCLUDING the GCL control, and `isRedactionSafe` returned TRUE on the result — a project codename
// matches none of its credential patterns, exactly as `audit-signal.ts` warns. Detection is not a
// backstop here; this cut IS the control.
// ⚠ dotAll only lets `.*?` find the region MORE often, which is the fail-safe direction.
/**
 * A region name safe to interpolate into the pattern above (`### 24.136`).
 *
 * ⛔⛔ EXPORTED SO `### 24.113`'s DERIVATION TEST CONSUMES THIS EXACT INSTANCE. That test certifies
 * every name the derivation PRODUCES; this certifies every name the hand-maintained table CONTAINS,
 * and the table is hand-maintained — which is the entire reason `### 24.113` exists. If the two
 * predicates ever diverged, one path would be laxer and the laxer one is what an author would use.
 * ⭐ Sharing the instance makes divergence UNREPRESENTABLE rather than forbidden by a paragraph
 * nobody re-reads (`contracts L103`). Safe to share: no `g` flag, so no `lastIndex` state.
 *
 * ⛔ WHAT AN UNSAFE NAME DOES, MEASURED EXECUTABLY (`### 24.113` Step 9), NOT REASONED:
 *   `["@ext"]`     → `a.@ext.ROW_KEY` comes back VERBATIM. `\b` requires a WORD character on the
 *                    region's inside edge, so the whole pattern fails and `?? path` returns the
 *                    row-authored key uncut — `### 24.119`'s fail-open by a different door.
 *   `["ext$"]`     → VERBATIM, same mechanism on the trailing edge.
 *   `["a|b"]`      → MIS-cuts: the alternation is injected, so `zzz.b.ROW_KEY` truncates to `zzz.b`.
 *                    A wrong answer rather than an absent one, which is harder to notice.
 *   `["pay(load"]` → `SyntaxError` while CONSTRUCTING the pattern ⇒ rule 1, see below.
 */
export const SAFE_REGION_NAME = /^[A-Za-z0-9_]+$/u;

/** The compiled form of a region table: usable patterns, refused ids, and the ids it covers. */
export interface CompiledRegions {
  readonly patterns: ReadonlyMap<string, RegExp>;
  /** Ids carrying at least one unsafe region name. They get NO pattern and cut MAXIMALLY. */
  readonly poisoned: ReadonlySet<string>;
  /** Ids present in the source table — an id absent here is unknown and fails closed. */
  readonly known: ReadonlySet<string>;
}

/**
 * Compile a region table. **PURE, AND IT MUST NEVER THROW FOR ANY WELL-TYPED TABLE** (`### 24.136`).
 *
 * ⚠ THAT QUALIFIER IS LOAD-BEARING AND WAS ADDED AFTER REVIEW FALSIFIED THE SHORTER SENTENCE. The
 * first wording said "PURE, TOTAL, AND IT MUST NEVER THROW", and security review found SEVEN throw
 * vectors reachable with a hostile, off-type table (`regions` a bare string or `null`; `table`
 * `null`; a throwing enumerable getter). ⛔ THAT IS THE EXACT DEFECT THIS FILE WARNS ABOUT SIXTY
 * LINES BELOW — a universal claim in a comment, falsified by its own body, which teaches an auditor
 * that the surrounding argument is stale. The guards below now make the well-typed claim true for
 * off-type input too, but the sentence is scoped rather than restored.
 *
 * ⛔⛔ THE NEVER-THROW PROPERTY IS THE RULE-1 HALF OF THIS TASK AND IS NOT A STYLE CHOICE. The
 * module-level `COMPILED_REGIONS` below is built at MODULE INIT, so anything that throws here
 * throws while `validation-refusal.ts` is being IMPORTED — on `applyPlan`'s import path. ⇒ ***the
 * SOLE WRITER (safety rule 1) would fail to load because of a typo in a refusal-path table.*** A
 * bad region name must degrade a cut, never prevent the writer from existing.
 * ⚠ THE TEMPTING IMPLEMENTATION IS TO VALIDATE AND THROW — it is louder, it is what a linter would
 * suggest, and it reintroduces the exact module-init failure this exists to remove, just with a
 * better message. The loudness belongs in the SUITE (`no_live_schema_id_is_poisoned`), where a
 * human is watching; the runtime belongs on the fail-safe path, where a user is.
 * ⭐ AND THE THROW IS UNREPRESENTABLE, NOT CAUGHT: no string matching `SAFE_REGION_NAME` can be an
 * invalid regex fragment, so `new RegExp` below cannot fail once the filter has run (`contracts
 * L103` — make the violation unrepresentable; a detector is belt, never the mechanism). There is deliberately no `try`/`catch`; adding
 * one would suggest the guard above is optional.
 *
 * @internal Exported to be pinned — and FENCED, not merely labelled. ⛔ `@internal` is a convention,
 * not a boundary: `package.json` declares a `"./*"` wildcard subpath export, so every internal here
 * would otherwise be deep-importable from outside (`### 24.78`, OPEN, names three files already
 * doing it). This module is therefore denied an exports entry —
 * `"./audit/validation-refusal": null` — which beats the wildcard in Node's resolver. Verified
 * blocking: the specifier returns `ERR_PACKAGE_PATH_NOT_EXPORTED` while an unfenced sibling deep
 * path still resolves.
 * ⚠ IF `### 24.78` EVER CLOSES, THAT MAKES THIS LINE REDUNDANT — NOT WRONG (`contracts L248`).
 * Do not read that entry's tick as permission to delete the fence; deleting it re-opens the path by
 * which a caller hand-builds a `CompiledRegions` and gets the row-authored path back verbatim.
 */
export function compileRegionPatterns(
  table: Readonly<Record<string, readonly string[]>>,
): CompiledRegions {
  const patterns = new Map<string, RegExp>();
  const poisoned = new Set<string>();
  const known = new Set<string>();
  for (const [id, regions] of Object.entries(table)) {
    known.add(id);
    // ⛔ READ THE ELEMENTS EXACTLY ONCE, AND VALIDATE THE COPY. Validating `regions` and then
    // `join`ing `regions` reads each element TWICE — measured by review with a getter-backed array
    // returning `"payload"` on the first read and `"a|b"` on the second: the guard passed and the
    // compiled pattern carried the injected alternation. Validate-then-reread is a TOCTOU on the
    // value the guard just approved.
    const safe: string[] | undefined = Array.isArray(regions) ? [...regions].map(String) : undefined;
    // ⛔ An off-type row is REFUSED, not thrown on: this runs at module init, so a throw here means
    // the sole writer cannot load (see the never-throw note above).
    if (safe === undefined || !safe.every((region) => SAFE_REGION_NAME.test(region))) {
      poisoned.add(id);
      continue;
    }
    // A schema with no regions gets no pattern — that is the identity cut, not a refusal.
    if (safe.length === 0) continue;
    patterns.set(id, new RegExp(`^(.*?\\b(?:${safe.join("|")})\\b)[./].*$`, "us"));
  }
  return { patterns, poisoned, known };
}

/**
 * The cut itself, against an explicitly supplied compilation.
 *
 * ⛔⛔ THE BRANCH ORDER IS THE GUARD. READ THIS BEFORE REORDERING ANYTHING BELOW.
 * A POISONED id and a REGION-LESS id are INDISTINGUISHABLE by pattern-presence — neither has one.
 * But the `pattern === undefined` branch returns the path **UNCHANGED**, which is correct for a
 * region-less schema (`sow:signed-provenance-stamp` has no free-form key region, so its paths are
 * already structural) and is the FAIL-OPEN for a poisoned one. ⇒ ***if the poisoned check moves
 * below it, every poisoned id returns the row-authored path VERBATIM — precisely the leak
 * `### 24.136` exists to close, reached through this function's own default branch.***
 * ⭐ The general shape (banked as a lesson, not restated here): a remedy that introduces a NEW
 * failure state routes it into an EXISTING default branch whose semantics were correct for the OLD
 * states only. ⛔ ENFORCED BY `a_region_with_a_non_word_leading_edge_is_REJECTED_not_silently_uncut`
 * — measured at code review to be the pin that reds on a reorder. ⚠ It is NOT enforced by the
 * region-less identity pin, which was named for this hazard and cannot discriminate it.
 *
 * @internal Enforces nothing here — see `compileRegionPatterns` (`### 24.78`).
 */
export function cutWithCompiled(path: string, schemaId: string, compiled: CompiledRegions): string {
  // ⛔ `Set.has` carries `### 24.103`'s protection where that fix used `Object.hasOwn` — an
  // inherited key (`"toString"`) is not a Set member. Stated because the `Object.hasOwn` call this
  // replaced was itself the remedy for a real defect, so a reader who finds it gone needs to see
  // where it went; pinned next door by `validation-refusal-audit.test.ts`'s
  // `an_unknown_schema_id_fails_closed_rather_than_silently_not_cutting`, which covers five
  // inherited keys including `__proto__`.
  if (!compiled.known.has(schemaId)) return MAXIMAL_CUT;
  if (compiled.poisoned.has(schemaId)) return MAXIMAL_CUT; // ⛔ MUST precede the branch below
  const pattern = compiled.patterns.get(schemaId);
  if (pattern === undefined) return path;
  return pattern.exec(path)?.[1] ?? path;
}

const COMPILED_REGIONS: CompiledRegions = compileRegionPatterns(FREE_FORM_KEY_REGIONS);

/**
 * Truncate a validation issue path at the candidate schema's free-form-key region, so a key the ROW
 * author chose can never appear in an audit ref — EVEN IF a future schema gives that region a real
 * subschema and starts raising per-entry issues under it. Replaces an argument with a construction
 * (`contracts L103` — ⚠ this cite read `contracts L73` until `### 24.136`, and
 * the wrong number was COPIED into that slice's new code before review caught it; `contracts L73` is about
 * multi-axis fixtures. Corrected at both sites in one commit, and noted here so the next reader
 * knows the pointer was audited rather than guessed: make the unsafe content unrepresentable
 * rather than detecting it — `isRedactionSafe`
 * provably cannot help here, since `audit-signal.ts` names an employer project codename as exactly
 * what its credential-shape heuristic misses).
 *
 * ⛔⛔ FAILS CLOSED ON AN UNKNOWN SCHEMA ID — it returns `MAXIMAL_CUT`, never the path. The closed
 * `CandidateSchemaId` union makes an unlisted id a compile error at the call site; this branch is
 * the second defence, for an id widened through a cast or an `unknown` boundary where the type
 * system is structurally blind. ⚠ THE TEMPTING IMPLEMENTATION IS `return path` — it looks like a
 * harmless pass-through and it is the fail-OPEN hole: the row-authored key reaches the signal with
 * no error and nothing to notice.
 * ⛔ AND IT MUST NOT THROW, WHICH IS A MEASURED CONSTRAINT AND NOT A STYLE CHOICE — stated as a
 * CHECKABLE claim, because the shorter version of it is false: `applyPlan`'s ONLY `try` blocks are
 * the two post-commit recording writes (`writer.ts` — the `deps.audit.append` and
 * `deps.revisions.record` calls); the gate call `runGate(...)` runs BEFORE them and is outside both.
 * ⇒ a throw from here escapes `applyPlan` uncaught on the SOLE-WRITER PATH — safety rule 1, at the
 * §16 never-throw boundary — converting a silent-refusal defect into an uncaught throw on the one
 * path this task exists to protect.
 * ⚠ DO NOT RESTATE THIS AS "`applyPlan` CONTAINS NO `try`". That sentence appears in `writer.ts`'s
 * own header and is FALSIFIED BY ITS OWN BODY; this slice copied it here and code review caught it.
 * An auditor greps `try`, finds hits inside `applyPlan`, and concludes the whole argument is stale.
 */
export function structuralPathOnly(path: string, schemaId: CandidateSchemaId): string {
  // ⛔ ONE IMPLEMENTATION, ONE COMPILATION. This delegates rather than duplicating the branch order,
  // because the order IS the guard (see `cutWithCompiled`) and a second copy would drift from it.
  // ⚠ THE SIGNATURE IS UNCHANGED AND MUST STAY SO: this takes a `CandidateSchemaId`, never a region
  // array or a compilation, which is what makes consulting the table non-optional at every call
  // site. `cutWithCompiled` accepts a compilation and therefore does NOT carry that guarantee — it
  // exists to be pinned, and is pinned as having no caller outside this module.
  return cutWithCompiled(path, schemaId, COMPILED_REGIONS);
}

// ⛔ THE ONE PROPERTY OF THIS SIGNAL A ROW AUTHOR CAN STILL INFLUENCE IS ITS LENGTH, so it is bounded
// (`### 24.98`, security review): ajv compiles with `allErrors: true`, so N malformed entries yield N
// issues and `AuditRecordSchema.refs` has no `.max`. ⚠ DEDUPE THEN CAP, AND THE DROP IS REPORTED — a
// silently truncated list reads as a complete one.
const MAX_ISSUE_PATH_REFS = 20;

// ⛔ `MAX_ISSUE_PATH_REFS` ABOVE IS A CARDINALITY CAP ONLY — it bounds HOW MANY refs this signal
// carries; nothing bounded how LONG any ONE of them is (`### 24.114`). `structuralPathOnly` is the
// PRIMARY defense: it cuts a row-authored key out of a path before it ever reaches here. This clamp
// is the BACKSTOP for a CUT FAILURE, stated honestly — it does not CLAIM to prevent one:
//   · an unmapped/inherited schema id degrades to the fixed `MAXIMAL_CUT` (already short) — covered;
//   · a REGION-LESS schema (`cutWithCompiled`, `pattern === undefined`) returns its path UNCHANGED,
//     deliberately (see that function's own docblock) — measured safe TODAY only because none of the
//     four live schemas' region-less paths carry row content, a property of the SCHEMAS, not of this
//     module;
//   · a path that does not match the compiled pattern falls through `?? path` unmodified.
// None of those three is EXPECTED to carry unbounded content — this bounds a cut failure, it does not
// prevent one, the same honest framing `applyPlan`'s corrected docblock uses (`### 24.116`).
const MAX_REF_LENGTH = 200;

// A ref built from `structuralPathOnly`'s output is composed only of this codebase's own closed
// schema-property vocabulary + `.`/`/` path separators + numeric array indices — plain ASCII
// identifiers, never free text (the free-form-key region is exactly what got cut). An ellipsis +
// bracketed marker is therefore not a substring any of the four live schemas can produce UNCLAMPED,
// so its presence is a reliable truncation signal, not a coincidence a row author could forge to make
// a complete ref look clamped (or vice versa) under normal candidate-data paths.
const REF_CLAMP_MARKER = "…[clamped]";

/**
 * Clamp ONE ref string to `MAX_REF_LENGTH`, appending a VISIBLE marker on truncation. A silently
 * shortened ref reads as a complete one — the same reported-drop discipline `buildRefusalSignal`'s
 * own `omitted` count applies to CARDINALITY, applied here to LENGTH: an operator scanning `refs`
 * must be able to tell "the whole path" from "the first N characters of it" without comparing string
 * lengths against a constant nobody displays.
 */
function clampRefLength(ref: string): string {
  if (ref.length <= MAX_REF_LENGTH) return ref;
  return ref.slice(0, MAX_REF_LENGTH - REF_CLAMP_MARKER.length) + REF_CLAMP_MARKER;
}

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
    // Cardinality cap FIRST (on the true distinct-path count, so `omitted`/`afterSummary` above stay
    // accurate to how many DISTINCT paths existed), length clamp SECOND, per-element — the two caps
    // are independent and compose without redefining what either counts (L3's cap/gate-order lesson).
    refs: paths.slice(0, MAX_ISSUE_PATH_REFS).map(clampRefLength),
    payloadHash: input.payloadHash,
    beforeSummary: input.beforeSummary,
    afterSummary:
      `${input.issues.length} issue(s), ${paths.length} distinct path(s)` +
      `${omitted > 0 ? `, ${omitted} path(s) not listed` : ""}; nothing admitted`,
  });
}
