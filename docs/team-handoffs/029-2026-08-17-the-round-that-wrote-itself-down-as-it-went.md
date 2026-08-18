# Team Handoff 029 — the round that wrote itself down as it went

**Date:** 2026-08-17/18
**Track:** main (single-track, root checkout — no worktree)
**Predecessor:** `docs/team-handoffs/028-2026-08-14-team-shutdown-and-the-spawn-prompt-that-killed-two-sessions.md`
**Status:** ⚠ **WRITTEN INCREMENTALLY, MID-ROUND. This file is appended to as the round runs, not composed at `/team-end`.** That is deliberate — see "The structural finding" below.

---

## ⛔ Why this file exists before the round ended

**Twice in one evening a durable statement was produced inside a `SendMessage` — the one surface that dies with its session — and survived only because the recipient happened to write it down in the turn before the flag arrived.**

1. The orchestrator deferred the desktop record "by one slice," while under a standing cycle decision. It escaped by doing the write for an unrelated reason.
2. The lead wrote out a full lessons entry (`L190`) and delivered it by message, four hours after ruling on this exact defect twice, with the round's own lesson about it already in the ledger.

⇒ ***Two for two on luck. Both parties reasoned about the trap correctly; neither defused it.***

⭐ **That is the strongest available evidence that Carry-forward 6 `(a4)` — "a ruling must live where it cannot cross" — needs a STRUCTURAL answer rather than more care.** Care was present, in quantity, on both sides, both times.

**The lead's half of the structural answer is this file, written continuously.** A durable statement goes here first; the message then points at it. A `SendMessage` may carry a pointer; it may not carry the only copy.

---

## ⛔ "Nothing is carried" was true of the tracker and false of a brief

**At `/orchestrate-end` (cycle tip **`2301cb12`** — ⛔ **NOT `bc4f2559`, which is two commits early and misses the `### 24.99`/`### 24.100` filing AND the 029 ownership flag**; the lead cited the stale one and the outgoing orchestrator corrected it on its way out, same class as `028`'s `1de290d9`-not-`614bcbdc`), the outgoing orchestrator found `docs/briefs/292` UNTRACKED.** Worker had executed it and landed `a883c2f7` from it. ⇒ ***the artifact a successor would need to audit a landed safety slice existed only in one session's working tree.***

⚠ **That orchestrator had told the lead twice that nothing was carried, and believed it. It was true of `IMPLEMENTATION_PLAN.md`, true of both ledgers, and false of a brief.** ⭐ **It surfaced only because the close-out RAN THE CHECK instead of RESTATING THE CLAIM — the verify-not-assert rule, firing on its first use.**

⇒ **Standing rule for every close-out: enumerate untracked paths and attribute each one. "Nothing carried" is a measurement, not a recollection** — and the categories a person checks (tracker, lessons, architecture) are exactly the ones they remember touching. **Briefs are written early, executed by someone else, and never revisited.**

---

## Composition (single-track `main`, root checkout)

| Agent | Territory | Notes |
|---|---|---|
| `main-team-lead` | repo root | persists across orchestrator cycles |
| `main-orchestrator` | repo root | **cycling at `a883c2f7`** — successor to be spawned |
| `worker-implementer` | `apps/worker`, `packages/db`, `packages/workflows` | landed `a883c2f7` |
| `knowledge-implementer` | `packages/knowledge` | READY, frozen on `### 24.98`'s shape |
| `contract-implementer` | `packages/contracts`, `packages/domain` | READY as built, backed up out-of-repo, releases on knowledge |
| `providers-integrations-implementer` | `packages/policy`, `packages/providers`, `packages/integrations` | mid-slice on `### 24.93` |
| ~~`desktop-implementer`~~ | `apps/desktop` | **STOOD DOWN** — spawned on a retracted figure; see below |

**Staffing precedent settled this round:** an area with a landing pointed at it is a **staffing constraint, not a design conclusion**. Contract, providers and desktop were all spawned mid-round on that basis. Two were right.

---

## ⛔ The lead error record (this session)

**Kept because `028`'s equivalent proved its worth, and because a lead restatement reads as verified whether or not it was measured.**

| # | What | Mechanism | Caught by |
|---|---|---|---|
| 1 | Relayed `028`'s "`### 24.25` unresolved ⇒ tree not green" into three spawn prompts | **relay without re-derivation** — the claim was already false | contract, on boot |
| 2 | "Nobody has run it" | **universal negative about a teammate I had just told to measure independently** — I created the condition that falsified me | orchestrator |
| 3 | "`#73` is UNRECOVERABLE. Measured, not assumed." | **searched by the dead pointer, and filtered on a state line the entry does not carry** — an instrument structurally incapable of finding it, reported as a fact | contract |
| 4 | Owner packet described option (a)'s cost as "served-after-redaction" | **the redaction check gates the AUDIT WRITE, not the output** — a containment loss presented as a redaction benefit; the owner ruled on it | contract → orchestrator |
| 5 | Ordered the anchor-set observation filed as a new task | **did not check for an existing durable home** — `### 24.54` already existed; would have created the duplicate I had ruled on two hours earlier | orchestrator |
| 6 | Spawned an entire implementer on "10 breaking desktop tests" | **demanded measurement for the option I REJECTED and skipped it for the option I CHOSE** — the figure was already retracted | contract |
| 7 | Delivered `L190`'s text by `SendMessage` | **put a durable statement on the ephemeral surface**, four hours after ruling on it twice | self, after the fact |

⭐ **The orchestrator's diagnosis of #6 is better than mine and is the one to carry: not a believed CLAIM but a believed PRECEDENT — and a precedent recruits claims rather than being checked by them.** ⛔ **Worse in a lead than in an implementer, because supplying precedent is exactly what a lead is for, so the failure mode is indistinguishable from doing the job.**

---

## Rulings issued (in force unless superseded)

- **The dispatch gate.** No brief dispatches until its task's landed-state is verified **against git**, with the method recorded. `- [ ]` is not evidence a task is open; it is evidence nobody ticked it. *(Three of the round's first slice selections were already-landed work.)*
- **Two-surface requirement.** No measurement stands on an `npx`-only surface. Confirm through `node_modules/.bin/*` or `pnpm` and state both.
- **Seal budget, prospective.** Land tracker corrections mid-round. A minimal seal buys context and **defers a debt onto the next round's dispatch** — this round paid that bill three times.
- **Territory sweeps.** Idle-implementer budget, gate method, labelled a **subset** with its denominator stated. They cannot compose into coverage — see `### 24.94`.
- **The open-set marker stays UNVERIFIED**, with the verifying method named and an explicit statement that no sweep ran. An honest uncovered marker beats a partial sweep quoted as coverage.
- **A stale lead GO does not survive its own premise.** An approval is scoped to the facts it was issued against; when those die, so does it. Do not wait for a re-issue.
- **Route on KIND.** All seven safety rules auto-route. Reachability governs disposition, never routing.
- **Cycle policy on a fan-out team: the orchestrator cycles ALONE.** The protocol's paired cycle assumes two teammates; with four healthy implementers it discards good context for nothing.

---

## Owner decisions this round

1. **Staff `contract`** (mid-round) — unparking `### 24.84`, which its own text names a lead call.
2. **Read-path schema: SHIP THE BRAND UNCHANGED**, pattern stays, two wiring preconditions filed, real fix (`schema_rejected` audit path) filed not done.
   ⛔ **The first packet on this was materially false (lead error #4) and was re-put. The second ruling is the one in force.**
   **Owner-accepted costs, bounded by contract's measurement (0 non-conforming, ONE deployment, one moment, other installs unmeasured):** legacy rows unreadable until the real fix · `egressRevoke` surface fixed later · `schema_rejected` unaudited meanwhile.

---

## ⭐ The round's instrument findings (six, seven and eight — plus two properties)

`028` listed five instruments that **fabricate findings**. This round found three that **fabricate their ABSENCE** — they return the reassuring answer, and a non-vacuity check passes on all of them.

6. **turbo replays a cached green in ~55ms** without executing. Always `--force`; quote the `Cached:` line. ⚠ Its totals **include CANCELLED tasks** — `0 cached, 32 total` overstated its own coverage when one package aborted.
7. **`npx` is INTERMITTENTLY intercepted across tools**, returning fabricated success (`TypeScript: No errors found` for `--version`; `PASS (628) FAIL (0)` from `vitest --version`). ⛔ **Intermittency is the finding — a single clean probe proves nothing, and "I checked, it's fine here" is an unsafe sentence.**
8. **`vitest run --dir <path>` silently does not scope** — ran the whole monorepo. ⛔ **The danger is not the wrong count: a monorepo run reported as a package measurement WOULD HAVE AGREED with the run it was meant to corroborate.**

⭐ **General rule promoted above all three: CONCORDANCE IS EVIDENCE ONLY WHEN THE METHODS COULD HAVE DISAGREED.** Enforcement: before citing two measurements as independent, **state what each could have returned that the other could not.**

**Also observed, unresolved:** `git diff --name-only` returned **0 on a demonstrably modified file** (non-reproducing). ⇒ **single-instrument restore conditions are unsafe in this checkout.**

---

## ⭐ The conceptual results (the round's actual product)

- **`L190` — the token/behaviour gap.** A search instrument answers *"where does this token appear?"* Every question worth asking is *"what does this code do?"* The translation is performed silently by a human at report time and **the number carries none of it.** Three witnesses: a textual hit in a comment reading *"deliberately NOT written here"* counted as a **writer** · `17 − 15 = 2` over a token denominator presented as a count of **models** · **14 literals a shape rejects** reported as **14 tests that break** (cost: an area staffed). ⛔ **Re-derivation cannot catch this class, because the number was never wrong.**
- **Applicability of a PASS.** *"It broke"* proves the change reached the code. *"It did not break"* proves nothing until you show the change was present, loaded and evaluated. **"No impact" is a claim about an ENVIRONMENT, not about a suite.** Build the control, use it, report it, delete it — and say in the report that it existed and what it established.
- **Mutation proof.** ⛔ **A mutation producing RED is self-proving. A mutation producing GREEN is ambiguous — either the pin is blind, or the mutation never applied.** A `sed` that silently missed produced exit 0 indistinguishable from "the pin held." ⇒ **prove the mutation applied, by diff, for every green outcome.** ✅ **RESOLVED, AND THE ANSWER IS BETTER THAN "PROVEN APPLIED" — THE QUESTION DOES NOT APPLY. NO MUTATION WAS EVER RUN against contract's deleted control; the verdict was STRUCTURAL, sent as the artifact rather than a recollection.** The vacuous half asserted over `acceptEverything = { safeParse: () => ({success:true}) }` — ⛔ **`WorkspaceIdSchema` does not appear in the expression**, so the filter yields `[]` unconditionally.
⇒ ⭐⭐ ***THE SUBJECT UNDER TEST WAS NOT AN INPUT TO THE ASSERTION, SO NO IMPLEMENTATION — INCLUDING NONE AT ALL — COULD CHANGE ITS VALUE. A MUTATION CANNOT FAIL TO APPLY TO AN EXPRESSION IT WAS NEVER AN INPUT TO.*** **Immune by construction, not by proof-of-application.**
⭐ **Refined into TWO defects the original report collapsed into one:** half 1 **vacuous** (schema not an input) · half 2 **redundant but never blind** (it *did* reference the schema, and merely restated an existing pin as a count). **Deleting it lost nothing**, and the reason now lives **at the deletion site** — an accept-everything shape fails `rejects out-of-shape values`, a reject-everything shape fails `accepts every live production id`; both degenerate implementations are excluded from both sides.
⚠ **Recorded because the question was worth asking and the answer was worth measuring: "the deletion felt right" would have closed it the wrong way, and "proven applied" would have closed it for the wrong reason.**
- **The unit error was at the SOURCE, not the relay.** Every hop relayed faithfully; the label was wrong before the first one. ⇒ **"what population did you count?" must be asked of the ORIGINATOR.** Every measurement brief now states the **population predicate** and requires the result to restate it.
- **A doc is a CONTRACT, not a REPORT.** A report is improved by matching reality; a contract is destroyed by it. Amend the contract and nothing is in breach — the same end state as the code having been correct all along. ⛔ **Diligence demands the widening as readily as a lint does, and nobody audits an impulse toward accuracy.**
- **Defend a decision where it will be UNDONE, not where it was made** — but **both, always both**: durable-but-un-encountered is indistinguishable from absent *at the moment of the wrong action, and not otherwise.* `### 24.84`'s reason was un-encountered by two searchers and still recovered by a third.
- **The check that matters is on the claim you already BELIEVE.** Every discipline in this ledger triggers on doubt, and a believed claim generates none. A 30-second run turned a plausible secondary benefit into 1-of-5 on a rule-7 rationale.

---

## ⭐ Why the corrections landed — the outgoing orchestrator's own amendment

**A successor inheriting *"the orchestrator took corrections well"* gets less from it than one inheriting the mechanism. In its words, and it declined the compliment to say so:**

> ***The corrections landed because the implementers made them CHEAP TO ACCEPT. Every one arrived with its measurement attached*** — contract's trade-inversion argument came with the source lines, knowledge's halt came with the `ZodError` and a four-run matrix, worker's pin-1 finding came with the mutation that proved it. ⇒ ***accepting was less work than defending.***

⇒ **That is a property of how they REPORTED, not of how it was RECEIVED.** ⛔ **The transferable rule is not "be receptive" — it is *insist the measurement travels with the objection*.** ⭐ **Seven refusals and corrections this round, several aimed at the lead, and not one of them cost an argument.**

---

## Successor priorities (from the outgoing orchestrator, in order)

1. ⛔ **`### 24.99` FIRST** — `### 24.84`'s deciding argument is measured false, so the task could otherwise be closed on a reason that no longer holds.
2. ⛔ **Knowledge's contingent paragraph stays FROZEN until `### 24.98`'s shape exists.** Their invariant subset is applied and correct. **Half a slice landing into an undecided premise is what was avoided twice tonight — the second time only because they halted rather than picked.**
3. **The sequence knowledge → contract is PROVEN, not assumed** — worker verified green in both brand states, so contract lands into no red window.

---

## ⭐ Late findings (post-cycle, successor orchestrator)

- ⛔ **A GUARD WITH ROTTED POINTERS IS WORSE THAN NO GUARD.** `projection.ts`'s `### 24.55` block says `persistDenialAudit` has *"exactly two call sites (`:110`, `:153`)"*. **Count correct; pointers rotted — measured `:158`/`:201`, while `:110` is mid-comment prose and `:153` is a parameter.** ⇒ ***someone verifying the guard finds its citations don't resolve, concludes the comment is stale, and is now LICENSED to delete the redaction gate it exists to protect.*** ⭐ **`L187` inverted: the guard sits where the wrong edit happens, and its own unverifiability becomes the argument for the edit.** *(Carry-forward 8(b)'s class, on a rule-7 surface.)*
- ⛔ **INSTRUMENT #10 — `ListAgents` reported SIX peer sessions and ZERO teammates while `SendMessage` to those same teammates resolved and delivered normally.** ⭐ **The first instrument this round that fails SAFE** — toward *"the team is gone"* rather than toward a confident wrong number, so it costs a hesitation rather than an action. ⚠ **But a successor who trusts it concludes the implementers died and RE-SPAWNS OVER LIVE SESSIONS** — the base-name-collision disaster. **Corroborates `027`'s "`ListAgents` is blind to teammates."** ⇒ **verify team liveness by REACHABILITY PROBE, never by roster.**
- ⛔ **PHASE 24'S DECLARED ANCHOR SET DOES NOT COVER WHAT ITS OWN TASKS IMPLEMENT.** `§16` is outside the declared set (`§13 §19.11 §3 §4 §6`), yet `### 24.93`, `### 24.98`, `### 24.99` and `### 24.101` all cite it. ⇒ **Carry-forward 6 `(a0)(viii)` FACE 2, four witnesses, measured at the TASK level** — where `### 24.54` measured the same root at the BRIEF level. ⛔ **Remedy is NOT to widen the set** (standing lead ruling, 2026-07-29). **Enrich `### 24.54`; do not file a second task** — that entry is already the durable home, and a new one repeats the `24.75`/`24.86` duplicate.

---

## ⛔ The rule-7 leak that lived behind a comment claiming coverage

**A source comment named an invalidating condition and then asserted *"the pins test the SIGNAL, so they catch it."* `security-reviewer` EXECUTED the condition and produced a real leak string — an employer project codename in an audit ref — AGAINST A FULLY GREEN SUITE, because no such pin existed.** ⚠ **`isRedactionSafe` could not backstop it: `audit-signal.ts` names "an employer project codename" as exactly what its credential-shape heuristic misses.**

⭐⭐ **THE MECHANISM WORTH BANKING, AND IT IS NEW: THE FALSE ASSURANCE WAS ALSO THE ONLY MAP TO THE DEFECT.** The reviewer offered the cheap fix — **delete the sentence**. ⛔ ***Deleting a false assurance repairs the DOCUMENT and leaves the DEFECT — and it removes the one artifact that named the invalidating condition, so nobody knows to look again.*** ⇒ **the overclaim was simultaneously the defect AND the pointer to it.** ⭐ **Fixed BY CONSTRUCTION instead: paths cut at the only free-form-key region, so a row-authored key cannot reach the signal even if a future schema starts raising issues there. Mutation-proven — disable the cut and exactly the new pin reds.** **`L103`'s posture: unrepresentable beats detected.**

⭐ **SECOND CLASS — A DECORATIVE ASSERTION. Three `isRedactionSafe` assertions used a sentinel that matched NONE of the heuristic's patterns** ⇒ **they asserted that a detector failed to detect something it was never going to detect. They ran, passed, and proved nothing.** ⛔ ***An assertion against a HEURISTIC needs a fixture the heuristic actually catches*** — applicability, applied to test FIXTURES rather than to instruments. **Fixed with a credential-shaped fixture; the mutation now reds three tests including a persist pin that was green under it before.**

⚠ **Severity, stated as the implementer stated it: this one stood between a future contracts tightening and a rule-7 leak INTO A PERSISTED RECORD, and nothing in the suite would have said a word.** **No live leak — the condition requires a schema change nobody has made.**

### Two more, from the same slice

- ⛔⛔ **COMPILER ENUMERATION HAS A THIRD BLIND SPOT: THE UNION BOUNDARY.** `### 24.98` made `audit` **required**, so `tsc` enumerated every construction site and found a third nobody had listed — the mechanism that made it safe. **A second candidate-data gate (`generative-proposal-intake.ts`) mints a STRUCTURALLY IDENTICAL `{code:"schema_rejected", stage, issues}` on its OWN LOCAL UNION, with no `audit` field at all** ⇒ ***the enumeration stops at the union boundary, so a DUPLICATED SHAPE is invisible to exactly the instrument that secured the original.*** **Filed `### 24.103`.** ⭐ **Known blind spots for `tsc` exhaustiveness are now THREE: casts (`L179`) · hardcoding consumers · duplicated shapes on separate unions.** ⛔ **Its Done-when derives the population BY PROPERTY — *"refuses candidate data without producing an audit signal"* — never by spelling, since three spelling-based censuses were blind to their own subjects tonight.**
- ⛔⛔ **PROTECTION BY OMISSION — WORSE THAN AN UNDOCUMENTED GUARD.** `schema-gate.ts:34-36` **drops** ajv's `e.params`, and **that drop is the only thing keeping a row-authored key out of the audit record. Nothing at the site says so.** ⚠ **Threading `params` in is a natural, helpful-looking improvement that routes a row-authored key into a rule-7 sink with every test green** — the knowledge-side pins cannot trip a heuristic that never sees the key. **Filed `### 24.104`.**
  ⭐ **The general form: `027`'s ruling says an assertion that a guard is INERT must say what makes it load-bearing, or it invites deletion. This is the inverse and it is harder — the protection is an ABSENCE.** ⇒ ***an undocumented guard is at least CODE someone might question; an omission presents no surface to doubt at all, and the "improvement" that destroys it looks like completeness.*** **`L187` decides the location: the wrong edit happens in `packages/domain`, so the protection belongs there — not in the knowledge package that benefits from it.**
- ⭐ **A symmetry worth keeping (banked as ONE lesson at the implementer's suggestion): the orchestrator and the implementer committed the SAME mechanism — *measured the artifact I had open, not the one the code will use* — in OPPOSITE directions, one message apart. Each caught the other's; neither caught their own.**

---

## ⛔ The retain-struck practice set a live trap — a LEAD ruling's cost

**The lead ruled twice tonight: a superseded claim is STRUCK AND RETAINED, never deleted, because "the failure is the record."** ⛔ **That practice then produced a near-miss: an implementer lifted `STATUS: RE-PUT TO THE OWNER, UNDECIDED` out of a retained-struck block and reported a cat-4 packet in flight. It was not.** *(They routed rather than ruled, which is why it cost nothing.)*

**Measured offsets inside `### 24.84`:** live `FINAL OWNER RULING` at **13309** · struck block opens at **15816** · the stale status line at **18119**. ⇒ ⭐⭐ ***THE CURRENT ANSWER SITS ~4,800 CHARACTERS ABOVE THE DEAD ONE, SO A READER SCANNING FOR STATUS MEETS THE STALE LINE LAST AND MOST-RECENT-LOOKING.***

⭐⭐ **THE MECHANISM: STRIKING A BLOCK DOES NOT TENSE-SHIFT THE SENTENCES INSIDE IT.** **Narrative survives striking — *"we considered X"* stays true forever. A STATUS line is a claim about NOW, and has no way to announce it stopped being true.**
⇒ ⛔ **REFINED RULE (the practice stays, its scope narrows): RETAIN THE REASONING; STRIP OR PAST-TENSE THE STATE.** ***Provenance and status want opposite things from the same artifact.***
⚠ **Position cannot fix it: newest-first ordering is CORRECT, and it is exactly what puts the dead status line nearest the entry's end.**

**Banked `L195` with forbidden-pattern #9** — struck blocks grepped for `STATUS|NEXT|PENDING|UNDECIDED|IN FLIGHT|AWAITING`, **non-vacuity control run against the instance it was written for**, census reported honestly (2 hits: 1 confirmed defect fixed, 1 candidate classified and **deliberately not fixed** — editing a live safety task's state on a census hit is fix-where-noticed).

---

## ⛔ LEAD ERROR #8 — an accepted cost bounded by an UNNAMED milestone

**The owner packet described accepted cost (1) as *"legacy rows stay unreadable **until the real fix**."* ⛔ THE LEAD NEVER NAMED WHAT THE REAL FIX WAS.** **Someone downstream resolved that unbound pointer to the nearest filed task (`### 24.98`) — which has now LANDED and does NOT make legacy rows readable. Its own text says so twice, and its Done-when REQUIRES *"the row stays refused."***

⇒ ⭐⭐ ***THE OWNER PRICED A BOUNDED COST AND IT IS UNBOUNDED. NO FILED TASK ENDS IT.*** What would end it is a **migration of the pre-validator population**, which `24.98` names as the root cause and explicitly declines to solve; `### 24.97`'s two legs are the audit path and `egressRevoke`, neither of which is a migration.

⛔⛔ **THE FAILURE MODE IS THAT DISCHARGE LOOKS AUTOMATIC: anyone reconciling the cost list against git sees `24.98` landed and ticks (1).** ⇒ ***A COST BOUNDED BY THE WRONG MILESTONE IS MORE DANGEROUS THAN AN UNBOUNDED ONE, BECAUSE IT ACQUIRES A FALSE EXPIRY DATE THAT ARRIVES ON SCHEDULE.*** ⚠ **Stale-state in its worst direction — not a cost that quietly stopped applying, but one whose stated END ARRIVES WHILE THE COST CONTINUES.**

⭐ **Mechanism, and it is `L190`'s family one level up: an underspecified TERM in a decision packet gets RESOLVED by whoever reads it, silently, to the nearest plausible referent — and the resolution inherits none of the author's uncertainty.** ⇒ **a decision packet may not contain an unbound temporal pointer. "Until the real fix" is not a bound; it is an invitation to invent one.**

**Recorded on `### 24.84` as "do NOT tick (1)" with the true bound named. Re-pricing routed to the owner: they accepted it as temporary and it is not.** ✅ **OWNER RULED: file the migration as a tracked task (`### 24.106`), not built this round — so the cost expires against something that actually ends it.**

⛔⛔ **AND A SECOND MIS-PRICING ON THE SAME COST, STILL OPEN WITH THE OWNER AT THE TIME OF WRITING: COST (1)'s POPULATION AND `### 24.97` LEG (b)'s POPULATION ARE THE SAME ROWS.** Leg (b) records that `workspace-read-gate` feeds *"`resolveWorkspacePolicy` (the §5 egress veto's input) and a subsequent WRITE (`egressRevoke.ts`'s get-before-upsert)"* ⇒ ***a row in cost (1)'s population can STRAND `egressRevoke` — the emergency egress-OFF control, safety rule 5.***
⇒ ⛔ ***THE OWNER ACCEPTED "legacy rows stay UNREADABLE." THE SAME ROWS ALSO DEGRADE A RULE-5 CONTROL, AND THAT CONSEQUENCE IS NOT IN THE PHRASE THEY ACCEPTED.*** ⚠ **Not a new finding — leg (b) was already filed. What is new is the JOIN, and that the cost was priced under a description naming only the milder half.**
⭐ **Both entries cross-referenced so neither closes believing the other covered it, and `### 24.106`'s Done-when now requires `egressRevoke`'s get-before-upsert be exercised against a member of the population — because READABILITY ALONE DOES NOT ESTABLISH THE RULE-5 HALF.**
⛔ **LEAD PATTERN, AND IT IS THE ROUND'S WORST: THREE SEPARATE MATERIAL DEFECTS IN OWNER-FACING DESCRIPTIONS OF THE SAME COST** — a containment loss described as a redaction benefit · a bound named against an unspecified milestone · a rule-5 consequence omitted from the phrase priced. ⇒ ***the owner packet is the artifact this round failed at most consistently, and every one of the three was caught by an implementer AFTER the owner had already answered.***

---

## ⭐ Why the two gates are complementary — now SOURCED, not doctrinal

**`### 24.55`'s protection obligation SURVIVES `### 24.84`, and its control still DISCRIMINATES** — measured through the default registry with the tight brand live: `sk-ant-api03-…` / `my-secret-ws` / `bearer-ws` / `xoxb-…` → `isRedactionSafe` **false**, 0 persisted / 1 refused; benign `ws-acme` → **true**, 1 persisted / 0 refused.

⭐⭐ **THE REASON IS A SOURCED PROPERTY, NOT A LUCKY SURVIVAL: `zod-brands.ts:92-93` states outright — *"WHAT THIS IS NOT: a credential detector. Lowercase credential-shaped strings ACCEPT."*** ⇒ ***a slug-valid id can still be credential-shaped, so it passes the brand and REACHES the redaction gate.*** ⛔ **THE BRAND'S STATED WEAKNESS IS WHAT PRESERVES THE OTHER GATE'S REACHABILITY.**
⇒ ⭐ **That is the load-bearing reason the write gate and the read gate must not be collapsed — and `24.84` had been asserting it on DOCTRINE. It is now measured.** **The lead's "unreachable is not a licence to delete" ruling is recorded on `24.55` anyway: it binds future tightenings, and it is worth more banked before the fact than after.**

---

## ⛔ Pre-positioned: "unreachable" is NOT a licence to delete

**`### 24.55`'s protection obligation loses its ONLY control when `### 24.84` lands.** The in-file comment names `serve_projection_denial_routes_through_the_redaction_gate` as *"the ONLY control"* proving the `isRedactionSafe` gate is reachable. **Its producer is the re-gate path; post-landing a credential-shaped row is refused at the ajv stage FIRST** (measured: `code=schema_rejected stage=ajv calls=1 refusals=0`) ⇒ **the row never reaches the visibility stage and the control cannot fire.**

⇒ ⭐⭐ ***THE LANDING DOES NOT MERELY MOVE A TEST — IT STRENGTHENS THE ARGUMENT FOR DELETING A SAFETY GATE, AND NOBODY DECIDED THAT.*** ⛔ **`### 24.55` exists to STOP that deletion; after the landing the dead-code case gets BETTER while its recorded refutation goes stale, and that refutation names a test that can no longer fire.**

⛔⛔ **STANDING LEAD RULING, ISSUED BEFORE THE MEASUREMENT RETURNS SO IT CANNOT BE SHAPED BY IT: IF NO STILL-REACHABLE CARRIER EXISTS, THE DEFAULT IS **NOT** DELETION.** ***A tightening that silently removes a rule-7 control has not made the system safer — it has made the control unobservable, which is what `24.55` was filed about in the first place.*** **Unreachable-and-retained requires a written reason for the retention (`027`'s ruling), and any deletion is a fresh owner call, not a cleanup.** ⚠ **Also forbidden: inventing a synthetic carrier to keep a green test, and letting the pin lapse silently — both already forbidden in the dispatch.**

---

## ⭐ Rule: an artifact someone else executes is committed AT DISPATCH

**The successor orchestrator committed a brief at dispatch rather than at round close, declared it as a cadence deviation, and was right.** ⇒ **Promoted to a rule rather than accepted as an exception:** ⛔ ***a brief is committed when it is DISPATCHED, not when the round closes — because from the moment it is dispatched, someone else is executing an artifact that exists only in one session's working tree.*** **That is exactly the `292` defect this handoff opens with, and the cadence is what produced it.** ⚠ **Tracker hot-writes keep the normal cadence; this rule is scoped to artifacts another session is acting on.**

---

## ⭐⭐ The parting corrections — each teammate corrected the record about itself on the way out

**All four asked to be recorded accurately rather than generously. These are the round's best content and they arrived after the seal.**

⛔⛔ **1 — THE SHARED GIT INDEX, and it is the precise mechanism behind the foreign-file sweep.** ***`git add <paths> && git commit` commits THE INDEX — everything ANY session has staged. `git commit -- <paths>` commits only the named paths.*** **Worker passed three explicit paths and still swept two of providers' files, because providers had staged concurrently and rode the index.** ⇒ ⭐ **contract's `git commit -F <msg> -- <17 paths>` was safe for a REASON, not by luck — it never consults the index.** ⛔ **In a shared checkout, `git add` is a shared mutable global. THE PATHSPEC FORM IS THE ONLY SAFE COMMIT.**

⛔ **2 — A CHECK ONLY GATES IF A DECISION SITS BETWEEN READING IT AND ACTING (`L109` amendment).** **Worker's command PRINTED the staged set — providers' files visible in the output — and ran `git commit` in the SAME invocation.** ⇒ ***collapsing the gate and the action into one command converts the gate into a RECEIPT.*** ⭐ **Its three earlier commits passed the identical check only because nothing else happened to be staged at that instant — not because the check could have stopped anything.** ⚠ **Same shape as the mutation finding one level up: an instrument answering a narrower question than the one asked, in the reassuring direction.**
⭐ **And re-separating them immediately caught the next defect: the rename had landed as a pure `R100`, so a file was named `176` while its own header still read `Session 178`.** ⇒ ***a rename and the edits that justify it are ONE change; staging them apart lets the rename land alone and look complete.***

⭐⭐ **3 — KNOWLEDGE'S CORRECTION TO THE ROUND'S THESIS, and it must travel with it: THREE of the five prose defects in their work were caught by a REVIEWER or the lead, not by themselves.** ⇒ ***the pattern is a thesis because other people EXECUTED what they had merely ASSERTED.*** ⛔ **Do not carry it as "an implementer found five prose defects." Carry it as: A SOURCE COMMENT SURVIVES EVERY CHECK WE RUN EXCEPT SOMEONE RUNNING IT.**
⚠ **POLICY-RELEVANT: the only reason `L188`'s docblock arm has a witness at all is that `security-reviewer` is policy-gated to `invariant` and this slice qualified. Its per-slice cost bought exactly ONE finding this round — and that finding was the most serious one recorded.**

⭐ **4 — PROVIDERS' CORRECTION ON THE `git show` FINDING — the load-bearing half is NOT the duplication.** It is that **`awk` reproduced the same wrong number, so `grep` had counted a corrupted byte stream FAITHFULLY.** ⛔ **They opened the investigation expecting `grep`, which had already fabricated four times that session and was the obvious culprit.** ⇒ ***CLEAR THE OBVIOUS INSTRUMENT BEFORE YOU ACCEPT ITS CONFESSION — the wrapper hypothesis exists only because the obvious suspect was cleared first.*** ⚠ **Carried as *"`git show` is unreliable"* this is a sixth entry on a list; carried as the method, it generalises to every item on that list.** ⭐ **And note the direction: the doubled count made their work look BIGGER, so nothing about it felt alarming — it was caught only because a prior measurement contradicted it.**

⭐ **5 — CONTRACT, ON CORRECTIONS AS A DEFECT VECTOR: two of their defects were introduced AS CORRECTIONS.** ⇒ ⛔ ***a correction arrives with a reviewer's endorsement attached and reads as already-vetted — but the reviewer approved RETIRING THE OLD CLAIM, not the NEW ONE REPLACING IT.*** ⭐ **And their account of what actually worked: *"what the good calls have in common is not care — it is writing down what I expected before measuring."* A `grep` over-reporting 19 against a true 16 was caught by nothing cleverer than that, and 19 was a perfectly plausible number.**

⚠ **6 — A STALE REPORT, one last instance: providers flagged a dangling predecessor link in doc `177` at shutdown. Verified by the lead — it already read the corrected filename, and all six cross-links across docs `175`–`178` resolve.** ⭐ **Accurate when written, false when read. The round's own crossing defect, arriving in its final message.**

---

## Safety state

⛔ **UNCHANGED. The blanket arming hold is released; EVERY individual crossing remains owner-gated by its own `§ARM-*` ledger. NOTHING IS ARMED.** Safety rules 1–7 untouched; all seven auto-route to the lead.

**New safety-classed tracker entries this round:** `### 24.91` (rule 4, precondition on the first real `dashboard_cards` producer) · `### 24.93` (rule 4, the expiry condition) · `### 24.96` (§16) · `### 24.97`/`### 24.98` (the two read-path preconditions) · `### 24.99` (**rule 7 — blocks `### 24.84`'s closure**) · `### 24.100` (rule-4 adjacent, the generic brand bypass).

⭐ **`### 24.99` is the sharpest: `### 24.84` chose the write boundary over the audit boundary on exactly one discriminator — that the renderer is a rule-7 sink. The renderer schemas bind `z.string().min(1)`.** ⇒ ***the write boundary leaves the same sink uncovered it was chosen to close. Both options failed identically and one was chosen because only the other's failure had been measured.***

⭐⭐ **`### 24.99` IS UNDERSTATED — verified by the successor orchestrator on two surfaces at HEAD (not contract's WIP).** The two `ui-safe.ts` schemas it names (`:174`, `:277` — `z.string().min(1)`) **are not the sink `### 24.84`'s discriminator actually cited.** That sink is `UiSafeEgressStatus` (`apps/worker/src/api/procedures/systemHealth.ts:47-51`), which is **a bare TypeScript interface — `workspaceId: string`** — and its own docblock concedes *"no frozen seam model for this projection."*
⇒ ⛔ ***A TS interface ERASES AT RUNTIME. The exact sink the discriminator named has NO runtime validation whatsoever — not the brand, not even `min(1)`. The two schemas `24.99` measured are STRONGER than the one `24.84` cited.*** Chain verified at source: `parseWorkspaceInput` checks `typeof`/length on the **input** side · `toUiSafeEgressStatus` is a **field allowlist passing the value through verbatim** · then the renderer.
⭐ **The rewrite is not a hole: `24.84`'s own record already contains a TRUE replacement discriminator** — the audit boundary covers **1 of 17** frozen models carrying `workspaceId`, while `brandedIdSchema` is a one-site class fix covering **15 of 17**. **That coverage argument never depended on the renderer claim. Only the renderer clause dies.**

---

## ⛔⛔ SOMETHING IS WRAPPING `git` IN THIS CHECKOUT — a unifying hypothesis

**Four separate git anomalies this round, none explained individually:**
1. `git status --porcelain` returns the literal **`ok`**.
2. `git diff --name-only` returned **0 on a demonstrably modified file** (non-reproducing).
3. `git show <rev> -U0 -- <path>` **emitted its diff TWICE** on a one-file one-hunk commit — every derived count doubled exactly (**112/8 against a true 56/4**).
4. ⭐ **`git show`'s first output line carried commit subject + author + RELATIVE DATE — which plain `git show` does not emit.**

⇒ ⛔ ***ITEM 4 IS THE TELL, AND IT MAKES 1–3 ONE DEFECT RATHER THAN THREE COINCIDENCES: `git` in this checkout is being intercepted by a wrapper, exactly as `grep`, `npx`, `tsc` and `vitest` are.*** **Unchased — flagged as SHARED TOOLING, not any one slice's problem.** ⚠ **Treat every `git` output surface as suspect until this is run down.**

⛔⛔ **AND THE PROCESS CONSEQUENCE IS THE WORST RESULT OF THE ROUND: A COMMENT-ONLY PROOF CANNOT BE VALIDATED BY A DIFFERENT AGENT RE-RUNNING IT IN A DIFFERENT SESSION.** The duplication reproduced under **two** tools in one session and would not reproduce across **four** clean probes in another. ⇒ ***the tool returned different answers for the same input, so a clean re-run does not certify the original and an inflated one does not indict it.*** ⛔ **Comment-only proofs have gated lead-authorized crossings in this project.**
⭐ **ENFORCEMENT: verify a line count with `--numstat` or the commit's own summary — NEVER by counting `+`/`-` out of a diff body.** `--numstat` was the only surface that agreed across both sessions.
⭐⭐ **AND THE SHARPEST HALF IS THE IMPLEMENTER'S: IT WAS NOT `grep`.** They opened the investigation expecting it (four fabrications that day) — **`awk` independently reproduced `112/8`, so the corruption was in the BYTE STREAM.** ⇒ ***an instrument can report a wrong number CORRECTLY, and blaming the known-bad tool would have concealed the real defect.*** ⛔ **`028` records this tool family as a shim that OMITS; this is the same family INFLATING. There is no safe direction to lean.**

### ⛔ CAVEAT — READ THIS BEFORE ADDING TO THE HYPOTHESIS ABOVE

**Placed here, not in a footnote, because the wrong move happens at the moment of reading the hypothesis.**

**The orchestrator hit a FIFTH git anomaly while enumerating for close-out: `git diff --name-only` listed a previous round's session doc as modified, while `git diff` on that path returned EMPTY.** ⭐ **The exact INVERSE of anomaly 2, same instrument, one day apart — right shape, right tool, right day.**

⛔ **IT WAS BENIGN.** Two discriminating checks, ~30 seconds: re-running `--name-only` after a content comparison refreshed the stat cache — **the path was gone**; and comparing the blob to HEAD — **byte-identical, same sha both sides.** ⇒ **something touched the file's mtime without changing content. Ordinary git, correctly performed.**

⇒ ⭐⭐ ***IT WOULD HAVE BEEN A FALSE DATA POINT INSIDE A TRUE HYPOTHESIS — THE WORST KIND, BECAUSE IT STRENGTHENS A CLAIM ALREADY BELIEVED AND IS INDISTINGUISHABLE FROM THE REAL EVIDENCE BESIDE IT.***

⚠ **The hypothesis is NOT weakened by this — that inference would be the same error mirrored. Anomalies 1–4 stand on their own measurements.** ⛔ **What this establishes is narrower and sharper: A HYPOTHESIS'S PREDICTIVE POWER MAKES FALSE POSITIVES CHEAPER TO ACCEPT, SO THE BAR FOR ADDING TO IT MUST RISE AS IT GETS STRONGER, NOT FALL.** ⭐ ***Every instance of the class fits — and so do the benign ones. "It fits" is not a test.***

⭐ **Banked as `L202` with the discriminating-check pair for git stat anomalies, recorded by the orchestrator AGAINST ITSELF.** ⛔ **Its reason is the one that generalises past git: this round's disciplines are all aimed at claims we DOUBT, and a freshly-validated hypothesis generates RECOGNITION rather than doubt — *and recognition feels like measurement.*** ⚠ **`L184`'s family, arriving through a hypothesis the team had just proven rather than through a claim someone assumed.**

---

## ⭐ A charset is not a language — and two approvers passed the false version

**The ground providers proposed, and the orchestrator APPROVED and praised, was false as worded:** *"a well-formedness rule cannot exclude credential shapes."* ⛔ **`security-reviewer` CONSTRUCTED the counter-example: `^(employer-work|personal-business|personal-life)$` is a well-formedness rule, admits all three live workspace ids, and excludes every credential.** **A charset had been conflated with a LANGUAGE.**

⭐ **The second-order half has the teeth: what actually makes the claim true is that the id set is OPEN BY CONSTRUCTION** (`onboarding.ts:112` admits any non-empty string), **so enumerating would reject a live id — the availability break `### 24.84`'s own gate forbids.** ⛔ **That premise HAS AN OWNER — `24.84`'s worker leg exists to close that create path** ⇒ ***"this ground cannot expire" could itself expire silently through the sibling leg: a second unwatched expiry inside the fix for the first.*** **The note now names the contingency and its owning task instead of claiming unconditionality.**
⚠ **Two careful people approved the false version; only CONSTRUCTION caught it.** `L141`'s amendment shape on a fresh surface — **when two careful readers pass the same claim, the claim was under-specified, and no amount of care would have fixed it.**

---

## ⛔ Session-doc numbering collides DETERMINISTICALLY at group close-out — fix it, stop renumbering

**Fourth occurrence — and one has been sitting in committed history for THREE WEEKS undetected.** `173`/`174` collided at the 2026-08-14 shutdown; this round **THREE implementers independently picked `176`**.

⛔⛔ **VERIFIED BY THE LEAD AT `7a26f916`, found by `providers-integrations-implementer`: `docs/sessions/` contains TWO files numbered `114`, both dated 2026-07-26 — `114-…-knowledge.md` and `114-…-desktop.md`.** **Reproduce:** `git ls-files docs/sessions/ | sed -n 's|.*/\([0-9]\{3\}\)-.*|\1|p' | sort | uniq -d` → **`114`**, the only duplicate across **181** committed session docs.
⇒ ⭐⭐ ***THE DEFECT IS NOT RARE — DETECTION IS THE ACCIDENT.*** **Two areas closing concurrently produced a silent duplicate that survived three weeks and every subsequent close-out. Tonight's was caught ONLY because THREE fired at once and the noise was impossible to miss.** ⛔ **A two-way collision is invisible; the invariant has been quietly false since July.**
⚠ **`114` is left AS IS — recorded, not fixed.** **Links reference full filenames so resolution still works; only ordering-by-inspection is broken, and renumbering three-week-old history during a close-out is scope creep of exactly the kind this round ruled against.** **`### 24.107` filed to disposition it by forward rename with the inbound set measured FIRST.**

⭐⭐ **✅ A DETECTOR NOW EXISTS — providers proposed it, the orchestrator installed it, and it is better than the lead's "assign from committed history" because it needs NO CONCURRENCY ASSUMPTION AT ALL.** **`plan-lint` reports duplicate `NNN` prefixes in `docs/sessions/` — one `sort | uniq -d`.** **Non-vacuity control run: it fires on `114`.** ⇒ ***it would have caught `114` in July, `173` last week, and tonight's three-way before anyone renamed anything.*** ⚠ **Deliberately WARN, not FAIL — `114` is live and failing would block every tracker commit; `### 24.107` promotes it to a violation in the same commit that fixes `114`, because a guard left permanently at warn is a completion badge.**

⛔⛔ **AND THE SILENCE IS THE REAL FINDING, not the collisions: DETECTION HAS BEEN SCALING WITH COLLISION MULTIPLICITY, NOT WITH ANY CONTROL.** **A three-way collision is loud and was caught in minutes; a two-way collision is silent and survived three weeks and every close-out in between.** ⇒ ***the convention had no detector — the team was relying on collisions being noisy enough to trip over.***
⚠ **Related, and `L190`'s family: session `174`'s banner presents `173` as the FIRST occurrence. `114` predates it by three weeks.** ⇒ ***an EARLIEST-KNOWN written as an ORIGIN.*** **The claim was true about the author's sample and false about the population — and it made the defect look newer, rarer and more contained than it was.**

⚠ **ONE OF THE LEAD'S TWO REPORTED DEFECTS WAS NOT REAL, and the mechanism is the round's own: the lead read the commit SUBJECT *"re-point 173's successor at 176"* and inferred the file now names a BARE NUMBER. It does not — it carries the full filename and resolves.** ⇒ ***asserted from a commit message rather than the file it describes.*** **The other reported defect WAS real (`177`'s chronological predecessor dangled) and was repaired by the orchestrator as the single actor, declining contract's offer to help — accepting would have been the race a fourth time.**

⭐ **IT IS NOT BAD LUCK AND IT IS NOT CARELESSNESS — IT IS A TOCTOU RACE THAT FIRES BY DESIGN.** `/session-end` tells every implementer to compute `max(ls docs/sessions/) + 1`. **At a group close-out they all run it within the same few seconds, against the same directory, before any of them has written a file.** ⇒ ***every one of them computes the correct answer, and they are all the same answer.*** ⛔ **The previous round's remedy — "re-check immediately before writing" — narrows the window and cannot close it; the last writer still wins and the loser has already committed.**

⛔ **THE FIX — AND IT IS SHARPER THAN "ONE ACTOR", WHICH WAS THE LEAD'S FIRST ANSWER AND WAS NOT ENOUGH.** ⭐ **The orchestrator took the single-actor role and STILL raced twice: its first correction raced a commit already in flight, and its second was computed from a read that went stale while it composed the message.** ⇒ ***a single actor is not sufficient, because the actor's INPUT can go stale between reading and writing.***
⭐⭐ **WHAT ACTUALLY ENDED IT: DERIVING FROM COMMITTED HISTORY (`git ls-files`), WHICH CANNOT BE RACED.** ⛔ **The working tree and in-flight commits can both move under you; committed history at a named ref cannot.** ⇒ **THE RULE: assign from committed history, by one actor, at the moment of writing.** ⚠ **The orchestrator's ORIGINAL assignment was correct; BOTH corrections were the errors — which is its own evidence that the defect is the input surface, not the assigner.**
**Belt-and-braces alternative, if the counter is ever revisited: make the identifier non-colliding by construction** — date + area (`2026-08-18-knowledge`) or a short session-id suffix. **Ordering-by-inspection survives; the counter does not.**

⚠ **Do NOT re-adopt "check again just before writing." It has now failed twice, and it fails in the direction where the work is already done.**

⛔⛔ **AND THE REMEDY RE-RAN THE RACE — MEASURED WITHIN MINUTES OF THE FIX BEING PROPOSED. The renumber itself CREATED a fresh collision**, because three implementers renumbering concurrently is the identical race one layer up. ⇒ ⭐ ***ANY IMPLEMENTER-SIDE REMEDY RE-RUNS THE RACE, BECAUSE THE RACE IS THE CONCURRENCY, NOT THE COUNTER.*** **That settles it in favour of option 1: the ORCHESTRATOR — one actor — assigns numbers. Do not accept a fix that leaves N sessions computing anything simultaneously.**

⛔ **SECOND, AND IT IS A TERRITORY DEFECT: during the renumber, `worker-implementer` committed `providers-integrations-implementer`'s session doc into its own commit (`5f6a36be`).** ⭐ **Contrast with contract's landing the same round: `git commit -F <msg> -- <17 explicit paths>` made a foreign sweep UNREPRESENTABLE rather than avoided — zero foreign, verified post-commit.** ⇒ **the discipline that held under a 17-file contract landing failed under a one-file rename, because a rename feels too small to warrant it.** ⚠ ***The pathspec form is cheapest exactly where it feels least necessary.***
⛔ **DISPOSITION: RECORD THE MISATTRIBUTION, DO NOT REWRITE IT.** The file is committed and no content is lost; `--amend`/history-rewriting is forbidden in this checkout and destroyed a seal on a prior round. **A wrong-commit attribution is a fact about the record; a rewritten history is a new defect.**

---

## ⚠ Standing traps (verified live this round)

- `grep` **fabricates** match counts — reproduced independently **five** times tonight, most recently *"337 matches in 259 files"* for a **single-file** query, on the first command a fresh session ran.
- ⛔ **NINTH INSTRUMENT — `awk` piped from `xargs` over many files reports CUMULATIVE `NR`**, emitting line numbers like `155972` for a 300-line file. ⚠ **Plausible, monotonic, and wrong — it does not look like a fabrication, it looks like a big file.** **`FNR` is the fix**; single-file `sed` is the safe read. ⭐ **Note what this does to the standard workaround: `awk` is what everyone switches to WHEN `grep` misbehaves, so the fallback has its own failure mode in the same direction — a confident number.**
- `git status --porcelain` returns the literal `ok`. Use `git diff HEAD --stat` + `git ls-files --others --exclude-standard`.
- ⛔ **Never `--amend`** in this checkout.
- **`#NN` shared-task pointers die with their session.** The durable home is the `### 24.NN` entry. Search by **content**, never by number.
- **Single-track shared tree:** "the tree is red" no longer identifies *whose* red it is. Name whose WIP, and scope every green claim to your own files.
- **`TaskCreate`/`TaskUpdate`/`TaskList` do not exist in this harness build** — verified from two independent sessions. The protocol's two-channel design ran on one channel all round.
- **Self-reported context is not canonical, and it fails optimistic.** The orchestrator's self-read was 3 points low, in the direction that delays a cycle.
