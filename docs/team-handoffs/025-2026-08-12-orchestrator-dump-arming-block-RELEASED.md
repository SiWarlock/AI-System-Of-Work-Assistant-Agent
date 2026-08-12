# 025 — ORCHESTRATOR STATE DUMP (arming block RELEASED; per-crossing gates stand)

**Date:** 2026-08-12 · **Track:** single-track `main` · **Author:** `main-orchestrator` (Sonnet 5) at ~77%, owner-directed cycle
**Status:** Orchestrator-only cycle. Worker already cycled (its replacement is **Opus 5**). Knowledge + providers stay. **No slice is in flight for me** — this is a clean handoff point.
⭐ **SUPERSEDES `023` AND `024` AS THE RESUME PATH.** `024` remains accurate as provenance; its dispatch list is twice-amended and **explicitly not instruction**.

> ⛔ **Verify every literal by command.** `git status` returns the literal `ok` here **and so does `git commit`'s receipt** (`L133`) — **and the receipt's FILE COUNT is wrong too, not just its success/failure.** Use `git log`/`git show`.

---

## ⭐⭐ THE HEADLINE: THE ARMING BLOCK IS RELEASED — AND THAT GRANTS NO CROSSING

**Owner ruling 2026-08-12, via the lead. Recorded at `eeda6864` across THREE surfaces.**

- ⭐ **RELEASED: the BLANKET HOLD that sat on top of every crossing since round 2.**
- ⛔⛔ **NOT RELEASED, and this must never be separated from the sentence above: EVERY INDIVIDUAL CROSSING REMAINS OWNER-GATED BY ITS OWN `§ARM-*` LEDGER. NOTHING IS ARMED. NO CROSSING MAY EXECUTE WITHOUT ITS OWN EXPLICIT OWNER CONFIRMATION AT THE TIME.**
- ⭐ **The release RETURNS the project to PER-CROSSING GATING. It does not grant a single crossing.**
- ⛔ **Never write "arming clear" or "cleared to arm."** **Safety rules 1–7 untouched; Step-9 routing on rules 1/4/5/6 still reaches the lead.**

**Conditions, all discharged:** (a) `24.12` `c86030f9` · (b) `24.17` `004ad65c` lead-verified · (c) `24.5`/`24.20` `aac45cf0` lead-verified · (d) `24.7` `0c8de4b2` lead-verified.

⭐ **WRITTEN TO THREE SURFACES DELIBERATELY, because a crossing-planner does not read the tracker's in-progress section** (`L94`): the tracker · **`## Owner gates & arming ledgers`** (leading with *"the block was released and THAT CHANGED NOTHING ON THIS PAGE"* — that page IS the per-crossing gate list) · **the turn-on runbook after `## Overview`**, so an operator meets it before step 1.

⚠⚠ **THE OPEN CAVEAT — an OPEN RECOMMENDATION, deliberately NOT a blocker (the owner released without conditioning on it):** `24.6`'s severity gradings across audits `001`–`004` **rest on reachability qualifiers**, and that class of claim was **falsified three times in one session by three competent people working by hand** (`L141`), with failures **biased toward over-claiming reachability**. **`24.29`'s census exists and has NOT been pointed at them.** ⇒ **re-derive the qualifier for your crossing's findings before relying on their severity.** ⭐ **A finding graded *"dormant, therefore not a live breach"* is exactly the shape that was wrong three times.**

**`24.8` / `24.9` / `24.33` remain NON-BLOCKING wiring preconditions for their own later crossings — unchanged by the release.**

---

## ⛔ TWO CORRECTIONS THE SUCCESSOR MUST HAVE

**1 — `24.43` IS DONE (`a5214c8e`, ticked). The cycle instruction that the fresh worker "takes `24.43`" is STALE.** ⚠ **A fresh Opus-5 worker handed that would redo completed work.** ⭐ **The Step-2.5 conditions the lead wanted carried forward are already SATISFIED in it** — the deliberate RED for leg B was run for real (throwaway orphan migration → confirmed failure naming the table → removed → green). **Worker's real next slice is `24.37`** (see queue).

**2 — ⭐ THE SPAWN `model` PARAM *DOES* OVERRIDE `CLAUDE_CODE_SUBAGENT_MODEL`.** The lead **tested this rather than trusting their own standing note that said it could not**, and verified in `~/.claude/teams/session-c9149a0e/config.json`: the new worker is `claude-opus-5[1m]` while orchestrator/knowledge/providers are `claude-sonnet-5[1m]`. ⇒ **mixed-model teams work; NO session restart needed.** ⛔ **Recorded as a CORRECTION because the stale note is `L143`'s shape in operational tooling — it would have cost a future lead a session restart it did not need.**

---

## Where the work stands

**Shipped this round (verified against diffs before ticking, not from Step-9 reports):**
`24.13` `7a4fe0ac` · `24.5`/`24.20` `aac45cf0` · `24.18` `91a68725` · `24.19` `4cef394f` · `24.29` `409730b6` · `24.30` `4730211b` · `24.7` `0c8de4b2` · `24.36` `f5cac8a8` · `24.38` `5fc64421` · `24.35` `3cc87f6f` · `24.39` `4db89061` · `24.43` `a5214c8e` · `24.33` `ce8e839f` · `24.32` `05fd1146` · `24.23` `68a83dd0` · **orchestrator-territory:** `24.40` `e0436916` · `24.41` `186c5fc6` · `24.42` `4d7d7051`.

⭐⭐ **The `L134` chain CLOSED at four — `24.23` → `24.30` → `24.36` → `24.38` — each instance surfaced by the PREVIOUS fix's own review, NONE by a gate, and the first-found was the last fixed.**

**Live:** knowledge on `24.33`'s follow-through / free · providers on `24.15` (task #19, Step 2.5 resolved, opens at Step 3) · worker **fresh (Opus 5)**.

**FILED + UNDISPATCHED** — ⚠ **verify each against the tracker; this list is a snapshot:**
- **`24.37`** — ⭐ **worker's natural next.** The `boot.ts` deps-literal audit, **widened**: `auditPersist` must be REQUIRED at consumption, not merely complete at construction.
- ⛔ **`24.45`** — `isRedactionSafe` is a keyword heuristic whose doc claims coverage it lacks. **BLOCKS the Phase 25.2/25.4 wiring, because the defect ARRIVES WITH the fix for it.** providers territory.
- **`24.44`** · **`24.26`** — ⛔ **cross-track PAIRS; `L121`'s provenance puts these with the LEAD.** ⚠ **Knowledge has been structurally idle for three dispatch rounds — not for lack of work, but because ALL its remaining work is paired. That is an allocation fact, not a scheduling gap.**
- **`24.46`** (contracts — unqueued) · **`24.47`** (eval-security — unqueued) · **`24.48`** · **`24.49`**.

---

## ⛔ TRAPS — every one cost real time today

1. **`git status` AND `git commit` both return the literal `ok`** — **and the receipt's FILE COUNT lies too.** One commit printed *"3 files changed, 100 insertions"*; `git show --stat` proved **1 file, 4 insertions.** **Verify by `git log`/`git show`, always.**
2. ⛔ **`git commit -- <paths> -m "msg"` FAILS** — `-m` after `--` parses as a pathspec. **Use `git commit -m "msg" -- <paths>`.**
3. ⛔ **`grep` with `\|` ALTERNATION returns EMPTY through this wrapper even when content is present.** Single-pattern greps. **An alternation grep's empty result is NOT evidence of absence** — I hit this verifying `"notebody"` (alternation → 0, single-pattern → 1).
4. ⛔ **NEVER read an exit code through a pipe.** `plan-lint … | tail -1 && git commit` reads **TAIL's** status — **I committed over a plan-lint RED that way** (`L111`→`L109`). **Use `cmd > /tmp/x 2>&1; echo $?`.**
5. ⚠ **`grep` is LINE-BASED: a phrase that WRAPS across a line break returns 0.** I nearly reported a missing scoped-claim on a commit that had one. **Read the text.**
6. **The default vitest reporter loses lines to terminal overwrite under capture** — use `--reporter=json --outputFile=`.
7. **`pnpm lint` IS typecheck.** Never write "lint clean."
8. ⭐ **`plan-lint` is now a LIVE pre-commit hook** (`.git/hooks/pre-commit`, owner-installed). **A tracker commit with a violation FAILS.** ⚠ **Repo-local, NOT shared by clone** — the briefing's mandatory before-and-after step is marked **do-not-delete** and remains binding.
9. **Messages cross CONSTANTLY** — **six times today.** ⭐ **Standing rule given to both implementers: if you sent a checkpoint and the orchestrator has had a turn since, ASSUME THE REPLY IS IN FLIGHT and check before flagging.**

---

## ⭐⭐ THE ROUND'S RESULT, and it is about method, not output

**TWELVE corrections landed against claims carrying ORCHESTRATOR or LEAD authority. Every one attached evidence. Every one was right.**

⭐ **Two were reviewers falsifying the ORCHESTRATOR's own approved premises:** `24.32`'s security-reviewer killed a leg of an approval I had already given (*"no real payload would carry `notebody`"* is true **vacuously** — there is no real producer to audit), and `24.23`'s found a **right classification resting on a wrong recorded reason** (`24.49`).
⭐ **`24.23`'s recorded scope was WRONG — filed as "one mapper, one concern," it was FOUR consumers** — found only because the implementer **enumerated** instead of fixing the one named.
⭐ **Knowledge falsified condition (d)'s premise from source at Step 0, before writing a line** — which is why `24.33` left the release path.

⇒ ***The records here are trustworthy not because anyone was careful, but because claims were cheap to falsify and people falsified them.*** ⛔ **The apparatus caught almost none of it. `plan-lint` caught four of MY violations; every other catch was a person re-measuring a claim rather than re-reading it.**

**Lessons banked: `L141`–`L145`.** Read **`L143`** (a recorded finding decays — re-measure, don't re-read) and **`L145`** (a comment asserting its own liveness is a reachability claim nothing re-measures) first.

⚠ **My own record, stated plainly rather than buried:** I authored two briefs with wrong scope, approved a narrowing on a premise a reviewer then falsified, committed over a `plan-lint` RED within the hour of filing the task to prevent exactly that, and let three documents go stale — the Log twice, `024` twice. **Each was caught by someone else re-measuring. That is the system working; it is not evidence the orchestrator was reliable.**

---

## For the successor

**First action: `/orchestrate-start`, then verify this file's claims against the tracker before acting on any of them** (`L143` — this dump is a snapshot and its author is the last person positioned to notice it has aged).
**Then: dispatch `24.37` to the fresh Opus-5 worker** (brief it; don't hand the tracker text). **Providers continues `24.15`. Knowledge needs the LEAD to sequence a pair or it stays idle.**
⛔ **Do NOT re-dispatch `24.43` — it is DONE.**
