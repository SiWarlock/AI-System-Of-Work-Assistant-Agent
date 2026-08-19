// spec(§16) spec(§6) — `### 24.136`: `structuralPathOnly` guards its OWN region names.
//
// ⛔⛔ TWO RULES IN ONE GAP. `### 24.113` (LANDED `106968f4`) certified every region name the
// DERIVATION produces. It cannot see a region added BY HAND — and the table is hand-maintained,
// which is the whole reason that task existed. The names are interpolated into a live regex at
// `REGION_PATTERNS` construction, so an unsafe one fails in two different ways:
//
//   rule 7 — `\b` needs a WORD character on the region's inside edge, so a non-word edge makes the
//            whole pattern fail and `structuralPathOnly`'s `?? path` fallback returns the
//            row-authored path VERBATIM — exactly `### 24.119`'s measured fail-open, reached
//            through a different door. ⛔ THE FOUR MEASURED CASES ARE ENUMERATED ONCE, at
//            `SAFE_REGION_NAME` in `validation-refusal.ts`, beside the predicate they justify —
//            NOT copied here, so there is one place to correct when the measurement is refined.
//   rule 1 — `["pay(load"]` throws `SyntaxError` while CONSTRUCTING the pattern. `REGION_PATTERNS`
//            is a module-level `const`, so that throw happens at MODULE INIT: importing
//            `validation-refusal.ts` fails, on `applyPlan`'s import path — the SOLE WRITER cannot
//            load. A refusal-path defect becomes a writer-availability defect.
//
// ⭐ THE RESOLUTION, AND IT IS THE DESIGN QUESTION THE BRIEF ASKED: the guard sits at CONSTRUCTION
// so no caller can bypass it, but its failure mode is DATA, NOT A THROW — a poisoned schema id
// gets no pattern and is recorded. Runtime degrades to `MAXIMAL_CUT` (contained, fail-safe, the
// same thing an unknown id already does); the LOUDNESS lives in `no_live_schema_id_is_poisoned`
// below, which reds the suite. ⇒ ***loud at TEST time, contained at RUNTIME*** — because the one
// thing this slice may not do is make module init a new place to throw.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
  GBRAIN_PROPOSED_FACT_SCHEMA_ID,
  SIGNED_PROVENANCE_STAMP_SCHEMA_ID,
  GCL_PROJECTION_SCHEMA_ID,
} from "@sow/contracts";
import {
  FREE_FORM_KEY_REGIONS,
  MAXIMAL_CUT,
  structuralPathOnly,
  compileRegionPatterns,
  cutWithCompiled,
} from "../../src/audit/validation-refusal";

const ID = "sow:probe";
/** Compile a one-row synthetic table. Never touches the live table. */
const compile = (regions: readonly string[]) => compileRegionPatterns({ [ID]: regions });

describe("region names are guarded where they are compiled (`### 24.136`)", () => {
  it("a_region_with_a_non_word_leading_edge_is_REJECTED_not_silently_uncut", () => {
    // spec(§16) — rule 7. `\b@` never matches, so the pattern fails wholesale and `?? path`
    // returns the row key verbatim. The guard must catch it BEFORE that regex is ever built.
    const compiled = compile(["@ext"]);
    expect(compiled.poisoned.has(ID)).toBe(true);
    expect(compiled.patterns.has(ID)).toBe(false);
    expect(cutWithCompiled("a.@ext.ROW_KEY", ID, compiled)).toBe(MAXIMAL_CUT);
  });

  it("a_region_with_a_non_word_trailing_edge_is_REJECTED", () => {
    // spec(§16) — rule 7, the mirror edge. Asserted separately from the leading edge because the
    // runner aborts at the first failing assertion, so one mutation over a merged block would
    // prove only one of them (`contracts L237`).
    const compiled = compile(["ext$"]);
    expect(compiled.poisoned.has(ID)).toBe(true);
    expect(cutWithCompiled("a.ext$.ROW_KEY", ID, compiled)).toBe(MAXIMAL_CUT);
  });

  it("an_injected_alternation_is_REJECTED", () => {
    // spec(§16) — rule 7, and this one does not fail to match: it MIS-cuts. `a|b` silently becomes
    // two alternatives, so an unrelated path is truncated at the wrong segment — a wrong answer
    // rather than an absent one, which is the harder direction to notice.
    const compiled = compile(["a|b"]);
    expect(compiled.poisoned.has(ID)).toBe(true);
    expect(cutWithCompiled("zzz.b.ROW_KEY", ID, compiled)).toBe(MAXIMAL_CUT);
  });

  it("an_unbalanced_group_fails_CONTAINED_not_at_module_init", () => {
    // spec(§6) — ⛔ THE RULE-1 PIN, AND THE REASON THIS IS NOT A `### 24.114` SIBLING.
    // `new RegExp("...(pay(load)...")` throws `SyntaxError`. Compiling must NOT propagate it:
    // `REGION_PATTERNS` is module-level, so a throw here means `import` fails and the sole writer
    // never loads. ⭐ The name predicate makes the throw UNREPRESENTABLE rather than caught — no
    // string that passes `/^[A-Za-z0-9_]+$/` can be an invalid pattern fragment (`contracts L103`).
    expect(() => compile(["pay(load"])).not.toThrow();
    const compiled = compile(["pay(load"]);
    expect(compiled.poisoned.has(ID)).toBe(true);
    expect(cutWithCompiled("x.pay(load.ROW_KEY", ID, compiled)).toBe(MAXIMAL_CUT);
  });

  it("a_region_less_schema_still_gets_the_IDENTITY_cut_not_a_refusal", () => {
    // spec(§16) — ⛔⛔ THE ORDERING IS THE GUARD, AND IT IS LOAD-BEARING, NOT STYLE. A poisoned id
    // has NO compiled pattern — and the pre-existing `pattern === undefined` branch returns `path`
    // UNCHANGED, because that is the correct identity cut for a schema with no free-form region at
    // all (the stamp). ⇒ ***a poisoned id reaching that branch is returned VERBATIM: the exact
    // fail-open this slice exists to close, arrived at through the guard's own absence.***
    // `### 24.113`'s placement argument, one file over: a guard behind another branch is
    // unreachable in precisely the case it exists for.
    // ⚠ NARROWED AT CODE REVIEW, WHICH MEASURED MY ORIGINAL WHERE I HAD ONLY READ IT: this pin was
    // named for the ORDERING hazard and could not discriminate it. The reorder mutation reds pins
    // 1-4 as well — pin 1 alone kills it — so the assertions duplicating pin 1 proved nothing pin 1
    // did not. ⇒ ***a pin NAMED for a hazard is not the same as a pin that can DETECT it***, which
    // is this area's own recurring defect arriving a third time. What remains is the one property
    // nothing else in this file asserts: a region-less schema must reach the identity branch rather
    // than the refusal. The ordering itself is enforced by pin 1, and the docblock says so.
    const regionless = compile([]);
    expect(regionless.poisoned.has(ID)).toBe(false);
    expect(regionless.patterns.has(ID)).toBe(false);
    expect(cutWithCompiled("a.b.ROW_KEY", ID, regionless)).toBe("a.b.ROW_KEY");
  });

  it("an_off_type_region_row_is_REFUSED_not_thrown", () => {
    // spec(§6) — the rule-1 pin's second half, added after security review measured SEVEN throw
    // vectors reachable with an off-type table (`regions` a bare string, `null`, a number) against
    // a docblock that claimed the function is TOTAL. ⛔ Every one of them throws at MODULE INIT on
    // the sole writer's import path, which is the failure this task exists to prevent — so an
    // off-type row must degrade to a refusal exactly like an unsafe NAME does.
    // ⚠ `tsc` forbids these shapes at the live call site; they are reachable through the seam,
    // which `cutWithCompiled_has_no_caller_outside_its_own_module` bounds but does not close.
    for (const bad of ["frontmatter", null, undefined, 42, { 0: "a" }]) {
      const table = { [ID]: bad } as unknown as Readonly<Record<string, readonly string[]>>;
      expect(() => compileRegionPatterns(table), `off-type regions: ${JSON.stringify(bad)}`).not.toThrow();
      expect(compileRegionPatterns(table).poisoned.has(ID)).toBe(true);
    }
  });

  it("each_region_is_read_ONCE_so_a_value_cannot_change_after_it_is_validated", () => {
    // spec(§16) — validate-then-reread is a TOCTOU on the value the guard just approved. Security
    // review measured it against the first implementation: a getter-backed array returning
    // "payload" on read 1 and "a|b" on read 2 passed the guard and compiled the INJECTED
    // alternation. ⛔ The remedy is that the guard validates a COPY and the pattern is built from
    // that same copy — so this pin reds the moment someone "simplifies" it back to reading
    // `regions` twice, which looks like removing a pointless allocation.
    let reads = 0;
    const twoFaced: string[] = [];
    Object.defineProperty(twoFaced, 0, {
      get: () => (reads++ === 0 ? "payload" : "a|b"),
      enumerable: true,
      configurable: true,
    });
    twoFaced.length = 1;
    const compiled = compileRegionPatterns({ [ID]: twoFaced });
    expect(compiled.poisoned.has(ID)).toBe(false); // "payload" is a safe name, so it compiles…
    // …and the compiled pattern must be the one that was VALIDATED, never the second read.
    expect(cutWithCompiled("zzz.b.ROW_KEY", ID, compiled)).toBe("zzz.b.ROW_KEY");
    expect(cutWithCompiled("x.payload.ROW_KEY", ID, compiled)).toBe("x.payload");
  });

  it("no_live_schema_id_is_poisoned", () => {
    // spec(§16) — ⭐ THIS IS WHERE THE LOUDNESS LIVES. Runtime degrades quietly to `MAXIMAL_CUT` on
    // purpose (rule 1: module init may not throw), so without this pin a hand-added bad region
    // would silently disable that schema's cut forever. Here it reds the suite instead.
    const live = compileRegionPatterns(FREE_FORM_KEY_REGIONS);
    expect([...live.poisoned]).toEqual([]);
  });

  it("the_audit_module_is_FENCED_from_deep_import_by_the_exports_map", () => {
    // spec(§16) — ⛔⛔ REPLACES A SCANNER WITH A FENCE. The first version of this pin walked the
    // repo asserting nobody deep-imports `cutWithCompiled`, on the recorded premise that "a fence is
    // not available" to this task. THAT PREMISE WAS FALSE: `package.json` already carries exact
    // subpath `null` keys beside the `"./*"` wildcard (the repo's own remedy, derived for
    // `### 24.65`), an exact key beats the pattern in Node's resolver, and every internal consumer
    // imports RELATIVELY — which never consults the exports map. So the seam is now closed rather
    // than watched. ⭐ `contracts L103`: unrepresentable beats detected; a scanner is belt.
    // ⚠ THIS PIN GUARDS THE FENCE ITSELF, because a `null` in a manifest is exactly the kind of
    // line that gets "tidied up" by someone who cannot see what it holds shut. Deleting it makes
    // `cutWithCompiled` deep-importable, and a caller who hand-builds a `CompiledRegions` gets the
    // row-authored path back VERBATIM — which `isRedactionSafe` measurably does not catch.
    // ⛔ AND IF `### 24.78` CLOSES, THIS FENCE BECOMES REDUNDANT — NOT WRONG (`contracts L248`).
    // A reader meeting that entry ticked must not take it as permission to remove the line.
    const manifest = JSON.parse(
      readFileSync(join(__dirname, "..", "..", "package.json"), "utf8"),
    ) as { exports: Record<string, unknown> };
    expect(manifest.exports).toHaveProperty(["./audit/validation-refusal"]);
    expect(manifest.exports["./audit/validation-refusal"]).toBeNull();
    // positive control: the wildcard it must override is genuinely present, so this is a real
    // override and not a key sitting next to nothing.
    expect(manifest.exports["./*"]).toBeDefined();
  });

  it("the_four_live_regions_are_unchanged", () => {
    // spec(§16) — ⭐ `contracts L239`: check the path the change exists to SERVE, not only the path it closes.
    // Every live cut must behave exactly as it did before this slice.
    expect(structuralPathOnly("sanitizedPayload.ROW_KEY", GCL_PROJECTION_SCHEMA_ID)).toBe("sanitizedPayload");
    expect(structuralPathOnly("creates.0.frontmatter.ROW_KEY", KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID)).toBe(
      "creates.0.frontmatter",
    );
    expect(
      structuralPathOnly("/externalActionProposals/0/payload/ROW_KEY", KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID),
    ).toBe("/externalActionProposals/0/payload");
    expect(structuralPathOnly("proposedContent.ROW_KEY", GBRAIN_PROPOSED_FACT_SCHEMA_ID)).toBe("proposedContent");
    // the region-less schema keeps the identity cut, and an unknown id still fails closed
    expect(structuralPathOnly("kwRevision", SIGNED_PROVENANCE_STAMP_SCHEMA_ID)).toBe("kwRevision");
    expect(structuralPathOnly("anything", "sow:not-a-candidate" as never)).toBe(MAXIMAL_CUT);
  });

});
