# Team Handoff 018 — egress-honesty round SEALED; FULL TEARDOWN (owner-directed)

**Date:** 2026-07-29 · **Track:** single-track `main` (no worktree — root checkout)
**Predecessor:** `017-2026-07-27-egress-integrity-sealed-hardstop-cycle.md`
**Successor:** `019-2026-07-29-two-waves-sealed-lead-context-pause.md` — ⛔ **NOTE: 018's three-step commit discipline is DEFECTIVE and 019 corrects it** (a pre-check chained into the commit is a receipt, not a gate; use `git commit -F <msg> -- <paths>`). 018's *"9.21 is the sole remaining gate blocker"* is also FALSE — see 019.
**Round-seal commit:** `9e478c4e` · **origin/main:** `d0886ea4` · ⛔ **64 COMMITS UNPUSHED — OWNER-RUN**

> **⭐ READ THIS, then `IMPLEMENTATION_PLAN.md` "Currently in progress"** (the three un-re-derivable items live there, deliberately NOT in Residuals) **+ `docs/team-protocol.md`** (not auto-loaded).

## Why this handoff exists

**Owner-directed FULL TEARDOWN** — not a cycle. All six sessions closed out and were shut down. The next session **re-spawns from scratch** using the prompts below.

## ⛔ FIRST FOUR THINGS

1. **PUSH. 64 commits.** Owner-run. Everything below is local-only.
2. ⚠ **`CLAUDE_CODE_SUBAGENT_MODEL` is currently `sonnet[1m]`** in `.claude/settings.local.json`. It governs **every** teammate uniformly. The `Agent` spawn `model` param does **NOT** override it (verified 2026-07-29) — a mixed-model team needs the odd one out set manually per-pane by the owner. Last round ran sonnet implementers + a manually-set opus orchestrator, and that worked well.
3. ⚠ **`pnpm lint` IS `pnpm typecheck`.** ESLint is not installed and has no config; no package defines `format:check`. **Every "preflight clean" claim in this project's history means "typecheck + tests passed."** There has never been lint or format coverage. State it that way; do not write "lint clean."
4. **Phase 9 is NOT exitable.** #8 landing does not change that — **9.21 is the sole remaining blocker and it is OUT of scope.** The acceptance line was updated so nobody misreads it.

## What landed

**The egress claim is now honest end to end.** `zeroEgressOnly` was derived from `!employerRawEgressAcknowledged` — a *consent flag* — at three sites, so it could assert local-only for a workspace with a cloud-allowlisted processor. All three now derive from `isZeroEgressOnlyWorkspace` (the owner-ruled option-C predicate), and the surface renders it epistemically.

**Five-slice tail (owner-scoped):** `2c03b3af` 13.8m-B · `bed423cb` 13.8h · `d7a9b170` 9.34 · `69b10883` **9.22** · `cda4d2f4` **#8**.
**Earlier this session:** 9.23 · 9.29 · 9.30/9.31 · #36 · #40 · #41 · 9.33 · gitignore `graphify-out/`.

**Green at seal:** db 453 · desktop 483 · worker 2006 · policy 477 · evals 613 · knowledge 653 · `plan-lint` 0.
**Lessons L84–L91** (+ amendments to L70/L75/L83/L89), index parity verified.

### Two owner rulings that are now load-bearing semantics

- **An empty `providerMatrix` is a CORRECT state**, not a missing writer. So `zeroEgressOnly` is `false` and the surface reads **"Provider routing: not established."** ⛔ **That is the deliverable, not a shortfall.** Do not "fix" it by seeding a default — a writer defaulting to local-only manufactures exactly the reassurance this arc deleted.
- **`false` means NOT ESTABLISHED** — never "cloud egress is possible." Both readings are claims the app cannot support.
- ⚠ The predicate covers **model-provider routing only**. Connectors and Tool-Gateway writes egress on their own paths and never consult it. The surface says so. **No wording may imply "nothing leaves this machine."**

## In flight at close

**None.** Tree clean. All five implementers `/session-end`-closed (docs **125–129**), orchestrator `/orchestrate-end`-sealed.

## ⭐ The three things a fresh session cannot re-derive

In `IMPLEMENTATION_PLAN.md` "Currently in progress" — put there *because* Residuals is where they would be missed:

1. **`lint` is typecheck** (item 3 above). ⚠ **This was already recorded in phase Residuals since 2026-07-26, correctly analogized, and re-confirmed — and all seven of us still read "lint clean" as evidence for a full round.** The move out of Carry-forward into Residuals was *correct* bookkeeping and is *exactly* what stopped it being read. **Correct bookkeeping produced the blind spot.** ⇒ **When you de-prioritise a known false-green, disarm the signal in the same move** (rename the script, or make the gate announce what it checks). ⚠ The next session will triage Carry-forward and skim Residuals exactly as we did.
2. **The eval guard sweep stopped on an OWNER BOUND, not on dryness.** Three iterations, **all three productive**; lens G never started; **7 of 7** leads on the last completed lens verified as real blind guards. Its task list is a **partial sample of an unfinished search**, and the hit rate says more remain. (#30, #41)
3. **9.32 deferred as an arc** ⇒ `true` is unreachable in production ⇒ #8 renders NOT ESTABLISHED **by design**. The product question is genuinely open: extend `ProvisioningProfile` / a settings surface / a local-model detection probe — none ruled out.

## Open findings — read the evidence-strength labels, they are deliberate

- **#44** — the §12 exactly-once suite still runs on a **fake** CAS. ⚠ "Delete the guard in production and the eval stays green" is **NOT simulation-proven**; the real function *is* pinned at `packages/db/test/invariants/operational-truth.test.ts`. The accurate statement is **a false green in one DoD criterion, not an undefended production path.**
- **#45** — the §5 veto's `AuditSignal` is produced and **dropped**; no persistence consumer.
- **#43** — the MEETING path has **no refusal channel at all** (producer field absent). §ARM-RESEARCH precondition.
- **#38 · #39** — the revoke-side race's benign half, and a foreign `egressPolicy.workspaceId` now detected nowhere (read side was always unguarded; not opened by 9.30).
- **#35** — **no ErrorBoundary anywhere in `apps/desktop`**: any render-time throw unmounts the whole root.
- **#26 (9.32) · #16 (9.27) · #32 · #37 · #9 (9.21)** — tracked, unstarted.
- ⛔ **§DEC-CANDGATE deferred a SECOND time, explicitly.** Owner-approved 2026-07-26 as a contract-first arc; skipped 07-28; deferred again 07-29 because the round's scope was arc + tail + teardown. **Cost: `EntityRef` has no schema in `packages/contracts` and no runtime validation, so every fix remains an instance-fix rather than a class-fix.** A recorded decision, not an oversight.

## ⚠ Two process findings that outrank most of the code

1. **Three reported reds; none reproducible at committed HEAD.** `@sow/evals`, `@sow/db`, and the desktop bundle test. Two were **tree-state artifacts of reading or testing a shared tree mid-slice.** ⇒ **"I saw a failure" and "the repository has a failure" are different claims.** Verify at a **commit**, never the live tree, while anyone is mid-slice.
2. ⛔ **A stall went undetected for ~20 minutes and the OWNER caught it — no instrument did.** A lead clearance stopped at the orchestrator and was never relayed; desktop waited on a go that never came. **A clearance that stops at the routing layer is indistinguishable, from the implementer's side, from a clearance never given** — everyone waits, nobody is blocked by anything real, and no signal reports it. **A stall is the only failure mode whose signature is the absence of a signal.** The check is answerable from data we already have: *is any task `in_progress` whose owner has been idle longer than a slice takes, with uncommitted files in its territory?* → scaffolding follow-up, next to the heartbeat fix. Corollary: **whoever imposes a hold owns releasing it.**

## Standing rules (unchanged)

Producer-first · composition-root = worker · no cross-area single-implementer verticals · ⚠ **safety/rule-5 Step-9s route to the LEAD** · push = owner-run at seals.

**Shared-tree discipline (five contention incidents last round, three inside a rule-5 commit):** per-file `git add` is **necessary but not sufficient**. Every commit: `git diff --cached --name-only` **BEFORE** · chain `add && commit` in **ONE** invocation · `git show --stat` **AFTER**. **Step 3 is the one that catches what 1–2 miss.** Structural fix (per-area worktrees or serialized close-out commits) is recorded, not done.

**Simulation mutations NEVER survive a turn boundary** — mutate, observe, revert, in one turn; worktree if longer. Other agents cannot distinguish your simulation from a real regression.

**Session doc numbers are ASSIGNED by the orchestrator, not auto-derived** — concurrent close-outs collided on 120 two cycles ago.

## ⚠ The lead-layer finding

**L81/L91 name the lead explicitly, and this round earned it.** Four lead-level framing errors, all compression-shaped, all caught by someone closer to the code:

- Relayed a bounded eval finding to the owner as an absolute ("nothing would notice").
- Told the owner #8 was unblocked without checking which predicate it read — would have shipped a rule-5 false assurance.
- Blocked 9.22 on a site that was already fixed: **two greps straddled a live edit, fused into one verdict** (and quoted, as proof of an untouched file, a comment that the edit deleted).
- Reported a session doc as committed when it was untracked — existence read as commit.

⇒ **The layer that writes the most durable text has the least contact with the code.** Every error was a claim *repeated* rather than verified; the clearances actually verified were sound. **Verify the claim you are about to repeat, not just the one you are about to act on.** And: ask the implementer to correct your close-out lists rather than dictating them — a wrong instruction in a close-out is never contradicted, because the work that would contradict it is what stops.

**A wrong instruction in a brief surfaces when the code contradicts it. A wrong instruction in a close-out becomes the durable record.**

---

## Spawn prompts for the next session

> Spawn the orchestrator first; implementers as their work opens. Each teammate's FIRST action is `team-register.sh`, then the start command. ⚠ Set the orchestrator's model manually if you want it on opus — the spawn param will not do it.

### Orchestrator
```
You are main-orchestrator on the System of Work Assistant agent team.
Track: main (single-track — repo root, NOT a worktree). Track label: main. All commits land on `main`.
Activated because: fresh session after a FULL TEARDOWN. Read docs/team-handoffs/018-2026-07-29-egress-honesty-sealed-full-teardown.md FIRST, then IMPLEMENTATION_PLAN.md "Currently in progress" — the three un-re-derivable items are there deliberately, NOT in Residuals.
⛔ 64 commits were unpushed at handoff — confirm with the owner whether they pushed before assuming origin is current.
⛔ `pnpm lint` IS `pnpm typecheck`. ESLint is not installed. Never write "lint clean" — write "typecheck + tests clean; no lint coverage exists."
⛔ Phase 9 is NOT exitable: 9.21 is the sole blocker and is out of scope until the owner says otherwise.
⛔ An empty providerMatrix is a CORRECT state (owner-ruled). zeroEgressOnly reads NOT ESTABLISHED by design. Do NOT seed a default to "fix" it.
Standing rules: producer-first; composition-root=worker; no cross-area verticals; safety/rule-5 Step-9s → the LEAD; push owner-run.
⚠ Verify implementer claims against COMMITS, not the live tree, while anyone is mid-slice. Three reported reds last round were tree-state artifacts.
⚠ A hold you impose is yours to release. A clearance that stops at you is invisible to the implementer waiting on it — that cost 20 minutes last round and only the owner noticed.
⚠ Treat a code-contradicting correction as the process working, and carry it upward. Six such corrections last round; all were right.

FIRST ACTION: ~/.claude/scripts/team-register.sh "main-orchestrator" orchestrator "main" "" "main" "main"
Then /orchestrate-start (NOT /session-start).
Confirm: (1) start command, (2) registry written, (3) re-derived state + first dispatch.

NOTE: graphify-out/graph.json exists — `graphify query "<question>"` to orient BEFORE reading raw source.
```

### Implementers (spawn as work opens)
```
Common to all: Track main, repo root, label main; commits land on `main`; talk only to the orchestrator.
FIRST: team-register.sh "<name>" implementer "main" "<area>" "main" "main" → then /session-start.
⭐ READ YOUR PREDECESSOR'S SESSION DOC FIRST (below) — written for you.
⚠ SHARED TREE: `git diff --cached --name-only` BEFORE · `add && commit` in ONE invocation · `git show --stat` AFTER.
⚠ A brief that contradicts the code is a FINDING, not an instruction to follow carefully.
⚠ Safety/rule-5 Step-9s route to the LEAD via the orchestrator.

worker    (apps/worker/)        doc 128 · queue: #9 9.21 (Phase-9 blocker, owner-gated) · #16 9.27 · #32 · #38 · #39 · #45 · 13.8m-C's worker half
desktop   (apps/desktop/)       doc 129 · queue: #35 NO ErrorBoundary anywhere (a render throw unmounts the root) · #13
knowledge (packages/knowledge/) doc 127 · queue: #43 13.8m-C — the MEETING path has NO refusal channel (producer field absent)
evals     (packages/evals/)     doc 125 · queue: #30 sweep (NOT dry, lens G unstarted, 7/7 verified last lens) · #37 spine suite (needs live infra) · #44
provint   (packages/providers/) doc 126 · ⛔ perplexity/xai must NEVER enter LOCAL_PROVIDERS (§ARM-RESEARCH). LOCAL_PROVIDERS stays module-private; export predicates.
contract  (packages/contracts/) NOT spawned in 2 rounds · §DEC-CANDGATE opener: EntityRef has NO schema; planner.ts validates only workspaceId/sourceRefs
```

## Pending owner gates (surface, never decide)

Employer login-switch residual · per-workspace subscription split · §ARM-23 web-fetch · connector arming · **§DEC-CANDGATE** (approved, twice-deferred) · **task 24.6 pre-go-live safety-assertion audit** (approved; scope grew materially this round — test assertions, fakes, corpora, docs, and *toolchain* are all in scope, and the constant-DENY substitution test is the cheapest probe).

## How to resume

Lead runs **`/team-start main`**, reads THIS doc + `IMPLEMENTATION_PLAN.md` "Currently in progress", spawns the orchestrator, then implementers as work opens. **Confirm the push happened first.**
