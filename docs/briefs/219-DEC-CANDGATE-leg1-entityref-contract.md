# /tdd brief — entityref_contract_and_schema (§DEC-CANDGATE leg 1, contracts)

## Feature

Give `EntityRef` (and `EntityKind`) a **real definition and a real Zod schema in `packages/contracts`**, with the generated JSON Schema, the field-set snapshot, and registry membership — so the candidate-data gate the architecture sentence rests on can actually run on this type. This is **leg 1 of 3**; it is **contracts-only** by design.

## Use case + traceability

- **Task ID:** 13.18 (§DEC-CANDGATE leg 1 — contracts; legs 2–3 are knowledge, then worker)
- ⚠ **This brief widens phase scope because** the class-fix for a Phase-13-discovered defect lives in `packages/contracts` (§3), not in §13 — all four instances arose on the §13 synthesis path but the shape that produced them is a missing contract. Placement reasoning is recorded in tracker task 13.18.
- **Architecture sections it implements:** `ARCHITECTURE.md §3` (shared contracts — primary) · Appendix A (new model row) · **REQ-S-006** (provider/agent output is candidate data until it passes the schema gate) · `§16` (the REQ-S-006 home per Phase 1's anchor line)
- **Related context:** `IMPLEMENTATION_PLAN.md` §DEC-CANDGATE ledger · contracts **L57** (the `requiresApproval` Approvals bypass) · **L60** (attendee display-name shapes) · **L65** (the `kind`-indexes-an-object-literal prototype hole) · task 13.8h (the `entityRefs` fan-out cap)

### ⛔ Scheduling status — do NOT re-escalate this for approval

**Owner-APPROVED 2026-07-26** as a dedicated contract-first arc. Deferred 07-28 and again 07-29 (both rounds were scope-bounded, and no contract implementer was spawned). **This round is the scheduling GO, not a new crossing.** The arc's own sequencing — **contracts → knowledge → worker** — is why you are the opener. The original approval terms still bind: ⛔ **do NOT fold any part of this into an unrelated slice**; the risk the owner named is *a rushed half-gate that READS as coverage.*

### Why this is a class-fix, and what it costs to keep deferring

Four instances of one shape landed in a single round — a field crosses the model boundary and is then consumed as if a TypeScript annotation constrained it:

1. the uncapped model-supplied `candidate.entityRefs` fan-out (13.8h)
2. `requiresApproval` carried but enforced nowhere — the §9.8 Approvals bypass (**L57**)
3. attendee display-name shapes no validator rejected — two high-severity bugs in 13.8g-A (**L60**)
4. `kind` trusted enough to index an object literal — the prototype-chain fallback hole in 13.8j (**L65**)

Every fix so far closed an **instance**. `kind: EntityKind` is a **compile-time claim about runtime-untrusted data**, so instance five will look novel to whoever meets it.

## Premises — verified in source. Corrections 1–2 fix MY original assumptions; **correction 3 fixes a correction** (a premise-check over-generalized, and the brief said the opposite of the truth until it was re-verified). All three matter; correction 3 is the one that would have cost you a red `@sow/domain` suite.

**Where it lives today** — declared **once**, and not in contracts:
- `packages/knowledge/src/synthesis/entity-resolver.ts:29` — `export interface EntityRef`
- Barrel-exported: `packages/knowledge/src/index.ts:54` — `export * from "./synthesis/entity-resolver";`
- Confirmed: **zero occurrences in `packages/contracts/src`.**

**The shape** — `entity-resolver.ts:26-32`:
```ts
/** The entity classes the living-vault synthesis resolves (knowledge-local, not a frozen contract). */
export type EntityKind = "person" | "project" | "concept";

/** A referenced entity to ground: a display name + its class. */
export interface EntityRef {
  readonly name: string;
  readonly kind: EntityKind;
}
```

**The guard that does not cover it** — `packages/knowledge/src/synthesis/planner.ts:197-200` validates **only** `workspaceId` and `sourceRefs` (the four guard statements; `:196-203` is the try/catch wrapper). `entityRefs` is declared at `planner.ts:83`, consumed at `:220` → `collectEntities` (`:305-332`), and **never schema-validated**. Defended only ad hoc per call site (`eRef?.kind`, `resolution == null`, try/catch).

**Consumers** (leg 2's surface — listed so you can shape the schema for real use, not so you edit them): `.name` at `entity-resolver.ts:171-172`, `packages/evals/src/synthesis/corpus.ts:59,63` · `.kind` at `planner.ts:319`, `meeting-rewrite.ts:194`, `entity-resolver.ts:142,149` · **producers** at `attendee-refs.ts:242` (`{name, kind:"person"}`) plus test fixtures.

### ⛔ CORRECTION 1 — the gap is already CROSS-PACKAGE, which strengthens the case

I had framed this as a `packages/knowledge` internal problem. It is not. **`packages/evals/src/synthesis/corpus.ts:20` imports `EntityRef` from `@sow/knowledge`'s public barrel** and constructs/consumes it (`:58-59,63`). So an un-schema'd type is **already acting as a de facto cross-package contract with zero runtime validation anywhere on that path.** That is the class-fix argument in one line — put it in your Step-9.

### ⛔ CORRECTION 2 — the type's own comment is part of what this arc overturns

`entity-resolver.ts:26` says **"knowledge-local, not a frozen contract."** That self-description is not merely an absence of a schema — it is an **explicit claim that will become false** when this lands. ⚠ **Flag that line at Step 9. Do not edit it** (it is in knowledge — leg 2's territory, and not yours).

### ⛔⛔ CORRECTION 3 — L49 IS NOT STALE, AND `registry-all.test.ts` IS NOT SUFFICIENT. **Green-in-contracts ≠ done.**

⚠ **An earlier draft of this brief told you the opposite. It was wrong, and following it would have shipped exactly the half-frozen seam L49 exists to prevent.** Recorded rather than quietly fixed, because the failure mode is instructive: a premise-check searched only `packages/contracts/src` and `packages/contracts/test`, correctly found nothing, and **wrongly generalized "not in contracts" to "does not exist."** The symbols are real — they live **outside** `packages/contracts`, which is L49's entire point.

**Contracts L49** (`packages/contracts/LESSONS.md:523-527`) — *"A NEW Appendix-A model lands as the FULL set in ONE round"* — and every element of it resolves:

| L49 element | Where it actually lives |
|---|---|
| the 4-file ADR-008 set | `src/models/<kebab>.ts` · `schemas/<kebab>.schema.json` · `src/models/__snapshots__/<kebab>.snap` · `test/models/<kebab>.test.ts` |
| seam fixture | `packages/contracts/src/fixtures/valid.ts` **+** `src/fixtures/index.ts` |
| **`ZOD_BY_ID` registration** | ⛔ **`packages/domain/test/fixtures/fixtures.test.ts`** — a **different package** |
| **membership-guard rows** | ⛔ **`packages/contracts/test/primitives/shared.test.ts`** |
| dual-dialect derived rollup | only where the model has one — `EntityRef` almost certainly does not |

⛔ **THE TRAP L49 WAS WRITTEN TO CLOSE, verbatim from session doc 111:** *"Missing the fixture/`ZOD_BY_ID` breaks the **DOMAIN** seam-fixtures meta-test (**not** the contracts suite) — **green-in-contracts ≠ done.**"* So `packages/contracts` can be fully green while the seam is half-frozen and `packages/domain` is red. ⇒ **`registry-all.test.ts` passing is necessary and NOT sufficient. Run the `@sow/domain` suite too, and report both counts.**

⭐ **`packages/domain` IS your territory** — the contract implementer owns `contracts` **and** `domain` (root `CLAUDE.md` role table). So the `ZOD_BY_ID` edit is in-scope for you, not a cross-area escalation.

⛔ **CORRECTED 2026-07-29 — THIS CHECKLIST IS MANDATORY, NOT CONDITIONAL ON Q1. An earlier draft of this brief said it attached "only if `EntityRef` becomes an Appendix-A model." That was WRONG, found by the implementer and verified by the orchestrator in source.** `registry.ts`'s `loadSchemasFromDir()` is an unconditional `readdirSync` over `../../schemas` filtered to `*.schema.json`, and `packages/domain/test/fixtures/fixtures.test.ts:129` measures coverage against **`defaultSchemaRegistry.ids()`** — the glob — plus `ZOD_BY_ID[schemaId]` (`:107`) for the zod tier. ⇒ **the moment `schemas/entity-ref.schema.json` exists, the domain meta-test goes RED without the fixture + `ZOD_BY_ID` + membership row. Appendix-A status is irrelevant to the mechanism.** ⚠ **What misled me, and will mislead the next reader: that test is NAMED `"provides exactly one VALID fixture for every registered Appendix-A schema"` — the name asserts an Appendix-A filter its mechanism does not have.** Only the `ARCHITECTURE.md` Appendix-A prose row + `CLAUDE.md` mirror are genuinely Q1-conditional, and those are the orchestrator's. ⛔ Do not edit any `LESSONS.md` regardless — L49 needs no correction; if anything it has just been re-validated.

## The house pattern to follow (verified, two examples)

`packages/contracts/src/models/proposed-action.ts` and `models/task.ts` are the templates:

```ts
export const PROPOSED_ACTION_SCHEMA_ID = "sow:proposed-action" as const;   // :15
export interface ProposedAction { ... }                                    // :23-35
interface ProposedActionInput { ... }                                      // :37-44
export const ProposedActionSchema: z.ZodType<
  ProposedAction, z.ZodTypeDef, ProposedActionInput
> = z.object({ ... }).strict();                                            // :46-63
```

- **Naming:** `<Model>Schema` · `<MODEL_SNAKE>_SCHEMA_ID` = `"sow:<kebab>"`.
- **Hand-written `interface`, not bare `z.infer`** — dodges the TS4023 declaration-emit bug (contracts LESSONS #1). Applies only if a brand is involved; follow the house shape regardless.
- **Barrel:** flat `export *` per model file in `packages/contracts/src/index.ts` (`:47-48` for these two).
- **JSON Schema:** generated to `packages/contracts/schemas/<kebab>.schema.json` via `emitJsonSchema` (`src/schema/emit.ts:13`) — **never hand-written**.
- **Snapshot test:** `packages/contracts/test/models/<kebab>.test.ts`, snapshot at `src/models/__snapshots__/<kebab>.snap` (a sorted JSON array of top-level field names). Pattern at `test/models/proposed-action.test.ts:15-29` — `describe("ProposedAction contract — spec(§3/§8/§9)")`, then `fieldSet(emitJsonSchema(...))` vs `loadFieldSnapshot(...)`, then `freezeGenerated(...)`. Helpers in `test/_helpers/freeze.ts`.
- **`spec(§X)` tag** goes on the outer `describe` string.

## Acceptance criteria (what "done" means)

- [ ] `EntityKind` and `EntityRef` are defined in `packages/contracts` following the house pattern (id constant + hand-written interface + `.strict()` Zod schema)
- [ ] `EntityRefSchema` **rejects** each of: a non-string `name` · an empty/whitespace-only `name` · a `kind` outside the three members · a missing `kind` · a missing `name` · an unknown extra property (`.strict()`) · `null`/`undefined`/a non-object · an array
- [ ] ⭐ **`EntityRefSchema` rejects a `kind` of `"__proto__"`, `"constructor"`, and `"prototype"`** — the **L65** prototype-chain hole, closed at the schema rather than at the consumer that indexes on it
- [ ] `EntityRefSchema` **accepts** each of the three valid kinds with a valid name (non-vacuity — the schema discriminates, it does not reject everything)
- [ ] The generated `packages/contracts/schemas/entity-ref.schema.json` is checked in and frozen by `freezeGenerated`
- [ ] The top-level field-name set is frozen by a checked-in `__snapshots__` entry
- [ ] `registry-all.test.ts` passes — the new `*_SCHEMA_ID` resolves to exactly one compiled validator (it collects reflectively, so no hand-edited list)
- [ ] ⛔ **The FULL L49 checklist completes IN THIS ROUND — MANDATORY, not Q1-conditional (see correction 3)** — seam fixture in `src/fixtures/valid.ts` + `src/fixtures/index.ts`, **`ZOD_BY_ID` registration in `packages/domain/test/fixtures/fixtures.test.ts`**, and membership rows in `test/primitives/shared.test.ts`. **A partial round leaves a half-frozen seam.**
- [ ] ⛔ **The `@sow/domain` suite is GREEN and its count reported** — the seam-fixture meta-test lives there, so **green-in-contracts ≠ done** (session doc 111). This is the bullet most likely to be missed.
- [ ] The type + schema are exported from `packages/contracts/src/index.ts`
- [ ] `packages/contracts` still imports **nothing** downstream — the pure-root invariant holds (`package.json` deps stay `ajv`, `ajv-formats`, `zod`, `zod-to-json-schema`)
- [ ] `pnpm typecheck` + `pnpm test` clean across the repo — ⛔ **a contracts change ripples; run the repo-wide typecheck, not just this package**
- [ ] Appendix A row + the `packages/contracts/CLAUDE.md` mirror row — ⛔ **flagged at Step 9, written by the ORCHESTRATOR. Do not write them.**

⛔ **Do NOT write "lint clean."** `pnpm lint` IS `tsc --noEmit`; ESLint is not installed and no package defines `format:check`. Say **"typecheck + tests clean; no lint coverage exists."**

## ⛔ Scope boundary — this is leg 1 of 3, and the interim duplicate is DELIBERATE

**IN scope (leg 1, contracts):** define the type + schema + JSON Schema + snapshot + barrel export.

**OUT of scope (leg 2, knowledge):** re-pointing `entity-resolver.ts` to import from `@sow/contracts`, deleting the knowledge-local declaration, and **calling the schema at the `planSynthesis` boundary** (the actual runtime gate). **OUT of scope (leg 3, worker):** any worker-side consumption.

⚠ **So at the end of this slice, `EntityRef` will be declared in TWO places** (contracts + knowledge), structurally identical, with knowledge still compiling against its own. **That is a recorded interim, not an oversight** — the standing rule is *no cross-area single-implementer verticals*, and re-pointing knowledge is a knowledge-area edit. I will record leg 2's obligation in the plan.

⛔ **The honest framing for your Step-9: this slice closes NOTHING at runtime yet.** It creates the gate; leg 2 calls it. If you describe leg 1 as "the candidate-data gap is closed," that is precisely the *half-gate that reads as coverage* the owner warned about.

⚠ **The layer direction is confirmed compliant:** contracts is the pure DAG root (`packages/contracts/CLAUDE.md` Module organization + forbidden pattern #2; `package.json:24-29` has no internal deps), and knowledge already depends on contracts (`entity-resolver.ts:20-21`). Defining the type **in** contracts and having knowledge import it **from** contracts is the correct direction. The reverse would be the violation — and is not what this is.

## Wiring / entry point (Step 7.5)

**`none — the runtime gate lands in leg 2 (knowledge).`** This slice's reachability is the **schema registry**: `registry-all.test.ts` proves the schema is compiled and resolvable, and the barrel export makes it importable. ⚠ **State this explicitly at Step 7.5 rather than claiming a production call path** — there isn't one yet, and inventing one would be dishonest wiring.

## Files expected to touch

**New:**
- `packages/contracts/src/models/entity-ref.ts` — id constant, `EntityKind`, `EntityRef`, `EntityRefInput`, `EntityRefSchema`
- `packages/contracts/schemas/entity-ref.schema.json` — **generated**, checked in
- `packages/contracts/test/models/entity-ref.test.ts` — schema behavior + field-set snapshot + generated-schema freeze
- `packages/contracts/src/models/__snapshots__/entity-ref.snap` — generated field-set snapshot

**Modified:**
- `packages/contracts/src/index.ts` — `export * from "./models/entity-ref";`
- ⛔ **MANDATORY (NOT Q1-conditional — the registry glob forces it; see correction 3) — the L49 full-set obligations:**
  - `packages/contracts/src/fixtures/valid.ts` + `src/fixtures/index.ts` — the seam fixture
  - **`packages/domain/test/fixtures/fixtures.test.ts`** — the `ZOD_BY_ID` registration (**a different package — in YOUR territory, and where the meta-test that catches omission lives**)
  - `packages/contracts/test/primitives/shared.test.ts` — membership-guard rows


⛔ **Do NOT touch:** `packages/knowledge/**` · `packages/evals/**` · `apps/**` (⚠ note `packages/domain` is NOT on this list — it is yours) · `ARCHITECTURE.md` · `IMPLEMENTATION_PLAN.md` · any `LESSONS.md` · any `CLAUDE.md` · `docs/briefs/`. All either another area's territory or orchestrator territory.

## RED test outline (Step 2)

In `packages/contracts/test/models/entity-ref.test.ts`, mirroring `test/models/proposed-action.test.ts:15-29`. Outer `describe("EntityRef contract — spec(§2/§3)")` — ⚠ **confirm the right `§` set against the Spec Anchor Index before committing to it, and flag at Step 2.5 if §2/§3 is wrong.**

1. **`freezes_its_top_level_field_name_set`** — `fieldSet(emitJsonSchema(EntityRefSchema, ENTITY_REF_SCHEMA_ID))` vs `loadFieldSnapshot("entity-ref")`.
   - Why: Appendix-A cross-doc invariant; a silent field change is a cross-track Finding.

2. **`freezes_its_generated_json_schema`** — `freezeGenerated(new URL("../../schemas/entity-ref.schema.json", …), emitJsonSchema(…))`.
   - Why: house pattern; the JSON Schema is generated, never hand-edited.

3. **`accepts_each_valid_kind`** — all three of `person`/`project`/`concept` with a valid name.
   - Asserts: `.success === true` for each.
   - Why: **non-vacuity.** A schema that rejects everything would pass every negative test below.

4. **`rejects_a_kind_outside_the_union`** — `kind: "organization"`.
   - Asserts: `.success === false`.
   - Why: **L65** — `kind` reaching an object-literal index must be constrained at the gate.

5. **`rejects_prototype_chain_kinds`** ⭐ — `"__proto__"`, `"constructor"`, `"prototype"`.
   - Asserts: all three rejected.
   - Why: **L65** directly. `ENTITY_NAMESPACES.get(kind ?? "")` is a `Map` today (so `.get` is prototype-safe), but the lesson's whole point is that the *consumer* should not be the only thing standing between untrusted `kind` and a lookup. ⚠ **Note in-code that a `Map` lookup is already safe — so this pin is defense-in-depth against a future consumer switching to an object literal, not a live hole today.** Claiming otherwise would overstate it.

6. **`rejects_a_non_string_or_empty_name`** — `name: 42` · `""` · `"   "` · missing.
   - Asserts: each rejected.
   - Why: **L60** — attendee display-name shapes that no validator rejected caused two high-severity bugs. ⚠ **The whitespace-only case is a real design decision, not obvious** — see Q2.

7. **`rejects_unknown_properties`** — a valid ref plus `{ path: "index.md" }`.
   - Asserts: rejected by `.strict()`.
   - Why: ⭐ **The §ARM-RESEARCH residuals (13.8j/13.8k/13.8l) are all about a model-supplied `path` reaching a writer-owned surface.** A `.strict()` schema means a smuggled `path` on an `EntityRef` cannot arrive at all. Worth calling out in your Step-9 as a benefit this slice delivers beyond the four named instances.

8. **`rejects_non_objects`** — `null` · `undefined` · `"person"` · `[]` · `[{name,kind}]`.
   - Asserts: each rejected.
   - Why: totality; the array case matters because the field is `readonly EntityRef[]` and a caller could pass the array where the element is expected.

## Cross-doc invariant impact (implementer flags at Step 9; orchestrator writes the docs)

- **Model field changes:** ⭐ **a NEW model is added.** This is **additive** — no existing frozen model changes shape, so no existing consumer breaks. That is what makes leg 1 low-risk despite being a frozen-contract surface.
- **Orchestrator doc rows to write hot (I write these, not you):** the `ARCHITECTURE.md` **Appendix A** row (`| EntityRef | §3 | name, kind |`, ~`ARCHITECTURE.md:761-795`) · the mirror row in `packages/contracts/CLAUDE.md`'s cross-doc table · a `§3`/REQ-S-006 note that `EntityRef` is now a gated candidate type. ⛔ **No L49 correction is owed — L49 is CORRECT** (see correction 3); an earlier draft of this line said otherwise.
- **§2.5-seam model touched?** ⭐ **Yes — this BECOMES one.** The schema-snapshot test is therefore **mandatory in this same `/tdd` cycle** (tests 1 + 2), not a follow-up.

## Things to flag at Step 2.5

1. **Where should the schema's `§` anchor point, and is `EntityRef` an Appendix-A model or a lower-tier internal type?** It is currently self-described as *"knowledge-local, not a frozen contract."* Promoting it to Appendix A makes it a cross-track frozen contract — a real commitment. ⛔ **NARROWED 2026-07-29: Q1 no longer gates the L49 checklist** (that is mandatory regardless) — it decides ONLY the `ARCHITECTURE.md` Appendix-A prose row + its `CLAUDE.md` mirror, both orchestrator-written. **My default vote, and the RULING: YES, promote it and add the Appendix-A row** — the whole point of the arc is that this type crosses boundaries (and Correction 1 shows it already crosses into `packages/evals`), so a type that crosses tracks belongs in the inventory. ⚠ **But this is the most consequential judgment in the slice**: it constrains all three legs and every future change. If you think it should be a contracts-internal type without an Appendix-A row, argue it at Step 2.5 — I would rather resolve it now than have leg 2 discover it.

2. **Should the schema reject a whitespace-only `name`, and should it trim?** Options: (a) reject empty and whitespace-only, no trim; (b) reject empty only; (c) trim then reject empty. **My default vote: (a) — reject, never transform.** A name is used to derive `entitySlug(entityRef.name)` and `faithfulKey(entityRef.name)` (`entity-resolver.ts:171-172`), so a transforming schema would silently change a derived path/key — and a candidate-data gate should **reject or pass, never rewrite** (a schema that mutates its input is a second producer). Flag if you see a caller that depends on trimming.

3. **Should the schema bound `name` length?** Unbounded strings reach path derivation and GBrain reads. **My default vote: YES, a generous cap** (the existing UI-safe convention is ≤1024 for a single-line string — verify and reuse rather than inventing a number). Rationale: unbounded is how the uncapped-fan-out instance (13.8h) happened, one level up. ⚠ **Do NOT put the fan-out cap in the schema** — `MAX_MODEL_ENTITY_REFS = 200` (`planner.ts:152`) bounds the *array*, is a knowledge-layer concern, and already exists. This is a per-field length bound, a different thing. Say which you did.

4. **Is a source-level drift guard worth it for the interim duplicate?** At the end of leg 1, contracts and knowledge both declare `EntityRef`. A contracts-side test **cannot** import knowledge (layer violation), so a normal equality test is impossible. Options: (a) nothing — accept the interim, leg 2 deletes it; (b) a source-level assertion in contracts that reads knowledge's file as text and compares the shape. **My default vote: (a), nothing.** (b) would make contracts' test suite depend on another package's source layout, which is worse than the two-round duplicate it guards — and leg 2 is the very next leg. But **say so explicitly in-code** near the new type so a reader in between knows the duplicate is tracked.

5. **Do the other un-schema'd siblings in `entity-resolver.ts` belong in leg 1?** `EntityCandidate` (`:35-41`), `EntityReadFault` (`:44-46`), `WithheldReason` (`:59-70`), `EntityResolution` (`:76-79`) also have no schemas. **My default vote: NO — `EntityRef` only.** It is the one the four recorded instances actually run through, and the owner's stated risk is a rushed over-broad half-gate. ⚠ But **`EntityCandidate` deserves your assessment**, because 13.8k's residual is precisely *"`resolveEntity` returns `candidate.path` VERBATIM from the GBrain read"* — if a `path` field on `EntityCandidate` is the real live hole, that is a **finding worth reporting even though it is out of scope here.** Report it; do not expand into it.

## Dependencies + sequencing

- **Depends on:** nothing in code. Owner approval 2026-07-26 (already given; this is the scheduling go).
- **Blocks:** **leg 2 (knowledge** — re-point the import, delete the local declaration, call the schema at the `planSynthesis` boundary) → **leg 3 (worker)**. Also relevant to the §ARM-RESEARCH residuals 13.8j/13.8k/13.8l.

## Estimated commit count

**1.** One additive contracts slice: type + schema + generated JSON Schema + snapshot + barrel export. Cohesive, bisectable, one logical unit.

⚠ **It touches a frozen-contract surface**, so: its own commit, `security-reviewer` at **invariant** scope (this is the candidate-data gate REQ-S-006 rests on), `code-quality-reviewer` every-slice per project policy. ⛔ **Do not bundle anything else into it** — the owner's approval terms say so explicitly.

## Lessons-logged candidates anticipated

- **Convention candidate** — "A type consumed as if a TypeScript annotation constrained it is a compile-time claim about runtime-untrusted data. The fix belongs at the boundary schema, not at each consumer." (The arc's thesis; generalizes L57/L60/L65.)
- **Convention candidate** — "A candidate-data schema rejects or passes; it never rewrites. A trimming/coercing schema is a second producer."
- **Convention candidate** — "`.strict()` on a candidate model is a structural defense against smuggled fields (a model-supplied `path` cannot arrive at all), not just tidiness."
- **Architecture-doc note candidate** — `§2`/REQ-S-006: `EntityRef` is a gated candidate type; Appendix-A row added.
- **Future TODO — belongs to a phase** — legs 2 and 3, with leg 2 owning the duplicate-declaration deletion **and** the runtime gate call.

## How to invoke

1. **Read this brief end-to-end**, including "Things to flag at Step 2.5." Read `models/proposed-action.ts` + `test/models/proposed-action.test.ts` first — they are the template, and matching them exactly is most of the slice.
2. ⚠ **Verify the premises.** Corrections 1-2 fix my own assumptions (the cross-package leak, the type's self-description); **correction 3 retracts a correction** — a premise-check wrongly called L49 stale and this brief said so until it was re-verified. **L49 is correct.** **A brief that contradicts the code is a FINDING, not an instruction to follow carefully** — and on this slice the corrections have been the most valuable output so far.
3. **Run `/tdd entityref_contract_and_schema`.**
4. **Step 2.5** — send the test-design write-up: one `Asserts:` line per test **plus the coverage map** (each acceptance bullet → its covering test, or an explicit `not-tested-because:`). ⚠ **Q1 (Appendix-A promotion) must be settled at Step 2.5** — it changes what the round's doc rows are. Reply will be `APPROVED.` / `TWEAK:` / `ADD:`.
5. ⚠ **SHARED TREE — three implementers, one checkout.** Every commit, all three steps: `git diff --cached --name-only` **BEFORE** · chain `add && commit` in **ONE** invocation · `git show --stat` **AFTER**. Step 3 catches what 1–2 miss. Per-file `git add`; never `-A` or `.`. ⚠ **A contracts change ripples repo-wide — run `pnpm typecheck` at the ROOT before you commit, and report the package count.**
6. **Step 9** — categorized flags + ship-ask. Include: the Q1 decision, what you actually did for registry membership (**which L49 elements attached, per Q1**), the `entity-resolver.ts:26` comment that goes stale, and your `EntityCandidate`/13.8k assessment.

**Your session doc number is 132** — assigned by the orchestrator, not derived. Do not compute it yourself.
