# Session 137 — orchestrator round: seven slices, and a round whose dominant finding was about its own gates

**Date:** 2026-07-30 · **Role:** orchestrator (`main-orchestrator`, single-track `main`, root checkout)
**Predecessor:** `136-2026-07-29-…` (knowledge-implementer) · **Successor:** _(next orchestrator session doc)_
**Round commits:** `809516ad..HEAD` — count with `git rev-list --count 809516ad..HEAD`, ⛔ **never quote a count from prose**
**Round narrative + decisions:** `docs/archive/IMPLEMENTATION_LOG.md`, entry `2026-07-30`
⛔ **NOTHING PUSHED** — owner-run by standing posture. Count unpushed with `git rev-list --count origin/main..HEAD`.

> **Why this doc exists:** the owner ruled an **orchestrator-only cycle**, and substantial orchestrator-side work landed (a gate fix ported to the scaffolding template, a convention flip, seven briefs, eight numbered tasks, a banked lesson) — Step-6's YES criterion.
>
> ⚠ **CORRECTION, added after this doc's own commit `103f15c7`:** this paragraph originally said *"all four implementers stayed up (27–56%) with no `/session-end`, so there are no implementer session docs this round."* **True when written; false minutes later.** The owner **revised the cycle to include `worker-implementer`** — it had climbed from 56% to **73% (WARN)**, it is the **critical path** (four queued items; sole unblock for knowledge *and* desktop), and it was cleanly between slices. ⇒ **`docs/sessions/138-…` is worker's, and it lands in its own commit AFTER this one.** ⛔ **So this doc's `/orchestrate-end` did NOT consume an implementer recap, and Step 1's "no implementer session doc" is a statement about ORDERING, not about absence** — a successor must read 138 alongside this. **contract, knowledge and desktop did not cycle** (27–33%). ⭐ **Corrected rather than rewritten, because the stale claim is the only thing that explains why the close-out doesn't reference a doc that exists.**

---

## What was built

**Seven slices** (six full + one leg), all verified against the **committed tree** rather than the commit subject:

| Task | Commit | One line |
|---|---|---|
| 9.39 | `89797bb2` | Delete the Copilot `turns` seed door — L103's structural answer, replacing 9.25's scanner (−353 lines) |
| 9.38 | `abf648c6` | The stored-row corruption code reaches a diagnostic consumer (L106's third-of-three) |
| `#38` | `64b682e5` | `egressRevoke`'s read stays gated — **closed by a PIN** after three sessions as a bare pointer |
| 9.27 | `c7a1e21a` | ⚠ **rule-5** — the Employer-Work egress notice made un-omittable at the type level |
| 13.21 | `8b2a0af4` | Owner-ruled Option C: `EntityRef` element-immutability restored at knowledge's sites |
| 13.22 | `a7323fa6` | The two `pure-root-scan` copies pinned equivalent |
| 13.8f-B | `9afc2eaf` | **The keystone** — `rewriteVaultForMeeting`'s first gated worker call site |
| 9.41-A | `bd73d4ea` | The audit drill-down summary shape frozen (leg A of three) |

**Orchestrator-side:** `spec-lint`'s use/mention escape (`86b5ecd0`) + its port to `scaffold/templates/` (`e26d8b5`, **unpushed, and `scaffold/` is now closed to writes**) · the trailer flip to `Opus 5` (`ae390a70`) · **L114** banked (`d566a5f1`) · seven briefs (227–233) · eight tasks numbered.

## Decisions made

- **9.27's cross-area crossing → Option A** (owner). No-cross-area rule relaxed **for that slice only**, scoped to two call sites in eval-security territory. **Verified twice independently** — orchestrator from the working tree, lead from the commit — at `4/2`: two call sites plus one explanatory comment each. **Ruling adopted: a comment explaining an authorised cross-boundary edit is PART of that edit**, since leaving a bare `{ kind: "none" }` for another area to reverse-engineer is worse stewardship, not more conservative.
- **Commit trailer → `Opus 5`** (owner). Closed in **three** in-target prescriptions, not the two named — a third in `docs/HANDOFF.md` was uncatalogued, and leaving it would have relocated the conflict rather than closed it (extension **disclosed, not hidden**; lead approved). ⛔ **The token was deliberately NOT swept:** it is also a **pricing table** (real model id + per-token rates) and a **cost-cap premise**. A blind replace would have falsified both. **Same literal, three meanings — classification, not substitution.**
- **`EntityRef` readonly → Option C** (owner, after a plain-language write-up). ⚠ **This overturned the orchestrator's own earlier prescription**, which scoping had refuted: `readonly` is **0 of ~30** in `packages/contracts/src/models/`, so adding it would have made `EntityRef` the outlier against a self-documented convention. **The real defect was a convention boundary crossed between two packages, not a convention violated.**
- **`scaffold/` closed to further writes** for the round (owner; account confirmed as theirs). The template↔in-target trailer divergence is a **knowing, recorded** consequence — a future `scaffold-upgrade` would re-import `4.8` over the ruling.

## Decisions explicitly NOT made

- **`/phase-exit 9` — still UNSPENT, by design.** Untouched this round. The blocker remains 9.5's doc-pack leg (a Drive connector that does not exist) plus the owner's nothing-deferred ruling. Both unblocks are the owner's.
- **13.8f-C's sequencing** — recorded as *with or after 13.8i, never before*, but **not** scheduled.
- **`(a0)(viii)`'s fix** — three candidates recorded cheapest-first; **the owner chooses**, not the orchestrator.
- **The `providerMatrix` seed** — untouched. An empty matrix remains a correct state.

## ⭐ The round's dominant finding, and its counterweight

**Read these together. The second is what makes the first safe to read (L111's meta).**

**Seven false-greens surfaced and only ONE was a bug in code:** `lint` that isn't lint · **`plan-lint`, a working gate nothing invoked** — found by it catching three orchestrator commits · a **MANDATED** `graphify` stale by a full round · a narrative-only task that would have linted green against the wrong checkbox · **two landed commits under unticked boxes** · work reported as owed that had already shipped · **and two the orchestrator authored**, one inside a brief written *while working the backlog about false-greens*.

**Every orchestrator brief was corrected by a closer reader — eight times, across all four implementers and their reviewers**, and *all* of it arrived as `file:line` findings rather than complaints:

1. `registry-all` measuring nothing (the bullet was **withdrawn, not waived**)
2. a comment-sweep grep pattern missing a site
3. a change-set predicate undercounting by two
4. an over-generalised `Readonly<T>` **depth** claim — *derived-cannot-drift is true of the field SET, silent on DEPTH*
5. a silently-dropped **symlink/lexical** bound on a "structurally closed" claim
6. an over-required comment set (routed to the orchestrator rather than trimmed — correctly, since the depth came from its requirements)
7. an acceptance criterion contradicting a precedent recorded **in the very task it descended from**
8. an `activeForm` mitigation **prescribed to the one party whose tooling cannot render it** — while quoting the caveat that says so

⇒ **This works because briefs cite premises that CAN be contradicted in one command.** ⚠ **Two of the eight shared one root cause, recorded against the orchestrator: specify a change set by what BREAKS, not by what the call LOOKS LIKE.** And **four verification greps produced false negatives** — the discipline of checking the tree is right; the *pattern* needs the same care as the decision to check.

## ⭐ The posture your successor should inherit, not just the state

**Two things belong here as posture rather than as findings, at the lead's request.**

**1. Never self-assess context; send the canonical line verbatim.** At close-out the temptation was to paraphrase — *"I'm around 70%"* — from a number the lead had already given me. Instead I ran `check-team-context.sh main --brief` and pasted it whole: `Team main: ACTION (worker-implementer=73%, main-orchestrator=79%)`. ⭐ **That is why the 79% is trustworthy, and it is also how `worker-implementer=73%` surfaced at all** — a figure that had moved from the 56% the owner's ruling was priced on, on the one area that is the critical path. **A paraphrase would have carried my number and silently dropped worker's.** ⇒ **The rule earns its keep precisely when paraphrasing would be easiest and would look harmless.**

**2. ⭐⭐ THE EIGHTH CORRECTION IS THE MOST IMPORTANT ONE IN THIS DOC, and it is not about `activeForm`.** I prescribed *"check `activeForm` before flagging a crossing"* — repeatedly — to the one party whose tooling **structurally cannot render it**, **while quoting the (a4) caveat that says exactly that.** Worker established it from their own tooling and offered a better substitute (*"have I already sent a Step 9?"* — check your **own outbound state**, not the board), which I adopted **verbatim**, replacing mine in the tracker.

⇒ **The posture: an orchestrator who can be corrected by the person RECEIVING the instruction is the mechanism working, not a failure of it.** ⛔ **Briefs and rulings that cannot be contradicted do not get corrected — they get followed.** All eight corrections this round arrived as `file:line` findings rather than complaints, and the reason is structural: **every brief cited premises checkable in one command, so a closer reader could contradict them cheaply.** Three of the eight were defects in *orchestrator-authored fixes*, found by the people the fixes were aimed at.

⚠ **Do not read the correction count as a quality problem to drive down.** Driving it down means writing briefs nobody can check — which converts visible, cheap corrections into invisible, expensive ones. **The count is the instrument, not the defect.** And **hold your own rulings to the same standard as your claims**: contracts **L113** exists because a low correction rate on *judgement* is evidence nobody checked it, not evidence it was better. **Ask the party who bore a ruling's cost to price it, with a specific question** — the generic *"anything unfiled?"* reliably returns nothing.

## Open follow-ups

- ⛔ **`(a0)(viii)` — nothing systematically surfaces tracked work nobody is queued on.** **9.27, a rule-5 fail-open, sat OPEN 07-26→07-30 in no queue.** ⭐ The anti-scanner lesson does **not** apply: **the tracked set is CLOSED and ENUMERABLE, so a sweep over it IS a gate.**
- **13.8f-D** — a throwing rewrite port degrades silently with no operator signal. **Exactly L114**, numbered rather than left in a review note.
- **9.40** — L106 #5, the Copilot proposal-row affordance with no live producer. ⚠ Its Done-when forks on a **product decision**, not an implementer's.
- **The `scaffold/` trailer divergence** — owed the moment writes reopen.
- **Carry-forward triage:** 6 items, all **KEEP**; two had completed sub-parts **deleted with pointers** (13.8f-B in item 1; 9.10-D → `### 9.41` in item 3). *0 deleted, 0 inlined, 0 deferred, 0 spread, 6 kept.*

## Next session target

**Worker is the only dispatchable area; the other three are blocked on it, not idle by choice.** Queue and precise unblock conditions are in `IMPLEMENTATION_PLAN.md` "Currently in progress" — including that **knowledge's 13.8m work is now *"widen `MeetingVaultRewriteResult` to carry `refusals` + add the sink"***, narrower than anyone had named, because the port **deliberately omits `refusals`** (adding it with no consumer would mint a fresh L106).

⚠ **`contract` has nothing clean** — 11.4 lead-held as not-standalone, 13.5's remainder isn't theirs, 13.8 is knowledge-led. ⛔ **Do not hand contract the `EntityRef` readonly question** — owner-ruled, shipped as 13.21.
