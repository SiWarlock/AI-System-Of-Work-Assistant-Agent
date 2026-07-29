# Team Handoff 019 — two waves sealed, Phase 9 audited, team PAUSED on lead context

**Date:** 2026-07-29 · **Track:** single-track `main` (root checkout, no worktree)
**Predecessor:** `018-2026-07-29-egress-honesty-sealed-full-teardown.md`
**Successor:** _(next `/team-end`)_
**Round-seal chain:** `a0661c19` → `6286f0d3` → `29417647` · **unpushed:** run `git rev-list --count origin/main..HEAD`

> ⛔ **PUSH IS OWED AND OWNER-RUN.** Nothing was pushed. Do not quote a commit count from this doc — it rots; run the command.

## Why this handoff exists

**Lead context reached ACTION tier (75%) with the owner away.** Owner's standing instruction: pause/idle the team at 80–85%. Both waves are sealed, the tree is clean, nothing is in flight. **The four implementers remain ALIVE AND IDLE** with warm context (49–61%) — this is a pause, not a teardown.

## ⛔ READ THESE TWO LINES FIRST — they are the round's thesis and they point in OPPOSITE directions

1. **L110:** *A record's job is not to be TRUE, it is to change what happens BY DEFAULT.* A correct entry that leaves the default untouched buys only the ability to say it was known — **worse than not knowing, because it converts a surprise into a foreseeable omission.**
2. **L111 meta:** *SKEPTICISM HAS A FALSE-POSITIVE RATE AND ITS FALSE POSITIVES DESTROY WORKING MACHINERY.* A distrusted-but-working gate is **worse** than a known-broken one — it gets bypassed *and* never replaced.

⚠ **Why #2 must be read with #1:** this round produced ~30 over-claim corrections and exactly one false doubt. **A reader who takes only the over-claim lessons will build the inverse defect.** The training set is lopsided; the correction is not.

## Team composition at close

- **Lead:** this session (track `main`), 75% at close
- **Orchestrator:** `main-orchestrator` — the *successor* (predecessor cycled at 78%, terminated conclusively, replaced without name overlap). 73% at close.
- **Implementers (all ALIVE + IDLE, `/session-end`-closed):** `worker-implementer` (doc 134) · `desktop-implementer` (doc 135) · `knowledge-implementer` (doc 136) · `contract-implementer` (**no doc — held by lead ruling all round, confirmed nothing unfiled**)

## What landed

**Wave 1 (six slices, pre-cycle):** `c09ccd9b` 9.21-A · `f4cc1b0f` 9.21-B (**9.21 CLOSED end-to-end**) · `3f33c97b` 9.35 · `93ebeabd` 13.18 · `0a6d6629` 13.20 · `93cafe5f` 13.19 (**§DEC-CANDGATE now exists AND is called**)
**Wave 2 (four slices, post-cycle):** `be62e348` 9.36 · `82ea0ebf` 9.37(a) · `71b0e437` 13.8m-C · `b7f39544` 9.25
**Phase 9 AUDIT, deliberately verdict-free** (`fed51bd5`): 10 anchors, **0 DRIFT**, 2 STALE-DOC; 1 unreachable desktop symbol. Lessons **L92–L112**.

## ⭐ The three things a fresh session cannot re-derive

1. **`/phase-exit 9` is UNSPENT and CANNOT return CLEAR.** 9.5's §4.5 doc-pack leg is blocked on a **Drive connector that does not exist**, and the owner ruled 2026-07-26 that nothing is deferred out of Phase 9. ⛔ **So Phase 9 is un-exitable until EITHER a Drive connector exists (a hard line, owner-only) OR the owner reverses that ruling.** ⚠ *"9.21 is the sole remaining gate blocker"* is **FALSE** — it reached the lead from THREE independent sources (owner brief, handoff 018, the plan) and **exactly one person checked.** The audit ran as an AUDIT precisely so a predetermined BLOCKED verdict was never minted; a qualifier attached to a quotable verdict does not survive quotation.
2. **`§4.5` was a NOTATION COLLISION, not a missing section** — it resolves to `docs/design/ui-ux/ui-ux-spec.md:206`. ⭐ **`ARCHITECTURE.md` has real numbered subsections ONLY under §19**; every other `§N.x` token in project prose is plan-task or other-doc shorthand wearing an architecture-anchor costume. **87 candidate lines** await a scoped sweep (measured, not estimated; candidate ≠ defect count).
3. **Root `pnpm lint` INTERMITTENTLY exits 1** before turbo starts (reproduced unpiped by knowledge, byte-identical to the orchestrator's dismissed run 1). `pnpm --filter . run lint` and `npx turbo run lint` succeed 11/11. Cause unidentified, **deliberately not chased**; exclusions in doc 136. ⚠ **Two findings, not one:** (a) the intermittency; (b) **something invokes eslint in a repo where eslint appears in ZERO manifests** — which cuts *against* "no lint coverage exists" and is a question mark over the invocation path, **not** evidence coverage exists.
   ⭐ **The finding that survives regardless, anchored on INSPECTION not execution:** all 11 packages' `lint` is literally `tsc --noEmit`; eslint in zero manifests; no `format:check`. **An inspectable fact cannot be re-opened by a flaky execution; an exit code can.** Never write "lint clean" — write *"typecheck + tests clean; no lint coverage exists."*

## In flight at close

**None.** Tree clean — 0 untracked, 0 modified, 0 staged.

## ⛔ Open decisions for the OWNER (surfaced, never decided)

- **Phase 9's exit** — build a Drive connector, or reverse the nothing-deferred ruling. Everything else in Phase 9 is done or audited.
- **The commit-trailer conflict.** `CLAUDE.md:93` **and** `/orchestrate-end`'s own template prescribe `Opus 4.8`; the harness prescribes `Opus 5`. **Decisive evidence, 4 data points + a controlled comparison:** every `Opus 5` in an implementer commit came from **copied orchestrator message text**; no implementer ever *chose* it — `b7f39544` had a supplied `5` and chose `4.8` unprompted. ⇒ **The routing layer's authorship silently overrides a documented repo convention.** Deliberately unresolved: an agent picking a side normalises a documented instruction out of existence.
- **Pre-existing gates, untouched:** employer login-switch residual · per-workspace subscription split · §ARM-23 web-fetch · connector arming · task 24.6 pre-go-live safety audit.
- **⛔ PUSH.**

## Carry-forward (next round, written into the tracker)

- **contract → 9.10-D leg 1** — released; 9.36 has landed off the `packages/db` seam. Lead ruling already made: adopt the `globalDrillDown` shape, `auditRef` NEVER leaves the worker, summary carries `event` + `occurredAt` ONLY, **no** `beforeSummary`/`afterSummary` (dropped as *"unbounded raw"*). The argument a future reader must **defeat**, not merely re-raise: an audit link's value is **provenance, not contents** — the renderer already shows the change.
- **worker → #38** (shrunk by 9.36 to *"does the revoke still need its own parse, given the read is now gated?"* — **establish, don't assume**) **+ 9.37(b)**
- **knowledge → the 13.8m meeting consumer**
- **Then 9.38** (task #12 — the unmet third of the Option-A refinement: the distinguishable error currently reaches nobody) **and the L106 #4 decision** (task #13)
- **Recorded, unworked:** the 87-line notation sweep · §DEC-CANDGATE leg 3 · delete the 9.25 seed door (the structural answer to a detector that cannot become a gate)

## ⚠ Process findings that outrank most of the code

1. **NINE overturns, and the asymmetry is STRUCTURAL, not luck.** A reader closer to the code overturned a reader further out nine times. **The counter-example matters too:** once the *lead* caught an error three closer readers missed — because the lead had **verified that specific commit earlier**. ⇒ **Refined rule: the closer reader usually wins, but a party who has verified a specific fact beats a fresh self-report regardless of distance.** ⭐ It only worked because briefs cited **falsifiable `file:line` premises** so they *could* be contradicted. **A brief that contradicts the code is a FINDING, not an instruction to follow carefully.**
2. **⛔ THE COMMIT DISCIPLINE IN HANDOFF 018 IS DEFECTIVE — DO NOT INHERIT IT.** The three-step form (`diff --cached` before · chained `add && commit` · `show --stat` after) has **no gate**: `&&` chains add→commit; **nothing chains check→add**. A pre-check printed a dirty index correctly and completely and the commit ran anyway, sweeping 14 of another implementer's staged files into a docs commit. ⇒ **A check whose output the actor reads only AFTER the action is a RECEIPT, not a gate.**
   ⭐ **CORRECTED FORM: `git commit -F <msg> -- <explicit paths>`.** A foreign staged file **structurally cannot** enter. ⚠ **Clause that must travel with it:** a NEW file still needs `git add` first — the add makes it *visible*, the pathspec on the *commit* remains the *filter*, so unrepresentability holds and only the no-add convenience does not. Without this clause someone concludes the form is broken and reverts to the detector.
3. **L100 has FIVE mechanisms for a wrong claim, and they sort by where they fail.** Wrong pattern · merged output · wrong scope (all fail at **gathering** → wrong fact) · **verified-evidence-inherited-inference** (fails at **inferring** → right fact, wrong conclusion, **every check passes**) · **incommensurable units** (fails at **comparing** → both facts right, comparison meaningless, **re-running CONFIRMS it**). Tells: *a count that decreases when content is added is a unit error, not a data change*; *"failed, then passed" reads FLAKY, never PASSING*.
   ⇒ **A negative claim from a scoped search is only as strong as its scope, and the scope must be stated with the claim.** *"I grepped and found nothing"* is not a finding unless it says where. **And stating the scope can reveal the claim was measuring the wrong thing** — that is how the 9.36 cast census was found to be counting decorations.
4. **The stall check is 0-for-3 and its limit is irreducible.** Three-signal method (task `in_progress` · owner idle · stale uncommitted files in territory) detects a **waiting state** and **cannot diagnose a cause**, because *an in-flight message is indistinguishable from an absent one at the observation point* — no fourth signal fixes it. ⇒ **Question, never accusation.** The round's one real stall was caught by a **read-back**, not the instrument. ⚠ And the lead logged a false positive as the check's *first true catch*: **a monitoring instrument's success ledger needs the same verification as any other claim, and inflates because the operator both raises the alarm and grades it.**
5. **SIX crossings.** Long messages and concurrent turns mean a reply routinely arrives after the thing it asks for is done. **Send a deadlock-breaking fact ALONE and SHORT.** Every crossing this round was harmless *because the receiver said so* — silent reconstruction is the failure, not the crossing.

## ⭐ The house pattern, and its limits

**Make the violation UNREPRESENTABLE**, six independent applications in one round, four authors, three areas, and now beyond code: 9.35's `fallback: (reset) => ReactNode` with **no error param** · `ProvisioningOwnedFields` (posture write untypeable) · 9.21-B's closed-literal partial variant · 9.36's read-gate · the **commit discipline** (process) · **inspectable evidence over exit codes** (evidence).
⛔ **LIMITS, which must travel with it:** it cannot express a runtime property, and **`$type<>()` on a DB column LOOKS like the pattern and is its INVERSE** — a compile-time claim over runtime-untrusted bytes, i.e. the defect 9.36 fixes. Without that, the seventh "application" is the original defect **defended by citing the lesson**.
⭐ **Process diagnostic:** *if the cheapest way to make the violation representable again is "forget one step," you have a DETECTOR, not a gate.*
⛔ **And where it does NOT reach:** *"no production consumer"* is a negative claim over an **unbounded construction space**, so three consecutive correct scanner fixes each left a hole that *moved* rather than shrank. **No scanner over an open space is ever a gate.** 9.25 ships as an honest **backstop** with two named residuals; the structural answer (delete the seed door) is recorded, not done.

## Spawn prompts for the next session

> **The team is ALIVE and IDLE — do NOT re-spawn.** Next `/team-start main` should verify the four implementers + orchestrator are still present (`~/.claude/teams/session-<first8>/config.json`) and resume by dispatching from Carry-forward. These prompts are for the case where the session was torn down.

### Orchestrator (only if respawning)
```
You are main-orchestrator on the System of Work Assistant agent team.
Track: main (single-track — repo root, NOT a worktree). All commits land on `main`.
Activated because: resuming after a lead-context pause. Read docs/team-handoffs/019-2026-07-29-two-waves-sealed-lead-context-pause.md FIRST, then IMPLEMENTATION_PLAN.md "Currently in progress".
⛔ PUSH IS OWED AND OWNER-RUN — confirm with the owner before assuming origin is current.
⛔ `pnpm lint` intermittently exits 1; lint-is-typecheck is established BY INSPECTION (11 scripts = `tsc --noEmit`, eslint in zero manifests). Never write "lint clean."
⛔ Phase 9 is un-exitable and `/phase-exit 9` is UNSPENT — the blocker is a nonexistent Drive connector plus an owner ruling, NOT 9.21.
⛔ COMMIT WITH `git commit -F <msg> -- <explicit paths>`. The three-step form in handoff 018 is a receipt, not a gate. A new file still needs `git add` first; the pathspec on the commit remains the filter.
⛔ An empty providerMatrix is CORRECT (owner-ruled); zeroEgressOnly reads NOT ESTABLISHED by design.
Standing rules: producer-first; composition-root=worker; no cross-area verticals; safety/rule-5 Step-9s → the LEAD.
⚠ Cite falsifiable file:line premises so you CAN be contradicted, and treat a contradiction as the mechanism working. Your predecessor was overturned on the gate blocker, an L26 citation, the cap ordering twice, 9.10-D's scope and #13's suitability; the lead was overturned on /phase-exit's premise, the cap ordering, four "absent" claims from searches that could not have matched, and a pre-approval it invalidated itself. Nine overturns, and the asymmetry is structural.
⚠ An allocation ask carries its OWN premise verification — do not defer it to brief-writing.

FIRST ACTION: ~/.claude/scripts/team-register.sh "main-orchestrator" orchestrator "main" "" "main" "main"
Then /orchestrate-start (NOT /session-start).
NOTE: graphify-out/graph.json exists — `graphify query "<question>"` before reading raw source.
```

### Implementers (only if respawning)
```
Common: Track main, repo root, label main; commits land on `main`; talk only to main-orchestrator.
FIRST: team-register.sh "<name>" implementer "main" "<area>" "main" "main" → then /session-start.
⭐ READ YOUR PREDECESSOR'S SESSION DOC FIRST.
⛔ COMMIT WITH `git commit -F <msg> -- <explicit paths>` (a new file needs `git add` first; the pathspec stays the filter).
⚠ A brief that contradicts the code is a FINDING, not an instruction to follow carefully. Nine overturns this round; every one was right.
⚠ Safety/rule-5 Step-9s route to the LEAD via the orchestrator.

worker    (apps/worker/)        doc 134 · #38 (establish, don't assume) · 9.37(b) · 9.38 · §DEC-CANDGATE leg 3
desktop   (apps/desktop/)       doc 135 · 9.5's audit-link consumer (after contract+worker legs) · the 9.25 seed-door deletion
knowledge (packages/knowledge/) doc 136 · the 13.8m meeting consumer · L106 #4 (task #13)
contract  (packages/contracts/) NO doc — held all round by lead ruling · 9.10-D leg 1 (ruling already made; see Carry-forward)
```

## How to resume

Lead runs **`/team-start main`**, reads THIS doc, **verifies the team is still alive rather than respawning**, and dispatches from Carry-forward. ⛔ **Confirm the push happened first.**
