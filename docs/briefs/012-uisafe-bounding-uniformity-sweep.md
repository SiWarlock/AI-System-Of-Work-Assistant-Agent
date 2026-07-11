# /tdd brief — uisafe_bounding_uniformity_sweep (finish the UI-safe token/title bounding convention — 2 remaining outliers)

## Feature
Finish the UI-safe display-field bounding convention started in slice 9.7-hardening: bind the **two remaining outlier fields** that are still unbounded `z.string().min(1)` while all their siblings are bounded. `UiSafeRecentChange.kind` → `uiSafeToken` (an open display token — "commit"/"sync" — matching the now-bounded `kind`/`type`/`status`/`sensitivity` tokens); `UiSafeDashboardCard.title` → `uiSafeSummaryLine` (a title — matching its siblings `UiSafeProjectDashboard.title`/`UiSafeManagedDoc.title`/`UiSafeCitation.title`, all already `uiSafeSummaryLine`). Defense-in-depth, validator-tighten only, no field-set change. Closes the codebase-wide UI-safe bounding convention (flagged at 9.7-hardening Step-9).

## Use case + traceability
- **Task ID:** 9.7 UI-safe hardening uniformity follow-up (origin: 2026-07-10 slice 9.7-hardening Step-9; carry-forward item d). Non-seam UI-safe contract hardening.
- **Architecture sections it implements:** `ARCHITECTURE.md §11` (Electron Desktop UI — the UI-safe read-surface family) + `§10` (Local App API — the read-model surface these project into) + the candidate-data/leakage discipline (safety rule 2 — bound/redact by TYPE at the boundary). Implementer confirms the §11 anchor at Step 0.
- **The MIRRORS (already in the file):** `uiSafeToken` (`ui-safe.ts` — the single-line max-64 token validator from 9.7-hardening, on `UiSafeDashboardCard.kind`/`.status`, `UiSafeIngestionItem.type`/`.sensitivity`, `UiSafeProjectDashboard.status`) and `uiSafeSummaryLine` (on `UiSafeProjectDashboard.title:402`, `UiSafeManagedDoc.title:356`, `UiSafeCitation.title:437`, plus every `summary`).
- **The 2 outliers to bind:** `UiSafeRecentChangeSchema.kind` (`ui-safe.ts:306`, `z.string().min(1)`) → `uiSafeToken`; `UiSafeDashboardCardSchema.title` (`ui-safe.ts:228`, `z.string().min(1)`) → `uiSafeSummaryLine`.

## Scope boundary (IN vs deferred)
- **IN (this slice):** the 2 validator swaps above + tests. Field NAMES/interfaces unchanged (only the Zod validators tighten).
- **DEFERRED (not this slice):** nothing outstanding — this closes the bounding convention. (If a future NEW UI-safe field lands unbounded, it's caught in that slice's own review, not here.)

## Acceptance criteria (what "done" means)
- [ ] `UiSafeRecentChangeSchema.kind` uses `uiSafeToken` (single-line, `.max(64)`, `.min(1)`); a multi-line / over-length / empty kind ⇒ rejected.
- [ ] `UiSafeDashboardCardSchema.title` uses `uiSafeSummaryLine` (matching its title siblings); a multi-line / over-length title ⇒ rejected.
- [ ] **No field-set change ⇒ the UI-safe freeze holds:** the allowlist + `_uiSafeParity` + the freeze tests stay green (field NAMES unchanged).
- [ ] **No legit-data regression:** every real producer/fixture value feeding `UiSafeRecentChange.kind` + `UiSafeDashboardCard.title` still validates (Step-0 grep; repo-wide gate is the backstop — titles already validate as `uiSafeSummaryLine` on the sibling types, kinds are short tokens).
- [ ] Repo-wide `turbo typecheck test` green (cross-package: contracts + worker + desktop + evals consumers).

## RED test outline (write cases first)
1. `recentchange_kind_rejects_multiline_overlength_empty` — a newline-bearing / >64 / empty `kind` ⇒ `UiSafeRecentChangeSchema.safeParse` FAILS.
2. `recentchange_kind_accepts_normal` — `"commit"`/`"sync"` ⇒ PASSES.
3. `dashboardcard_title_rejects_multiline_overlength` — a newline-bearing / over-length `title` ⇒ `UiSafeDashboardCardSchema.safeParse` FAILS (parity with the sibling titles).
4. `dashboardcard_title_accepts_normal` — a normal single-line title ⇒ PASSES.
5. `freeze_still_holds` — both schemas keep EXACTLY their prior field names (`.strict()`, validator-only change).
6. `existing_fixtures_still_valid` — representative recent-change / dashboard-card fixtures still validate under the tightened schemas.

## Cross-doc invariant impact
- **NONE.** Both types are non-seam (no Appendix-A row, no generated schema/snapshot, no ajv-registry, no cross-doc-table row). Validator-tighten within existing fields — field SET unchanged, so no snapshot/allowlist/parity change. Cross-PACKAGE ⇒ repo-wide gate, not a frozen-contract round.

## Things to flag at Step 2.5 (design questions — default votes)
1. **`kind` → `uiSafeToken` vs. `uiSafeSummaryLine`.** Default vote: `uiSafeToken` (a `kind` is an enum-like token — "commit"/"sync" — consistent with the other `kind`/`type` tokens bound in 9.7-hardening). Confirm.
2. **`title` → `uiSafeSummaryLine` (not `uiSafeToken`).** Default vote: `uiSafeSummaryLine` (a title is a prose-like single-line label, not a short token — matches the 3 sibling `title` fields; a 64-char token cap could truncate/reject a legit longer card title). Confirm (Step-0: check no card title exceeds the summary-line cap).

## Wiring / entry point (Step 7.5)
- **Entry point:** both fields are live on the mounted `query.recentChanges` / `query.dashboard` read-model queries — the tightened validators run at the existing boundary re-validation (`sanitize*`) + schema gate. No new entry point; reachable via the existing UI-safe query paths.
- **Blocks:** nothing. **Depends on:** the `uiSafeToken`/`uiSafeSummaryLine` validators (present since 9.7-hardening).

## Estimated commit count
**1.** The 2 validator swaps + tests. Cross-package ⇒ repo-wide gate. Tightens existing boundaries (not new) ⇒ Step-8 review OPTIONAL per policy — self-check reject multi-line/over-length + no legit-data regression.

## Lessons-logged candidates (implementer flags Step 9)
- None new — the redact/bound-by-TYPE principle is Lesson §5; this closes the convention its 9.7-hardening application opened. No new lesson expected.

## How to invoke (implementer)
1. `/tdd` against this brief. Step 0 — read the 2 field sites (`ui-safe.ts:306`, `:228`) + confirm (grep producers/fixtures) no legit `kind` exceeds 64 and no legit card `title` exceeds the summary-line cap.
2. Step 2.5 — ping Q1–Q2 (both are the validator-choice calls; Q2 title-cap must not regress) BEFORE writing cases.
3. RED first (reject multi-line/over-length/empty + accept-normal for both fields + freeze-still-holds + no-fixture-regression).
4. Step 8 — OPTIONAL per policy; self-check reject-multiline/overlength + no regression via the repo-wide gate.
5. Step 9 — categorized flags (should be empty — this closes the convention) + ship-ask. No cross-doc/frozen change.
