# /tdd brief — call_the_candidate_gate (§DEC-CANDGATE leg 2, knowledge)

## Feature

Re-point `EntityRef` at the `packages/contracts` definition, delete the knowledge-local duplicate, and **run `EntityRefSchema` on model-supplied `entityRefs` at the `planSynthesis` boundary.** Leg 1 built the gate; **this is the leg that closes it.**

## Use case + traceability

- **Task ID:** 13.19 (§DEC-CANDGATE leg 2 of 3 — contracts → **knowledge** → worker)
- ⚠ **This brief widens phase scope because** it cites `§16`/REQ-S-006 for the same reason 13.18 did — the arc's anchors are the candidate-data gate, not §13. Placement per L92 (active phase + declared widening); reasoning recorded in tracker task 13.19.
- **Architecture sections it implements:** `ARCHITECTURE.md §6` (candidate gate) · **REQ-S-006** · `§16`
- **Related context:** task **13.18** (`93ebeabd`, leg 1) · contracts **L95** (the arc's thesis, banked from leg 1) · contracts L57/L60/L65 (the four instances) · task 13.8h (the fan-out cap)

## ⛔ Read this first: leg 1 deliberately closed nothing

Leg 1 shipped `EntityRef` + `EntityKind` + a `.strict()` `EntityRefSchema` into `packages/contracts` with the generated JSON Schema, snapshot, fixture, `ZOD_BY_ID` and membership row — **and no caller.** Its own commit says so. **A boundary schema with no caller closes nothing** (contracts L95).

**The gap this closes**, verified in source: `planSynthesis`'s input guard at **`planner.ts:197-200`** validates **only** `workspaceId` and `sourceRefs`. `candidate.entityRefs` is declared at **`planner.ts:83`**, consumed at **`:220`** via `collectEntities` (**`:305-332`**), and **never schema-validated**. So `kind: EntityKind` is a **compile-time claim about runtime-untrusted, model-supplied data**, defended only ad hoc per call site (`eRef?.kind`, `resolution == null`, try/catch).

## The exact surface

**What exists in contracts now** (`packages/contracts/src/models/entity-ref.ts`, verified):
- `ENTITY_REF_SCHEMA_ID = "sow:entity-ref"` (`:35`)
- `EntityKind` as a `const` tuple + `entityKindSchema = z.enum(EntityKind)` + `type EntityKind` (`:42-44`)
- `interface EntityRef` (`:50`) · `EntityRefSchema: z.ZodType<EntityRef, z.ZodTypeDef, EntityRefInput>` (`:63`), `.strict()`, `name: z.string().min(1).max(1024).refine(isNotBlank)` (`:72`)

**What knowledge has today:**
- `packages/knowledge/src/synthesis/entity-resolver.ts:26-32` — the duplicate `EntityKind` + `EntityRef`
- Barrel-exported at `packages/knowledge/src/index.ts:54`
- Importers: `planner.ts:46` · `meeting-rewrite.ts:47` · `attendee-refs.ts:35` · tests
- Consumers of the fields: `.name` at `entity-resolver.ts:171-172` · `.kind` at `planner.ts:319`, `meeting-rewrite.ts:194`, `entity-resolver.ts:142,149` · **producer** at `attendee-refs.ts:242` (`{name, kind:"person"}`)

## ⛔ TWO TRAPS — both verified, both will bite a naive swap

**TRAP 1 — a cross-package consumer in ANOTHER AREA'S territory.** `packages/evals/src/synthesis/corpus.ts:20` imports `EntityRef` **from the `@sow/knowledge` barrel** and constructs/consumes it (`:58-59,63`). ⇒ **Deleting the knowledge declaration without re-exporting breaks `packages/evals`, which is eval-security territory.**
⇒ **Re-export the contracts type from `packages/knowledge/src/index.ts`** so that import keeps resolving unchanged. ⛔ **Do NOT edit `packages/evals`** — not your area, and it needs no change if you re-export.

**TRAP 2 — the contracts type is LOOSER than the one you're deleting.** Knowledge's fields are `readonly`; **contracts' are not** — stated outright in `entity-ref.ts:7` (*"knowledge's fields are `readonly`; this one's aren't"*). ⇒ A naive swap **silently loosens immutability at every knowledge consumer.** Small, but it is a guarantee you'd be deleting without deciding to. **See Step-2.5 Q2** — I have a route to fix it contracts-side that costs you nothing.

## Acceptance criteria

- [ ] `entity-resolver.ts` imports `EntityRef`/`EntityKind` from `@sow/contracts`; the local declarations are **deleted**
- [ ] `packages/knowledge/src/index.ts` **re-exports** the type so `packages/evals`' barrel import resolves unchanged — **`packages/evals` is not touched and still compiles**
- [ ] ⭐ **`EntityRefSchema` runs on model-supplied `entityRefs` at the `planSynthesis` boundary** — a malformed ref (bad `kind`, blank/non-string `name`, unknown extra key like a smuggled `path`) is **rejected** rather than reaching `collectEntities`/`resolveEntity`
- [ ] ⭐ **A rejection is SURFACED, never silently dropped.** ⛔ The §ARM-RESEARCH residual **13.8m** exists because *"a poisoned-row attack is byte-identical to a benign empty run"* — validating and then dropping silently **recreates exactly that**. Emit a count/refusal on the existing channel (see Q3)
- [ ] The existing `MAX_MODEL_ENTITY_REFS = 200` fan-out cap (`planner.ts:152`, 13.8h) still applies, and `entityRefsTruncated` still discriminates a capped run from a benign one
- [ ] `entity-resolver.ts:26`'s now-false `"knowledge-local, not a frozen contract"` comment is **corrected** (it's yours this time — leg 1 flagged it and correctly left it)
- [ ] Validation happens **once at the boundary**, not per consumer — the point of the arc is a class-fix, not a fifth instance
- [ ] `@sow/knowledge` + `@sow/contracts` + `@sow/domain` + `@sow/evals` all green; repo-wide `pnpm typecheck` clean, **package count reported**
- [ ] ⛔ **"typecheck + tests clean; no lint coverage exists."** Never "lint clean."

## Wiring / entry point (Step 7.5)

`planSynthesis` (`packages/knowledge/src/synthesis/planner.ts`, the guard at `:197-200` → the `entityRefs` consumption at `:220`). This is a **real production path** — unlike leg 1, this slice is reachable. Name where the validation sits relative to the existing guard and the cap.

## Files expected to touch

**Modified:**
- `packages/knowledge/src/synthesis/entity-resolver.ts` — delete the duplicate; import from `@sow/contracts`; fix the `:26` comment
- `packages/knowledge/src/index.ts` — re-export the contracts type
- `packages/knowledge/src/synthesis/planner.ts` — the boundary validation + refusal surfacing
- `packages/knowledge/test/` — tests

⛔ **Do NOT touch:** `packages/evals/**` (eval-security) · `packages/contracts/**` (contract's — flag at Step 2.5 instead) · `apps/**` · `IMPLEMENTATION_PLAN.md` · `ARCHITECTURE.md` · any `LESSONS.md`/`CLAUDE.md` · `docs/briefs/`.

## RED test outline (Step 2)

1. **`malformed_entity_ref_is_rejected_at_the_boundary`** — `kind:"organization"`, blank `name`, `name:42`, and a smuggled `{path:"index.md"}`, each on a model-supplied ref.
   - Asserts: rejected; never reaches `resolveEntity`.
   - Why: REQ-S-006 / contracts L95. The slice.
2. **`a_rejected_ref_is_surfaced_not_silently_dropped`** ⭐ — one poisoned ref among valid ones.
   - Asserts: the run reports the refusal (count or equivalent) and is **distinguishable from a benign run with no refs**.
   - Why: **13.8m** — *a poisoned-row attack is byte-identical to a benign empty run.* Validating-then-dropping recreates it.
3. **`valid_refs_still_resolve_unchanged`** — the three valid kinds.
   - Asserts: identical behaviour to pre-slice.
   - Why: **non-vacuity** — proves the gate discriminates rather than rejecting everything.
4. **`the_fan_out_cap_still_applies_after_validation`** — >200 valid refs.
   - Asserts: capped at `MAX_MODEL_ENTITY_REFS`; `entityRefsTruncated` reports the drop.
   - Why: 13.8h. Validation must not bypass or double-count the cap.
5. **`validation_runs_once_at_the_boundary_not_per_consumer`** — spy/count schema invocations for a multi-ref candidate.
   - Asserts: bounded by the ref count, not multiplied by consumer count.
   - Why: the arc's thesis; a per-consumer gate is instance-fixing with extra steps.
6. **`evals_barrel_import_still_resolves`** — import `EntityRef` from `@sow/knowledge` the way `corpus.ts:20` does.
   - Asserts: it type-checks and is the contracts type.
   - Why: Trap 1 — a cross-area break must fail *here*, in your suite, not in theirs.
7. **`a_deterministic_caller_supplied_ref_is_unaffected`** — `attendee-refs.ts:242`'s `{name, kind:"person"}` path.
   - Asserts: unchanged.
   - Why: the gate targets **model-supplied** data; a deterministic producer shouldn't newly fail. ⚠ If it *does*, that's a finding worth reporting, not a test to loosen.

## Cross-doc invariant impact

- **Model field changes:** none — you consume leg 1's model. ⚠ **If Q2 concludes contracts should gain `readonly`, that is a contracts change → `contract-implementer`, not you.** Flag it; I'll sequence it.
- **Orchestrator doc rows:** an `ARCHITECTURE.md §6`/REQ-S-006 note that the gate is now called. Mine.

## Things to flag at Step 2.5

1. **Where exactly does validation sit — inside the existing `:196-203` try/catch guard, or as a separate pass before `collectEntities`?** **My default vote: extend the existing guard block** — it already owns "unusable input ⇒ typed err" and adding a third check keeps one place responsible. ⚠ But `entityRefs` is *optional* and a bad ref shouldn't necessarily fail the whole plan the way a bad `workspaceId` does — which is really Q3.
2. **The `readonly` mismatch (Trap 2).** (a) Accept the loosening. (b) Have knowledge re-export a `Readonly<EntityRef>` alias. (c) **Ask contracts to add `readonly`** — additive, compile-time only, no schema or JSON-Schema change. **My default vote: (c)** — it's the honest fix and `contract-implementer` is working in that package right now on 13.20, so I can bundle it at near-zero cost. **Flag it and I'll route it**; don't work around it silently.
3. ⛔ **What happens to a plan containing one bad ref among good ones — reject the whole plan, or drop the ref and report?** This is the real design question. **My default vote: drop the invalid ref, keep the plan, and REPORT the refusal** — a single malformed model-supplied ref shouldn't destroy an otherwise-valid synthesis, but it must not vanish either (see 13.8m). ⚠ **Whatever you choose, the reporting half is non-negotiable.** If the honest answer is that no refusal channel exists on this path yet, **say so** — that's 13.8m/#43's shape and a finding, not something to invent quietly.
4. **Does `EntityKind`'s change from a bare union to a `const` tuple + `z.infer` break any knowledge consumer?** **My default vote: no** — `z.infer<z.enum<[...]>>` is the same union type. Confirm by typecheck rather than by reasoning.

## Dependencies + sequencing

- **Depends on:** **13.18 ✅ `93ebeabd`** (landed).
- **Blocks:** **leg 3 (worker)** — and it is what makes the arc's cost (four instance-fixes for one shape) stop accruing.

## Estimated commit count

**1.** One slice: re-point + delete + gate + surface. Cohesive.

⚠ **Safety-relevant** — this is the REQ-S-006 candidate-data gate the architecture sentence rests on. `security-reviewer` at **invariant** scope, `code-quality-reviewer` every-slice. ⛔ **If you find yourself changing what reaches Markdown or a writer-owned surface, STOP** — that's beyond leg 2 and needs routing.

## Lessons-logged candidates anticipated

- **Convention candidate** — "Deleting a duplicated type requires re-exporting it wherever a *barrel* consumer depends on the old home; check importers of the barrel, not just of the file."
- **Convention candidate** — "A boundary gate that validates and then silently drops is a poisoned-row attack rendered byte-identical to a benign run. The refusal is half the gate."
- **Architecture-doc note candidate** — `§6`/REQ-S-006: model-supplied `entityRefs` are schema-gated at `planSynthesis`.

## How to invoke

1. Read this brief end-to-end, **especially the two traps** — both are verified and both break something outside your suite.
2. ⚠ **Verify the premises.** Every `file:line` is a claim from a read. **A brief that contradicts the code is a FINDING** — five premise corrections have come back to me this round and every one improved the work. Two of them came from the implementer who did leg 1.
3. **Run `/tdd call_the_candidate_gate`.**
4. **Step 2.5** — write-up with one `Asserts:` per test + the coverage map. **Q3 must be settled there.**
5. ⚠ **SHARED TREE** — `git diff --cached --name-only` BEFORE · chain `add && commit` in ONE invocation · `git show --stat` AFTER. Per-file adds only.
6. **Step 9** — categorized flags + ship-ask.

**Your session doc number is 133** — orchestrator-assigned. Do not compute it.
