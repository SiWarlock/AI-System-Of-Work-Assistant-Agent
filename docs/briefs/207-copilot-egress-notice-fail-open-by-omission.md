# /tdd brief — copilot_egress_notice_absence_is_derived

## Feature
Stop the Copilot's cloud-egress consent notice from being fail-open-by-omission: make the *absence* of the notice mean something the renderer can actually justify, so "the egress signal did not arrive" can never render identically to "there was nothing to disclose."

## Use case + traceability
- **Task ID:** 9.24 (new — see "Plan bookkeeping") · ⚠ **rule-5** · **PRE-EXISTING** (not introduced by any slice this round)
- **Architecture sections it implements:** `ARCHITECTURE.md §5` (egress veto / consent posture), `§11` (desktop surfaces), `§10` (UI-safe read-model), REQ-S-002
- **Scope note — this brief widens phase scope because** the only out-of-set token below is `§2.5`, the brief template's "shared-contract seam" SECTION NAME, not a claimed anchor (real anchors §5/§10/§11 are all in phase 9's set).
- **Origin:** desktop's #10 Step-9 correction to L56's scope. They verified their "only instance" claim held for `renderer/chrome/` and named this sibling as a **different mechanism** of the same defect class.
- **The code:** `apps/desktop/renderer/surfaces/copilot/Copilot.tsx:96-104` — `turn.egressProcessor !== undefined ? <notice/> : null`.
- **The contract:** `packages/contracts/src/api/ui-safe.ts:474-484`. `egressProcessor` is OPTIONAL; its **presence** is the Employer-Work egress notice, set only when raw Employer-Work content was synthesized by a cloud processor with egress acknowledged ON. Value is a server-derived processor label, never raw content, single-line bounded.

## ⚠ Absence currently means THREE different things — and only one of them is a defect
Read the contract line carefully: the field is *"ABSENT for a local/zero-egress answer AND for non-Employer-Work cloud egress (those need no special notice)."* So a missing notice collapses:

1. **Local / zero-egress answer** — genuinely nothing to disclose. ✅
2. **Non-Employer-Work cloud egress** — content *did* go to a cloud model (e.g. a personal-workspace question answered by Claude), and the owner deliberately chose no notice for that case. ✅ **by owner decision**
3. **The signal did not arrive** — producer didn't set it, a projection dropped it, validation rejected the value, or an older payload shape lacks it. ❌ **this is the defect**

**Case 3 is the whole scope of this slice.** Case 1 is correct. **Case 2 is an owner-chosen product posture and is explicitly OUT of scope** — adding a notice for personal-workspace cloud egress would change a decision the owner made deliberately ("cloud is fine WITH a notice" applies to Employer-Work). If you believe case 2 should change, that is a **Step-2.5 escalation to the lead**, not a design call to take in this slice, and not something to fold in quietly.

## Acceptance criteria
- [ ] **FIRST, establish reachability of case 3 and report it** — can `egressProcessor` be absent on a turn where raw Employer-Work content *did* egress to a cloud processor? Trace the producer → projection → renderer path and state the answer with `file:line` evidence. Everything below is scoped by that answer (see Step-2.5 Q1); a "not reachable" conclusion is a legitimate outcome and changes this slice's shape.
- [ ] The renderer distinguishes **"no disclosure required"** from **"disclosure state unknown"**, and the unknown case never renders as the safe/silent one.
- [ ] If a present-but-INVALID `egressProcessor` (over-length, multi-line, failing `uiSafeSummaryLine`) can reach the renderer or cause a silent field drop, that path resolves to **unknown**, not to absent-and-silent. Pin it.
- [ ] Case 1 remains silent — a genuinely local answer must not grow a notice or a warning (that would train the owner to ignore the surface, and it is not what the contract says).
- [ ] **Case 2 behavior is unchanged** — pinned explicitly, so a future refactor can't quietly start disclosing personal cloud egress and call it a bug fix.
- [ ] Nothing raw crosses: the notice still renders only the server-derived label, and an unknown-state rendering discloses no content, no route, no processor guess (rule 7).
- [ ] `pnpm build:sow` then `/preflight` clean.

## Wiring / entry point (Step 7.5)
No new entry point — `CopilotTurn` already renders on the Copilot sidebar for every turn. Confirm with `/wired` that the changed branch is the one the live sidebar renders, and state whether the unknown state is reachable from the real producer or only constructible in tests (if only constructible, say so plainly rather than implying live coverage).

## Files expected to touch
**Modified:** `apps/desktop/renderer/surfaces/copilot/Copilot.tsx` · the Copilot turn-view mapper in `renderer/lib/` (wherever `CopilotTurnView` is built) · `renderer/styles.css` only if an unknown-state style is needed · desktop tests.

**Do NOT touch:** `packages/contracts/**` (if the *contract* needs a distinct unknown signal rather than an overloaded optional, that is a frozen-contract question — **flag at Step 2.5, do not edit**), `apps/worker/**`, and all orchestrator-territory docs.

## RED test outline (Step 2)
1. **`unknown_disclosure_state_is_not_rendered_as_safe`** — Asserts: a turn whose egress signal is unknown/undetermined renders a distinct unknown affordance, not the silent no-notice path. Why: rule-5 — absence must be derived, not assumed (L56).
2. **`invalid_processor_label_resolves_to_unknown`** — Asserts: an over-length / multi-line / schema-failing label yields the unknown state, never silent-absent, and never renders the raw invalid value. Why: a dropped invalid field is the most likely real-world route into case 3.
3. **`local_answer_stays_silent`** — Asserts: case 1 renders no notice and no warning. Why: don't create alarm noise on the safe path; matches the contract.
4. **`non_employer_cloud_egress_behavior_unchanged`** — Asserts: case 2 renders exactly as today. Why: it's an owner-chosen posture — pin it so it can't drift under the cover of a fix.
5. **`employer_cloud_egress_still_discloses`** — Asserts: the present-and-valid path still renders the consent notice with the server label. Why: non-vacuity — the fix must not suppress the disclosure it exists to protect.
6. **`unknown_state_discloses_nothing_raw`** — Asserts: the unknown rendering contains no content, no route, no guessed processor. Why: rule 7.

## Cross-doc invariant impact
- **Model field changes:** none *if* the renderer can derive unknown locally. If it cannot — i.e. the honest fix requires the worker to send a distinct tri-state instead of an overloaded optional — that is a **frozen-contract + producer change** spanning contracts/worker, so **stop and flag at Step 2.5**; I'd split it producer-first rather than let a desktop slice reach across.
- **§2.5-seam model touched?** `UiSafeCopilotAnswer` is a §10 read-model construct, not an Appendix-A model — but it IS a shared contract surface, so any change to it is orchestrator-routed, not desktop-local.
- **Orchestrator doc rows to write hot (Step 9):** `ARCHITECTURE.md §5`/§11 — the three meanings of an absent notice, which one is owner-chosen, and how unknown is surfaced.

## Things to flag at Step 2.5
1. **What did the reachability trace conclude?** This is the question the slice turns on. (a) case 3 unreachable — the producer always sets it on an employer cloud turn and no drop path exists ⇒ the slice shrinks to a documented invariant + a pin that *keeps* it unreachable; (b) reachable via a drop/validation path ⇒ the full fix; (c) reachable because the producer simply may not set it ⇒ producer-first, worker leg before desktop. My default vote: **report the evidence and let the answer pick**; I'm not pre-voting a conclusion I haven't traced. Do not implement past what the trace supports.
2. **Where does unknown get derived — renderer or producer?** My default vote: **renderer, if it can** (a locally-derivable unknown avoids a contract change), but if the renderer genuinely cannot distinguish "absent because safe" from "absent because dropped", say so — that's finding (c) and it's a producer change, which is the honest answer even though it's the more expensive one.
3. **What does the unknown affordance look like?** My default vote: **quiet and specific** — a short "disclosure state unavailable" line in the same slot, not an alarm. It must not imply egress happened (that would be its own false claim in the opposite direction — see L62 on direction-agnostic honesty).
4. **Does case 2's silence deserve its own visible treatment?** My default vote: **out of scope, escalate if you disagree.** Worth noting the tension for the record: a personal-workspace answer synthesized in the cloud shows nothing, so the UI cannot distinguish it from a local answer — that is the owner's call and may be worth revisiting, but not inside a bug-fix slice.

## Dependencies + sequencing
- **Depends on:** nothing. Unblocked, desktop-only, disjoint from worker's 9.22 and knowledge's 13.8j.
- **Blocks:** nothing. Independent of #8 (which waits on 9.22).

## Estimated commit count
**1** — or **0 code commits** if the trace concludes case 3 is unreachable, in which case the deliverable is the documented invariant plus the pin that keeps it so. Say which at Step 2.5.

## Lessons-logged candidates anticipated
- **Convention candidate** — "A derived-presence indicator is only honest if its ABSENCE is also derived; an overloaded optional that means both 'safe' and 'unknown' is a fail-open by omission."
- **Convention candidate** — "When an optional field's absence carries semantics, enumerate every meaning of absent before changing the consumer — one of them may be a deliberate product decision, not a bug."
- **Architecture-doc note candidate** — §5/§11: the three meanings of an absent Copilot egress notice and how unknown is surfaced.

## How to invoke
1. Read this brief; note that **case 2 is owner-chosen and out of scope**, and that acceptance item 1 is a *trace*, not an implementation.
2. Run `/tdd copilot_egress_notice_absence_is_derived`.
3. Step 0 restate → **Step 2.5 with the reachability evidence** → then implement only what the trace supports.
4. Step 8: `security-reviewer` (**invariant**, rule-5) + `code-quality-reviewer`.
5. `pnpm build:sow` before `/preflight`. **Step-9 → the LEAD** (rule-5; they're already tracking this finding with the owner).
