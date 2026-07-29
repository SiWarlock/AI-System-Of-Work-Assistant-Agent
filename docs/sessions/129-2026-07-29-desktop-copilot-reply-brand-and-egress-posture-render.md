# 129 — desktop: Copilot reply brand (9.34) + render the derived egress posture (9.10-C bullet 1, #8)

**Date:** 2026-07-29
**Track / role:** main · desktop-implementer
**Predecessor session:** `docs/sessions/120-2026-07-28-desktop-copilot-renderer-parity.md`
**Successor session:** `docs/sessions/131-2026-07-29-desktop-errorboundary-and-partial-scaffold-repair.md`

---

## Why this session existed

Respawned mid-round after the hardening-tail seal. Two desktop-territory follow-ups were queued from doc 120's Open follow-ups: task **#34** (brand the Copilot reply, closing 9.28's relocated residual) and task **#8** (9.10-C's unmet acceptance bullet 1), the latter gated on worker task 9.22 landing first. #34 had no dependency and was picked up first; #8 unblocked mid-session when 9.22 landed (`69b10883`) and was the round's final slice per the orchestrator.

## What was built

### Slice 1 — Commit `d7a9b170` (2 files, +120/−23)

Task #34: `CopilotTurnView.reply` and `CopilotAnswerView`'s prop were `UiSafeCopilotAnswer` — structurally satisfiable by a hand-built literal omitting the optional `egressProcessor` rule-5 disclosure field (9.28's honest bound). Introduced a nominal `AdmittedCopilotAnswer` brand (a `unique symbol` field, compile-time-only) mintable only via the now-exported `admitReply()`. Added a separate `CopilotTurnSeed` (unbranded candidate) type for the mount-time seed prop, since that boundary is genuinely unvalidated data and shouldn't claim an admission it hasn't performed.

**Files:** `apps/desktop/renderer/surfaces/copilot/Copilot.tsx`, `apps/desktop/test-dom/copilot-panel.test.tsx`.

### Slice 2 — Commit `cda4d2f4` (2 files, +212/−21)

Task #8 (9.10-C bullet 1): renders the derived `zeroEgressOnly` posture, now that 9.22 makes it mean what it documents. Adds a "Provider routing: established / not established" pill (epistemic wording, never "safe"/"local-only"/"zero-egress"/"nothing leaves this machine") plus a shared scope note ("Covers model-provider routing only — connector reads and external-write traffic are governed separately and aren't reflected here."), carried both as visible text and as the pill's `title`. `true` renders plainly — it is currently unreachable in production (task 9.32, an owner-ratified deferred arc: nothing writes a non-empty `providerMatrix` yet).

**Files:** `apps/desktop/renderer/surfaces/workspace-settings/egress.tsx`, `apps/desktop/test-dom/egress-settings-page.test.tsx`.

## Decisions made

- **9.34 — `CopilotTurnSeed` split.** Keeping the mount-time seed prop's declared type unbranded (candidate data, re-validated by `admitReply` at mount) rather than branding it too — branding it would have forced test fixtures to pre-mint via `admitReply`, which is honest for the *state* type but dishonest for the *seed* type (which represents not-yet-admitted data, e.g. a future restore). The orchestrator called this "the part I'd have missed."
- **9.34 — exported `admitReply`.** The sole minting function must be reachable by any future consumer (a `copilotBriefing`/`copilotConcept` surface, or a test) — keeping it module-private would make the brand un-mintable by anyone legitimate too.
- **#8 — pill wording iterated over two Step-2.5 rounds.** Round 1: orchestrator's own draft wording ("no verified local-only routing…") tripped the forbidden-pattern #7 grep on the exact banned token it was warning against — caught before code, not after. Round 2 (TWEAK from orchestrator): re-aim (not retire, L67) the pre-9.22 "never claims zero-egress/local-only" test rather than deleting it, since its *intent* is more load-bearing now that a real claim exists on this surface; and make the pill subject-bearing ("Provider routing: …") rather than a bare epistemic word, since it sits adjacent to the existing ack pill and a contentless "Not established" invites misreading it as about the ack. Round 2 also added (ADD) a standing test pinning the new pill's decoupling from the sibling `employerRawEgressAcknowledged` field — 9.22's entire achievement, now pinned at the renderer too.
- **#8 — exact-text equality, never regex containment**, for every state-specific pill assertion: `"not established"` contains `"established"` as a substring, so a naive `.toMatch(/established/)` on the false state would also pass. Flagged by me at Step-2.5; the orchestrator noted they likely wouldn't have caught it in review.
- **#8 — the shared scope note is a safe constant.** Forbidden-pattern #7 bans asserting a safety posture from a constant — but the scope note states what the predicate *measures* (a fixed architectural fact), never the derived *value*; only the pill text itself moves with `zeroEgressOnly`. Documented explicitly in-code so a future reader doesn't misread the constant as the violation.

## Decisions explicitly NOT made

- **#8 — no de-emphasis styling for the unreachable `true` state.** Rendered plainly; de-emphasizing it would itself be an implicit claim the predicate doesn't support (orchestrator/lead-approved).
- **#8 — three lows from code-quality review deferred**, per the lead's ruling: (1) the new pill's class is static (`sow-pill--egress-scoped`, state only in the `data-` attribute) vs. the sibling ack pill baking state into its class name — inconsistent within-file convention, not a bug; (2) the re-aimed test's `[title]`-only sweep overlaps `no_naming_attribute_overclaims`'s broader sweep — duplicated coverage, not incorrect; (3) a pre-existing, zero-reference dead CSS selector `.sow-pill--zero-egress` in `styles.css` — out of scope for this diff.
- **#8 — test naming kept as the brief's snake_case**, not reformatted to the file's pre-existing full-sentence convention. Lead's ruling: consistency with the brief that specified the names beats consistency with the file; renaming would churn a safety test file for style at the round's last slice. Recorded as a convention question for a future session, not a fix.

## TDD compliance

**Clean, both slices.** 9.34: two `@ts-expect-error` compile-time pins confirmed RED before the brand (both directives reported "unused" — TS2578 — since the unbranded literal compiled with no error) and GREEN after; both reviewers independently re-ran this exact mutation (alias the brand back to a plain type) and confirmed it. #8: RED test outline followed per brief 216; 6 tests added/re-aimed, plus a 7th (ADD, decoupling) after Step-2.5.

**Mutation-verification (L75), #8 — 4 restoration forms run, not just designed:**
1. Hardcode the pill to always render "established" — caught by 2 tests (`false_renders_not_established_and_claims_nothing`, `posture_text_moves_with_the_governing_state`).
2. Re-couple the pill's condition to `employerRawEgressAcknowledged` instead of `zeroEgressOnly` — caught by 3 tests, including the dedicated `posture_pill_is_decoupled_from_the_ack_field`.
3. Strip the `title` attribute — **initially NOT caught** by `no_naming_attribute_overclaims`: its non-vacuity check (`nodes.length > 0`) was trivially satisfied by unrelated pre-existing Retry/Revoke button `aria-label`s. Fixed by adding a positive anchor (`row(...).querySelector("[data-egress-scope][title]")).not.toBeNull()`) on the feature's own element before the generic sweep; re-verified it now catches the mutation. **This is banked as L90** (below).
4. Restore a genuine over-claim phrase ("… nothing leaves this machine") into the true-state text — caught by 4 tests, including the two `BANNED_EGRESS_CLAIM` regex assertions specifically, confirming the regex *fires* on a real restoration rather than merely passing on clean text (also folded into L90). Run at the code-quality-reviewer's flag (a medium finding), closed in-slice with an in-code comment documenting the verification.

All mutations reverted; clean suite reconfirmed after each (`pnpm --filter @sow/desktop typecheck && test && build`, 483 tests green throughout both slices' final states).

## Reachability

- **9.34:** Both admission doors (`finish` on the live `onAsk` path; the `turns` seed prop, test-only — `AppShell.tsx` mounts `<Copilot>` without ever passing it) confirmed live/dormant exactly as documented; no third construction path exists anywhere in the repo (security-reviewer verified via grep for every importer of `CopilotTurnView`/`CopilotAnswerView`/`admitReply`).
- **#8:** The new pill renders on the same live path as the pre-existing ack pill (`EgressSettings` → workspace settings). `true` is unreachable in production per 9.32 (no non-empty `providerMatrix` writer yet) — not a wiring gap, an owner-ratified interim.

## Cross-doc invariant audit

**Clean, both slices.** Neither touches `packages/contracts` or `packages/domain`. 9.34's brand is a renderer-local nominal type over the existing `UiSafeCopilotAnswer` (no contract change). #8's `UiSafeEgressStatus` is unchanged — 9.22 changed only its derivation, not its shape. Nothing owed at Step 9 for either slice.

## Open follow-ups

**Desktop queue:**
- **#35** — no `ErrorBoundary` anywhere in `apps/desktop`; any render-time throw unmounts the whole root. Still open, not picked up this session (round bounded toward teardown after #8).
- **#13** — precondition on Copilot history/restore carrying derived disclosure state; activates when that feature is built.
- Test-naming convention question (snake_case vs. full-sentence) flagged for a future session — no action needed now.
- Three deferred lows from #8's code-quality review (see "Decisions explicitly NOT made" above) — no task needed, informational.

**Not desktop territory, flagged only:** a pre-existing dead CSS selector `.sow-pill--zero-egress` in `apps/desktop/renderer/styles.css` (zero live references) — worth a future cleanup pass, out of scope for both slices this session.

## `/preflight` note

Repo-root `pnpm lint` and `pnpm format:check` are not currently runnable (no `eslint` binary installed at root; no `format:check` script defined) — a pre-existing tooling gap, not introduced this session; `apps/desktop`'s own `lint` script is `tsc --noEmit` and was run directly instead. Repo-wide `pnpm typecheck` (turbo, 11 packages): **20/20 tasks green**. Repo-wide `pnpm test` (turbo): one flaky suite (`apps/desktop/test/bundle/main-bundle-resolution.test.ts`, a real-vite-build verification test sensitive to concurrent turbo builds) plus one unrelated `@sow/db` postgres-pglite migration failure — both re-ran in isolation and passed clean (4/4 and untouched by this session's diff respectively), confirming neither is a regression from these two commits. `apps/desktop`'s own full suite (`pnpm --filter @sow/desktop typecheck && test && build`) was run clean multiple times throughout both slices.

## Lessons banked this session (orchestrator-recorded)

- **L90** — a non-vacuity guard must be verified by deleting the feature it exists to guard, not just checked for "some matching node exists somewhere." My attribute-sweep test's non-vacuity check passed even with the feature's own `title` attribute removed, because unrelated pre-existing buttons' `aria-label`s satisfied the same selector. Generalization: *delete your feature entirely — does the non-vacuity guard still pass?* If yes, it isn't anchored to the feature. Also covers the banned-token regex: verified only on clean text isn't verified — it must be confirmed to *fire* on a real restoration (L75 applied).
