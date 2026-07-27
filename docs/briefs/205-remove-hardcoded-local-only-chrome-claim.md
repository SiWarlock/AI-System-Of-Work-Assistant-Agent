# /tdd brief — remove_hardcoded_local_only_chrome_claim

## Feature
Delete the hardcoded, unconditional "Egress: local-only" pill from the persistent app chrome, and pin that no chrome-level egress claim can return without a data source. ⚠ **rule-5 false assurance, currently LIVE on every surface.**

## Use case + traceability
- **Task ID:** 9.10 follow-on (owner/lead-directed 2026-07-26) · ⚠ **rule-5** · **no dependency — do this now, do NOT wait for 9.22**
- **Architecture sections it implements:** `ARCHITECTURE.md §5` (EgressPolicy / egress veto), `§11` (desktop surfaces), REQ-S-002
- **The defect:** `apps/desktop/renderer/chrome/AppShell.tsx:342-348` renders a shield-and-checkmark pill reading `Egress: local-only` with `aria-label="Egress mode: local-only"` — **no props, no data source, no condition**. It is false in both directions post-flip: personal workspaces are provisioning-seeded `[claude]` (`40414dd1`) and `employer_work` is default-seeded ack=true scoped `[claude]` (`bcde3d61`) — both cloud. The `aria-label` makes it a false assurance on the accessibility surface too.
- **Provenance:** `c379f847` (task 9.5 R2 AppShell extraction) — pre-existing chrome that predates the egress flip; **not** from the 9.10-C slice. No test pins the string, so removal breaks nothing.
- **Why it outranks Finding 2:** Finding 2 was data-derived (`!ack`), confined to one pane, and never rendered. This is **static** (cannot be right except by coincidence), **global** (every surface), and **already shipping**. It also directly contradicts the 9.10-C pane landed in `7e251b0e`: in the running app the egress row reads "Cloud egress acknowledged" *inside* a chrome that reads "Egress: local-only".
- **Why removal needs no truthful replacement first:** deleting a false safety claim requires no crossing authorization, and the honest interim state is showing nothing. Same reasoning that made 9.22/9.23 ordinary tasks.

## Acceptance criteria
- [ ] The hardcoded pill is **gone** — no "local-only" text, no `aria-label` asserting an egress mode, no shield/checkmark egress affordance in `AppShell`.
- [ ] Any now-orphaned CSS for it is removed too (don't leave dead selectors behind). ⚠ Do **not** remove `styles.css:1960` `.sow-pill--zero-egress` — that one is pre-staged for task #8; only remove what *this* pill used.
- [ ] **A regression pin asserts the app chrome makes no egress claim**: rendering `AppShell` produces no text or accessible name matching `/local-only|zero-egress|egress mode/i`. This is the pin that stops the claim coming back.
- [ ] Existing `app-shell.test.tsx` coverage still passes (nav, routing, aria-current) — this is a deletion, not a re-layout.
- [ ] `pnpm build:sow` then `/preflight` clean.

## Wiring / entry point (Step 7.5)
No new entry point — this removes rendering from an existing one. `AppShell` is already reachable on every route; the pin renders it directly. Confirm nothing else in `renderer/` references the removed class or copy (grep before you commit).

## Files expected to touch
**Modified:** `apps/desktop/renderer/chrome/AppShell.tsx` (delete the pill) · `apps/desktop/renderer/styles.css` (remove only this pill's now-dead selectors) · `apps/desktop/test-dom/app-shell.test.tsx` (the no-egress-claim pin).

**Do NOT touch:** `apps/desktop/renderer/surfaces/workspace-settings/**` (that's task #8), `apps/worker/**`, `packages/**`, and all orchestrator-territory docs.

## RED test outline (Step 2)
1. **`chrome_makes_no_egress_claim`** — Asserts: rendering `AppShell` yields no text node and no accessible name matching `/local-only|zero-egress|egress mode/i`. Why: rule-5 — the chrome must not assert an egress posture it cannot know. **This is the load-bearing test; it must fail before the deletion and pass after.**
2. **`no_dead_egress_pill_styles`** — Asserts (structural): the removed pill's class has zero references in `renderer/`. Why: a dead selector invites someone to "restore" the badge.
3. **Existing shell coverage unchanged** — nav item set, route dispatch, `aria-current` still pass. Why: proves a pure deletion, not a chrome regression.

## Cross-doc invariant impact
- **Model field changes:** none. No producer, no projection, no contract.
- **Orchestrator doc rows to write hot (Step 9):** I'll record the §5/§11 note (the chrome asserts no egress posture; the per-workspace pane is the only egress surface) and the lesson the lead asked for — the recurring "posture asserted from a constant/default-seed instead of derived from governing state" shape, of which this is the third instance this round.

## Things to flag at Step 2.5
1. **Does anything replace it visually?** My default vote: **nothing** — leave the space empty. A neutral placeholder ("Egress: —") still implies the chrome is the place to learn egress posture, which is exactly the wrong affordance for a *per-workspace* fact. The truthful scope-aware pill rides task #8.
2. **Does the pin belong in `app-shell.test.tsx` or the security spec?** My default vote: **both is overkill; put it in `app-shell.test.tsx`** where the chrome is already rendered, and mention it at Step 9 — if you think `test/security/renderer-*.spec.ts` is the more durable home (it's the file a future security review reads), say so and I'll take that instead.
3. **Scope discipline:** if you find *other* hardcoded posture/safety claims in the chrome while you're in there, **flag them at Step 2.5, don't fix them in this commit.** Given this is the third instance of the pattern this round, finding a fourth is plausible — but a rule-5 deletion commit should be reviewable at a glance.

## Dependencies + sequencing
- **Depends on:** nothing. Deliberately unblocked — it does NOT wait on 9.22.
- **Blocks:** nothing. Task **#8** later adds the truthful, scope-aware, data-bound pill once 9.22 provides a real local-only signal.

## Estimated commit count
**1.** A rule-5 deletion gets its own commit, reviewable at a glance.

## Lessons-logged candidates anticipated
- **Convention candidate (lead-requested, round-level)** — "A safety posture must be DERIVED from the governing state, never asserted from a constant or a default-seed. Three instances in one round: a pre-store constant (9.10-A), a provisioning re-seed (9.23), and a hardcoded chrome badge (this)."
- **Convention candidate** — "A component-scoped pin cannot see chrome-level claims: 9.10-C's `NEVER claims zero-egress` pin passed only because it rendered the pane without its `AppShell` wrapper. Safety-claim pins need to render the composed surface, or the claim can be false one element outside the test's viewport."
- **Architecture-doc note candidate** — §5/§11: the app chrome asserts no egress posture; the per-workspace pane is the only egress surface.

## How to invoke
1. Read this brief; note Q3 (don't widen the commit).
2. Run `/tdd remove_hardcoded_local_only_chrome_claim`.
3. Step 0 restate → Step 2.5 (short — three tests) → GREEN.
4. Step 8: `security-reviewer` (**invariant**, rule-5) + `code-quality-reviewer`.
5. `pnpm build:sow` before `/preflight`. **Step 9 sign-off routes via the lead** (rule-5 surface).
