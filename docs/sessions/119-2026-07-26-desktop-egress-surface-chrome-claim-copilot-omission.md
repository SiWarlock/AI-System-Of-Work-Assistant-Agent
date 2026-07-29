# 119 — desktop: 9.10-C egress surface · the false chrome claim · the Copilot omission trace

**Date:** 2026-07-26
**Track / role:** main · desktop-implementer
**Predecessor session:** `docs/sessions/118-2026-07-26-worker-noteslug-livingvault-zeroegress.md`
_(back-link owed: 118 is another implementer's session doc. Following the precedent 118 itself set, I did not edit another implementer's artifact — see Open follow-ups.)_
**Successor session:** `docs/sessions/120-2026-07-28-desktop-copilot-renderer-parity.md`

---

## What landed

| Commit | Task | Substance |
|---|---|---|
| `7e251b0e` | **9.10-C** | Per-workspace egress posture surface + owner revoke (⚠ rule-5). 11 files, +921/−5, +26 tests. |
| `5d56f00f` | **#10** | Removed the hardcoded `Egress: local-only` chrome claim (⚠ rule-5, was LIVE). 4 files, +119/−28, +3 pins. |
| `d0886ea4` | **#12 / 9.24** | Copilot egress-notice omission: **traced, found unreachable**, pinned. 1 file, +121, **zero production change**. |

Desktop suite at close: **465 passed / 0 failed**. Typecheck (node/web/testdom) + `build:sow` clean.

---

## Decisions made

- **9.10-C is status + revoke only — no re-ack affordance.** The ack direction is an owner-gated provisioning-time crossing and the worker exposes no re-ack command. Pinned as an ABSENCE at two layers: the client module exports (exact-equality + name regex) and an exact control INVENTORY over every interactive node in *both* posture states.
- **Renderer-local `UiSafeEgressStatusView`** (3 fields) mirroring `cross-workspace-link.ts`, not a `@sow/worker` type import (desktop L5). Runtime guard is the allowlist reconstruction. ⚠ Documented pair, not compiler-enforced: a worker-side field rename degrades to "posture unavailable" at runtime — the honest direction.
- **A per-workspace read verifies the returned id EQUALS the requested one.** Found in review: `status.workspaceId` was validated, carried, and never used — the tell. A foreign payload now folds to UNKNOWN instead of rendering under another workspace's label.
- **Deleting a false safety claim needs no truthful replacement first.** The honest interim is showing nothing; the truthful scope-aware pill rides #8 once 9.22 makes the producer honest.
- **A no-claim pin must be DIRECTION-AGNOSTIC and subtree-scoped.** The approved 3-phrase blocklist let 20/25 plausible restorations through and passed `Egress: cloud-allowed` green — the identical defect. The toolbar may now not mention egress at all; the disjoint left-rail nav noun stays legal.
- **9.24 is a characterization slice.** The trace concluded case 3 is unreachable, so the deliverable is a verified invariant + pins, not a fix. Zero production change is the correct outcome, not a non-delivery.

## Decisions explicitly NOT made

- **`zeroEgressOnly` is read but NOT rendered** (9.10-C acceptance bullet 1). The producer returns `!acknowledged`, not the documented local-provider pin, so the pill would assert "content stays local" on every personal workspace while it egresses to Claude. Deferral **declined by the owner** — the bullet is recorded UNMET and **task #8** is how it gets met, over 9.22's truthful signal. Not waived.
- **Case 2 of the Copilot notice** (non-Employer-Work cloud egress renders nothing) is an **owner-chosen posture**, deliberately left unchanged and pinned so it can't drift under cover of a bug fix. The tension is real — a personal cloud answer is indistinguishable from a local one — and is recorded for deliberate revisiting, not resolved here.
- **`ConnectionPill`'s glyph left alone.** It reuses the deleted badge's byte-identical green shield-with-checkmark and now sits in the vacated slot, so the toolbar still shows a green shield where the assurance used to be. A visual change to a correctly-derived component doesn't belong in a rule-5 deletion commit. **Must not outlive #8 / the owed `/design-review`.**
- **`/phase-exit 9` NOT started** (orchestrator instruction). Blocked by 9.21 (explicitly `Blocks:`) + the outstanding `[~]` legs, and needs owner-approved deferrals.

---

## TDD compliance

**Clean, with two deviations that are documented rather than hidden:**

- **9.10-C** — RED confirmed for the right reason (module-not-found on `renderer/lib/egress-status`; missing "Egress" nav item), then GREEN. All post-review hardening (workspace-id identity check, stale-read guard, retry, armed-confirm reset) was **also written test-first**, RED confirmed before each fix.
- **#10 — one test's first RED was for the WRONG reason.** The structural pin failed under jsdom with `fileURLToPath` throwing (an infrastructure error, not an assertion). Caught at Step 3, moved to the node tier, and non-vacuity then proven against the committed state (`HEAD` carried 2 offending lines per file; the working tree 0) rather than by mutating a shared tree. ⚠ My in-file rationale for the tier move was **factually wrong and corrected after measuring**: `import.meta.url` IS a `file:` URL under jsdom; it is the static `new URL("<literal>", import.meta.url)` form that Vite's web transform rewrites to an asset URL.
- **#12 — no RED by construction** (characterization slice: the behaviour already existed). Substituted **mutation testing**: each load-bearing assertion was confirmed by breaking the behaviour, observing the failure, and restoring clean. Assertions with no plausible current mutation are labelled in-file as future-proofing rather than presented as proven. Deliberate, documented deviation — not a violation, but it means the pins' value rests on the mutation evidence, which is recorded in the commit message.

**Two of my own tests were replaced for passing-for-the-wrong-reason**, both caught before commit:
1. A stale-read pin passed because a sibling row's fixture was stealing the deferred resolver — the test asserted nothing about the row it named.
2. `non_employer_cloud_egress_behavior_unchanged` **could not observe what its name claimed**: the renderer keys the notice solely on field presence and never sees workspace type, so the scope argument was decorative and the test duplicated an existing branch. Replaced with a pin on the scope-blindness itself, which fails on the specific wrong fix.

## Cross-doc invariant audit

**Clean — no model field changes in any of the three commits.** Verified: none of `7e251b0e` / `5d56f00f` / `d0886ea4` touches `packages/contracts` or `packages/domain`. 9.10-C consumes the existing `UiSafeEgressStatus` projection via a renderer-local view type; #10 is a deletion; #12 is tests-only. Nothing was flagged at Step 9 as a cross-doc invariant change, and nothing is owed.

## Reachability

- **9.10-C** — nav `NavLink surface="workspace-settings"` (`AppShell.tsx`) → `navigate` → `App.tsx` render branch → `EgressSettings`; read → `live.ts createEgressStatus` → `systemHealth.egressStatus`; revoke → `live.ts createRevokeEgressAck` → authed `egressCommand.revokeEgressAck`. No test-only references.
- **#10** — deletion from an existing entry point; `AppShell` renders on every route and the pin mounts it directly.
- **#12** — no new entry point; `CopilotTurn` already renders on the Copilot sidebar for every turn.

**No tested-but-unwired features.**

---

## The 9.24 trace (recorded here because it is the part most likely to be lost)

Absence of the Copilot notice is overloaded **three** ways: (1) local/zero-egress — nothing to disclose; (2) non-Employer-Work cloud egress — **owner-chosen** silence; (3) the signal didn't arrive — the defect. **Case 3 is NOT reachable on the live path.** The legs that close it:

- `egressProcessor` is **`.optional()`, not `.catch()`** — the field can never be silently stripped; only the whole answer can fail.
- A failed/rejected ask renders an **explicit `ASK_FAILED` turn**, never a plausible answer with a missing notice. This is the renderer-side property this slice pins.
- **Both real synthesis adapters fail closed on a non-Claude route before any egress**, and `buildCopilotDeps` pairs `synthesis`+`routeSelector` under one ternary so they cannot skew. *This* is what prevents "egressed on a route the classifier called local" — the single-chokepoint argument alone does not.
- Supporting: the posture adapter carries a workspace-id read-back re-gate; the pre-veto retrieval seam enforces loopback (incl. the userinfo-spoof form).

⚠ **CORRECTION — the leg I got wrong.** I claimed at Step 2.5 that an invalid `egressProcessor` **hard-rejects** the whole answer. That is **too strong**: `uiSafeSummaryLine` admits any single-line string ≤1024, so it rejects multi-line/over-length/empty but **NOT a URL- or path-shaped label** (unlike the sibling `citationId`'s `uiSafeOpaqueRef`). The conclusion survives on the `.optional()` leg; the guarantee as I stated it was false, and it had already been accepted. Pinned as characterization (`a leak-shaped processor label renders VERBATIM`) so a future tightening is deliberate rather than discovered in a banner.

**The server-side legs are already pinned by pre-existing worker tests** (tunneled-local notice, hard-reject, per-procedure threading) — the invariant is better covered than my Step-2.5 write-up implied.

---

## Open follow-ups

**Rule-5 findings raised this session (all verified in code before escalating, all now tracked):**
- **9.23** (worker) — re-provision silently restores a revoked egress ack: `provisionWorkspace` re-seeds *before* its existence check, so the revoke 9.10-B shipped is not durable. **9.21 is exactly a re-provision path**, so this goes live when 9.21 lands. Treated as a prerequisite for calling 9.10 done.
- **9.22** (worker) — `zeroEgressOnly` is `!acknowledged`, not the documented local-provider pin. Blocks **#8**.
- **9.27** (worker) — `toUiSafeCopilotAnswer(candidate, egressProcessor?)` takes the notice as an **optional trailing positional**: a fourth skill that forgets it yields a servable, notice-free answer **with every test green**. The sharpest remaining regression path.
- **9.28** (renderer) — `Copilot.tsx` is the ONLY reader of `egressProcessor`, while `copilotBriefing`/`copilotConcept` already return notice-bearing answers with **no renderer consumer**. The first surface rendering one without reading the field re-opens case 3.
- **#13** — precondition on any future Copilot history/restore: rehydrating a stored employer cloud answer without its notice IS live case 3. The honest fix *then* is a derived disclosure state on the turn view (a contract/producer question at that point).
- **#14 / 9.26** — the Copilot answer is the only renderer read path with **zero** client-side re-validation (`live.ts` has 4 `safeParse` re-gates; `copilot-ask.ts` has 0).

**Desktop work queued:** **#8** (deliver 9.10-C acceptance bullet 1 over 9.22's truthful signal — and fold in the `ConnectionPill` glyph); **9.10-D** audit-link, which is the *same affordance* as 9.5's remaining leg and needs a worker producer first (`UiSafeRecentChange.changeId` exists as the handle, but **no `audit.` procedure exists in `queries.ts` at all**) — sequence as ONE worker→desktop pair.

**Doc/process:**
- **Back-link owed on 118** (another implementer's session doc; not my territory to edit — orchestrator may fill it).
- The 9.24 trace conclusion must live in the **§5/§11 arch note**, not only in a desktop test file — every leg it rests on is worker-side and the worker track never reads desktop tests. Orchestrator confirmed they're writing it with the corrected reasoning.
- **Phase-9 "Acceptance criteria (9)" is stale** — still lists 9.9/9.12 as absent and 9.11 first-run as incomplete, all since landed. Must be reconciled before the gate runs or it audits against a false blocker list.
- Root has **no `format:check` script** and no ESLint anywhere (every `lint` is `tsc --noEmit`), so `/preflight` steps 2–3 are structural no-ops — `/preflight` currently *claims* a lint gate it does not run. Matches carry-forward item 7.

---

## How this was built (worth keeping)

The most consequential finding of the session came from a *verification step, not a task*: checking that no zero-egress claim survived my own 9.10-C slice surfaced a hardcoded `Egress: local-only` badge asserting local-only egress on **every screen**, while employer and personal content egress to Claude. The ranking argument (static vs data-derived · global vs one pane · shipping vs inert) is what moved it ahead of the producer fix in the queue.

Then the same error shape appeared three more times, at three different altitudes: my egress-settings pin was blind to the chrome *around* it; the orchestrator's first doc sweep searched for phrasings it already knew rather than the topic (nine mandate sites, not four — including a locked **generation prompt** that would have regenerated the badge by construction); and my own approved no-claim pin passed the opposite-direction claim. **Ban the topic in a surface that cannot know it — don't blocklist the phrasing that happened to be wrong.**
