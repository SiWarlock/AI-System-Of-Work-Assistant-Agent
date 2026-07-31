# Team Handoff 021 — FULL TEARDOWN + SELF-CONTAINED RESUME PROMPT

**Date:** 2026-07-31 · **Track:** single-track `main` (root checkout, no worktree)
**Predecessor:** `020-2026-07-31-autonomous-run-decision-log.md` (the decision log — **read it second**)
**Status:** 🔴 **TEAM FULLY DOWN. Machine restarted. This file is the ONLY resume path.**

> ⛔ **WHY THIS FILE IS DIFFERENT FROM EVERY PRIOR HANDOFF.** The owner restarted the machine and
> **cannot paste a resume script.** They will type ONE line — *"Read docs/team-handoffs/021 and
> resume as team lead."* — and nothing else. **Everything a fresh lead needs is in this file or it
> does not exist.** Do not assume the owner remembers anything. Do not ask them to look something up.

---

# PART 1 — DO THESE FOUR THINGS, IN ORDER, BEFORE READING ANYTHING ELSE

## Step 1 — Confirm agent teams are ON (else STOP)

```bash
if [ "${CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS:-}" = "1" ]; then echo OK; else echo MISSING; fi
```

`MISSING` ⇒ **do not spawn anything.** Tell the owner it needs `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`
in `settings.json`'s `env` block, and that it takes effect only on a **fresh session**.

## Step 2 — ⛔ PRUNE THE TEAM REGISTRY *BEFORE* ANY `/context-check`

**As of the teardown the registry held 85 entries. SIX were this team; the rest were already corpses,
most from other projects.** After the restart **all 85 are dead.** Left in place they poison
`/context-check`'s aggregate, which computes over ALL rows — a **brand-new team reports `HARD-STOP`**
because a corpse sits at 81%. That happened on 2026-07-30 and nearly triggered a pointless cycle.

⭐ **THE DISCRIMINATOR DEPENDS ON WHICH SITUATION YOU ARE IN — GET THIS RIGHT, THEY ARE OPPOSITES:**
- **After a FULL TEARDOWN (this one):** every pre-existing entry is genuinely dead, so **mtime /
  keep-only-mine is CORRECT and safe.** Nothing else is running.
- **After a MID-ROUND CYCLE (not this one):** ⛔ **mtime is WRONG and would kill live sessions** —
  teammates that were never cycled still carry their ORIGINAL mtime. There, discriminate by
  **DUPLICATION** (one name with two entries ⇒ the older is superseded).

⚠ **Only prune when no other Claude session is running** (true immediately after a restart; ask the
owner if unsure — they may have started another project). This team's six dead ids:

```
20b6bc03-…  knowledge-implementer     4a18a25e-…  worker-implementer
637bb666-…  contract-implementer      a149d370-…  desktop-implementer
b70fd9bd-…  main-team-lead            d0dc9d3e-…  main-orchestrator
```

Back up, then prune everything that is not the current session:

```bash
mkdir -p ~/.claude/team-registry-backup-$(date +%Y%m%d)
cp ~/.claude/team-registry/*.json ~/.claude/team-registry-backup-$(date +%Y%m%d)/ 2>/dev/null
ls ~/.claude/team-registry/*.json | wc -l     # expect ~85
# delete all EXCEPT your own session's file, then re-verify the count
```

⛔ **THE SHELL IS zsh AND IT DOES NOT WORD-SPLIT UNQUOTED PARAMETERS.** `for id in $LIST` runs **ONCE**
with the whole string as a single filename, and a `[ -f "$f" ] && rm "$f"` chain then **silently
no-ops and reports success.** Use literal loop items or an array, and **print a per-item exit code
plus a final count** — a receipt is not a gate.

⚠ **After pruning, "stale" FLIPS MEANING.** Before: stale = corpse. After: stale = a **LIVE** teammate
whose heartbeat has not re-rendered (heartbeats ride the status-line render and lag badly while idle).
**Treat an absent percentage as NO DATA, never as low usage.** The owner reads pane percentages as the
reliable signal.

## Step 3 — Verify state BY COMMAND (never from a hash quoted in this file)

⛔ **EVERY STATE LITERAL IN THIS DOCUMENT SELF-INVALIDATES. Handoff 019's seal chain rotted in FOUR
MINUTES.** Run these; believe the output, not the prose:

```bash
git rev-parse --short HEAD origin/main
git rev-list --count origin/main..HEAD      # ~100 at teardown, unpushed BY DESIGN
git diff --stat                             # expect clean
git ls-files --others --exclude-standard    # expect empty — ⚠ RUN BOTH (contracts L117)
git log --oneline -10
```

⚠ **`git status` RETURNS THE LITERAL STRING `ok` IN THIS ENVIRONMENT — it tells you nothing.** Use
`git log` / `git diff` / `git ls-files` / `git cat-file`. This has misled multiple sessions.

⛔ **PUSH IS OWNER-RUN, AT SEALS ONLY. THE LEAD NEVER PUSHES.** ~100 unpushed commits is the designed
state, not a backlog. If `git rev-list --count` shows a large number, that is **correct**.

## Step 4 — Register yourself, then spawn (Part 2)

```bash
~/.claude/scripts/team-register.sh "main-team-lead" lead "main" "" "main"
```

---

# PART 2 — SPAWN PROMPTS (paste-ready, all six)

⚠ **MODEL — READ BEFORE SPAWNING.** `CLAUDE_CODE_SUBAGENT_MODEL` governs **ALL** teammates. **The
`Agent` spawn `model` param does NOT override it.** If a mixed-model team is wanted, the **owner sets
the orchestrator's pane to Opus manually** after spawn. Verify what actually happened:
`~/.claude/teams/session-<first8>/config.json` → the `model` field (`[1m]` = 1M context).

**Spawn with the `Agent` tool, `subagent_type: "general-purpose"`, and a `name` — the `name` is what
makes it a TEAMMATE rather than a background subagent, and only the LEAD can create teammates.**

**Spawn the orchestrator FIRST**, then implementers as their work becomes live. ⭐ **Do NOT spawn all
five implementers reflexively** — see each area's status in Part 3; two have no queued work.

### `main-orchestrator`

```
You are main-orchestrator on the System of Work Assistant agent team.
Track: main (single-track, root checkout — NO worktree). Track label: main.
Predecessor session sealed 2026-07-31 after a full teardown + machine restart.

FIRST ACTION — register for context monitoring:
  ~/.claude/scripts/team-register.sh "main-orchestrator" orchestrator "main" "" "main"

Then run /orchestrate-start. NOT /session-start.

⭐ REQUIRED READS, IN ORDER, BEFORE DISPATCHING ANYTHING:
  1. docs/team-handoffs/021-2026-07-31-full-teardown-resume-prompt.md  (this round's resume state)
  2. docs/team-handoffs/020-2026-07-31-autonomous-run-decision-log.md  (12 decisions, still binding)
  3. docs/audits/001-2026-07-31-24.6-pre-go-live-safety-assertion-audit.md
     — ⛔ 4 of 6 partitions. Its COVERAGE LEDGER is round-2 scope. F3 is an arming blocker.
  4. IMPLEMENTATION_PLAN.md "Currently in progress" + "Carry-forward"

Confirm in your first reply: (1) the start command you ran, (2) that the registry entry exists
(ls ~/.claude/team-registry/${CLAUDE_CODE_SESSION_ID}.json).
```

### Implementers — one template, substitute `<AREA>` and `<DIR>`

| `<AREA>` | `<DIR>` | Spawn now? |
|---|---|---|
| `worker` | `apps/worker/` | ⭐ **YES — head of queue** (13.8i-B, brief 241 **v2**) |
| `desktop` | `apps/desktop/` | ⭐ **YES** — 9.40 successor task + audit round-2 AC-3 surface |
| `knowledge` | `packages/knowledge/` | **YES** — owns the audit's largest unreached gap |
| `contract` | `packages/contracts/` | ⛔ **NOT YET** — deliberately unqueued (see Part 3) |
| `eval-security` | `packages/evals/` | ⛔ **NOT YET** — no session existed this round |

```
You are <AREA>-implementer on the System of Work Assistant agent team.
Track: main (single-track). Track label: main. Working directory: <DIR> (repo root checkout — NO
worktree; all commits land on `main`). Talk only to main-orchestrator.

FIRST ACTION — register for context monitoring:
  ~/.claude/scripts/team-register.sh "<AREA>-implementer" implementer "main" "<AREA>" "main" "main"

Then run /session-start. NOT /orchestrate-start.

Read root CLAUDE.md + <DIR>CLAUDE.md + <DIR>LESSONS.md. Your resume state is in
docs/team-handoffs/021-…md Part 3 — read your own area's row.

Confirm in your first reply: (1) the start command you ran, (2) that the registry entry exists.
```

---

# PART 3 — WHERE EACH AREA STOPPED AND WHAT RESUMES IT

### worker — ⭐ HEAD OF QUEUE. Nothing on disk; slice not started.

**Task #15 / `13.8i-B`** — bind `ProposeKnowledgeApprovalPort` on **BOTH** paths. **Brief `docs/briefs/241-…` v2
is committed and current** (`9d6bc19b`; dispatch `d07af81f`). ⛔ **Use v2. v1's central premise was
FALSE and worker's guard caught it at Step 1** — v1 claimed the sink already exists at boot; the sole
call site is inside `agentSynthesisFactory`, a lazy factory gated on `copilotRealModel &&
copilotAgentMode` — **Copilot's own C5.3 seam, a different feature.**

**The real shape (3 layers, v2):** a new `ProofSpineParams` field → a new **always-bound** Temporal
activity with dormancy **inside** it (mirror `createLivingVaultActivity`) → **both**
`sourceIngestionWorkflow` **and** `meetingCloseoutWorkflow` in `apps/worker/src/temporal/workflows.ts`
— a file v1 never named. ⭐ **Why always-bound: the Temporal sandbox CANNOT read boot config**, so the
delegate binds unconditionally and the arming decision lives in the activity, which yields an **empty
plan set** unless the owner-armed port was supplied.

**RULED (lead, decisions 11–12):** worker's option (a) — a **second**
`createApprovalsKnowledgeProposeSink(...)` at the real composition root — is **APPROVED**; the old
*"never a second sink"* wording forbade the wrong noun (it targets a second minting **PATH**; two
objects over identical repos with planId idempotency are **one path instantiated twice**).
**NOT an arming crossing** — binding and arming are separately observable **by construction**.
⛔ **Acceptance keeps the *"default boot mints ZERO Approval cards"* pin AND its non-vacuity control.**

### desktop — 9.40 mechanism deleted; successor task owed.

Ruled (decision 8): **delete the mechanism, keep the goal.** `UiSafeCopilotAnswer` excludes proposals
**by explicit design** (`packages/contracts/src/api/ui-safe.ts:498-500`), so populating `proposalLabel`
would contradict the answer seam. ⭐ **The decisive fact, measured:** the affordance's stated
precondition (*"Approvals lands with that page"*) **HAS landed** and it still cannot be wired, because
a bare label carries **no approval id** ⇒ *"the shape is wrong for any producer that could exist,"*
not *"the producer is late."* **Successor task must exist** naming the corrected producer shape
(turn→approval link carrying an **id**). Precedent applied: the egress-pill reconciliation in
`#### Residuals (9)` — **keep the GOAL, correct the MECHANISM.**

### knowledge — leg C landed (`b0319823`, ticked `cb7f3574`). ⛔ Owns the audit's largest gap.

`13.8g-C leg C` verified `normalizeAttendees` needed no change; correspondence pin added; contracts
**L119** banked. ⛔ **Round-2 audit priority: ALL of `packages/knowledge/src/synthesis/*` is in the
audit's UNREACHED set** — entity-resolver, planner, ingest-rewrite, link-healer, meeting-rewrite,
attendee-refs, grounded-path, match-keys. **That is the living-vault area, i.e. exactly what arming
touches.** ⚠ Prior lessons (L32/L37/L38/L60/L65) record heavy fixing of this defect class here —
⛔ **do NOT treat past fixes as present coverage.**

### contract — ⛔ DELIBERATELY UNQUEUED, not overlooked, not idle.

Leg A landed; nothing downstream is contract territory. **Its next natural work arrives when a
frozen-contract change surfaces, or with audit round-2's AC-3 partition** (contracts is in AC-3's
surface). ⭐ **This is a CLASSIFICATION, not a shrug** — recorded so a successor does not read the
empty queue as an oversight and invent work, nor cycle the area away.

### eval-security — no session this round. `../SoW-build-evalsec` is its territory; coordinate.

---

# PART 4 — ⛔ SAFETY + AUTHORIZATION STATE (read before touching any flag)

## The four hard lines are OWNER-GATED AGAIN. Assume NOTHING carried over.

On 2026-07-31 the owner authorized crossing all four hard lines — employer-work cloud egress · the
propose-bridge flip · real external write/fetch (connector arming) · real external-API spend and paid
keys, including test cloud cost. ⛔ **THAT AUTHORIZATION WAS RUN-SCOPED AND THAT RUN IS OVER.**

⭐ **`CLAUDE.md`'s Key safety rules and the Owner-gates ledgers were deliberately NEVER EDITED**, so
they re-bind automatically with no action needed. **A fresh lead MUST NOT infer standing permission
from handoff 020** — 020 says so itself, and that inference is precisely the L121 defect the same
round recorded. **If the owner wants the go-live to continue, that is a NEW decision from them.**

## ⛔ NOTHING ARMING MOVES UNTIL AUDIT 24.6 IS COMPLETE — and this now rests on EVIDENCE, not caution.

**`docs/audits/001-…` — 4 of 6 partitions. AC-3 and DOC-1 DIED on the org spend limit** (both with
zero output). ⭐ **Those two are the two that mattered most for this audit's stated purpose:**
- **DOC-1 IS constraint 3.** 24.6's own text says **a code-only audit would have CLEARED the archetype
  defect** — the chrome pill's mandate lived in a *locked screen-generation prompt* and a *normative
  governance principle*, not in code. ⇒ **without DOC-1 this IS the code-only audit 24.6 exists to prevent.**
- **AC-3 was the archetype's own surface** (the desktop renderer where that pill lived).

⭐ **ROUND-2 SCOPE IS `AC-3` + `DOC-1` ONLY — plus the coverage ledger.** ⛔ **Do NOT re-run AC-1 or
FO-1: they SUCCEEDED and produced the night's best and most severe work.** (The lead asserted
otherwise mid-round by subtracting from a stale commit message instead of reading the file; the
orchestrator caught it. The report's own status table is authoritative.)

**⭐ THE METHOD FINDING, which outranks any single defect:** *"iterations to dry" measures **SEARCH-KEY
SATURATION**, not **SURFACE COVERAGE** — and 24.6's constraint 1 asks only for the former.* AC-2 and
TEST-1 both reported **dry at ~16% of their surface**, honestly. ⛔ **Six partitions each reporting
"dry" would have read as a swept repo.** Fix the metric before round 2 or it repeats.

**The coverage ledger's unreached set** (round-2 scope): all of `packages/knowledge/src/synthesis/*` ·
most of `packages/knowledge/src/{fs-watch,gbrain/*,markdown-vault,knowledge-writer/*}` ·
`packages/providers/src/{model,broker}/*` · **almost all of `packages/integrations/src`** (every vendor
connector + write adapter — ⚠ **directly relevant to connector arming**) · `packages/policy/src/denials.ts` ·
large parts of `apps/worker/test`, all of `packages/workflows/test`, most of `packages/knowledge/test`.

## The six audit findings — F3 is the one that blocks

- ⭐ **F3 [HIGH, rules 4/5/6] — ARMING BLOCKER.** Every policy-layer denial on the interactive Copilot
  path builds an `AuditSignal` and **discards it**; `toAuditRecordInput` (the only thing that persists
  one) has **ZERO callers repo-wide**; no tRPC error middleware; no `HealthItem` for these classes.
  ⛔ **Guarantee HOLDS, DETECTION IS LOST** — do **not** compress this to "a violation goes undetected."
  **One accidental trip and a sustained probing campaign against the employer-egress veto are
  BYTE-IDENTICAL at every durable surface.** Broader than tracked `#45`. **Must be a numbered task.**
- **F4 [medium]** — `outboxHealth` has **zero callers** while the Phase-6 acceptance text asserts OBS-2
  as **delivered**. ⛔ **This audit's own mechanism, sitting in the tracker: an acceptance line claiming
  a safety signal that does not exist.**
- **F1 [re-graded by the orchestrator, by measurement]** — `retrieveLocalEmbed` has zero production
  callers, `egressGate` is test-only ⇒ **not a live breach; a live arming PRECONDITION with no
  enforcement.** The module says a remote backend *"MUST bind `egressGate`"* — ⭐ **and MUST is prose,
  not a gate.**
- **F5** meeting-path refusals dropped (tracked; live at arm-time) · **F6** a fail-safe auto-ingest
  egress constant with a named residual · **F2** the exactly-once suite's CAS double (a **GAP**, not a
  lock — TEST-1 verified the real function is independently covered before reporting).

⭐ **VERIFIED NEGATIVE worth keeping (AC-1, best-covered partition):** the strict
`requiresApproval !== false` withhold is **confirmed present on BOTH the source and meeting commit
boundaries.** A verified negative on a fail-closed predicate is load-bearing at arming time.

## Still the owner's — do not decide these

1. **The root `CLAUDE.md` standing-rule amendment** (`(a0)(ix)(1)`) — amending the owner's own rule off
   a lead's instance-ruling is **L121 performed on L121**.
2. **Is 24.6's constraint 5 the owner's?** Its header said *"FOUR BINDING CONSTRAINTS (owner-set)"* and
   listed **five**; the lead fixed the count (`932727c3`) but **did NOT ratify the fifth**. Constraint 5
   is the one putting **test assertions and fakes** in scope — it carries the headline finding and
   stands either way, but should be badged correctly.
3. **Per-workspace subscription SPLIT** — new scope, not a safety call.
4. **Phase 9's exit** — ⛔ **not clearable by any authorization**: blocked on a Drive connector that
   **does not exist**, plus the nothing-is-deferred-out-of-Phase-9 ruling.
5. **Push** — ~100 commits unpushed by design.

---

# PART 5 — OPERATIONAL TRAPS (each one cost a real session)

- **`pnpm lint` IS TYPECHECK.** All 11 packages' `lint` is literally `tsc --noEmit`; **eslint appears in
  ZERO manifests.** ⛔ **Never write "lint clean"** — write *"typecheck + tests clean; no lint coverage
  exists."* Bare `pnpm lint` also fails **intermittently** before turbo starts; `npx turbo run lint`
  works. **Two runs disagreeing means FLAKY, never PASSING.**
- **`bash scripts/plan-lint.sh` BEFORE and AFTER any `IMPLEMENTATION_PLAN.md` edit.** ⛔ **Nothing
  invokes it automatically** — a gate nothing invokes is read as a gate that passed. Baseline at
  teardown: **0 violations, 4 warnings.**
- **`spec-lint` cannot lint a bare-`#N` task id**, and a foreign doc-numbering token in a brief trips it
  — escape with `spec-lint:mention`.
- **Commit with `git commit -F <msgfile> -- <paths>`.** A heredoc commit message can be **blocked by the
  auto-mode classifier**; write the message with the Write tool to the scratchpad instead. ⚠ **The
  pathspec filters by FILE, not by HUNK** — for shared docs (`IMPLEMENTATION_PLAN.md`), `git diff <path>`
  first as its own step and commit promptly.
- **Cross-area lesson citations are `contracts LNN`, never bare `LNN`.** ⭐ **Five ledgers all start at
  §1 — bare `L39` names TWO lessons and `L3` names FOUR.** ⚠ ~10 existing bare citations remain
  unadjudicated (`(a0)(x)`); that number is an **upper bound on the AMBIGUOUS set, not a defect count.**
- **`scaffold/` is a SEPARATE gitignored checkout** with its own remote (the owner's account,
  confirmed). Its edits are **invisible** to this repo's git and need their own commit there. **2
  commits unpushed.** ⛔ Owner closed it to writes; the `Opus 5` vs `4.8` trailer divergence is a
  **known, accepted** debt owed the moment writes reopen.
- **`graphify update .` after code changes** — it went a full round stale while every tool call
  instructed its use.
- **The harness task list VANISHED TWICE in one night.** ⭐ Cost nothing **only because** every ruling
  was already in the tracker (contracts **L51**). **Never let a decision live only in the task list or
  in a message.**
- **Empty `providerMatrix` is CORRECT.** Phase 9 is un-exitable; **9.21 CLOSED**.

---

# PART 6 — HOW THIS TEAM WORKS BEST (earned the hard way, 2026-07-30/31)

⭐ **The single most valuable pattern of the round: PRE-RULE THE PRINCIPLE, NOT THE INSTANCE.** A
pre-ruling that `propertyNames` guards were not tradeable ended up protecting **three** distinct
hazards written for one. A guard written as *"binding and arming must remain separately observable"*
survives the permission that made it look unnecessary; the same guard written as *"authorized only
because…"* would have expired with it.

- ⛔ **A doubt filed as a question does not weaken the assertion it doubts.** A brief that asserts X in
  its premises and asks *"is X true?"* in its review section **ships X** — the implementer builds from
  the premises and reads the questions as scaffolding. **An unresolved premise is not written as a
  premise.** (Cost: brief 241 v1, caught only by worker's Step-1 guard.)
- ⛔ **Authority attaches to the SPEAKER, not the claim (L116).** When the lead restates an
  unverified peer claim, it acquires the lead's authority and stops being challengeable. **A false
  doubt sent DOWN meets someone with a reason not to push back.** ⇒ *when I restate something, treat it
  with the confidence its ORIGINAL source had.*
- ⛔ **Name the property you actually MEASURED, then ask whether it is the one you care about (L118).**
  Instances tonight: presence reported as safety · a `9275` citation count that matched line refs ·
  *"iterations to dry"* as a coverage proxy · the lead's own partition count derived by subtraction
  from a stale commit message.
- ⛔ **A correction applied to the channel that STATES a claim, and not to the channel that REPEATS
  it, leaves the repeating channel authoritative (L94).** Happened twice tonight in one file.
- ⛔ **Run BOTH `git diff --stat` AND `git ls-files --others` after any session death (L117).** An
  untracked file is invisible to the first and one `git clean` from gone. **Twice tonight.**
- ⛔ **"Not in my area" generalises to "does not exist" (L93).** A grep scoped to `apps/worker` +
  `packages` missed a real production caller in `apps/desktop`.
- ⭐ **A prohibition written against the wrong NOUN forbids the correct fix.** *"Never a second sink"*
  targeted objects when it meant minting **paths**.
- ⭐ **Escalate the question you cannot answer in-scope rather than dropping it.** One audit partition
  did this unprompted and it produced **F1**. Every round-2 prompt must require **out-of-scope-observed**
  reporting — **six partitions means six chances for a defect to sit BETWEEN them.**
- ⭐ **Pre-commit re-run triggers BEFORE results arrive.** Judging *"was that deep enough?"* against
  findings you have already read is how a thin pass gets rationalised as a clean surface.
- **A structured `shutdown_approved` proves termination; its ABSENCE proves nothing.** Probe by sending
  — *"no agent reachable"* is the answer. **Gate shutdowns on the INDEX (`git ls-files`), never on a
  message.**
- **Messages CROSS constantly** (four times tonight). ⛔ **Before reporting something outstanding, check
  your inbox; before re-ruling, check whether you already ruled.** An idle teammate blocked on an
  already-made decision is **indistinguishable** from one blocked on a pending decision.
- **Close-out order, strict:** all implementers `/session-end` → **then** orchestrator
  `/orchestrate-end` → then `/team-end`. ⛔ **Never seal over a live session.**
- **Slice atomicity:** a current slice ALWAYS finishes. ⭐ **But a slice not yet STARTED is not
  in-flight** — worker was stopped at Step 1 with nothing on disk, at zero cost.

---

# PART 7 — THE ROUND IN ONE PARAGRAPH

15+ slices landed across contract, worker, knowledge and desktop. The 9.41 audit-drill arc completed
all three legs. The living-vault keystone advanced through 13.8f-C/D and 13.8g-C. The owner authorized
crossing all four go-live hard lines; the lead sequenced the pre-go-live safety audit (24.6) ahead of
any arming slice, and **that audit then died at 4 of 6 partitions on an org spend limit — with its own
coverage ledger showing it had not yet looked at the living-vault and connector surfaces the arming
work touches.** ⭐ **So the arming block that began as the lead's caution now stands on the audit's own
evidence.** The round's best work was adversarial: worker's guard caught a false brief premise before
Step 1, the orchestrator caught the lead's stale partition count and a self-inflicted wrong measurement
by three orders of magnitude, and an audit partition escalated a question it could not answer instead
of dropping it. ⛔ **The round produced roughly thirty over-claim corrections and very few false
doubts — a reader who takes only the over-claim lessons will build the inverse defect.**
