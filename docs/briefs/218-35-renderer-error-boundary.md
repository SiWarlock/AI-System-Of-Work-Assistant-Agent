# /tdd brief — renderer_error_boundary (task #35, desktop)

## Feature

Add a React **ErrorBoundary** to `apps/desktop` so a render-time throw degrades to a visible, recoverable failure state instead of unmounting the entire application root. There is currently **no ErrorBoundary anywhere in `apps/desktop`** — verified, and the codebase already documents its own absence.

## Use case + traceability

- **Task ID:** 9.35 (the numbered home for tracked finding #35)
- **Architecture sections it implements:** `ARCHITECTURE.md §11` (Electron desktop UI) · `§16` (nothing fails silently / degrade-and-surface, never crash)
- **Related context:** `docs/team-handoffs/018-2026-07-29-egress-honesty-sealed-full-teardown.md` (lists #35) · task 9.34 (`d7a9b170`, the `admitReply` brand) · task 9.26 (`f0cc804c`) · `apps/desktop/LESSONS.md` §3/§4 (the DOM-less node tsconfig split)

## The gap, with file:line evidence (premises — verify them; a contradiction is a FINDING)

**The root mount is unprotected** — `apps/desktop/renderer/main.tsx:6-12`:

```
const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");
createRoot(root).render(<StrictMode><App /></StrictMode>);
```

Nothing wraps `<App />`, so a throw anywhere in the tree unmounts everything `createRoot` owns.

⭐ **The codebase already knows this and worked around it rather than fixing it.** `apps/desktop/renderer/surfaces/copilot/Copilot.tsx:137-138` states it verbatim:

> *"There is NO ErrorBoundary anywhere in apps/desktop (verified), so React 18 unmounts the ENTIRE ROOT — not just the panel — instead of showing ASK_FAILED."*

That comment is the justification for 9.34's `admitReply` admission gate (`Copilot.tsx:149-152`): Copilot defends itself by **validating before render**, precisely because there is nothing to catch a throw after. ⚠ **Read that comment before you design.** It is the closest thing to a prior decision on this gap, and it tells you what the boundary is *for*: the surfaces that have **not** built their own pre-render validation are the ones currently one bad payload away from a white screen.

**The house pattern for failure is fold-to-`{ok:false}`, never throw.** Every command caller wraps in `try { … } catch { return { ok: false }; }` — `renderer/lib/copilot-ask.ts:16-47`, and the same shape at `renderer/lib/live.ts:206, 254, 289, 326, 365, 401` plus the sibling `lib/*.ts` command modules. `live.ts` hydrates only on `if (…?.ok === true)` (`:212-213, 226, 230, 234, 260-262, 291, 329, 368, 406`) — a non-ok Result is a silent no-op. ⚠ **So async/command failures are already handled.** The boundary is specifically for **render-time** throws, which this pattern cannot catch. Say that plainly in-code, or a future reader will think the boundary made the folds redundant.

## ⛔ TWO candidate boundary sites, and the choice is load-bearing — this is your primary Step-2.5 question

`App()` (`renderer/App.tsx:47`) has an **early return** at `:214-244` that renders `<Onboarding>` *instead of* `<AppShell>` when first-run gating applies. So:

- **Site A — around `<App />` in `main.tsx:10`.** Catches everything: the Onboarding path, `App()`'s own logic before its return, chrome, nav, Copilot rail, and all surfaces. Cost: a caught error replaces the **whole UI** — the user loses navigation and cannot route away from the fault.
- **Site B — around `{children}` in `chrome/AppShell.tsx:480`.** Catches only the per-surface render, so chrome + nav + Copilot rail stay alive and the user can **navigate away from a broken surface** — a genuinely better recovery story. Cost: it covers **neither the Onboarding path nor `App()` itself**, so the crash class that produces a white screen on first run stays uncovered.

⚠ **Neither site alone covers the task's stated defect** (*"any render-time throw unmounts the whole root"*). **My default vote: BOTH — a root boundary at Site A as the backstop, plus a surface-level boundary at Site B for recoverability.** Two instances of one component, different fallbacks. If you think one is enough, say which and what you are accepting; ⛔ **do not silently ship one and describe it as closing #35** — that is the bounded-claim problem this project keeps re-learning (contracts L56). If you ship one, the plan entry must say which crash class remains uncovered.

**The route switch is an inline ternary chain**, not a component — `App.tsx:312-379`, with `<Today/>` as the default branch (`:368-378`). Route types live in `renderer/store/route.ts:13-38` (hand-rolled discriminated union, no router lib); the `navigate` reducer is `renderer/store/projections.ts:172-175`. There is no route-change hook to reset a boundary on — **relevant to your reset design** (see Step-2.5 Q3).

**The 11 surfaces** under `renderer/surfaces/`: `approvals/Approvals.tsx` · `calendar/index.tsx` · `connectors/index.tsx` · `copilot/Copilot.tsx` · `cross-workspace-links/index.tsx` · `ingestion-inbox/index.tsx` · `onboarding/index.tsx` · `projects/Projects.tsx` · `system-health/index.tsx` · `today/Today.tsx` · `workspace-settings/egress.tsx`.

## ⛔ PREMISE CORRECTION — there is NO logging channel to report to

I assumed one existed. **It does not.** `apps/desktop/preload/bridge.ts:29-74` (`SowBridge`) exposes exactly: `app.getVersion` · `session.getToken` · `worker.getConnection` · `vault.open` · `vault.reveal` · `lifecycle.firstRunStatus` · `lifecycle.markOnboarded`. The channel allowlist is `PRELOAD_CHANNELS` at `bridge.ts:101-109` (7 entries, **mirrored in `preload/inventory.json`** — that file's own comment at `:98-100` warns they move together).

⇒ **An ErrorBoundary has nowhere to report a caught error.** Options: stay renderer-local (`console.error` only) or add a preload channel. **My default vote: renderer-local `console.error` only, and NO new preload channel in this slice.** A new IPC channel is a preload-surface change with an allowlist + `inventory.json` mirror obligation — that is its own slice with its own review, and bundling it here mixes a UI-resilience fix with an IPC-surface expansion. ⛔ **Flag a persistent-logging follow-up at Step 9 rather than building it.**

⚠ **Redaction (safety rule 7) applies to whatever you render or log.** A caught error's `message`/`stack` may contain content derived from worker payloads. **Do not render a raw `error.message` into the DOM, and do not render a stack.** A fixed, human-readable string is the safe default; `console.error` of the raw error is acceptable (dev-tools only, not a log sink), but state that reasoning in-code.

## Acceptance criteria (what "done" means)

- [ ] A throw during render of a route surface renders a visible fallback UI — the app root stays mounted
- [ ] The fallback renders **no raw `error.message` and no stack trace** (rule 7); a fixed safe string only
- [ ] Chrome/nav survive a surface-level throw **and the user can navigate to a different surface** (if Site B is implemented — if not, this bullet is explicitly `not-tested-because:` and the plan says so)
- [ ] A throw on the **Onboarding** path (the `App.tsx:214` early-return branch) is also caught (if Site A is implemented — same disclosure rule if not)
- [ ] A throw in `App()` itself, before its return, is caught (Site A)
- [ ] The boundary catches **render** throws — and a test documents that it does **not** catch async/event-handler failures (that is what the `{ok:false}` folds are for). This is a characterization pin against a future reader assuming the boundary covers everything
- [ ] The boundary is reusable — one component, instantiable at both sites, with a caller-supplied fallback
- [ ] The happy path is **byte-equivalent in behavior**: with no throw, the rendered output is unchanged (non-vacuity — prove the boundary is inert when nothing fails)
- [ ] `StrictMode` double-invocation (`main.tsx:9`) does not produce a doubled or wedged fallback
- [ ] Render tests live in `apps/desktop/test-dom/` and compile under `tsconfig.testdom.json`
- [ ] `pnpm test` + all three `tsc` passes clean (`tsc -p tsconfig.node.json && -p tsconfig.web.json && -p tsconfig.testdom.json`, per `package.json:13-14`)

⛔ **Do NOT write "lint clean."** `pnpm lint` IS `tsc --noEmit`; ESLint is not installed and no package defines `format:check`. The honest phrasing is **"typecheck + tests clean; no lint coverage exists."**

## Wiring / entry point (Step 7.5)

`apps/desktop/renderer/main.tsx:10` (Site A, wrapping `<App />` inside `<StrictMode>`) and/or `apps/desktop/renderer/chrome/AppShell.tsx:480` (Site B, wrapping `{children}`). ⚠ **The boundary must be reachable from the real mount path, not only from tests** — a boundary component that exists but wraps nothing is the classic unreachable-capability defect (`/wired` it).

## Files expected to touch

**New:**
- `apps/desktop/renderer/chrome/ErrorBoundary.tsx` (or another location you argue for) — the boundary component + its fallback
- `apps/desktop/test-dom/error-boundary.test.tsx` — render tests

**Modified:**
- `apps/desktop/renderer/main.tsx` — wrap `<App />` (Site A)
- `apps/desktop/renderer/chrome/AppShell.tsx` — wrap `{children}` (Site B)

⛔ **Do NOT touch:** `IMPLEMENTATION_PLAN.md` · `ARCHITECTURE.md` · any `LESSONS.md` · any `CLAUDE.md` · `docs/briefs/` · `packages/*`. All orchestrator territory — flag at Step 9 instead.

⚠ **`preload/bridge.ts` + `preload/inventory.json` are OUT OF SCOPE** per the premise correction above. If you conclude a channel is genuinely required, that is a Step-2.5 escalation, not an edit.

## RED test outline (Step 2)

In `apps/desktop/test-dom/error-boundary.test.tsx` — `// @vitest-environment jsdom` docblock first, then `@testing-library/react` (`render`, `screen`, `cleanup`), matching the house style at `test-dom/app-shell.test.tsx:1-3` and `test-dom/copilot-panel.test.tsx:1-3`.

1. **`boundary_renders_fallback_on_child_render_throw`** — a child component that throws during render.
   - Asserts: fallback text present; the throwing child's output absent.
   - Why: §16 degrade-and-surface. The core contract.

2. **`boundary_is_inert_when_no_throw`** — a normal child.
   - Asserts: child output rendered verbatim; no fallback text anywhere.
   - Why: non-vacuity — proves the boundary does not alter the happy path.

3. **`fallback_exposes_no_raw_message_or_stack`** — child throws `new Error("SECRET-abc123")`.
   - Asserts: `"SECRET-abc123"` does NOT appear in the rendered DOM; no stack-shaped substring appears.
   - Why: safety **rule 7** redaction. ⭐ **The load-bearing safety pin of this slice** — verify it by mutation (render the message, watch this test go RED, restore).

4. **`surface_throw_leaves_chrome_and_nav_mounted`** — render the real `AppShell` with a throwing child (Site B).
   - Asserts: nav landmarks / chrome still queryable; fallback shown in the content region.
   - Why: the recoverability claim. If Site B is not implemented, this becomes an explicit `not-tested-because:`.

5. **`user_can_navigate_away_from_a_broken_surface`** — after a surface throw under Site B, fire a nav interaction.
   - Asserts: the boundary resets and the new surface renders.
   - Why: a boundary that latches forever turns one bad render into a permanently dead pane. ⚠ **This is where the reset design gets tested** — see Q3.

6. **`root_boundary_catches_a_throw_in_App_itself`** — Site A, with `App` made to throw.
   - Asserts: fallback rendered, root still mounted.
   - Why: covers the `App.tsx:214` early-return / Onboarding class that Site B structurally cannot reach.

7. **`boundary_does_not_catch_async_or_handler_failures`** — a child whose `onClick` rejects / throws asynchronously.
   - Asserts: no fallback; the component stays mounted.
   - Why: **characterization, not endorsement** — pins the real boundary of the boundary so nobody later assumes it supersedes the `{ok:false}` folds in `lib/*.ts`.

8. **`strictmode_double_render_yields_one_stable_fallback`** — wrap in `<StrictMode>` as `main.tsx:9` does.
   - Asserts: exactly one fallback rendered; no wedged/duplicated state.
   - Why: `main.tsx:9` ships StrictMode; React 18 double-invokes in dev.

## Cross-doc invariant impact (implementer flags at Step 9; orchestrator writes the docs)

- **Model field changes:** none. No contract type is touched.
- **Orchestrator doc rows to write hot:** an `ARCHITECTURE.md §11` note that the renderer has a render-time error boundary, and — **if you ship only one site** — an explicit statement of the crash class that remains uncovered. I author both from your Step-9.
- **§2.5-seam model touched?** No.
- ⚠ **A design-doc check I want from you at Step 9, not a code change:** Residuals(9) records that `design-system.md` once *mandated* a UI element the code had deleted, which made the deletion non-durable. **Does any design doc specify crash/error-state UI that this fallback should match, or contradict?** A one-line answer is enough; if there is a conflict it is mine to fix.

## Things to flag at Step 2.5

1. ⛔ **One site or both?** Options in "TWO candidate boundary sites" above. **My default vote: BOTH.** Site B alone leaves the first-run/Onboarding white-screen uncovered; Site A alone gives the user no way to recover except restart. If you ship one, name the uncovered class explicitly — a partial fix described as complete is the defect class this project keeps paying for.

2. **Class component or a library?** React error boundaries require `componentDidCatch`/`getDerivedStateFromError`, i.e. a **class** component — there is no hook equivalent. The repo is otherwise function-components throughout. **My default vote: a hand-rolled class component, no new dependency.** It is ~30 lines, and adding a dependency for it is not worth the supply-chain surface. Confirm no such dep already exists before assuming.

3. **Reset strategy.** A boundary that latches leaves a permanently dead pane. Options: (a) `key` the boundary on the current route so a nav remounts it; (b) a "Try again" button in the fallback that clears error state; (c) both. **My default vote: (a) as the primary** — it makes recovery automatic and needs no new UI, and `state.route` is already available at both sites (`route.ts:13-38`). (b) is a reasonable addition; (c) if cheap. ⚠ There is **no route-change hook** to subscribe to, so `key`-ing is the idiomatic fit here — but verify how the route value is threaded at each site before committing.

4. **Fallback content + placement.** A full-pane message, or something smaller? Should it mention the app is still running? **My default vote: a short, calm, fixed message + the reset affordance, styled to the existing surface conventions** — no error codes, no "contact support," no raw detail. Match the tone of the Copilot `ASK_FAILED` treatment (`Copilot.tsx:125-127`) since that is the house precedent for a user-visible failure.

5. **Does `admitReply` become redundant?** 9.34's brand + `admitReply` (`Copilot.tsx:149-152`) exist *because* no boundary existed. **My default vote: NO — change nothing in Copilot.** Validate-before-render is strictly better than catch-after-throw (it degrades one turn instead of blanking a pane), and 9.34's brand is a typecheck-level guarantee a runtime boundary cannot replace. ⛔ **Do not "simplify" Copilot on the strength of this slice.** Flag it if you disagree; do not act on it. ⚠ Note the Copilot comment will become **partly stale** once this lands ("There is NO ErrorBoundary anywhere in apps/desktop") — flag the exact line at Step 9 and I will decide whether to amend it; **do not edit it yourself** on the theory that it is a comment, since it is load-bearing documentation of *why* `admitReply` exists.

## Dependencies + sequencing

- **Depends on:** nothing. No gate, no producer leg. Independently shippable — which is why it opens desktop's round.
- **Blocks:** nothing formally. Reduces the blast radius of every future renderer defect.

## Estimated commit count

**1.** One focused slice. **Not a safety-invariant change** — but acceptance bullet 2 / test 3 **is** a rule-7 redaction pin, so treat the fallback's content as safety-relevant: `security-reviewer` at **invariant** scope is warranted on that basis, `code-quality-reviewer` every-slice per project policy.

⛔ If the slice grows a preload channel, it is **no longer one commit and no longer this brief** — stop and flag.

## Lessons-logged candidates anticipated

- **Convention candidate** — "A renderer with no error boundary makes every render-time throw a whole-app outage, which pushes each surface into building its own pre-render validation. Provide the boundary AND keep the validation: they fail differently and the cheaper one should win first."
- **Convention candidate** — "An error boundary's fallback is a redaction boundary: `error.message` can carry content derived from untrusted payloads, so it is never rendered."
- **Architecture-doc note candidate** — `§11`: renderer render-time failure containment, and its explicit non-coverage of async/handler failures.
- **Future TODO — operational** — persistent error reporting needs a preload channel (`bridge.ts:101-109` + `inventory.json` move together); deliberately out of scope here.

## How to invoke

1. **Read this brief end-to-end**, including "Things to flag at Step 2.5." Read `Copilot.tsx:129-143` before designing — it is the prior art.
2. ⚠ **Verify the premises.** Every `file:line` is a claim from a read, not gospel. **A brief that contradicts the code is a FINDING, not an instruction to follow carefully.** I already had one premise corrected while writing this (I assumed a logging channel existed; it does not) — that correction improved the brief, and another one would too.
3. **Run `/tdd renderer_error_boundary`.**
4. **Step 2.5** — send the test-design write-up: one `Asserts:` line per test **plus the coverage map** (each acceptance bullet → its covering test, or an explicit `not-tested-because:`). ⚠ **The one-site-or-both decision must be resolved at Step 2.5, not at Step 9** — it changes which acceptance bullets are coverable. Reply will be `APPROVED.` / `TWEAK:` / `ADD:`.
5. ⚠ **SHARED TREE — three implementers, one checkout.** Every commit, all three steps: `git diff --cached --name-only` **BEFORE** · chain `add && commit` in **ONE** invocation · `git show --stat` **AFTER**. Step 3 catches what 1–2 miss. Per-file `git add`; never `-A` or `.`. The three code areas are disjoint; the real collision surface is shared docs — which you should not be touching at all.
6. **Step 9** — categorized flags + ship-ask. Include: the site decision + any uncovered crash class, the design-doc check, and the exact `Copilot.tsx` line that goes stale.

**Your session doc number is 131** — assigned by the orchestrator, not derived. Do not compute it yourself.
