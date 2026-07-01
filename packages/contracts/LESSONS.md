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

## <a id="3"></a>3. The ajv `validate()` gate is structural-only — the candidate-data gate is a composition

**Date:** 2026-06-30.
**Source slice:** Phase-1 task 1.15 fixtures meta-test (commit `a039e86`); surfaced by the domain-layer consistency critic.

`zod-to-json-schema` (ADR-008) silently **drops `.refine`/`.superRefine`** — a Zod conditional invariant does not appear in the generated JSON Schema. So `validate(output, schemaId)` (the 1.2 ajv gate, REQ-S-006) checks only structure (types, required, `additionalProperties:false`) and **admits cross-field-invariant violations**: a `read_only` ToolPolicy with `allowsMutating:true` (ING-7 / safety rule 6), an unsourced `KnowledgeMutationPlan` (REQ-F-006 / safety rules 1 & 2), an EgressPolicy acknowledged without `acknowledgedAt` (safety rule 5), a `ParityReport` `cleanForServing` carrying a HARD divergence (§12 fail-closed). The 1.15 fixtures meta-test had to use a **full ajv+Zod biconditional** (the literal "validate() ok iff valid" was unsatisfiable for refine-only invalid fixtures), which is what exposed this.

Consequence — the candidate-data gate (safety rule 2) is a **composition**, never ajv alone: ajv `validate()` (structural) **+** the model's Zod `parse` (cross-field refines) **+** the §3 universal rules (`universal-rules.ts` + `no-inference.ts`) **+** the §5/§6/§7 predicates (egress veto, ING-7 admission, GCL visibility). Every §9 meeting validator, §5 admission gate, and §7 broker MUST run the full composition before any side effect. Treating the ajv gate as the whole gate is a reviewer-rejection condition (EVALUATION_CRITERIA).

**Rule:** Never treat the ajv `validate()` structural gate as the complete candidate-data gate — compose it with the model's Zod parse + the §3 universal rules + the §5/§6/§7 predicates.

## <a id="4"></a>4. A security predicate parsing an untrusted URL/endpoint must isolate the authority BEFORE extracting userinfo/host

**Date:** 2026-07-01.
**Source slice:** Phase-3 §5 egress veto (`packages/policy`, task 3.4); found by the adversarial-verify pass, fixed in commit `bc18914`.

The Employer-Work egress veto (safety rule 5) trusts `isLoopbackEndpoint(endpoint)` as PROOF that a route claiming `egressClass:'local'` truly cannot leave the machine. The first-pass hand-rolled `extractHost` stripped URL **userinfo** (`lastIndexOf('@')`) BEFORE stripping the path/query/fragment. URL grammar only allows userinfo inside the **authority** (before the first `/ ? #`); any `@` after that is path/query/fragment, NOT userinfo. So `http://evil.com/@127.0.0.1` (real host `evil.com`) was parsed as host `127.0.0.1` → `isLoopbackEndpoint`=true → `processorOfRoute`=null (non-egress) → the veto ALLOWED raw Employer-Work content to egress to an arbitrary remote host with the acknowledgment OFF. Every standard HTTP client connects to `evil.com` for that URL. The same worked via path/query/fragment/backslash/scheme-less variants; a remote-authority `file://evil.com/…` / `unix://evil.com/…` was likewise mis-classed local.

Fix: **isolate the authority first** — strip path/query/fragment (and backslash, a WHATWG special-scheme path separator) to get the authority segment, THEN take the last `@` within it, THEN the host. For `file:`/`unix:` inspect the authority (`file:///path` is local; `file://host/…` must have a loopback host). Harden the classifier to treat a null/neither-key/both-key route as EGRESS, never non-egress.

Two meta-lessons: **(a)** for any loopback/SSRF/allowlist decision, prefer isolating the URL authority component explicitly (or a vetted URL parser) over a linear strip-in-sequence — order of stripping is a security boundary. **(b) Green unit tests ≠ a safe security gate.** 134 unit tests passed; the CRITICAL bypass was found only by an **adversarial-verify** stage (independent skeptics prompted to REFUTE the invariant, each constructing a concrete bypass input). Run that stage on safety-critical predicates; encode every found bypass as a regression test (`packages/policy/test/adversarial-regressions.test.ts`).

**Rule:** A security predicate that parses an untrusted URL/endpoint must isolate the authority (strip path/query/fragment + backslash) before extracting userinfo/host — stripping userinfo first is loopback/SSRF-spoofable — and must be gated by an adversarial-verify pass, not unit tests alone.
