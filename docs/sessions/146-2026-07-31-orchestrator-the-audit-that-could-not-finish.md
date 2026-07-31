# Session 146 — orchestrator: the audit that could not finish, and a premise that did not survive contact with the code

**Date:** 2026-07-31 · **Role:** orchestrator (`main-orchestrator`, single-track `main`, root checkout)
**Predecessor:** `141-2026-07-31-orchestrator-six-slices-three-areas-and-the-proxy-family.md` · **Successor:** _(next orchestrator session doc)_
**Round commits:** `214fc8a9..HEAD` — count with `git rev-list --count 214fc8a9..HEAD`, ⛔ **never quote a count from prose**
**Narrative + all rulings:** `docs/archive/IMPLEMENTATION_LOG.md`, entry `2026-07-31 (second round of the day)`
⛔ **NOTHING PUSHED** — owner-run. Count with `git rev-list --count origin/main..HEAD`.
**Resume:** `docs/team-handoffs/021-…` (self-contained by design — the owner restarts the machine and types one line).

---

## ⭐ READ FIRST — what you inherit that is NOT in the tracker

**1. ⛔ THE ARMING BLOCK IS NOT CAUTION ANYMORE — IT IS EVIDENCE, AND THE EVIDENCE IS AN ABSENCE.** Task 24.6 ran and **is not satisfied**: 4 of 6 partitions returned, **AC-3 and DOC-1 died on an org monthly spend limit with zero output.** The two that died are the two that matter most for the task's own stated purpose — **DOC-1 *is* constraint 3**, whose text says *a code-only audit would have CLEARED the archetype defect*, and **AC-3 was the archetype's own surface** (the desktop renderer where the hardcoded "Egress: local-only" pill lived). ⇒ **run 1 IS the code-only audit 24.6 exists to prevent.** Read `docs/audits/001-…` before touching any arming flag. ⛔ **Round 2 is AC-3 + DOC-1 ONLY, plus the coverage ledger — do NOT re-run AC-1 or FO-1**, which succeeded and produced the round's most severe findings (24.7, 24.8, 24.9).

**2. ⭐ THE AUDIT'S METHOD FINDING OUTRANKS EVERY DEFECT IT FOUND.** *"Iterations to dry" measures **search-key saturation**, not **surface coverage** — and 24.6's constraint 1 asks only for the former.* Two partitions **honestly** reported reaching dry at **~16%** of their surface. **Six partitions each reporting "dry" would have read as a swept repo.** Recorded as a defect in 24.6's own constraint 1, Done-when amended to require a coverage ledger. **This is contracts L118 aimed at the audit's own instrument: the verb of measurement and the noun of the claim disagree.** ⚠ The largest unreached surfaces are **all of `packages/knowledge/src/synthesis/*`** and **almost all of `packages/integrations/src`** — **exactly what arming touches.**

**3. ⛔ MY OWN BRIEF SHIPPED A FALSE PREMISE, AND I HAD ALREADY WRITTEN DOWN MY DOUBT.** Brief 241 asserted *"the sink instance already exists at boot (`boot.ts:1756`)"* **while asking, in its own Step-2.5 section, whether that line sat inside a conditional scope.** The question is the proof I knew the premise was unestablished. I measured *"the identifier appears in `boot.ts`"* and reported *"an instance exists at boot."* ⭐ **The channels are not equal — an implementer builds from the premises and reads Step-2.5 as review scaffolding, so a brief that asserts X and asks whether X is true SHIPS X.** Banked as **L122**. ⚠ **Not L118** (the measurement was correct and *known incomplete*); nearest relative is L94, but worse — a correction at least knows it is fixing something.

**4. ⭐ THE ANSWER WAS ALREADY IN THE LEDGER — L59, banked from the very task 13.8i-B depends on.** *"When the consumer is workflow-SANDBOX code, the arming gate belongs in the ACTIVITY; sandbox code cannot read boot config."* I wrote a composition-root parameter-threading brief past it. `worker-implementer` rediscovered it from an in-code comment. ⇒ **a brief that names a dependency INHERITS that dependency's lessons** — that is L122's second instance and its cheap mechanical half.

**5. ⭐ THE GUARD THAT CAUGHT IT WAS WRITTEN FOR A DIFFERENT HAZARD.** Brief 241's hard-line guard existed for a possible *arming crossing*. It caught a **premise defect.** Second confirmed instance this round of *pre-rule the principle, not the instance* — and it was cheap **because it fired before Step 1**, so no RED tests were written against the wrong target.

---

## What was built (implementer slices this round)

| Task | Commit | One line |
|---|---|---|
| 13.8f-C | `8199a61f` | sibling entity-page plans commit on the meeting path — in the WORKFLOW, after the main commit |
| 13.8g-C leg C | `b0319823` | the declared-list ⟷ consumed-as-list correspondence pin; **no production change needed** |
| 9.40 | `d5e987d4` | the Copilot proposal-row **mechanism deleted**, ⭐ **goal re-tracked as 9.42** |
| *(cross-area)* | `08340160` | a **1-line** assertion-preserving fixture conformance fix in `packages/evals` |

**13.8f-D CLOSED** by 13.8f-C rather than by its own slice — verified against **both** Done-whens before closing, original finding preserved verbatim.

## Decisions made

- **9.40 → delete the mechanism, keep the goal.** ⭐ **The deciding evidence was upgraded from inference to measurement at briefing time, and it is a better argument than "no producer exists":** the button's own comment recorded it as honest-disabled *"until the Approvals surface + navigation land with that page"* — **that precondition HAS landed, and the affordance still cannot be wired**, because `proposalLabel?: string` carries no approval id. ⇒ **the SHAPE is wrong for any producer that could exist**, which kills *"just wait for the producer"* in a way *"the producer is late"* does not.
- **13.8i-B widened to BOTH construction sites, deliberately not split.** As two tasks, closing one would read as *"PROPOSE plans reach humans"* with only one path bound — **the arc's own title-vs-mechanism defect, third instance.**
- **`"never a second sink"` rewritten to forbid the BEHAVIOUR, not the OBJECT.** Two sink objects over the same repos with planId idempotency are **one minting path instantiated twice**. ⭐ *A prohibition written against the wrong noun forbids the correct fix.*
- **The four hard lines were authorized to cross and then NOT crossed** — a separate sequencing ruling put 24.6 first. **Authorization removed the human gate; it did not reorder the arc.**

## Decisions explicitly NOT made

- **`(a0)(ix)(1)`** — the root `CLAUDE.md` standing-rule amendment for L121. **Left with the OWNER by both of us, for the same reason one level apart:** I declined because writing it off my own ruling reproduces L121's provenance defect; the lead declined because he ruled the *instance* while codifying a *standing exception* is a different act on someone else's rule. ⭐ **L121 performed on L121.**
- **24.6 round 2** — not re-dispatched; a new fan-out at a teardown boundary, and blocked on the owner regardless.
- **`/phase-exit 9`** — untouched, unspent by design.

## Posture the successor should inherit

**1. ⛔ I asserted from a held belief three times tonight and was caught or self-caught each time; the pattern is the point, not the instances.** (a) The brief-241 premise above. (b) A verification where **my first two measurements were both proxies** — counting changed lines *mentioning* "9.24", then using a describe-extractor that only sees top-level tags; neither measures *"the block is unchanged."* The property is the **hunk boundaries.** (c) A measurement command that returned **9275** ambiguous citations because `L[0-9]+` also matches `ARCHITECTURE.md` line refs — the correct narrowing gives **10.** ⇒ **Every one was caught by re-measuring rather than by thinking harder. Re-measure.**

**2. ⭐ The lead was wrong twice and correcting it mattered both times — push back on the ruling channel too.** (a) A stale retracted framing survived in handoff 020's *deferred* section while its decision-log row carried the correction — **two entries in one file disagreeing, with the stale one where the owner reads first** (L94). (b) *"2 of 6 returned; AC-1/FO-1 never reported"* — **4 returned**, and FO-1 produced the night's most severe finding. ⭐ **The lead's own diagnosis of his error is the better lesson: he built the missing-list by SUBTRACTION from his own point-in-time commit message rather than by reading the file.**

**3. `plan-lint` caught a real ordering error and I mis-ordered index rows three times.** 9.42 was inserted **before** 9.41 — caught mechanically. And I inserted lessons-index rows **descending into an ascending table three separate times.** ⇒ **the tool is not the problem; the insertion habit is. Verify order after every index write** — nothing would ever have failed.

**4. An idle area is the expensive failure, and the classification is the deliverable.** The lead asked me to distinguish *"nothing queued"* from *"nothing to do."* **Contract was classified explicitly as deliberately-unqueued-and-held** — and the lead then added a *reason* to hold it (24.6's contracts-area findings are its natural territory). ⛔ **An unexamined idle area is not an answer; an examined one is.**

**5. Route an area-specific caveat to the AREA, not only into your own seal.** I asked knowledge to carry the `synthesis/*` coverage gap in its **own** session doc. **A caveat about knowledge's territory surviving only in the orchestrator's seal is filed where the area that owns it will not look** — the same return-path defect fix (i) closed for the lessons ledger, recurring at the session-doc layer.

## Orchestrator-side work landed

- **Briefs:** `240` (13.8g-C leg C) · `241` **v2, rewritten not patched** (13.8i-B — a brief whose Files list is missing a layer cannot be repaired by adding a bullet) · `242` (9.40).
- **Lessons banked:** **L119** (consumer-side correspondence pin) · **L120** (staffing ≠ permission; *a weak reason bundled with a strong one gets laundered*) · **L121** (compile-break-is-part-of-the-change, **with its boundary**) · **L122** (an unresolved premise is not written as a premise) · **L123** (⭐ ***"MUST is prose, not a gate"*** — the lead's phrase, kept verbatim, *"the whole audit in five words"*).
- **Fix (i) landed** — five area `CLAUDE.md` files now point **up** at the project-wide ledger, and the **`contracts LNN`** citation convention is adopted. Re-measured: `grep -c` was **0 in all five** before, **1 in all five** after.
- **Tasks opened:** **9.42** (9.40's goal) · **24.7 / 24.8 / 24.9** (the audit's findings) · **13.23** (INLINE-TARGETed from Carry-forward).
- **Carry-forward triaged 8 → 6:** 1 inlined, 1 deleted, 0 deferred, 0 spread, 6 kept.

## Preflight

Suites at seal: `@sow/workflows` **601/601** · `@sow/worker` **2063/2102** (39 skipped, unrelated) · `@sow/knowledge` **672/673** (1 skipped, unrelated) · `apps/desktop` **511/511** · repo-wide typecheck **20/20**. `plan-lint` **0 violations**. ⛔ **No lint coverage exists in this repo** (`lint` is `tsc --noEmit` in all 11 packages, eslint in zero manifests) — never write "lint clean."
