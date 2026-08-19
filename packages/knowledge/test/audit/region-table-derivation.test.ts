// spec(§16) — `### 24.113`: NOTHING re-derives `FREE_FORM_KEY_REGIONS`.
//
// ⛔⛔ THIS GUARDS A CONTROL THAT IS CORRECT TODAY, AND THAT IS PRECISELY WHY IT IS NEEDED. Both
// reviewers verified the table independently at HEAD (`### 24.103` Step 8). The table is
// hand-derived per candidate schema and nothing re-derives it, so tomorrow's drift is SILENT: the
// region name stops matching, `structuralPathOnly`'s pattern runs, matches nothing, cuts nothing,
// and the `?? path` fallback returns the row-authored path VERBATIM into an audit ref — with every
// test in this suite green. `isRedactionSafe` provably does not backstop that (`### 24.119`
// measured it returning `true` on a leaked employer project codename), so the cut IS the control.
//
// ⭐ THE FINDING IS SHARED-SHAPE REACHABILITY, NOT TOP-LEVEL DRIFT. `SourceRefSchema` is reachable
// from BOTH `sow:gcl-projection` AND `sow:knowledge-mutation-plan` ⇒ ONE `z.record` added to that
// ONE nested shape invalidates TWO table rows at once. A detector that only compared top-level
// properties would pass green while exactly that walked through it — so the per-reacher assertions
// below (`a_free_form_region_...` / `the_shared_shape_...`) are the acceptance criterion and the
// rest is scaffolding for them.
//
// ⛔ THE DERIVATION IS RUN ON BOTH VALIDATOR SURFACES BECAUSE BOTH ARE LIVE PRODUCERS OF THE PATHS
// BEING CUT — this is NOT belt-and-braces. `writer.ts`'s `runGate` refuses at stage (a) with ajv
// errors (`/a/b` dialect) and at stage (b) with Zod issues (`a.b` dialect), and
// `structuralPathOnly`'s pattern handles both dialects deliberately. A region visible on only one
// surface would leave the other surface's issue paths UNCUT in production. They are also two
// independent implementations of the same constraint and could genuinely disagree, which is what
// makes their agreement evidence rather than an echo (029: concordance is evidence only when the
// methods could have disagreed).
import { describe, it, expect } from "vitest";
import {
  KnowledgeMutationPlanSchema,
  KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
  GBrainProposedFactSchema,
  GBRAIN_PROPOSED_FACT_SCHEMA_ID,
  SignedProvenanceStampSchema,
  SIGNED_PROVENANCE_STAMP_SCHEMA_ID,
  GclProjectionSchema,
  GCL_PROJECTION_SCHEMA_ID,
  SourceRefSchema,
  CanonicalSourceRefSchema,
} from "@sow/contracts";
import { emitJsonSchema } from "@sow/contracts/schema/emit";
import {
  FREE_FORM_KEY_REGIONS,
  SAFE_REGION_NAME,
  type CandidateSchemaId,
} from "../../src/audit/validation-refusal";

// ─── the live candidate schemas, paired with the ids the table is keyed by ────────────────────
// ⛔ TYPED AS `Record<CandidateSchemaId, unknown>` ON PURPOSE: `tsc` then requires an entry for
// every member of the closed union, so a fifth candidate schema cannot be added to the table
// without this guard being pointed at it too. (`### 24.98`'s enumeration technique, reused. Its
// KNOWN blind spot still applies and is out of scope here — a fifth schema validated against its
// OWN local union is invisible to this enumeration; see `### 24.103`'s union-boundary note.)
const LIVE_SCHEMAS: Readonly<Record<CandidateSchemaId, unknown>> = {
  [KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID]: KnowledgeMutationPlanSchema,
  [GBRAIN_PROPOSED_FACT_SCHEMA_ID]: GBrainProposedFactSchema,
  [SIGNED_PROVENANCE_STAMP_SCHEMA_ID]: SignedProvenanceStampSchema,
  [GCL_PROJECTION_SCHEMA_ID]: GclProjectionSchema,
};
const SCHEMA_IDS = Object.keys(LIVE_SCHEMAS) as CandidateSchemaId[];

// ══ surface 1 — the emitted JSON Schema ═══════════════════════════════════════════════════════
// ⚠ PRECISELY: this RE-EMITS from the Zod source. Production ajv compiles the CHECKED-IN artifacts
// `packages/contracts/schemas/*.schema.json`, which `defaultSchemaRegistry` reads from disk. The two
// are canonically identical today, and that identity is pinned by `freezeGenerated` in CONTRACTS'
// suite — a real `expect(JSON.parse(read)).toEqual(value)`, not a silent rewrite. ⛔ Named here
// because this file's conclusion rests on a premise it cannot see (`contracts L66`): weaken that
// freeze test and this surface silently stops describing what ajv actually validates.

/**
 * Keywords whose appearance INVALIDATES this walk's central assumption rather than merely being
 * unhandled. `emitJsonSchema` pins `$refStrategy: "none"`, so every sub-schema is INLINED and a
 * reference keyword cannot appear — measured across all four schemas at HEAD.
 *
 * ⚠ WHAT THIS GUARD DOES AND DOES NOT CATCH — THE FIRST WORDING OVERCLAIMED (security review).
 * Under `"none"` a reference keyword is structurally IMPOSSIBLE, so this cannot fire for the
 * failure it names. What actually befalls a RECURSIVE definition is that `zod-to-json-schema`
 * collapses it to `{}` with only a `console.warn`; the walk then finds nothing beneath it and
 * returns quietly. Bounded, and stated so nobody reads more assurance into it than it carries: ajv
 * validates nothing under a `{}` collapse either, so no issue path can arise there, and a one-sided
 * collapse would red `both_validator_surfaces_derive_the_same_regions`. The guard is retained for a
 * future emitter CONFIG change, which is the case it genuinely catches.
 */
const AJV_REFERENCE_KEYWORDS = ["$ref", "$defs", "definitions"] as const;
/**
 * Composition keywords traversed with the enclosing property name carried through. ⛔ `not` AND
 * `if` ARE DELIBERATELY ABSENT AND ARE REFUSED BELOW INSTEAD: their subschemas describe what the
 * data must NOT match / a PREDICATE selecting a branch, not the shape of the value at that path, so
 * harvesting a region out of either would add a table entry for a key set that cannot occur — an
 * OVER-CUT, the direction that silently truncates every path beneath it and that no safety
 * assertion in this repo would notice. Refusing beats guessing: none of the seven appears at HEAD,
 * so neither arm has a live fixture and only the refusal fails loudly.
 */
const AJV_COMPOSITION_KEYWORDS = ["allOf", "anyOf", "oneOf", "then", "else"] as const;
/** Refused, not traversed — see above. Grouped with the reference keywords for one throw site. */
const AJV_REFUSED_KEYWORDS = ["not", "if"] as const;

interface Derivation {
  /** Property names under which a free-form (row-authored) key set can appear. */
  readonly regions: readonly string[];
  /** ⛔ Non-vacuity counter: distinguishes "measured empty" from "never looked". */
  readonly nodesVisited: number;
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * ⛔ THE OPEN-KEY PREDICATE, and `absent` is EXCLUDED DELIBERATELY. The module docblock states the
 * rule as `additionalProperties ∉ {false, absent}`: a bare `{}` (what `z.unknown()` emits) declares
 * no object constraints at all, so no validator raises a per-entry issue beneath it and no
 * row-authored key can become a path segment there. `false` closes the key set outright and wins
 * over any `propertyNames`.
 *
 * ⚠ BOUND, STATED BECAUSE THE SENTENCE ABOVE READS AS GENERAL AND IS NOT (security review): in JSON
 * Schema `additionalProperties` governs only keys NOT matched by `properties`/`patternProperties`,
 * so `{additionalProperties: false, patternProperties: {…}}` still admits pattern-matched keys and
 * this predicate would wrongly report it closed. `false` beats `propertyNames`; it does NOT beat
 * `patternProperties`. Measured unreachable — `zod-to-json-schema@3.25.2` never emits
 * `patternProperties` at all — so the clause is kept for the day that changes, and it is the
 * ORDERING that would then need revisiting, not the clause.
 */
function isOpenKeyed(node: Record<string, unknown>): boolean {
  const additional = node["additionalProperties"];
  if (additional === false) return false;
  return (
    additional !== undefined ||
    node["patternProperties"] !== undefined ||
    node["propertyNames"] !== undefined
  );
}

function deriveFromJsonSchema(root: Record<string, unknown>): Derivation {
  const regions = new Set<string>();
  let nodesVisited = 0;

  const visit = (node: unknown, propertyName: string | null, depth: number): void => {
    if (!isPlainObject(node)) return;
    if (depth > 64) throw new Error(`ajv walk exceeded depth 64 at ${propertyName ?? "<root>"}`);
    nodesVisited += 1;

    for (const keyword of AJV_REFERENCE_KEYWORDS) {
      if (node[keyword] !== undefined) {
        throw new Error(
          `ajv walk met "${keyword}" at ${propertyName ?? "<root>"}: emitJsonSchema pins ` +
            `$refStrategy:"none", so this walk assumes every sub-schema is inlined. That ` +
            `assumption is now false and the derivation would silently under-report.`,
        );
      }
    }
    for (const keyword of AJV_REFUSED_KEYWORDS) {
      if (node[keyword] !== undefined) {
        throw new Error(
          `ajv walk met "${keyword}" at ${propertyName ?? "<root>"}: its subschema constrains ` +
            `what the value must NOT be, or selects a branch, so a region harvested from it would ` +
            `be an over-cut. Decide what the region set should be and pin it explicitly.`,
        );
      }
    }

    if (isOpenKeyed(node)) {
      if (propertyName === null) {
        throw new Error(
          "the schema ROOT is open-keyed: the region table is keyed by property name and cannot " +
            "express a root-level free-form key set",
        );
      }
      // ⛔ DO NOT DESCEND. `structuralPathOnly` truncates the path AT this region, so every path
      // beneath it is already discarded; deriving a nested region here would demand a table entry
      // for a segment that can never survive the cut, and the comparison is EQUALITY.
      regions.add(propertyName);
      return;
    }

    const properties = node["properties"];
    if (isPlainObject(properties)) {
      for (const [name, child] of Object.entries(properties)) visit(child, name, depth + 1);
    }
    const items = node["items"];
    if (Array.isArray(items)) for (const child of items) visit(child, propertyName, depth + 1);
    else visit(items, propertyName, depth + 1);
    for (const keyword of AJV_COMPOSITION_KEYWORDS) {
      const branch = node[keyword];
      if (Array.isArray(branch)) for (const child of branch) visit(child, propertyName, depth + 1);
      else visit(branch, propertyName, depth + 1);
    }
  };

  visit(root, null, 0);
  return { regions: [...regions].sort(), nodesVisited };
}

// ══ surface 2 — the Zod `_def` graph (what `runGate` stage (b) parses with) ════════════════════
// ⛔ WALKED STRUCTURALLY, WITHOUT IMPORTING `zod`. `@sow/knowledge` does not depend on zod (pnpm
// resolves it only for `@sow/contracts`), so this reads `_def` shapes rather than zod types. That
// is also the honest scope: it tests THIS WALK, not zod's emitter.

/**
 * Wrappers this walk follows, and the `_def` key holding the wrapped schema.
 *
 * ⛔⛔ EXACTLY THE FOUR THE LIVE TYPE CENSUS MEASURES, AND PRE-WIRING MORE WOULD BE A DOWNGRADE, NOT
 * A FAVOUR. An unhandled typeName THROWS with an actionable message; a wrapper entry naming the
 * WRONG `_def` key does not — `visit(def[wrapperKey], …)` would receive `undefined`, return at the
 * `typeof node !== "object"` guard, and drop every region beneath it SILENTLY. ⇒ ***a guessed
 * wrapper trades a guaranteed loud stop for an unverified silent traversal, in the one direction
 * this file exists to prevent.*** `ZodNullable`/`ZodBranded`/`ZodUnion`/`ZodLazy`/`ZodPromise`/
 * `ZodCatch`/`ZodReadonly`/`ZodIntersection`/`ZodPipeline`/`ZodTuple`/`ZodSet`/`ZodMap` are
 * therefore NOT listed: the first live schema to use one reds this suite and names itself, which is
 * the outcome we want. ⚠ The module docblock's method names Branded/Union among the wrappers it
 * traversed; neither exists in any candidate schema today, so that arm never had a live fixture
 * there either — the throw makes the gap loud instead of assumed.
 * ⭐ `ZodEffects` is the load-bearing one (23 occurrences): the branded-id schemas build on
 * `.transform()`, so dropping it loses regions across every schema — mutation-verified.
 */
const ZOD_WRAPPERS: Readonly<Record<string, string>> = {
  ZodOptional: "innerType",
  ZodDefault: "innerType",
  ZodArray: "type",
  ZodEffects: "schema",
};
/** Childless types. An unlisted typeName THROWS — see `the_walk_refuses_...`. */
const ZOD_LEAVES = new Set([
  "ZodString", "ZodNumber", "ZodBoolean", "ZodEnum", "ZodNativeEnum", "ZodLiteral", "ZodNever",
  "ZodUnknown", "ZodAny", "ZodNull", "ZodUndefined", "ZodVoid", "ZodDate", "ZodBigInt", "ZodNaN",
  "ZodSymbol",
]);

interface ZodDerivation extends Derivation {
  /**
   * Every schema INSTANCE the walk reached without crossing a free-form region. That is exactly
   * the population the table governs — paths below a region are cut, so a shape reachable only
   * beneath one cannot contribute a segment.
   */
  readonly reached: ReadonlySet<unknown>;
}

function deriveFromZod(root: unknown): ZodDerivation {
  const regions = new Set<string>();
  const reached = new Set<unknown>();
  const onPath = new Set<unknown>();
  let nodesVisited = 0;

  const visit = (node: unknown, propertyName: string | null, depth: number): void => {
    if (node === null || typeof node !== "object") return;
    if (depth > 64) throw new Error(`zod walk exceeded depth 64 at ${propertyName ?? "<root>"}`);
    // ⛔ CYCLE GUARD IS PATH-LOCAL, NOT GLOBAL. A global "seen" set would skip the SECOND reacher
    // of a shared instance and silently drop its region — under-reporting, in the calming
    // direction, inside the detector written for shared shapes.
    if (onPath.has(node)) return;

    const def = (node as { _def?: unknown })._def;
    if (!isPlainObject(def)) return;
    nodesVisited += 1;
    reached.add(node);
    onPath.add(node);
    try {
      const typeName = String(def["typeName"]);

      // ⭐ ONE RULE, THREE TRIGGERS: a free-form key set is a free-form key set however it is
      // spelled. Three re-worded copies of this guard is how the three spellings drift apart.
      const recordRegion = (trigger: string): void => {
        if (propertyName === null) {
          throw new Error(
            `the schema ROOT is open-keyed (${trigger}): the region table is keyed by property ` +
              `name and cannot express a root-level free-form key set`,
          );
        }
        regions.add(propertyName);
      };

      if (typeName === "ZodRecord") {
        recordRegion("ZodRecord");
        return; // do not descend — the cut truncates here
      }
      if (typeName === "ZodObject") {
        // ⛔ AN ABSENT `catchall` MUST NOT READ AS "CLOSED", WHICH IS WHAT THE FIRST VERSION DID VIA
        // `String(undefined) === "undefined"`. Every zod-v3 ZodObject carries a catchall (`ZodNever`
        // when unused), so its ABSENCE means this walk is reading a shape it does not understand —
        // and defaulting to closed silently skips whatever region is there. Fail loud instead.
        const catchall = def["catchall"];
        const catchallDef = isPlainObject(catchall)
          ? (catchall as { _def?: unknown })._def
          : undefined;
        if (!isPlainObject(catchallDef)) {
          throw new Error(
            `zod walk: ZodObject at ${propertyName ?? "<root>"} has no readable _def.catchall, so ` +
              `whether its key set is open cannot be determined`,
          );
        }
        const catchallName = String(catchallDef["typeName"]);
        if (catchallName !== "ZodNever") {
          recordRegion(`catchall(${catchallName})`);
          return;
        }
        if (def["unknownKeys"] === "passthrough") {
          recordRegion("passthrough");
          return;
        }
        const shape = def["shape"];
        // ⛔ NO SILENT ELSE: an unreadable shape means every field beneath this object is skipped,
        // and the resulting `[]` is indistinguishable from "this object is closed".
        if (typeof shape !== "function") {
          throw new Error(
            `zod walk: ZodObject at ${propertyName ?? "<root>"} has no callable _def.shape, so its ` +
              `fields cannot be enumerated and any region beneath it would be dropped silently`,
          );
        }
        const fields = (shape as () => Record<string, unknown>)();
        for (const [name, child] of Object.entries(fields)) visit(child, name, depth + 1);
        return;
      }
      // ⛔⛔ `Object.hasOwn`, NOT A BARE LOOKUP — AND THIS IS `### 24.103`'s OWN DEFECT REPRODUCED
      // IN THE WALK THAT DERIVES THE TABLE THAT FIX PROTECTS. `ZOD_WRAPPERS["toString"]` resolves
      // through the prototype chain to `Function.prototype.toString`, passes `!== undefined`, and
      // then `def[<function>]` is `undefined` — so the subtree is dropped WITHOUT ever reaching the
      // throw below. That is the exact inherited-key bypass `validation-refusal.ts:158-160`
      // documents for `FREE_FORM_KEY_REGIONS` itself. (Security review. Unreachable from real zod,
      // whose every typeName starts `Zod` — but this file hand-rolls `_def` objects.)
      const wrapperKey = Object.hasOwn(ZOD_WRAPPERS, typeName) ? ZOD_WRAPPERS[typeName] : undefined;
      if (wrapperKey !== undefined) {
        const inner = def[wrapperKey];
        // ⛔ THE SILENT-DROP GUARD. A wrapper naming a `_def` key this zod version does not use
        // would otherwise pass `undefined` down and discard the whole subtree without a word.
        if (inner === undefined) {
          throw new Error(
            `zod walk: "${typeName}" has no "${wrapperKey}" in its _def at ` +
              `${propertyName ?? "<root>"}; the wrapper table is wrong for this zod version and ` +
              `the subtree beneath it would be dropped silently.`,
          );
        }
        visit(inner, propertyName, depth + 1);
        return;
      }
      if (ZOD_LEAVES.has(typeName)) return;
      throw new Error(
        `zod walk met unhandled type "${typeName}" at ${propertyName ?? "<root>"}: it may contain ` +
          `a free-form key region this walk would not see. Add it to ZOD_WRAPPERS or ZOD_LEAVES ` +
          `after checking which, and re-derive the table.`,
      );
    } finally {
      onPath.delete(node);
    }
  };

  visit(root, null, 0);
  return { regions: [...regions].sort(), nodesVisited, reached };
}

// ─── hand-rolled `_def` fixtures (no zod dependency in this package) ──────────────────────────
const zodObject = (shape: Record<string, unknown>): unknown => ({
  _def: { typeName: "ZodObject", unknownKeys: "strip", catchall: { _def: { typeName: "ZodNever" } }, shape: () => shape },
});
const zodRecord = (): unknown => ({
  _def: { typeName: "ZodRecord", keyType: { _def: { typeName: "ZodString" } }, valueType: { _def: { typeName: "ZodUnknown" } } },
});
const zodArray = (inner: unknown): unknown => ({ _def: { typeName: "ZodArray", type: inner } });
const zodObjectWithCatchall = (shape: Record<string, unknown>): unknown => ({
  _def: { typeName: "ZodObject", unknownKeys: "strip", catchall: { _def: { typeName: "ZodString" } }, shape: () => shape },
});
const zodPassthrough = (shape: Record<string, unknown>): unknown => ({
  _def: { typeName: "ZodObject", unknownKeys: "passthrough", catchall: { _def: { typeName: "ZodNever" } }, shape: () => shape },
});
const zodOptional = (inner: unknown): unknown => ({ _def: { typeName: "ZodOptional", innerType: inner } });

const ajvRegionsFor = (id: CandidateSchemaId): Derivation =>
  deriveFromJsonSchema(emitJsonSchema(LIVE_SCHEMAS[id] as Parameters<typeof emitJsonSchema>[0], id));
const tableRow = (id: CandidateSchemaId): string[] => [...FREE_FORM_KEY_REGIONS[id]].sort();

describe("FREE_FORM_KEY_REGIONS is derived, not trusted (`### 24.113`)", () => {
  it("the_region_table_equals_the_derivation_from_the_live_schemas", () => {
    // spec(§16) — `### 24.113` Done-when. ⛔ EQUALITY, NOT CONTAINMENT: the two directions are
    // different defects. Derived-but-absent-from-the-table is an UNCUT region — a rule-7 leak.
    // Present-in-the-table-but-not-derived is an OVER-CUT, which silently truncates every reported
    // path beneath it and no safety assertion in this repo would notice. A subset assertion would
    // catch one and license the other.
    for (const id of SCHEMA_IDS) {
      // ⛔⛔ MEMBERSHIP IS NOT ENOUGH — THE NAMES ARE INTERPOLATED INTO A REGEX AND A BAD ONE
      // DISABLES THE CUT SILENTLY (security review, rule 7). `validation-refusal.ts:129` builds
      // `^(.*?\b(?:<regions>)\b)[./].*$`, so a region is only safe if `\b<name>\b` behaves and no
      // metacharacter can escape the group. Measured against that exact construction: `@ext` and
      // `ext$` make the pattern MATCH NOTHING — `\b` needs a word char on the region's inside edge
      // — and the `?? path` fallback then returns the row-authored path VERBATIM, which is
      // `### 24.119`'s fail-open reached through this door instead. `a|b` injects an alternation
      // and mis-cuts; `pay(load` throws `SyntaxError` at MODULE INIT, on `applyPlan`'s import path.
      // ⚠ Not reachable today (all four live regions are plain words) — and the trigger is an
      // ordinary future property name like `@context` or `$meta`, with THIS FILE the only thing
      // that computes those names. Word chars only, asserted where they are derived.
      // ⚠ ORDER IS DELIBERATE: this runs BEFORE the equality assertion. A poisoned region name is
      // the more dangerous condition, and sitting behind equality it would be UNREACHABLE in
      // exactly the case it exists for — where someone added the bad name to the table too, so
      // equality passes. Verified against the real construction (`node`, this session): with
      // regions `["@ext"]` the path `a.@ext.ROW_KEY` comes back VERBATIM.
      for (const region of ajvRegionsFor(id).regions) {
        // ⭐ THE PRODUCTION PREDICATE ITSELF, NOT A COPY (`### 24.136`). A second literal here could
        // drift from the one `REGION_PATTERNS` actually compiles against, and whichever was laxer
        // would be the one that mattered. Sharing the instance makes divergence unrepresentable.
        expect(region, `region "${region}" (${id}) must be regex-safe for the cut`).toMatch(
          SAFE_REGION_NAME,
        );
      }
      expect(ajvRegionsFor(id).regions, `ajv-derived regions for ${id}`).toEqual(tableRow(id));
    }
  });

  it("both_validator_surfaces_derive_the_same_regions", () => {
    // spec(§16) — both surfaces produce refusal issue paths in production (`runGate` stages (a)
    // and (b)), so a region seen on only one is a live uncut path on the other. Kept as its own
    // test so a SURFACE DISAGREEMENT is distinguishable from a TABLE mismatch.
    for (const id of SCHEMA_IDS) {
      expect(deriveFromZod(LIVE_SCHEMAS[id]).regions, `zod-derived regions for ${id}`).toEqual(
        ajvRegionsFor(id).regions,
      );
    }
  });

  it("the_derivation_recovers_the_one_region_already_known_to_be_real", () => {
    // spec(§16) — INSTRUMENT CONTROL, stated in the module docblock: an instrument that cannot find
    // the one region already known to be real is not measuring anything. Unaided — no hint passed.
    // ⚠ HONEST BOUND (code review): this is a POSITIVE control — was the walk pointed at the right
    // thing — and it is SUBSUMED by the equality test above, since the table contains
    // `sanitizedPayload` and equality implies containment. It cannot fail alone. Kept because it
    // states the intent the docblock names and localises the failure; the NON-VACUITY half (did the
    // walk run at all) is carried by `nodesVisited`, not here.
    expect(ajvRegionsFor(GCL_PROJECTION_SCHEMA_ID).regions).toContain("sanitizedPayload");
    expect(deriveFromZod(GclProjectionSchema).regions).toContain("sanitizedPayload");
  });

  it("the_shared_nested_shape_is_reachable_from_exactly_the_two_ids_the_finding_names", () => {
    // spec(§16) — `### 24.113`'s PREMISE, pinned so it cannot rot: `SourceRefSchema` is reachable
    // from BOTH `sow:knowledge-mutation-plan` and `sow:gcl-projection`, which is why one `z.record`
    // there invalidates TWO rows. Asserted by INSTANCE IDENTITY, not by name.
    // ⛔ WITH ITS NEGATIVE CONTROL: `CanonicalSourceRefSchema` is a different shape reached by ONE
    // id only. Without it, "reachable from two" is indistinguishable from a walk that says yes to
    // everything.
    const reachers = (target: unknown): CandidateSchemaId[] =>
      SCHEMA_IDS.filter((id) => deriveFromZod(LIVE_SCHEMAS[id]).reached.has(target));
    expect(reachers(SourceRefSchema).sort()).toEqual(
      [GCL_PROJECTION_SCHEMA_ID, KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID].sort(),
    );
    expect(reachers(CanonicalSourceRefSchema)).toEqual([GBRAIN_PROPOSED_FACT_SCHEMA_ID]);
  });

  it("a_free_form_region_in_a_SHARED_nested_shape_is_seen_for_EVERY_schema_that_reaches_it", () => {
    // spec(§16) — ⛔ THE FINDING ITSELF. One shape instance, two roots: the derivation must report
    // the region for BOTH. A walk that memoised shapes globally, or compared only top-level
    // properties, passes every other test in this file and fails this one.
    // (a) CROSS-ROOT — `### 24.113`'s literal shape: one shape instance, two schema roots.
    const shared = zodObject({ freeFormBucket: zodRecord() });
    const rootA = zodObject({ alpha: zodArray(shared) });
    const rootB = zodObject({ beta: zodOptional(shared) });
    expect(deriveFromZod(rootA).regions).toEqual(["freeFormBucket"]);
    expect(deriveFromZod(rootB).regions).toEqual(["freeFormBucket"]);
    // (b) ⛔⛔ INTRA-ROOT, AND (a) CANNOT DETECT THE HAZARD WITHOUT IT — MEASURED, NOT ASSUMED.
    //     (a) walks each root in its OWN call, so per-call memoisation never fires and (a) passes
    //     against a walk that memoises globally. Here ONE instance is reached under TWO property
    //     names in ONE walk: a global "seen" records `alpha`, skips the second visit, and silently
    //     drops `beta` — the region name differs per reacher, which is exactly what (a)'s shared
    //     INNER name cannot expose. Verified by mutation: with the path-local guard replaced by a
    //     global memo, (a) stays green and (b) reds.
    const sharedRecord = zodRecord();
    const reachedTwice = zodObject({ alpha: sharedRecord, beta: sharedRecord });
    expect(deriveFromZod(reachedTwice).regions).toEqual(["alpha", "beta"]);
  });

  it("every_open_key_spelling_is_recognised_as_a_region", () => {
    // spec(§16) — ⛔ ADDED AT CODE REVIEW: `ZodRecord` was the ONLY open-key spelling any assertion
    // in this file had ever demonstrated the walk can find, yet the walk carries two more detectors
    // — a real (non-`ZodNever`) catchall, and `passthrough`. Neither is reachable from a live
    // candidate schema today, so neither had a fixture: a region-DETECTOR that no assertion runs is
    // the same defect as the region-TABLE nothing re-derives, one level up.
    // ⚠ NOT hypothetical: `emit.ts`'s own header injects `propertyNames` specifically for real
    // catchalls and names `.passthrough()` as a known unguarded gap — i.e. the emitter says these
    // are the shapes a future model reaches for.
    expect(deriveFromZod(zodObject({ bucket: zodObjectWithCatchall({}) })).regions).toEqual(["bucket"]);
    expect(deriveFromZod(zodObject({ bucket: zodPassthrough({}) })).regions).toEqual(["bucket"]);
    // and an absent catchall is refused rather than silently read as a closed key set
    expect(() =>
      deriveFromZod(zodObject({ bucket: { _def: { typeName: "ZodObject", unknownKeys: "strip" } } })),
    ).toThrow(/no readable _def\.catchall/u);
  });

  it("the_empty_row_is_measured_empty", () => {
    // spec(§16) — `sow:signed-provenance-stamp` is empty BY MEASUREMENT, not by omission (module
    // docblock). ⛔ A derivation that never looked produces the identical `[]`, so the walk must be
    // shown to have RUN over it — the non-vacuity half the empty row has no other way to state.
    const ajv = ajvRegionsFor(SIGNED_PROVENANCE_STAMP_SCHEMA_ID);
    const zod = deriveFromZod(SignedProvenanceStampSchema);
    expect(ajv.regions).toEqual([]);
    expect(zod.regions).toEqual([]);
    // ⛔ ASSERTED AGAINST THE MEASURED COUNTS, NOT `> 1` (security review): the stamp is the ONE row
    // where `regions === []` carries no signal of its own, so this counter is all that separates
    // "measured empty" from "never looked" — and a `> 1` bound is ~4x looser than the real value,
    // loose enough that a walk mutated to stop at depth 1 would still pass HERE and be caught only
    // incidentally, via the other three schemas. Tight bounds fail on the row that needs them.
    expect(ajv.nodesVisited, "ajv nodes visited over the stamp").toBeGreaterThanOrEqual(8);
    expect(zod.nodesVisited, "zod nodes visited over the stamp").toBeGreaterThanOrEqual(8);
  });

  it("a_value_shaped_row_key_is_NOT_a_region", () => {
    // spec(§16) — `frontmatterUpdates[]` carries a row-authored key as a VALUE (`key: string`),
    // never as a path segment, so it must NOT derive as a region. Over-cutting is the silent
    // direction: `\b` is what keeps `frontmatter` from swallowing it, and nothing else would tell.
    const plan = ajvRegionsFor(KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID).regions;
    expect(plan).not.toContain("frontmatterUpdates");
    expect(plan).toContain("frontmatter");
  });

  it("the_walk_refuses_a_shape_it_cannot_prove_it_understands", () => {
    // spec(§16) — ⛔ THE UNDER-REPORTING DIRECTION IS THE CALMING ONE, so it fails LOUD rather than
    // returning a confident short answer. A reference keyword voids the inlining assumption
    // `$refStrategy:"none"` currently guarantees; an unhandled Zod container may hide a region.
    // and the two open-key spellings on the ajv side that no LIVE schema exercises either —
    // `patternProperties` and `propertyNames` are both emitter-reachable (`guardCatchallPropertyNames`
    // injects `propertyNames` for every real `.catchall()`), so leaving them unpinned would be the
    // undemonstrated-detector defect one surface over.
    expect(
      deriveFromJsonSchema({
        type: "object",
        properties: { bucket: { type: "object", patternProperties: { "^x": {} } } },
      }).regions,
    ).toEqual(["bucket"]);
    expect(
      deriveFromJsonSchema({
        type: "object",
        properties: { bucket: { type: "object", propertyNames: { pattern: "^y" } } },
      }).regions,
    ).toEqual(["bucket"]);
    expect(() => deriveFromJsonSchema({ type: "object", properties: { a: { $ref: "#/x" } } })).toThrow(
      /\$ref/u,
    );
    expect(() => deriveFromZod(zodObject({ a: { _def: { typeName: "ZodTuple" } } }))).toThrow(
      /ZodTuple/u,
    );
  });
});
