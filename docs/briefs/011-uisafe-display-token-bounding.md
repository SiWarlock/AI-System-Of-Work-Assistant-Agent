# /tdd brief — uisafe_display_token_bounding (UI-safe hardening — bound the open display tokens to a single-line length-capped token, defense-in-depth across the UI-safe family)

## Feature
Tighten the open display-token fields across the UI-safe projection family from unbounded `z.string().min(1)` to a **single-line, length-capped `uiSafeToken`** validator (redact-by-TYPE, mirroring `uiSafeSummaryLine`). Content-derived fields are already dropped by the projectors, so there is **no active leak** — this is **defense-in-depth**: the CONTRACT itself now rejects a multi-line / over-length token, closing a UI-injection / display-bloat vector at the boundary rather than relying on producers to stay well-behaved. Codebase-wide UI-safe convention slice (the security-reviewer's LOW from 9.7-B, routed to do as ONE convention slice, not per-field).

## Use case + traceability
- **Task ID:** 9.7 UI-safe hardening follow-up (origin: 2026-07-10 slice 9.7-B Step-9 security-reviewer LOW; carry-forward item d). Non-seam UI-safe contract hardening.
- **Architecture sections it implements:** `ARCHITECTURE.md §11` (Electron Desktop UI — the UI-safe read surface / projection family) + `§10` (Local App API — the read-model surface these project into) + the candidate-data/leakage discipline (safety rule 2 — redact/bound by TYPE at the boundary). Implementer confirms the §11 UI-safe anchor at Step 0.
- **The MIRROR (already in the file):** `uiSafeSummaryLine` (`packages/contracts/src/api/ui-safe.ts:43`) — the single-line bounded validator (rejects the CR/LF/VT/FF/NEL/LS/PS newline family, length-capped) already applied to `summary`/`title`/label fields. This slice adds a sibling `uiSafeToken` (single-line, non-empty, tighter max — a token is not a summary) and applies it to the open token fields.
- **The fields to bound (unbounded `z.string().min(1)` today):** `UiSafeDashboardCard.kind` (`ui-safe.ts:208`) + `.status` (`:210`); `UiSafeIngestionItem.type` (`:489`) + `.sensitivity` (`:490`); `UiSafeProjectDashboard.status` (`:384`). (5 fields across 3 non-seam UI-safe types.)

## Scope boundary (IN vs deferred)
- **IN (this slice):** a NEW `uiSafeToken` validator (single-line, `.min(1)`, length-capped, control-char-free — mirror `uiSafeSummaryLine`'s newline rejection) + applying it to the 5 named fields + tests. Keep the field NAMES + the interfaces unchanged (only the schema validator tightens).
- **DEFERRED (not this slice):** any change to the field SET / allowlist / parity (none needed — validator tightening only); the ARIA/a11y follow-up; anything touching a frozen Appendix-A seam (UI-safe types are non-seam).

## Acceptance criteria (what "done" means)
- [ ] NEW `uiSafeToken` in `ui-safe.ts` (co-located with `uiSafeSummaryLine`): `.min(1)`, single-line (rejects the same newline/control family `uiSafeSummaryLine` rejects), length-capped at a token-appropriate max (default 64 — flag at 2.5). Exported/co-located per the file's convention.
- [ ] `uiSafeToken` applied to all 5 fields: `UiSafeDashboardCardSchema.kind`/`.status`, `UiSafeIngestionItemSchema.type`/`.sensitivity`, `UiSafeProjectDashboardSchema.status`. The TS interfaces (`kind: string` etc.) are unchanged; only the Zod validators tighten.
- [ ] **No field-set change ⇒ the UI-safe freeze holds:** the allowlist + `_uiSafeParity` `Exact<>` + the freeze tests (`apps/worker/test/api/uiSafe.test.ts` + the contract freeze tests) stay green (field NAMES are what those pin, not validators).
- [ ] **No legit token regresses:** the bound is generous enough that every real token in the codebase (`email`/`meeting`/`low`/`high`/`active`/`done`/etc. + every producer/fixture value) still validates — the repo-wide `turbo typecheck test` proves no existing valid data is rejected.
- [ ] Repo-wide `turbo typecheck test` green (cross-package: `@sow/contracts` ui-safe + `@sow/worker` + desktop consumers). The tightened validators are proven by new RED tests.

## RED test outline (write cases first)
1. `token_rejects_multiline` — a `kind`/`type`/`sensitivity`/`status` value containing a newline (each of the CR/LF/… family) ⇒ the schema `.safeParse` FAILS (parity with `uiSafeSummaryLine`).
2. `token_rejects_overlength` — a token longer than the cap ⇒ FAILS.
3. `token_rejects_empty` — `""` ⇒ FAILS (`.min(1)` preserved).
4. `token_accepts_normal` — a normal short token (`"meeting"`, `"low"`, `"active"`) ⇒ PASSES, for each of the 5 fields.
5. `freeze_still_holds` — the UI-safe allowlist + `_uiSafeParity` + freeze tests are unaffected (field-set unchanged) — assert the 3 schemas still `.strict()` with the same field names.
6. `existing_fixtures_still_valid` — the representative fixtures/producers for dashboard-card / ingestion-item / project-dashboard still validate under the tightened schemas (no legit-data regression).

## Cross-doc invariant impact
- **NONE.** The 3 UI-safe types are non-seam (no Appendix-A row, no generated schema/snapshot, no ajv-registry, no `packages/contracts/CLAUDE.md` cross-doc-table row). This tightens VALIDATORS within existing fields — the field SET is unchanged, so no snapshot/allowlist/parity change. Cross-PACKAGE (contracts + worker + desktop) ⇒ repo-wide gate, but not a frozen-contract round.

## Things to flag at Step 2.5 (design questions — default votes)
1. **Token max length (load-bearing — must not regress legit data).** Default vote: **64** chars (tokens are short enum-like labels; `uiSafeSummaryLine`'s longer cap is for prose). Confirm no real token in the codebase exceeds it (grep the producers/fixtures at Step 0); widen if any legit token is longer.
2. **New `uiSafeToken` vs. reuse `uiSafeSummaryLine`.** Default vote: a DEDICATED `uiSafeToken` (tighter max, semantically a token not a summary) sharing `uiSafeSummaryLine`'s single-line/control-char rejection helper (don't duplicate the newline logic — factor the shared single-line guard). Confirm.
3. **Newline/control family.** Default vote: reject exactly the family `uiSafeSummaryLine` rejects (CR/LF/VT/FF/NEL/LS/PS) — one shared guard, no drift. Confirm.

## Wiring / entry point (Step 7.5)
- **Entry point:** these fields are already live on the mounted read-model queries (`query.dashboard`/`query.ingestionInbox`/`query.projectDashboards`) — the tightened validator runs at the existing boundary re-validation (`sanitize*`) + the schema gate. No new entry point; the hardening applies at the already-reachable projection boundary. Note at Step 7.5: reachable via the existing UI-safe query paths.
- **Blocks:** nothing.
- **Depends on:** the existing UI-safe framework (`uiSafeSummaryLine` + the freeze machinery) — all present.

## Estimated commit count
**1.** The `uiSafeToken` validator + 5 field applications + tests. Cross-package ⇒ repo-wide gate. NOT a new trust boundary (tightens an existing one) ⇒ Step-8 review OPTIONAL per policy — but a one-line self-check that the bound rejects multi-line/over-length + doesn't regress legit tokens.

## Lessons-logged candidates (implementer flags Step 9)
- Possible (implementer's call): "UI-safe OPEN display tokens (enum-like `kind`/`type`/`status`/`sensitivity`) are bound by TYPE at the contract — single-line + length-capped `uiSafeToken` sharing one newline/control guard with `uiSafeSummaryLine` — defense-in-depth so a mis-behaved producer can't inject a multi-line/over-length token even though content-derived fields are already dropped." May fold into Lesson §10 or §5 (redact-by-type). Likely no new lesson needed.

## How to invoke (implementer)
1. `/tdd` against this brief. Step 0 — read `uiSafeSummaryLine` (`ui-safe.ts:43`) + the 5 field sites + confirm (grep producers/fixtures) that no legit token exceeds the chosen cap.
2. Step 2.5 — ping Q1–Q3 (Q1 max length is load-bearing — must not regress legit data) BEFORE writing cases.
3. RED first (reject multi-line/over-length/empty + accept-normal for each field + freeze-still-holds + no-fixture-regression).
4. Step 8 — OPTIONAL per policy (not a new trust boundary); self-check the bound rejects multi-line/over-length + doesn't regress legit tokens.
5. Step 9 — categorized flags + ship-ask (note: no field-set/frozen-contract change; repo-wide gate for the cross-package validator tighten).
