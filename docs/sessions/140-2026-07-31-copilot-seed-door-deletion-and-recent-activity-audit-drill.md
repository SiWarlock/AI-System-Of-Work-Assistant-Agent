# 140 — desktop: delete the Copilot `turns` seed door (9.39) + the Recent Activity audit-drill affordance (9.41 leg C)

**Date:** 2026-07-31
**Track / role:** main · desktop-implementer
**Predecessor session:** `docs/sessions/135-2026-07-29-dead-css-cleanup-and-copilot-rehydrate-precondition.md`
**Successor session:** _(next `/session-end`)_

---

## Why this session existed

Fresh desktop-implementer spawn after a full team teardown (handoff 019). Two slices dispatched in sequence: task **9.39**, the structural fix 9.25 recorded as the answer and deliberately didn't do (delete the Copilot `turns` seed door rather than keep hardening its scanner); then task **9.41 leg C**, the desktop-side close of the 9.41 arc (make a Recent Activity row's `changeId` actionable against leg B's already-mounted `query.auditDrill`).

## What was built

### Slice 1 — commit `89797bb2` — delete the Copilot `turns` seed door (9.39)

**Files modified:** `apps/desktop/renderer/surfaces/copilot/Copilot.tsx`, `apps/desktop/test-dom/copilot-panel.test.tsx`.
**Files deleted:** `apps/desktop/test/renderer/copilot-rehydrate-seam.test.ts` (the whole file, not edited in place).

9.25 had shipped a 4-test AST scanner proving no production code passed `turns=` to `<Copilot>` — three adversarial-review rounds, each closing a real evasion (JSX spread, aliased import/namespace tag/`createElement`, barrel re-export), stopped by ruling with two residuals named rather than closed. Its own durable reading was that *"no production consumer"* is a negative claim over an unbounded construction space, so a scanner over it is a detector, not a gate — and the structural answer is to delete the seed door instead. This slice does that: deletes `CopilotTurnSeed`, the `turns` prop, its `useState` seed-initializer branch, and corrects every "door 2"/"both doors"/"seed prop" comment (7 sites — 2 past the brief's own enumerated 5, since the brief specified the sweep as a grep *pattern* rather than a fixed list; an 8th, `:298`'s stale "seed turn" id-collision comment, was caught only by code-quality review, not the sweep itself, since it didn't use the pattern's phrasing).

The scanner's replacement is a single `@ts-expect-error` compile-time test on `<Copilot turns={[]} />` — non-vacuous because an unused `@ts-expect-error` directive is itself a `tsc` error (mirrors the file's own existing 9.34 brand-test idiom). It lives in `copilot-panel.test.tsx` (jsdom tier), not the old file's node tier, because `tsconfig.node.json` has no `"jsx"` compiler option and doesn't include `test-dom` — a JSX compile-gate structurally cannot live where the scanner was.

Six tests converted from `turns` seed fixtures to a mocked `onAsk` driving the real live-ask path (same assertions, different construction). One test (the proposal-row affordance) couldn't convert that way: `finish` (the sole live-ask producer) never sets `proposalLabel` — only the now-deleted seed door ever did, which was already true in production before this slice (`AppShell` passes no `turns` either). Fixed by exporting the previously-private `CopilotTurn` component (mirrors the existing `CopilotAnswerView` export) so that one test renders it directly — a presentational-component render, not a reinstated construction route into `Copilot`'s own `useState`. Security review confirmed that boundary explicitly.

### Slice 2 — commit `3640c0e4` — the Recent Activity audit-drill affordance (9.41 leg C)

**Files created:** `apps/desktop/renderer/lib/audit-drill.ts`, `apps/desktop/test/renderer/audit-drill.test.ts`, `apps/desktop/test-dom/today-recent-activity.test.tsx`.
**Files modified:** `apps/desktop/renderer/{App.tsx, lib/live.ts, styles.css, surfaces/today/Today.tsx}`, plus three existing test-dom fixtures (`today-brief`, `today-priorities`, `app-partial-scaffold-markonboarded`) that needed a one-line addition each once `onAuditDrill`/`auditDrill` became required fields.

A per-row "Details" button on the Today Recent Activity list calls a new wrapper (`createAuditDrill`, mirrors `drilldown.ts`/`copilot-ask.ts`) against leg B's `query.auditDrill`, and renders the resolved `{event, occurredAt}` inline. This is the first surface in the codebase where a drill's *fetched payload* reaches the DOM — every prior drill (`onDrillDown`/`globalDrillDown`) is a permission gate that discards its own result and re-hydrates through a separate, already-scoped read. That difference is why the reasoning below matters more than the diff.

#### Why four failure causes render as one state (the probe-oracle argument)

A denial, a transport throw, a malformed `{ok:true}` payload, and a schema-reject (extra key / oversized `event` / bad timestamp) all fold to a byte-identical `{ok:false}` at the wrapper, and the renderer shows one non-committal "Details unavailable" state for all of them. This isn't caution for its own sake: leg B mints **distinct** codes server-side, deliberately, for the operator. If the renderer let any of those distinctions leak — even just "not found" reading differently from "denied" — the affordance becomes a probe oracle an attacker (or a curious user) can use to enumerate which `changeId`s exist versus which are permitted, against the audit store itself. Whoever touches this next and thinks "surely a 404-style message would be more helpful" needs to know that's the exact regression the design forecloses.

#### Why the per-row state needs a seq guard at all, and why key-separation alone isn't the whole answer

The precedent (`egress.tsx`'s `PostureCell` + per-key `seq`) exists because a slow resolution for a stale request must never overwrite fresher state for the *same key*. The first design question was whether that even applies here, since `deriveChangeId` (worker-side, `apps/worker/src/api/projections/recentChanges.ts`) hashes `workspaceId` into the opaque `changeId` — so a resolution for workspace A's `changeId` structurally can never key onto a row rendered for workspace B. That's real, and it's enough to answer the orchestrator's original ask (a mid-flight scope switch A→B).

It is **not** enough for A→B→**back to A**. `RecentActivity`'s own state (`cells`, `seq`) isn't reset on scope change — the component isn't remounted, just re-rendered with a new `changes` prop. If a user activates a drill on row X in workspace A, switches to B before it resolves, then switches back to A before the stale promise settles, X's `changeId` is now rendered again (same audit row, same key) — and without protection, the stale resolution from the *first* visit would silently "resolve" a row the user never re-activated on the *second* visit. Key separation says nothing about this case, because the key doesn't change; it reappears. This is what makes the seq guard load-bearing rather than decorative: I closed it by extending `egress.tsx`'s own unmount-invalidation pattern to fire on every `changes` **replacement**, not only unmount (a cleanup `useEffect` that bumps every current row's `seq` whenever the joined `changeIds` string changes) — genuinely the same mechanism, applied at a different trigger, not new invention.

The orchestrator's own review of this design pointed at a different, adjacent failure mode: if that effect's dependency were the `changes` **array reference** rather than the derived string, an innocuous parent re-render (new array identity, same content) would invalidate every in-flight drill — and *nothing in the test suite as originally written would catch it*, because the "superseded resolution never paints" test passes **harder**, not less, when nothing ever resolves. That's the sharpest thing about this bug class: the wrong implementation and the right one are indistinguishable by every test that only asserts an absence. I'd already used the derived string (`changeIds`), so there was no live bug — but I hadn't proven it, which is exactly the gap. Added a test that activates, forces a same-content re-render, and asserts the drill *still completes*; then mutation-verified it by reverting the dependency to the raw array and watching the row hang forever, confirming the test actually discriminates rather than passing by accident.

#### The stuck-loading bug (the security reviewer's catch, not mine)

None of the above protects a row that's still "loading" at the moment its request gets invalidated. The seq bump stops the *wrong* content from painting — it does nothing to *unstick* the row, because nothing calls `setCells` on the drop path. Concretely: activate a drill, switch away before it resolves (seq bumped, correctly dropped when it lands), switch back — the row is now permanently stuck reading "Checking details…", its own re-entrancy guard (`if (cells[changeId]?.kind === "loading") return`) blocking every future click on it, forever, with no error and no way to retry. This is worse in kind than the wrong-paint bug it's adjacent to: that one is a silent security-adjacent risk that never manifested; this one is a visible, permanent UX dead end that *would* manifest the first time someone tried the A→B→A sequence. The security reviewer found it, not the ADD I was working from — the orchestrator's own framing ("could a drill ever fail to complete") and the reviewer's ("what happens to a row already loading when its context is invalidated") are adjacent, not the same question, and neither implies the other. Fixed by having the same cleanup effect also clear a stuck-`loading` cell back to not-yet-activated (only `loading` — `ready`/`unavailable` cells are retained across a switch, per the deliberate "retain resolved state per session" decision below), and added a test that reproduces the exact A→B→A sequence and confirms the row becomes freshly clickable rather than staying stuck.

#### Smaller decisions, with the reasoning that would otherwise be lost

- **`onAuditDrill` is REQUIRED on `TodayProps`, always resolves internally rather than being hidden when there's no live worker** (mirrors `onAskCopilot`, not `onRevoke`). The two existing shapes in this codebase read as: "hide the control" for a *mutating*, safety-relevant, one-directional action (egress revoke); "always offer, degrade internally to a safe failure" for a *read*. Audit-drill is a read, and "Details unavailable" + Retry is already the honest degrade for "worker unreachable" — hiding it would need extra prop-plumbing for no behavioral gain.
- **No control renders while "loading"** (a plain "Checking details…" status span, not a disabled button) — not my first instinct (I initially designed a re-clickable loading button so the seq guard would have an obvious reachable driver). Reconsidered when the orchestrator pointed out leg B's resolver scans up to 1000 audit rows hashing each — not cheap — and that `egress.tsx`'s own `inFlightRef` exists specifically to forbid duplicate dispatch of a costlier-than-trivial action. Checked `egress.tsx`'s actual loading branch rather than trusting my own Copilot-`pending`-instinct: it renders no button either. Once I adopted that, the re-click race I'd designed test 7 around became unconstructable through the UI — which is why that test was replaced with the scope-change race (still reachable, and the actually-realistic production sequence) rather than kept alongside a driver that no longer exists.
- **`changeId` needs no `encodeURIComponent`-style escaping in the cleanup effect's derived key**, unlike `egress.tsx`'s `ids` (which escapes workspace ids of unknown shape for injectivity, desktop L12). `changeId` is a sha256 hex digest — it cannot contain the join delimiter, so the join is already injective. Stated in-code rather than left as an unexplained divergence from the precedent, per the orchestrator's ask.
- **`cells` entries are never pruned except a stuck-`loading` one** — `ready`/`unavailable` state persists per-row for the whole session, even across a switch-away-and-back, because the audit record itself is immutable once written (Q2's decision). This means a resolved row's content is *cached*, not re-fetched, if you revisit it.

## Decisions explicitly NOT made

- **9.39 does not solve disclosure-on-rehydrate.** 9.25 established the fail-open-by-omission case is unreachable today (a different claim from "handled"). Deleting the seed door removes the construction route; 9.25's rule-5 precondition **moves** to whatever future slice builds Copilot restore — it does not discharge. Do not read the commit as closing 9.25's risk.
- **9.39's `proposalLabel` producer gap is named, not fixed.** `finish` never populates it; the UI branch that renders it is real but has had no live producer since before this slice. Routed by the orchestrator as L106 instance #5 (a rendered affordance with no producer) — under-shows, doesn't leak, not a rule-5 issue. Left alone deliberately.
- **9.41-C does not fully prune `cells`.** Only a stuck-`loading` entry is cleared on invalidation; a resolved/`unavailable` entry for a `changeId` no longer in `changes` lingers in memory for the rest of the session. Code-quality review flagged this as a deferred low (bounded by the recent-changes feed's own flood-bound, not a live defect) — noted in-code, not fixed.
- **No fourth adversarial round on either scanner/guard.** Both slices' reviewers (security + code-quality) ran once each, per the standard Step-8 policy for an invariant-touching slice; findings were real (one per slice) and were fixed in-slice rather than deferred.

## TDD compliance

**9.39** — clean, with the deletion slice's inherent shape stated rather than glossed: the one genuinely new failing test was the `@ts-expect-error` compile gate (RED confirmed via `tsc -p tsconfig.testdom.json`, since vitest's esbuild transform doesn't type-check and wouldn't have caught it). The 6 "converted" tests were rewritten fixtures proving an *existing* pin via a different construction, not new red-green cycles — this is the brief's own explicitly-designed shape for a deletion slice, reviewed and approved at Step 2.5, not an oversight.

**9.41 leg C** — clean for the 9 tests in the approved Step-2.5 plan (RED confirmed: node-tier via a module-not-found error, dom-tier via 5/6 "button not found" failures, both for the right reason). Two exceptions worth stating plainly rather than folding into "clean":
- `re_gate_never_over_rejects_a_legitimately_maximal_event` (the max-length-boundary test) was added at Step 8 in response to code-quality review, after `audit-drill.ts` already existed — a standard "review finds a gap, add coverage" addition, not a red-first violation on new behavior.
- `a_drill_completes_across_an_innocuous_re_render` was added post-implementation, at the orchestrator's explicit ADD, to pin behavior the code *already had* (the dependency was already the derived string). Rather than a traditional red-first cycle, I mutation-verified it: ran it green against the existing code, then deliberately reverted the dependency to the raw array reference, confirmed the test goes RED (the row hangs), then reverted the mutation and confirmed GREEN again. This is the L90 discipline (a pin never observed to fail is unproven) applied to a test that was correct on arrival — the case where skipping the verification is most tempting.

Both exceptions are Step-8/ADD-driven coverage additions on already-implemented code, not TDD skipped on new behavior; neither is safety-critical-and-untested.

## Reachability

- **9.39** — a removal, not an addition. `AppShell.tsx:23/493`'s production `<Copilot>` render is unaffected; compiles and behaves identically with `turns` gone. No new entry point.
- **9.41 leg C** — a real, new production path, confirmed at Step 7.5: `AppShell` → `Today` (already-reachable render) → `RecentActivity`'s per-row button → `onAuditDrill` (`App.tsx`, resolves `workspaceId` via `resolveOnboardedWorkspaceId` + threads to `liveRef.current.auditDrill`) → `live.ts`'s `createAuditDrill(live.client)` → the real tRPC client → `query.auditDrill` (leg B, already mounted, `aa949ee7`). Scoped claim, stated in the commit: the affordance resolves against real audit rows where the feed is populated — not an unqualified "audit drill-down is live."

## Open follow-ups

**Routed hot at Step 9 (orchestrator territory — not mine to edit):**
- 9.39: the 9.25 tracker entry's restatement ("moved to the restore producer"); the L106 #5 task for the `proposalLabel` producer gap.
- 9.41-C: a `LESSONS.md` entry extending the async-per-row convention past `egress.tsx`'s unmount-only phrasing (invalidate-on-every-replacement + clear-stuck-loading), with the stuck-loading half credited to the security reviewer's catch rather than mine — the orchestrator is banking this to `apps/desktop/LESSONS.md`, not me.

**Not picked up this session (desktop queue, unchanged from handoff 019):**
- 9.5's audit-link consumer — still blocked on contract + worker legs per the lead's original brief; not attempted.
- `cells` full pruning (a deferred low from code-quality review) — noted in-code, not scheduled.

## `/preflight` note

`apps/desktop`, standalone, both slices: all three `tsc` tiers (`node`/`web`/`testdom`) clean throughout. Test suite: 503 (start of session) → 499 (9.39, net −4: deleted scanner file + deleted seed-boundary test − 1 new compile-gate test) → 508 → 510 → 511 (9.41-C, +12 net across the approved plan + two Step-8/ADD additions). Final: **511/511 green.** "Typecheck + tests clean; no lint coverage exists in this repo (`lint` is `tsc --noEmit`, `eslint` in zero manifests)" — never "lint clean."
