# Session 082 — 15.2 SourceEnvelope `+body` field (contract-track)

- **Date:** 2026-07-15
- **Phase:** Part II · Phase 15 (Ingestion-Spine Plumbing, §19.2) — contract-track slice
- **Team:** `session-734f946b` — orch (orch22 → cycled → orch23) + contract-impl (this session) + worker-impl2 + desktop-impl; on `main`
- **Predecessor session:** [081-2026-07-15-worker-impl-phase14-worker-foundation.md](081-2026-07-15-worker-impl-phase14-worker-foundation.md)
- **Successor session:** [083-2026-07-15-worker-impl2-phase14-15-spine.md](083-2026-07-15-worker-impl2-phase14-15-spine.md) _(then contract-impl shuts down after round close; re-spawned for the next contract/domain slice)_
- **Commit:** `a6495293` — `feat(contracts): 15.2 thread source content via SourceEnvelope +body field`
- **Brief:** `docs/briefs/094-15.2-source-envelope-body-field.md` (spec-lint PASS @f555ff99)

## Why this session existed

The ingestion spine registers a `SourceEnvelope` that carries only `contentHash` — the file/OSB extractor reads the real source text, hashes it, then **discards** the text. So nothing downstream can build a real note; ingested notes commit the `"source ingestion (C1)"` placeholder body. 15.2 is the **contract half** of the fix: extend the frozen `SourceEnvelope` seam with the extracted text so 15.3's note-body projection can build a real note from the validated extraction. **Closes G2** (of the flagship spine G-chain).

## What was built

**Files modified (all `packages/contracts/`, one slice commit `a6495293`):**
- `src/models/source-envelope.ts` — added `body?: string` to the `SourceEnvelope` interface + `SourceEnvelopeInput`, and `body: z.string().optional()` to `SourceEnvelopeSchema` (`.strict()` preserved; `z.ZodType<SourceEnvelope, ZodTypeDef, SourceEnvelopeInput>` annotation still valid — `body?` on both Out and In). Field carries a doc comment: candidate data, redaction is the consumer's job (15.3+), opaque format, optional (Lesson 15).
- `schemas/source-envelope.schema.json` — regenerated via `emitJsonSchema` (`UPDATE_SNAP=1`): `body` under `properties` (`type: string`, no `minLength`), **NOT** in `required`; `additionalProperties: false` preserved.
- `src/models/__snapshots__/source-envelope.snap` — hand-edited top-level field-set now includes `"body"` (sorted → first).
- `test/models/source-envelope.test.ts` — +6 contract tests under `describe("15.2 — additive body field")`: accepts-body (+ roundtrip), accepts-empty-body, validates-without-body (+ `body===undefined` + `body ∉ required`), freezes-body-into-snapshot, no-leak-through-`UiSafeIngestionItem`, gate-validates-non-string-rejected.

**Doc rows written HOT by the orchestrator (working tree, uncommitted — ride the round commit):**
- `ARCHITECTURE.md` Appendix-A `SourceEnvelope` row → `…routingHints, body?` (candidate extracted text; §19.2/§8).
- `packages/contracts/CLAUDE.md` cross-doc table `SourceEnvelope` row → same.

## Decisions made

1. **`body` OPTIONAL (`body?: string`), not required** — Lesson 15. A required field would drop every source registered before a producer emits `body` (nothing does yet). The required gate lands **with** its producer/consumer in 15.3. Pinned by the `validates-without-body` + `body ∉ required` test (guards against a wrong required-body impl).
2. **Format OPAQUE — `z.string().optional()`, no `.min(1)`/`.max()`** — an empty extraction is a valid state and long-form transcripts are valid; the producer / 15.3 defines any tighter constraint (avoid a re-freeze — Lesson 15). Empty-string body explicitly accepted (test).
3. **`body` is candidate-data gated, not trusted-through** — `.string()` rejects a non-string; ajv `additionalProperties:false` still rejects unknown keys. Pinned by the non-string-rejected test.
4. **No embedder leak via explicit field-PICK** — the only projection FROM `SourceEnvelope` in contracts, `UiSafeIngestionItem` (`src/api/ui-safe.ts`), is an **independent hand-authored `.strict()` field-PICK** (`sourceId/type/sensitivity/summary`), NOT a spread/`.extend`/`.merge` of `SourceEnvelopeSchema` (verified: zero such usages repo-wide). Pinned non-vacuously (allowlist lacks `body` + schema strict-rejects a `body` key).
5. **Two code-quality low fixes applied** — trimmed the duplicated `body` interface doc comment (cross-ref the schema-side comment); added a `body===undefined` output assertion to the without-body test (strengthens the optionality pin at runtime).

## Decisions explicitly NOT made (deferred)

- **Producer threading** (`file-source.ts` / extractors stop discarding text → set `body`) — worker/integrations slices (15.3 + extractor slices). This slice defines the field + gate only.
- **Consumer / note-body projection** consuming `validated.value.body` — worker slice **15.3** (kills the `"source ingestion (C1)"` placeholder).
- **Redaction / log-sink enforcement over `body`** (raw within-workspace content, rule 7) — the **consumer's** obligation (15.3+); the security review flagged it informationally so 15.3 inherits the redact-by-type (Lesson 5) + length-bound requirement. Documented in-code.
- **Any `body` length/content bound** — deliberately omitted (opaque); the producer/15.3 tightens if needed.

## TDD compliance

**Clean.** RED confirmed first — 3 genuine failures for the right reasons (accepts-body & accepts-empty-body: `.strict()` rejected `body`; freezes-snapshot: old `.snap` lacked `body`), with 3 wrong-impl guard tests + the 2 co-frozen ADR-008 drift guards (exact field-set + `freezeGenerated` schema.json) going RED on the model edit until regen. GREEN after the model + schema + snap moved together. The two review-driven fixes were a comment trim (no behavior) + a strengthening assertion on an already-approved test (not new untested code) — no TDD violation.

## Reachability

- **`SourceEnvelope.body`** — ships **DORMANT** (Lesson 15). Reachable via the exported `SourceEnvelopeSchema` (registered in the schema registry; embedded by the `@sow/integrations` `registerSource` gate + `@sow/workflows` `sourceIngestion`/`ingestionTriage` ports). No producer sets it and no consumer reads it yet — **by design**: producer = 15.3/file-source, consumer = 15.3 note-body projection. A contract field is not a callable symbol; it flows through the already-reachable exported schema. No unwired-symbol gap.

## Open follow-ups

- **[Cross-doc invariant change — DONE hot]** `SourceEnvelope +body?` mirrored in `ARCHITECTURE.md` Appendix-A + `packages/contracts/CLAUDE.md` (orchestrator, working tree; lands in the round commit). Nothing left for contract-impl.
- **[Convention candidate — for orch `/orchestrate-end`]** "additive candidate field through a frozen seam": OPTIONAL + additive + gate-validated (string-if-present) + no-embedder-leak via explicit field-PICK, producer/consumer gate lands separately (Lesson 15 in action). Candidate for a contracts lesson.
- **[Downstream requirement — 15.3+]** the note-body consumer MUST redact `body` by-type (Lesson 5) + bound its length before any log sink / render (rule 7). Security-review informational note; captured so it isn't dropped when the required gate composes with the producer.

## How to use what was built

15.3 (worker-impl2) reads `validated.value.body` off the schema-gated `SourceEnvelope` to project the note body/frontmatter (replacing the `"source ingestion (C1)"` placeholder) — degrading gracefully when `body` is absent (dormant sources) — and MUST apply redaction/length-bounding at that consumer.
