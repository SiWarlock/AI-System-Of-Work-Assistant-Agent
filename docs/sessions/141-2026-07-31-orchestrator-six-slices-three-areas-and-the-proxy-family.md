# Session 141 — orchestrator: six slices, three areas in parallel, and a round that named its own defect family

**Date:** 2026-07-31 · **Role:** orchestrator (`main-orchestrator`, single-track `main`, root checkout)
**Predecessor:** `137-2026-07-30-orchestrator-round-seven-slices.md` · **Successor:** `146-2026-07-31-orchestrator-the-audit-that-could-not-finish.md`
**Round commits:** `1930ed74..HEAD` — count with `git rev-list --count 1930ed74..HEAD`, ⛔ **never quote a count from prose**
**Narrative + all rulings:** `docs/archive/IMPLEMENTATION_LOG.md`, entry `2026-07-31`
⛔ **NOTHING PUSHED** — owner-run. Count with `git rev-list --count origin/main..HEAD`.

---

## ⭐ READ THIS FIRST — what you inherit that is NOT in the tracker

**1. `docs/briefs/239-13.8f-C-…` (`@aacd9ee0`) is AUTHORED AND DELIBERATELY UNDISPATCHED.** Written mid-round *while I still held the 13.8i context*, at the lead's instruction, precisely so you would not re-derive it with a fresh worker idle. ⛔ **It must not go out before its precondition is checked** — 13.8f-C needs a `requiresApproval !== false` filter, **and that filter IS 13.8i's §9.8 territory**, so dispatching it before 13.8i would have silently split a tracked task. **13.8i has now landed (`a7d4ae9d`), so the precondition is satisfied** — but the brief tells its reader to verify that rather than trust it, and to **read 13.8i's shipped diff before designing**, because 13.8f-C is its meeting-path analog and divergence needs a reason.

**2. The 13.8g-C ruling's REASONING, which matters more than its outcome.** The lead ruled direction (ii) **refined**, owner-delegated. What a successor must not lose:
- ⛔ **NOT a global widening of `isPrimitiveOrTbd`** — that predicate is generic across every `ExtractionField`, so widening it would flip a rule-2 surface from default-closed to default-open. **That defect was in MY framing of the option; the lead caught it.**
- ⭐ **Forgery answered BY CONSTRUCTION:** JSON Schema's `properties` (declared keys) beats `additionalProperties` (scalar-only rest), so default-closed is free **and a payload structurally cannot add itself to `properties`.** "The schema declares, the payload never does" is a property of the shape, not a rule someone upholds.
- ⛔ **The guards are NOT tradeable** — pre-ruled *before* Step 2.5 so it wasn't decided under pressure. ⭐ **It had been written for ONE hazard and turned out to cover THREE**, which is the argument for pre-ruling the principle rather than the instance.
- **The `decisions` gap:** declaring only `attendees` would have left a dead branch under a task marked closed — **a fresh instance of the defect the task exists to close.** Ruled: declare both, and **list-ness has exactly ONE source.**

**3. Leg C's timing — knowledge unblocks at leg A's STEP-2.5, not leg A's commit.** The shape settles at the review checkpoint. Leg A has since landed entirely, so **`13.8g-C leg C` is dispatchable NOW**: verify `normalizeAttendees` needs no change. ⚠ **If it DOES need changing, that is a FINDING against the lead's ruling and must be surfaced loudly, not absorbed.**

**4. Phase 25/26 is ONE thing, not two cells.** The labels are wrong (ruled). ⛔ **But do not just relabel** — the **Track column means two different things on different rows** (Phase 25 by *domain*, the Track map by *territory*), so fix the ambiguity first (state the sense in the legend), *then* the rows. Fixing 25/26 alone makes the next mislabelled row **harder** to spot, because the table will look audited. ⚠ **Phase 26 was inferred, not audited — probable, not established.**

**5. Contracts L40 is AMENDED, and the amendment's reason outranks its content.** Its *"the receipt's `planIds` IS the batch-undo unit"* clause is superseded (see below). ⭐ **A lesson silently outlived by a later slice is a FALSE-GREEN IN THE LESSONS INDEX** — the thing every `pin:`, enforcement line and cross-reference rests on. **Amending a contradicted lesson is part of the slice that contradicts it, not follow-up.**

---

## What was built

| Task | Commit | One line |
|---|---|---|
| 9.41-B | `aa949ee7` | the `auditDrill` resolver — `auditRef` never leaves the worker |
| 9.41-C | `3640c0e4` | the desktop affordance ⇒ ⭐ **the 9.41 arc is COMPLETE** |
| 13.8g-B + 9.37(b) | `661a720c` | attendee threading (**ships INERT**) + the doc-header rider ⇒ **9.37 closed** |
| 13.8i | `a7d4ae9d` | ⚠**SAFETY** — the PROPOSE tier into §9.8 Approvals |
| 13.8g-C leg A | `5eaf33f5` | ⚠**rule-2** — declared list-valued extraction fields |

**Three areas ran in parallel** (worker · desktop · contract). **Knowledge stayed idle on established grounds** — an exhaustive sweep (both state forms, all 26 phases, all 61 `packages/knowledge` occurrences cross-checked) returned *nothing dispatchable*.

## ⛔ Two things that shipped and do NOT do what their names say

**Both are contracts L118 aimed at a task title, and both are the likeliest thing a successor mis-quotes.**
- **13.8g-B "threads attendees"** — and yields **zero refs**, because the extraction gate admitted only scalars until `5eaf33f5`, and **leg B has not landed**, so nothing honours the new declaration yet.
- **13.8i "routes the PROPOSE tier into Approvals"** — it built the **mechanism** and left the **binding**. `ProposeKnowledgeApprovalPort` has **zero composition-root bindings**, so a PROPOSE plan cannot mint a live Approval card **and would not even if the leg were armed — arming and binding are separate gaps** (`13.8i-B`).

⚠ **13.8i's commit body says the binding is absent but opens "ships behind the existing dormancy,"** which reads as unarmed-as-expected. The lead's stronger wording **crossed the commit**; ⛔ history was **not** rewritten (shared tree, live agents — L83), so **the tracker tick carries the imperative form**.

## Decisions made

- **13.8i's `planIds` deviation — ACCEPTED, and the implementer's reason was stronger than they argued.** The batch-undo unit is **what COMMITTED**, not what the producer emitted. **13.8d's tier split had ALREADY diverged the two sets — unnoticed, because nothing consumed the field.** Forwarding `receipt.planIds` would reference plans with no revision. **The task's wording predates approval-routing existing** (L79).
- **13.8i (a)/(b) as ONE commit, not the two the brief required.** The implementer established by diff that they share the withhold loop's branches *and* all three return sites — one contiguous hunk. **The split rule exists to keep a safety change reviewable; a contorted split scatters it.** Purpose over letter.
- **Desktop's `/session-end` started early**, deviating from the lead's stated sequence — **their REASON was slice atomicity, which covers worker, not desktop.** Flagged rather than taken silently; the lead confirmed the instruction had been broader than its reason.

## Decisions explicitly NOT made

- **`9.40`'s product fork** — desktop's only unblock. ⛔ Its second branch **deletes a specified affordance**, and *"an area is idle"* is not a reason to do that. Named as available, explicitly not recommended.
- **Phase 25/26 relabelling** — ruled but deliberately not executed; see above.
- **`/phase-exit 9`** — untouched, still unspent by design.

## ⭐ The round's finding — a FAMILY, banked as contracts L118

*A **proxy** standing in for the **property**.* Seven members surfaced or were re-read as instances **in one evening**: presence→safety (L117) · lines-changed→progress · conventional-location→necessary-location · a-gate-that-runs→a-gate-that-checks (L89) · a-test-that-runs→a-test-that-discriminates (L75/L84/L90) · the-tracker-says-X→X-is-true · a-summary→what-it-summarises.

⭐ **Every check involved was CORRECT.** The proxy isn't wrong; it answers a different question than the one reported. ⇒ ***Name the property you actually measured, then ask whether it is the property you care about.*** The tell is a sentence whose **verb of measurement and noun of claim disagree**.

⚠ **Its limit is recorded so it is not over-applied and then discarded: NOT "distrust proxies."** Measuring the real property is often impossible. **The rule is REPORT THE PROXY, NOT THE PROPERTY** — a stated proxy invites the reader to notice the gap; a proxy reported as the property closes the question.

⭐ **Why three surfaced within an hour: we started saying the measured property out loud.** The pattern wasn't hiding — it was invisible while each of us reported conclusions instead of measurements. **That is an argument for the reporting discipline over any detector**, and it is why L118's enforcement point is *any sentence reporting reassurance*.

## Posture the successor should inherit

**1. My corrections ran BOTH directions this round, and the downward ones are the ones to watch.** I was corrected on: the global-widening framing (lead) · a wake message inferring position from a diff stat (worker) · telling contract a fixture was missing when it existed (self-caught before sending) · claiming "both reviews are clean" without saying whose session ran them (lead). ⛔ **I also nearly sent a false doubt DOWN to an implementer who had done it right** — banked as L116's third instance, because **a false doubt sent up meets someone with standing to push back; sent down it meets someone with a reason not to.** Hold a downward doubt to a **strictly higher** bar.

**2. Pre-ruling the PRINCIPLE beat ruling the instance, twice.** The guards-not-tradeable pre-ruling was written for one hazard and covered three. The reviewer-529 bound was written before anyone was at 84%. ⇒ **When you can see a decision coming, make it while nobody is under pressure — and write it as a principle, because the instance you can see is rarely the only one.**

**3. Write to disk as you go, not at the handoff.** The task list **vanished mid-close-out**, taking every `step25`/`rulingChannel` field with it — **L51 demonstrating itself in real time.** It cost nothing *only* because each ruling had already been written to the tracker. ⛔ **Task metadata is session-scoped. The tracker is not. Never let a ruling live only in metadata.**

**4. `plan-lint` as a GATE, not a receipt.** I shipped one violation early by chaining the lint into the same invocation as the commit (**L109**, one round after it was banked). Run it as its **own step**; it caught two later problems before they landed.

## Open follow-ups

- **`13.8i-B`** — the composition-root binding. Required before any PROPOSE plan reaches a human.
- **`13.8g-C` legs B (worker gate) + C (knowledge verify)** — C is dispatchable now.
- **`9.40`** — desktop's blocker; a product decision.
- **Phase 25/26 Track column** — fix as one thing.
- **Carry-forward triage:** *0 deleted, 0 inlined, 0 deferred, 0 spread, 8 kept* — with item 3's 9.41 sub-part **closed with a pointer** now that the arc completed. ⚠ **8 items sits at the soft `~7` cap** (`plan-lint` passes, which is the enforced bound). **I did NOT force-resolve at 81% context** — hasty scope calls while draining are worse than an accurate 8-item list. **Your first triage should look hard at items 7, 9 and 10.**

## Preflight

Worker's `/session-end` reported **typecheck + tests clean across the full repo graph, 20/20**, including `packages/contracts` after leg A landed. **No lint coverage exists in this repo** (`lint` is `tsc --noEmit`) — ⛔ never write "lint clean."
