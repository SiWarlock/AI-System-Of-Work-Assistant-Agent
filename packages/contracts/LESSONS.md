<!--
  TEMPLATE: area LESSONS.md → write to <code-area>/LESSONS.md (one per code area).
  This file is EMPTY by design at bootstrap. Do NOT invent lessons. The header,
  the format block, and the "lessons start at §1" note are all that ship.
  Lessons accrete through /tdd Step 9 → orchestrator hot-routing. Delete this comment.
-->

# LESSONS.md — System of Work Assistant (shared contracts & domain)

> Full prose for every lesson logged during work in `packages/contracts/`. The compact index lives in `packages/contracts/CLAUDE.md` "Lessons logged" table.
>
> **Lesson numbers are stable IDs.** New lessons get the next sequential number. Numbers may be referenced from code comments, commit messages, and cross-references between lessons. **Don't reorder; don't reuse a deleted number's slot.**
>
> **Lessons start at §1.** Each code area has its own lesson sequence — lessons don't carry across code areas.

---

## Lesson format

```markdown
## <a id="N"></a>N. <Short topic> — <one-line rule>

**Date:** YYYY-MM-DD.
**Source slice:** <slice-id or commit hash>.

<2-5 paragraphs explaining: what was discovered, why it matters, how to
apply the rule, what edge cases are still open. Cite file:line references
where applicable.>

**Rule:** <one-sentence summary, same as the heading subtitle>.
```

---

## <a id="1"></a>1. Branded `z.infer` + `declaration: true` → TS4023 — use an explicit interface + `z.ZodType` annotation

**Date:** 2026-06-30.
**Source slice:** Phase-1 contract freeze (tasks 1.3–1.9), commits `512d731` / `4bdedf6`.

The shared branded IDs (`src/primitives/ids.ts`) carry their brand via a module-private `declare const __brand: unique symbol`. When a model's exported TypeScript type is derived with bare `export type X = z.infer<typeof XSchema>` and the schema embeds a branded field, the declaration emitter (`tsconfig` has `declaration: true`) must name `__brand` to write the `.d.ts` for `X` — but `__brand` is not exported, so `tsc` raises **TS4023 "… cannot be named"**. `--noEmit` still runs this check, so it fails the `pnpm typecheck` gate, not just a build.

The fix every branded model uses: declare an **explicit `interface X { … }`** (and an `interface XInput { … }` for the parse-input shape, since branded fields accept plain strings on input and the brand is applied on parse), then annotate the schema `export const XSchema: z.ZodType<X, z.ZodTypeDef, XInput> = z.object({…}).strict()…`. The nameable `X` sidesteps the emitter; `.strict()` unknown-key rejection and `.refine()` invariants are unaffected. For embedded sibling schemas, derive the input shape with `z.input<typeof SiblingSchema>` so the input interface stays in lockstep with the sibling's contract (see `knowledge-mutation-plan.ts`). `egress-policy.ts` is the canonical reference.

**Rule:** A model whose Zod schema embeds a branded ID must export an explicit `interface` + annotate the schema `z.ZodType<Out, ZodTypeDef, In>` — never rely on bare `z.infer` for the exported type.

## <a id="2"></a>2. Zod-as-source contract recipe (ADR-008) — generate the JSON Schema, freeze the field set, import shared shapes

**Date:** 2026-06-30.
**Source slice:** Phase-1 contract freeze (task 1.2 harness + 1.3–1.9), commit `8a42f13`.

Every frozen Appendix-A seam model is authored from **one** Zod schema and ships exactly four files: `src/models/<kebab>.ts` (the `.strict()` schema + `z.infer`/interface type + `X_SCHEMA_ID`), `schemas/<kebab>.schema.json` (the **generated** strict JSON Schema — `emitJsonSchema` via `zod-to-json-schema`, `additionalProperties:false`, never hand-written), `src/models/__snapshots__/<kebab>.snap` (the hand-authored top-level field-name set = the frozen spec), and `test/models/<kebab>.test.ts`. The test (a) freezes the field set against the `.snap`, (b) drift-guards the generated `schema.json` via `freezeGenerated`, (c) exercises valid/invalid fixtures + every `.refine`. The ajv-strict `defaultSchemaRegistry` globs `schemas/*.schema.json` by `$id`; `registry-all.test.ts` proves it compiles all + that every exported `*_SCHEMA_ID` resolves (REQ-S-006 coverage).

Two anti-drift disciplines are load-bearing: **(1)** shared sub-shapes (`ContextRef`, `SourceRef`, the KW mutation primitives, `CanonicalSourceRef`), shared enums, and branded-ID Zod schemas are authored **once** (`shared-shapes.ts` / `shared-enums.ts` / `zod-brands.ts`) and *imported* by composites — re-declaring one inline is the cross-track Finding the freeze exists to prevent. **(2)** `.refine()` conditional invariants are **not** expressible in the generated JSON Schema (`zod-to-json-schema` drops them), so they are enforced by Zod + the model's tests; the ajv gate stays structural (type/required/`additionalProperties`). Deeper cross-field validators are Phase-1 task 1.11. A field add/remove/rename must edit `ARCHITECTURE.md` Appendix A + the schema + the `.snap` in the same round.

**Rule:** Each Appendix-A model ships 4 files (`.ts`/`schemas/*.schema.json`/`__snapshots__/*.snap`/test); the JSON Schema is generated (never hand-written); import shared brands/enums/sub-shapes — never re-declare them inline.
