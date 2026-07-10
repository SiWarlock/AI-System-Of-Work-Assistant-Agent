# /tdd brief — region_marker_neutralization (Phase 6/9 hardening — shared region composers)

> **Step-0 corrections (2026-07-09, `3daa0c8`):** (1) the inner-body builders are `composeMeetingRegionBody` (`meetingOutputs.ts`) + `composeRegionBody` (`projectSyncOutputs.ts`) — NOT `noteSlug.ts` (which holds the WRAPPERS + the new shared `neutralizeRegionMarkers`); the fix spans 3 files. (2) There was NO prior fail-closed behavior to replace — the projections concatenated raw (the AC is "apply neutralization," and the slice closes a latent un-guarded forgery vector). (3) The neutralization MUST be applied at the INNER-body builders (the single source feeding create + the patch `newBody`), not the wrappers, or create/patch diverge + the patch re-introduces the marker.

## Feature
Harden the two region-body composers — `composeMeetingRegionBody` (`packages/workflows/src/activities/projections/noteSlug.ts`, this session) AND projectSync's `composeRegionBody` (same module) — to gracefully **neutralize any `kw:region` marker string embedded in the assistant CONTENT** before it is wrapped in the real region markers, replacing the current fail-closed-on-marker behavior. The load-bearing invariant: a content-embedded marker can NEVER forge or break a region boundary (so `applyRegionPatch`'s `indexOf(open)`/`indexOf(close)` boundary search only ever finds the REAL wrapping markers) — region-boundary integrity is preserved; the change only trades a fail-closed build refusal for a safe graceful degrade. Cross-cutting: ONE shared neutralization applied by both composers so they can't diverge.

## Use case + traceability
- **Task ID:** region-marker-neutralization (Phase 6/9 §6 hardening; the cross-cutting follow-up flagged at the meetingOutputs create-vs-patch Step-9 — carry-forward `(origin: 2026-07-09)`). Not a new plan `N.x` task — a hardening slice.
- **Architecture sections it implements:** `ARCHITECTURE.md §6` (KnowledgeWriter region-patch / human-section preservation — `applyRegionPatch` + the `<!-- kw:region:<id> -->` boundary markers) + safety rule **1**. Implementer confirms the §6 region-patch anchor at Step 0.
- **Related context:** `applyRegionPatch` (`packages/knowledge/src/knowledge-writer/writer.ts:495`) — the consumer whose `indexOf(open)`/`indexOf(close)` boundary search must not be confused by a content-embedded marker; `composeMeetingRegionBody` + `composeRegionBody` + `PROJECT_STATUS_REGION`/`MEETING_OUTPUTS_REGION` (`noteSlug.ts`); the current fail-closed behavior (the implementer confirms its exact form at Step 0 — Step-2.5 Q1).

## Acceptance criteria (what "done" means)
- [ ] A SHARED neutralization (one helper, applied by BOTH `composeMeetingRegionBody` and `composeRegionBody`) transforms any `<!-- kw:region:… -->` / `<!-- /kw:region:… -->` marker-shaped substring in the assistant content into a neutralized (non-marker) form, so the composed region body contains exactly ONE real open + one real close marker (the wrapping pair) — never a content-embedded one.
- [ ] **Region-boundary integrity (the safety pin):** given content that embeds a marker string (open, close, the region's own id, or a foreign region id), the composed note round-trips through `applyRegionPatch` such that a re-close/patch replaces exactly the intended region span — the content marker can NOT cause `indexOf` to select a wrong boundary (no over-/under-replacement, no human content outside the region touched). Assert via a compose→applyRegionPatch round-trip.
- [ ] **Graceful, not fail-closed:** content containing a marker string composes successfully (no `build_failed` / no throw) with the marker neutralized — replacing the prior fail-closed refusal (Step-2.5 Q1 confirms the prior behavior). If the prior behavior was NOT a hard refusal, this AC narrows to "the neutralization is applied" (implementer confirms at Step 0).
- [ ] **Idempotent + content-preserving:** neutralizing already-clean content is a no-op (byte-identical); neutralization is a visible, reversible-enough transform (does not silently delete content — it escapes/defuses the marker token, preserving the human-readable text). Confirm the exact transform at Step-2.5 Q2.
- [ ] **No frozen-contract / driver / KMP change:** a pure string-composition hardening in `noteSlug.ts`; no contract, schema, snapshot, or Appendix-A change. Cross-doc invariant = none.
- [ ] Both projectors' existing suites stay green (the meeting create-vs-patch + projectSync outputs tests); the new neutralization tests pin the boundary-integrity + graceful-degrade + idempotence properties.

## RED outline (write cases first)
1. `content_embedded_open_marker_neutralized` — content containing `<!-- kw:region:meeting-outputs -->` composes to a body with exactly one REAL open+close pair; the embedded one is neutralized.
2. `boundary_integrity_roundtrip` (SAFETY) — compose a note whose content embeds a marker, then `applyRegionPatch` a new region body ⇒ exactly the wrapping region span is replaced; no content outside the real markers is touched, no over/under-replacement (mirror the `project-sync-outputs`/`applyRegionPatch` test style).
3. `foreign_and_close_markers_neutralized` — content embedding a CLOSE marker and a FOREIGN region id are both neutralized (can't forge any boundary).
4. `clean_content_is_noop` — content with no marker string composes byte-identically to today (regression pin — the common path is unchanged).
5. `graceful_not_failclosed` — content with a marker string composes successfully (no throw / no build_failed), marker neutralized (per Step-2.5 Q1's confirmed prior behavior).
6. `both_composers_share_one_neutralization` — the meeting and project composers apply the SAME neutralization (assert via the shared helper / identical treatment of the same embedded marker), so they can't diverge.

## Cross-doc invariant impact
- **Model field changes:** **none** — pure string-composition hardening in `noteSlug.ts`; no contract / schema / snapshot / Appendix-A change.
- **Architecture-doc note candidate:** §6 region-patch prose may note that region composers neutralize content-embedded markers (boundary integrity by construction). Orchestrator-write, optional.

## Things to flag at Step 2.5 (design questions — default votes)
1. **Prior behavior + graceful target.** Default vote: confirm the current fail-closed form (build_failed / throw / silent) at Step 0; the target is a graceful NEUTRALIZE (compose succeeds, marker defused). If the current behavior is already graceful somewhere, narrow the AC accordingly. Confirm.
2. **Neutralization transform.** Default vote: defuse the marker token by breaking its recognizability to `applyRegionPatch`'s exact `<!-- kw:region:` / `<!-- /kw:region:` `indexOf` search (e.g. a zero-width / escaped insertion that a human still reads) — NOT deleting the content. Must be robust to open/close/own-id/foreign-id + case/whitespace variants that `applyRegionPatch` could match. Confirm the exact transform + that it can't be un-neutralized by a later composition.
3. **Shared-helper placement.** Default vote: one neutralization helper in `noteSlug.ts`, called by both composers (single authority — mirrors the `meetingNotePath` single-authority lesson). Confirm.

## Wiring / entry point / blocks
- **Entry point:** both composers are live — `composeMeetingRegionBody` via the meeting-closeout projection, `composeRegionBody` via projectSync — reachable through the live drivers. The neutralization is exercised whenever assistant content embeds a marker string. Note at Step 7.5.
- **Blocks:** nothing. Closes the shared marker-string-in-content region-integrity/robustness gap.
- **Depends on:** the shipped region composers + `applyRegionPatch` (all present).

## Estimated commit count
**1** (the shared neutralization + both composer call-sites + tests). Touches the KnowledgeWriter region-boundary integrity (§6 / safety rule 1) ⇒ Step-8 review MANDATORY (a content marker must not forge/break a boundary; the neutralization must be robust to every `applyRegionPatch`-matchable variant).

## Lessons-logged candidates (implementer flags Step 9)
- Possible: "a region-wrapped note composer must NEUTRALIZE any boundary-marker string embedded in the content (via a single shared helper both composers use) so a content-embedded marker can never forge/break a region boundary in `applyRegionPatch` — graceful-degrade the note, don't fail-closed, and never let the two composers diverge." Implementer's call.

## How to invoke (implementer)
1. `/tdd` against this brief. Step 0 — confirm the current fail-closed behavior of both composers + the §6 region-patch anchor + re-read `applyRegionPatch`'s exact boundary search.
2. Step 2.5 — ping Q1–Q3 (defaults above; Q2 the exact neutralization transform is load-bearing) BEFORE writing cases.
3. RED first (the boundary-integrity round-trip + the clean-content no-op regression are the load-bearing pins).
4. **Step 8 — MANDATORY adversarial review** (general-purpose Agent, security + code-quality): a content-embedded marker (open/close/own/foreign id, case/whitespace variants) must NOT forge or break a region boundary in `applyRegionPatch`; the neutralization must be robust + content-preserving + idempotent; the common (clean-content) path must be byte-unchanged.
5. Step 9 — categorized flags + ship-ask.
