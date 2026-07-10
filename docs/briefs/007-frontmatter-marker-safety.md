# /tdd brief — frontmatter_marker_safety (Phase 6/9 hardening — extends region-marker neutralization to frontmatter)

## Feature
Neutralize `kw:region` marker strings in the MODEL-DERIVED frontmatter values that the meeting-closeout + projectSync projections compose (meeting title / decisions / attendees; project title), reusing the shipped `neutralizeRegionMarkers` (`noteSlug.ts`, `3daa0c8`), so a marker-valued frontmatter field can never inject a spurious region into `parseSections` — which scans `MARKER_RE` over the WHOLE note (frontmatter included) inside `checkOwnership`/`enforceHumanOwnership`. Completes the region-marker threat model surfaced at the round-2 Step-9 review: today a legit note whose model-derived title/decision text contains a marker-shaped substring gets its KnowledgeWriter commit REJECTED fail-closed (a spurious write failure); this makes it a graceful no-op while preserving boundary integrity.

## Use case + traceability
- **Task ID:** frontmatter-marker-safety (Phase 6/9 §6 hardening; the out-of-slice FINDING from the region-marker Step-9 review — Carry-forward `(origin: 2026-07-10)`). Not a new plan `N.x` task — a hardening follow-up.
- **Architecture sections it implements:** `ARCHITECTURE.md §6` (KnowledgeWriter ownership / human-section preservation / region-boundary integrity — `checkOwnership` + `parseSections`) + safety rule **1**. Implementer confirms the §6 ownership anchor at Step 0.
- **Related context:** `checkOwnership`/`enforceHumanOwnership` (`packages/knowledge/src/knowledge-writer/ownership.ts:62`) — runs `parseSections(nextContent)` over the FULL note (incl. frontmatter) and rejects `malformed_marker` (nested/unexpected-close/mismatched-close/duplicate-region-id); `parseSections` (`markdown-vault/sections.ts:86`) scans `MARKER_RE` over the whole content; the shipped `neutralizeRegionMarkers` (`noteSlug.ts`, fixpoint escape — the transform to REUSE); `serializeScalar` (the YAML-quote codec that does NOT strip `<!--`); the model-derived frontmatter composition sites in `meetingOutputs.ts` + `projectSyncOutputs.ts` (confirm exact sites at Step 0).

## Scope boundary (IN vs out)
- **IN:** neutralization of the MODEL-DERIVED (untrusted, extraction/model-sourced) frontmatter values the two projections write — meeting title/decisions/attendees, project title — reusing `neutralizeRegionMarkers`. Mirrors the region-body fix (neutralize untrusted content at its source).
- **OUT (do NOT touch):** human-authored frontmatter (checkOwnership's job is to PROTECT human content, not rewrite it — a human deliberately placing a marker in their own frontmatter is a separate concern, not this slice); `serializeScalar`'s general contract for non-frontmatter callers (unless Step-2.5 Q1 picks the marker-safe-serializer option scoped to these notes).

## Acceptance criteria (what "done" means)
- [ ] Each model-derived frontmatter value the two projections compose (meeting title/decisions/attendees; project title) passes through `neutralizeRegionMarkers` before serialization, so no `<!-- kw:region:… -->` substring survives into the composed frontmatter.
- [ ] **Boundary integrity (the safety pin):** a note whose model-derived frontmatter value embeds a marker string (open/close/own-id/foreign-id, ws/case variants) composes to a note where `parseSections` sees EXACTLY the intended real body region(s) and ZERO spurious frontmatter region ⇒ `checkOwnership` does NOT reject it as `malformed_marker`. Assert via `parseSections` over the composed note + a `checkOwnership` create/patch that passes.
- [ ] **Graceful, not fail-closed:** a marker-valued model-derived frontmatter field composes + writes successfully (no `malformed_marker` rejection, no throw) — replacing today's spurious fail-closed rejection.
- [ ] **Clean values unchanged (regression pin):** a frontmatter value with no marker string composes byte-identically to today (common path unchanged); neutralization is idempotent + content-preserving (single escape char, no deletion).
- [ ] **Human frontmatter untouched:** the fix applies ONLY to the model-derived values the projections write — it does not rewrite human-authored frontmatter or human body content.
- [ ] **No frozen-contract / driver / KMP change:** reuses `neutralizeRegionMarkers`; pure string hardening at the composition sites. Cross-doc invariant = none.

## RED outline (write cases first)
1. `frontmatter_open_marker_neutralized` — a model-derived title/decision embedding `<!-- kw:region:x -->` ⇒ composed frontmatter has no exact marker; `parseSections` over the whole note ⇒ zero spurious frontmatter region.
2. `checkownership_passes_with_marker_valued_frontmatter` (SAFETY) — create AND patch of a note whose model-derived frontmatter embeds a marker ⇒ `checkOwnership` returns ok (no `malformed_marker`); the real body region(s) parse exactly as intended.
3. `close_and_foreign_markers_neutralized` — close + foreign-id markers in a frontmatter value are neutralized.
4. `clean_frontmatter_byte_identical` — a marker-free frontmatter value composes byte-identically to today (regression pin).
5. `human_frontmatter_and_body_untouched` — human-authored frontmatter / body content is not rewritten by the fix.
6. `graceful_not_failclosed` — a marker-valued model-derived field writes successfully (no rejection / no throw); idempotent re-run.

## Cross-doc invariant impact
- **Model field changes:** **none** — reuses `neutralizeRegionMarkers`; pure string hardening at the frontmatter composition sites. No contract / schema / snapshot / Appendix-A change.
- **Architecture-doc note candidate:** §6 ownership prose may note that model-derived frontmatter values are marker-neutralized (boundary integrity extends to frontmatter). Orchestrator-write, optional.

## Things to flag at Step 2.5 (design questions — default votes)
1. **Neutralization site.** Default vote: apply `neutralizeRegionMarkers` per model-derived value at the composition sites in `meetingOutputs.ts` + `projectSyncOutputs.ts` (targeted; leaves `serializeScalar`'s general contract + human frontmatter untouched). Alternatives: a marker-safe `serializeScalar` (broader — verify no other caller relies on raw passthrough) OR a frontmatter-block-level neutralization. Confirm the exact model-derived value set at Step 0.
2. **Scope = model-derived only.** Default vote: neutralize ONLY the projection's model-derived values, NOT human-authored frontmatter (which checkOwnership protects). Confirm no model-derived value is missed (each field sourced from extraction/model output).
3. **Reuse the shipped helper.** Default vote: reuse `neutralizeRegionMarkers` verbatim (single authority — same fixpoint/linear-regex guarantees); do NOT fork a second neutralizer.

## Wiring / entry point / blocks
- **Entry point:** both projections are LIVE (meeting-closeout + projectSync drivers); the neutralization is exercised whenever a model-derived frontmatter value embeds a marker string. Note at Step 7.5.
- **Blocks:** nothing. Closes the frontmatter half of the region-marker threat model (drains the Carry-forward finding).
- **Depends on:** `neutralizeRegionMarkers` (shipped `3daa0c8`) + the projection frontmatter composition (present).

## Estimated commit count
**1** (neutralize the model-derived frontmatter values at the composition sites + tests). Touches the KnowledgeWriter ownership/region-boundary integrity (§6 / safety rule 1) ⇒ Step-8 review MANDATORY (a marker in a model-derived frontmatter value must never form a `parseSections` region; human content untouched; clean values byte-identical).

## Lessons-logged candidates (implementer flags Step 9)
- Likely none new — folds into lesson 9 (neutralize untrusted markers at the source; the threat model includes frontmatter, not just region bodies). Implementer flags if a distinct rule emerges.

## How to invoke (implementer)
1. `/tdd` against this brief. Step 0 — confirm the model-derived frontmatter value set + composition sites in `meetingOutputs.ts`/`projectSyncOutputs.ts` + re-read `checkOwnership`/`parseSections`.
2. Step 2.5 — ping Q1–Q3 (defaults above; Q1 the neutralization site + Q2 model-derived-only scope are load-bearing) BEFORE writing cases.
3. RED first (the `checkOwnership`-passes-with-marker-valued-frontmatter safety pin + the clean-value byte-identical regression are load-bearing).
4. **Step 8 — MANDATORY adversarial review** (general-purpose Agent, security + code-quality): a marker (any variant) in a model-derived frontmatter value must NOT form a `parseSections` region or trip `checkOwnership`; human frontmatter/body untouched; clean values byte-identical; reuse of `neutralizeRegionMarkers` is verbatim (no weaker fork).
5. Step 9 — categorized flags + ship-ask.
