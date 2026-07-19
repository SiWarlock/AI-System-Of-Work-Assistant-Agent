# Root-Cause Analysis — IMPLEMENTATION_PLAN.md degradation

> **Scope.** Why the task tracker grew from 1,812 → 4,283 lines (2.36×) with **zero net-prune commits ever**, and how to fix it in the workflow **scaffolding repo** so no regenerated project repeats it. Produced 2026-07-19 by the plan-doc cleanup (git archaeology over the full 156-commit doc history + the command files, four independent analyzers + synthesis).
> **Portability.** Every fix below is phrased template-relative: local generated file → "currently says" (quote) → "change to" (exact text) → the `scaffold/templates/<path>` to edit. Fixes target the **template**; the local generated copy is only cited to show the lived-in symptom. **No fix was applied in this repo's workflow files — recommendations only**; the owner applies them upstream in the scaffolding repo, then `/scaffold-upgrade`s this repo.
> **Companion state.** The one-time migration the fixes assume (compact the degraded doc to the new standard) **was completed 2026-07-19** in this repo: `IMPLEMENTATION_PLAN.md` rebuilt to the one-checkbox standard (4,283 → 2,249 lines, all states repo-verified), history archived verbatim to `docs/archive/IMPLEMENTATION_LOG.md`, and `scripts/plan-lint.sh` created (passing, exit 0). Only the template-side fixes remain.

---

## 1. Executive summary (the causal chain)

1. At `t=0` (commit `bbc53201`, 2026-06-29) the scaffolding shipped a plan template whose header **promises** "Living sections are bounded/pruned at `/orchestrate-end`," and shipped `/orchestrate-end` with **real prune rules already written** — a `~7`-item Carry-forward cap (Step 5.5) and a `~10`-round Log-roll (Step 4). The command file was **never edited again** (single commit in its whole history). So this was never a missing-rule problem for those two sections.
2. But two of the five living sections had **no drain rule at all**: **"Currently in progress"** (Step 5 only says *"update"*, never *"replace/overwrite"*, and no cap) and **materialized `/phase-exit` checklists** (parked in "Currently in progress," never relocated after CLEAR). Structural asymmetry: the sections that grew hardest were the ones with no authored drain.
3. The prune rules that *did* exist were **gated on user interaction** (Step 5.5 "Propose ONE of five outcomes to the user"; DEFER escalates) — so **autonomous rounds skipped them entirely**. Log-roll fired **0 times** (its archive file `docs/archive/TASKS-LOG.md` was never created). Carry-forward decreased only twice in 156 commits, both trivial, never near the cap.
4. Two accelerants compounded it: **dual-write** — every `◆` round narrative was written into "Currently in progress" *and* mirrored by a Log entry (an emergent seam between Step 4 and Step 5, not an instruction); and **generation residue** — each cycling orchestrator (orch2 → orch25, 16 generations) appended a self-attributed round narrative and compacted none of its predecessors'.
5. The single largest step-change (`f754a481`, 2026-07-15, +1,035/−1) bulk-inserted the Part-II roadmap (Phases 14–25) with **every metadata checkbox born `[ ]`**. Completion then migrated off the boxes into prose: Phase 14 was certified COMPLETE the same day with **0/7 task boxes ticked**, via a `[x]` phase-exit self-cert row — because the format has **no single load-bearing state line per task**.
6. Net: the caps predated the breach by the entire project lifetime; the failure is **non-execution** (Carry-forward, Log) **+ never-authored drains** (Currently-in-progress, phase-exit checklists, generation residue) **+ a format that let completion live in narrative**. `/session-end` is exonerated — it is forbidden to touch the plan; **100% of plan writes route through `/orchestrate-end` + `/phase-exit`**, so the fix surface is exactly those two command templates plus the plan template and a lint guardrail.

**Provenance note on `scripts/plan-lint.sh`:** the script exists in this repo because **the 2026-07-19 cleanup authored it** as the migration's guardrail deliverable (the RCA analyzers observed it mid-cleanup, uncommitted). It implements the *entire* target standard — `≤3` Currently-in-progress, `≤7` Carry-forward, one-checkbox `DONE/PARTIAL/OPEN/DEFERRED/OWNER-GATED` vocabulary, `**Spec:**`-anchor-or-`arch_gap`, an Owner-gates ledger, and Log-as-pointer-to-`docs/archive/IMPLEMENTATION_LOG.md` — and passes (exit 0) against the rebuilt doc. Two things remain deliberately undone here, awaiting the template fix: it is **referenced by no command** (Fix 5 wires it into `/orchestrate-end`), and it is **absent from `scaffold/templates/scripts/`** (Fix 5 templates it).

---

## 2. Degradation timeline

Line-spans are proxies for item counts (RC2/RC4 archaeology across the true 156-commit history; RTK/`--follow` truncation corrected via `git rev-list`).

| Date | Commit | Pathology onset | Writing role / command | Evidence |
|---|---|---|---|---|
| 2026-06-29 | `bbc53201` (root) | Header claim "bounded/pruned at /orchestrate-end" authored **and** caps already present (CF `~7`, Log `~10`-roll); `/orchestrate-end` frozen from here (1 commit, entire history) | template ship | orchestrate-end.md L81, L43 present at root; file never re-edited |
| 2026-06-29 | `bbc53201` | **P5** Carry-forward born **at** the `~7` cap (7 items) | /orchestrate-end Step 5.5 | grows 7→11→30→…→124 lines |
| 2026-06-30 | `4fba664c` | **P1** dual-write begins (`◆` narrative in CIP + a mirrored "Detail: Log …" pointer) | /orchestrate-end Step 4+5 seam | `◆` entries end "Detail: Log <date> round N" |
| 2026-07-01 | `f9b11240` | **P4** first materialized `/phase-exit` checklist parked in "Currently in progress"; never removed | /phase-exit Step 1 | `-S` shows 1 count-changing commit (insert), 0 removals |
| 2026-07-02 | `70c8caff` / `af2ea0fc` | CIP 10× root (93 lines); CF `~4×` over cap (30) | /orchestrate-end Step 5 | CIP span 9→93; CF 7→30 |
| 2026-07-13 | `36044125` | **P2** Log 30→255 in one jump (dual-write accretion lands unbounded — no roll ever fired) | /orchestrate-end Step 4 | `docs/archive/TASKS-LOG.md` never created |
| 2026-07-15 | `f754a481` (+1,035/−1) | **P2/P3/P6 origin** — Part-II (Phases 14–25) bulk insert; every metadata box born `[ ]`; 11 orch generations stamped at once | orchestrator `docs(plan+arch)` roadmap | biggest single add; `-S'Phase 14 — Onboarding'` |
| 2026-07-15 | `73143d1b` | **P3** Phase 14 certified COMPLETE with **0/7** task boxes ticked, via a `[x]` phase-exit self-cert row; parked header reads **BLOCKED** | /phase-exit 14 (orch23) | `git show … \| grep '^\+.*14\.[1-7]'` adds no task-box tick |
| 2026-07-17 | `06504f00` | **P5** token Step-5.5 pass (123→116 lines) while CF sat `~17×` over cap | /orchestrate-end Step 5.5 | one of only 2 CF decreases in 156 commits |
| 2026-07-19 | `adab96ef` (HEAD) | **P5** resolved items **annotated** (`✅ RESOLVED` / "safe to prune next round"), never deleted; totals CIP 278 / CF 124 / Log 561 / doc 4,263 | /orchestrate-end | annotate-in-place, 0 net-prune across 156 commits |
| 2026-07-19 | working tree | `scripts/plan-lint.sh` authored **by the cleanup** to the target standard — wiring + templating deferred to the scaffolding fix (Fix 5) | cleanup deliverable | referenced by no command yet; not in `scaffold/templates/scripts/` |

**Compaction census:** 156 plan-touching commits, +5,658/−1,395 (4.1:1 add:del). By net direction: 110 append, 46 equal-churn (checkbox rewrites), **0 net-prune**. No commit ever removed more than it added. "Currently in progress" and Log each had **0 decreases**; Carry-forward had 2 (both trivial).

---

## 3. Per-pathology root cause (6 pathologies)

### P1 — Dual-write of round narratives (into "Currently in progress" **and** the Log)
- **Mechanism.** Each seal wrote a full `◆` narrative into "Currently in progress" *and* a mirrored Log entry; the CIP copy even ends with a pointer to its Log twin ("Detail: Log 2026-07-15 round 8"). Two accreting sinks, one round, neither pruned.
- **Literal instruction.** `/orchestrate-end` **Step 4** (L41): *"Append a Log entry to `IMPLEMENTATION_PLAN.md`."* **Step 5** (L64): *"**Currently in progress** — update with the last commit hash, suite count, **next session target**, anything blocking."* Step 4's format field also carries *"Next session target"* (L54). The command **never instructs writing the narrative twice** — but the two steps overlap on "next session target"/blockers, and nothing forbids the same prose landing in both.
- **Onset evidence.** `4fba664c` (2026-06-30); recent seals (`adab96ef` +23/−2, `084e11b6` +51/−8) show near-zero deletes against both sinks.
- **Verdict — EROSION-BY-SEAM (not instructed).** Answers **Q(a): NO**, the command does not instruct a dual narrative-write. The dual-write is an emergent seam: a Log section *plus* a free-text CIP with an overlapping "next session target" field invited it. Killed by removing the Log from the plan (P2 fix) + making CIP a `≤3`-line REPLACED snapshot with no narrative.

### P2 — Append-only accretion despite the header's "bounded/pruned" claim
- **Mechanism.** Header promises all living sections are pruned; in practice 0 of 156 commits net-pruned. Split by cause:
  - **Log / Carry-forward / Decisions-tabled** — prune rules **exist** and were **ignored** (Log-roll: 0 events, archive file never created; CF: 2 token dips).
  - **Currently-in-progress / materialized phase-exit checklists** — **no prune rule was ever authored** (erosion-by-omission). These grew hardest (CIP 9→278, ~31×).
- **Literal instruction.** Header claim (local L5 / template L14): *"Living sections are bounded/pruned at `/orchestrate-end`."* Backed for 3 of 5 sections (Step 4 Log-roll L43; Step 5 Decisions-relocate L60; Step 5.5 CF cap L81) — **unbacked** for CIP (Step 5 L64 "update" only) and phase-exit checklists (no rule).
- **Onset evidence.** Caps present at root `bbc53201`; command never edited; breaches accrue 2026-06-30→2026-07-19; big Log jump `36044125` (2026-07-13).
- **Verdict — SPLIT: instructed-but-never-executed (Log/CF/Decisions) + never-authored-drain (CIP/checklists).** The header over-promises. Killed by removing the Log from the plan, adding a REPLACE rule + `≤3` cap for CIP, and enforcing all caps mechanically via `plan-lint.sh` at `/orchestrate-end`.

### P3 — Part-II checkbox-state divergence (boxes born `[ ]`, completion in narrative)
- **Mechanism.** Part-II (Phases 14–25) entered in one commit with every per-bullet metadata box `[ ]` (Part-I used `[x]`). Completion then migrated to `◆` DONE-notes + a `[x]` phase-exit self-cert row asserting "All 14.X task checkboxes ticked" — while the literal 14.1–14.7 boxes stayed `[ ]`. **No commit in history ever ticks a 14.x task metadata box.** Adjacent inversions confirm structure-vs-prose drift: `18.31–18.34` shipped code but their `### 18.x` headings live only in an uncommitted working-tree append (headings trail work, promoted late-batch at each round-seal); `18.25` is real committed work that **never** got a `### 18.25` heading (sequence skips 18.24→18.26 by design).
- **Literal instruction.** `/orchestrate-end` **Step 3** ticks *task* boxes but permits multiple `- [ ]` metadata bullets per task with **no single canonical state line** (L39: *"The `- [ ]` field lines under a task are never individually checked"*). Phase completion is gated on a `/phase-exit` CLEAR row — which a self-cert `[x]` satisfied without the task boxes.
- **Onset evidence.** `f754a481` (2026-07-15, boxes born unticked); `73143d1b` (same day, Phase 14 COMPLETE at 0/7).
- **Verdict — FORMAT-ENABLED EROSION.** Not a violated instruction — the multi-checkbox-per-task format has no load-bearing state line, so completion could legitimately live in prose. Killed by the hybrid **one-checkbox-per-task State line** (`- [x] DONE · hash · date`) that `plan-lint.sh` enforces as the first content line, with headings forbidden to carry state tokens.

### P4 — Materialized `/phase-exit` checklists parked in "Currently in progress" forever
- **Mechanism.** Ten fully-materialized checklists (phase-exit 4/5/6/7/Worker-wiring/8/10/14/18/18-crossing) sit in "Currently in progress"; each `-S` probe shows exactly one count-changing commit (the insert), **zero removals**. Completed gates (mostly CLEAR, one BLOCKED) permanently inflate the "in progress" section — its single biggest contributor.
- **Literal instruction.** `/phase-exit` **Step 1** (L25): *"Materialize the checklist for `$ARGUMENTS` **under the phase**…"* — so parking them in CIP already **contradicts** the placement. **Step 4** CLEAR (L56): *"The phase may be ticked complete at the next `/orchestrate-end`"* — ticks the phase box, **never touches the checklist**. No command anywhere prunes/relocates a materialized checklist after CLEAR.
- **Onset evidence.** `f9b11240` (2026-07-01, first parked checklist).
- **Verdict — EROSION-BY-OMISSION (+ placement drift).** Answers **Q(d):** placement should be under-the-phase, not CIP; nothing relocates post-CLEAR. Killed by moving full checklists to the archive and leaving a one-line **`Gate:`** pointer in the phase.

### P5 — Carry-forward unbounded (53 items vs `~7` cap); resolved items annotated not deleted
- **Mechanism.** Grew 7→124 lines (`~53` items, `~7×` over cap); resolved items are annotated in place (`[Note-projection … ✅ RESOLVED 18.29] … safe to prune next round`) — the "next round" prune never runs (0 net-prune). The clearest case of an explicit force-resolving instruction disregarded.
- **Literal instruction.** `/orchestrate-end` **Step 5.5** mandates a 5-outcome walk, outcome **(a) DELETE** (L74): *"Remove the bullet; cite where it was completed"*; **hard cap** (L81): *"keep Carry-forward under ~7 items… force-resolve those"*; Forbidden (L160): *"Skipping Step 5.5 triage."* Both the cap and Remove-don't-annotate are explicit and were **ignored**.
- **Weakness that let it slip.** Step 5.5 is **user-gated** (L69: *"Propose ONE of five outcomes to the user"*; DEFER escalates), so autonomous rounds skipped it wholesale.
- **Onset evidence.** Born at cap `bbc53201`; `~4×` over by 2026-07-02; token dip `06504f00` (2026-07-17); annotate-in-place at HEAD `adab96ef`.
- **Verdict — EROSION-AGAINST-COMMAND (confirmed).** Answers **Q(c):** the cap + Remove-not-annotate are both mandated and both ignored; the escape hatch is the user-gating. Killed by de-gating: DELETE-completed / INLINE-stale run **mechanically** each round (reserve user prompts for DEFER), a per-phase `#### Residuals` overflow home, and a `plan-lint.sh` cap + no-annotate check.

### P6 — Successive orchestrator generations append their own state, compact none
- **Mechanism.** HEAD carries residue from 16 orchestrator generations (orch2–25) across two cycling lineages; distinct `orch` tokens rose monotonically 0→11→14→16 with **zero decrements on cycle**. Each cycling orchestrator wrote a fresh self-attributed `◆` narrative and left every prior one in place (orch16+orch17 alone still contribute 61 mentions after draining 2026-07-14).
- **Literal instruction.** **None.** No command tells a cycling orchestrator to compact its predecessor's round narrative. `/orchestrate-start` reads the reconciled tracker; `/orchestrate-end` Step 5 only "updates" CIP. Generation residue has no drain.
- **Onset evidence.** `f754a481` (2026-07-15) — `orch` stamping entered in bulk (0→11); pre-07-15 orchestrators did not stamp generations.
- **Verdict — EROSION-BY-OMISSION.** Same root as P2/P4 (no authored drain for a growing region). Killed by the REPLACE-not-append CIP rule (P1/P2 fix): a `≤3`-line snapshot of NOW cannot carry N generations of narrative, and round history goes to the archive log where accretion is intended.

**Write-source scoping (Q(e)): `/session-end` is exonerated.** It is *forbidden* to touch the plan (session-end.md L11: *"Do NOT touch `IMPLEMENTATION_PLAN.md`"*). All plan writes route through `/orchestrate-end` (+ `/phase-exit` materialize/tick). The entire fix surface is those two command templates + the plan template + the lint guardrail.

---

## 4. Concrete workflow fixes

> **Template-divergence note (applies to all command fixes).** `scaffold/templates/.claude/commands/orchestrate-end.md` and `session-end.md` differ from the local generated copies **only by placeholder substitution** (`{{TASK_TRACKER}}`, `{{CODE_AREA}}`, `{{ARCH_DOC}}`, `{{AI_TRAILER}}`, `{{GIT_REMOTE}}`, `{{AUDIT_CMD}}`). `phase-exit.md` is **byte-identical** (fully portable, no placeholders). So every quote below matches the template once you re-insert placeholders; edit the template, and the generator re-emits the local copy. Quotes use the template token (e.g. `{{TASK_TRACKER}}`) where one exists.

### Fix 1 — Remove the Log section from the plan entirely (history → archive only) — kills P1, P2, P6
- **File · step:** `IMPLEMENTATION_PLAN.md` header + `## Log` section.
- **Currently says (template `scaffold/templates/IMPLEMENTATION_PLAN.md` L14 + L217–221):**
  > "The living sections below (Currently-in-progress, Carry-forward, **Log**, Trims, Decisions) are **bounded** — pruned/archived at `/orchestrate-end`, never left to grow…"
  >
  > "`## Log` — The orchestrator's framing of each round… keep the most recent ~10 rounds inline; roll older entries into `docs/sessions/`… or `docs/archive/TASKS-LOG.md`…"
- **Change to:** **Delete the entire `## Log` section** and drop "Log" from the living-sections list in the header. Replace the Log section with a one-line pointer stub the lint recognizes:
  > `## Log`
  >
  > `Round history is **not** kept in this file. See docs/archive/IMPLEMENTATION_LOG.md (append-only, orchestrator-written at every /orchestrate-end).`
- **Template path:** `scaffold/templates/IMPLEMENTATION_PLAN.md` (L14 living-sections list; replace L217–221).
- **Kills:** P1 (removes the second dual-write sink), P2 (the 561-line Log was the single largest accreting region), P6 (generation narratives now land in an append-only archive, not the plan).

### Fix 2 — `/orchestrate-end` Step 4: append the Log entry to the archive, never inline — kills P1, P2
- **File · step:** `orchestrate-end.md` Step 4.
- **Currently says (L41, L43):**
  > "## Step 4 — Append a Log entry to `{{TASK_TRACKER}}`"
  > "**Keep the Log bounded** … once more than ~10 rounds have accumulated inline, roll the oldest into `docs/archive/TASKS-LOG.md` with a one-line pointer."
- **Change to:**
  > "## Step 4 — Append a Log entry to `docs/archive/IMPLEMENTATION_LOG.md`"
  > "The plan file carries **no** inline Log. Append the round's framing (same format below) to `docs/archive/IMPLEMENTATION_LOG.md` — an append-only audit trail read on demand, never loaded whole. Do **not** write round narratives into `{{TASK_TRACKER}}`; the plan holds only NOW (Currently-in-progress) + the forward working set (Carry-forward)."
- **Template path:** `scaffold/templates/.claude/commands/orchestrate-end.md` Step 4 (with `{{TASK_TRACKER}}` token).
- **Kills:** P1 (the mirrored Log entry now lives outside the plan), P2 (removes the unbounded inline Log and its dead `TASKS-LOG.md` roll that never fired).

### Fix 3 — `/orchestrate-end` Step 5: REPLACE "Currently in progress," never append; `≤3` items — kills P1, P2, P4, P6
- **File · step:** `orchestrate-end.md` Step 5, bullet 4.
- **Currently says (L64):**
  > "- **\"Currently in progress\"** — update with the last commit hash, suite count, next session target, anything blocking."
- **Change to:**
  > "- **\"Currently in progress\"** — **REPLACE the whole section (do NOT append).** It is a snapshot of NOW: `≤3` items / `≤15` lines — last commit hash, suite count, next session target, active blockers. **Delete** the prior snapshot's lines; never stack rounds. **No round narratives** (those go to `docs/archive/IMPLEMENTATION_LOG.md`) and **no materialized `/phase-exit` checklists** (those live in the archive with a `Gate:` pointer — Step for phase-exit)."
- **Template path:** `scaffold/templates/.claude/commands/orchestrate-end.md` Step 5.
- **Divergence to reconcile:** the **template plan already carries** the REPLACE intent in its CIP comment (`scaffold/templates/IMPLEMENTATION_PLAN.md` L32: *"REPLACE this section at every /orchestrate-end — do NOT append… (≤ ~8 lines)…"*) — but `/orchestrate-end` was never updated to match, and the cap there is `~8` lines, not `≤3` items. Tighten that comment to `≤3 items / ≤15 lines` so plan + command + lint agree.
- **Kills:** P1/P6 (a replaced `≤3`-item snapshot cannot hold narratives or generation residue), P2 (CIP was the never-drained `~31×` region), P4 (explicitly bars parked checklists).

### Fix 4 — `/orchestrate-end` Step 5.5: de-gate the cap; DELETE resolved mechanically, never annotate — kills P5
- **File · step:** `orchestrate-end.md` Step 5.5 (outcome (a) L74; cap L81; gating L69).
- **Currently says (L69, L74, L81):**
  > "Propose ONE of five outcomes **to the user**, with a one-line rationale:"
  > "**(a) DELETE** | Item was completed since it landed in Carry-forward | Remove the bullet; cite where it was completed"
  > "**Hard cap: keep Carry-forward under ~7 items.**… force-resolve those…"
- **Change to (L69):**
  > "Walk every bullet. **Apply DELETE and INLINE-TARGET mechanically — no user prompt** (a completed or phase-owned item is a bookkeeping fact, not a scope decision). **Only DEFER (a scope cut) escalates to the user.** For each item pick one of five outcomes:"
- **Add after the outcome table:**
  > "**Resolved items are DELETED, never annotated.** An item completed since it landed is removed with a one-line archive/commit pointer — do **not** leave a `✅ RESOLVED` / \"safe to prune next round\" marker in place. A resolved annotation is a lint failure. Overflow past the `~7` cap that is still live moves to that item's phase as a `#### Residuals` bullet, not kept in Carry-forward."
- **Template path:** `scaffold/templates/.claude/commands/orchestrate-end.md` Step 5.5.
- **Also update the plan template's Carry-forward guidance** (`scaffold/templates/IMPLEMENTATION_PLAN.md` L42) to add: *"Resolved items are DELETED with an archive pointer (never annotated in place); overflow past ~7 goes to the owning phase's `#### Residuals`, not here."*
- **Kills:** P5 (removes the user-gate that autonomous rounds skipped; forbids the annotate-in-place that grew CF to 124 lines).

### Fix 5 — `/orchestrate-end` new Step 6.5: wire `scripts/plan-lint.sh` as a blocking gate — kills P2, P3, P5 (enforcement backstop for all)
- **File · step:** `orchestrate-end.md` — insert a new step between Step 6 (session doc) and Step 7 (commit).
- **Currently says:** *(nothing — no lint step exists; `plan-lint.sh` is referenced by no command.)*
- **Change to (new step):**
  > "## Step 6.5 — Run the plan-format lint (blocking)
  >
  > Before staging, run the structural lint on the reconciled tracker:
  > ```bash
  > scripts/plan-lint.sh {{TASK_TRACKER}}
  > ```
  > It enforces the format contract mechanically: `≤3` Currently-in-progress items, `≤7` Carry-forward with no resolved-in-place annotations, exactly one state-checkbox line per `### N.M` task (vocabulary `DONE/PARTIAL/OPEN/DEFERRED/OWNER-GATED`; `DONE` needs `\`hash\`` + ISO date), no state tokens on headings, a `**Spec:**` anchor or `arch_gap` per task, `OWNER-GATED` tasks pointing at a defined `§ARM-*/§DEC-*` ledger, and a Log section that is only a pointer. **Exit non-zero blocks the close-out** — fix the violations, do not commit around them. This is the mechanical backstop for the caps that were promised but never enforced."
- **Template paths (two edits):**
  1. `scaffold/templates/.claude/commands/orchestrate-end.md` — add Step 6.5 (with `{{TASK_TRACKER}}` token) + list it under "Forbidden": *"Committing a round whose `plan-lint.sh` exits non-zero."*
  2. **Add the script to the template:** copy `scripts/plan-lint.sh` → **`scaffold/templates/scripts/plan-lint.sh`** (it is currently only in the generated repo, absent from the template — see §1 surprising finding). It already reads a `[plan-file]` arg and defaults to `IMPLEMENTATION_PLAN.md`, so it is portable as-is; the generator should template no tokens inside it.
- **Kills:** converts every "instruction that eroded because it was never enforced" (P2, P5) and the format drift (P3) into a hard gate; nothing lands unless the caps hold.

### Fix 6 — `/phase-exit`: archive the full checklist, leave a one-line `Gate:` pointer in the phase — kills P4
- **File · step:** `phase-exit.md` Step 1 (materialize) + Step 4 (CLEAR verdict).
- **Currently says (Step 1 L25; Step 4 L54, L56):**
  > "Materialize the checklist for `$ARGUMENTS` **under the phase**… by copying the template's rows verbatim."
  > "Append the gate outcome to the `{{TASK_TRACKER}}` Log:"
  > "**CLEAR** — every row ticked. The phase may be ticked complete at the next `/orchestrate-end`."
- **Change to (Step 1):**
  > "Materialize the checklist for `$ARGUMENTS` in **`docs/archive/phase-exit-<phase>.md`** (not inline in the plan) by copying the template's rows verbatim. In the plan phase body, keep only a one-line **`Gate:`** pointer: `**Gate:** <PENDING|CLEAR|BLOCKED> — see docs/archive/phase-exit-<phase>.md`."
- **Change to (Step 4):**
  > "Append the gate outcome to **`docs/archive/IMPLEMENTATION_LOG.md`** (the plan carries no Log). On **CLEAR**, update the phase's one-line `Gate:` pointer to `**Gate:** CLEAR (evidence: <report paths>) — see docs/archive/phase-exit-<phase>.md`; the full ticked checklist stays in the archive, never in the plan. The phase may be ticked complete at the next `/orchestrate-end`."
- **Template path:** `scaffold/templates/.claude/commands/phase-exit.md` (byte-identical to local — a single edit covers both). Also point the plan template's "Phase exit checklist (template)" note (`scaffold/templates/IMPLEMENTATION_PLAN.md` L102–105) at the archive-materialization convention.
- **Kills:** P4 (the 10 parked checklists — CIP's biggest contributor — never enter the plan; a `≤3`-item CIP has no room for them, and `plan-lint.sh` fails on `materialized checklist` text inside CIP).

### Fix 7 — Doc-header convention block: state vocabulary + caps (the standard, stated once) — anchors P2, P3, P5
- **File · step:** `IMPLEMENTATION_PLAN.md` header (Reading-discipline blockquote).
- **Currently says (local L5 / template L14):**
  > "Living sections are bounded/pruned at `/orchestrate-end`." *(template L14: "…are **bounded** — pruned/archived at `/orchestrate-end`, never left to grow…")* — **false in practice** (0 net-prune in 156 commits); the claim asserted enforcement that no rule performed.
- **Change to (replace the over-promising sentence with the concrete, lint-backed contract):**
  > "**Format contract (lint-enforced by `scripts/plan-lint.sh` at every `/orchestrate-end`).**
  > • **Task state** lives on ONE checkbox line — the first content line under each `### N.M` heading: `- [x] DONE · \`hash\` · YYYY-MM-DD` / `- [~] PARTIAL · remaining: …` / `- [ ] OPEN` / `- [ ] DEFERRED · …` / `- [ ] OWNER-GATED · §ARM-… / §DEC-…`. Headings carry **no** state tokens; completion never lives in prose.
  > • **Currently in progress** — `≤3` items / `≤15` lines, **REPLACED** each round (a snapshot of NOW, not a history).
  > • **Carry-forward** — `≤7` items; resolved items **deleted** (never annotated); overflow → the owning phase's `#### Residuals`.
  > • **Round history** — only in `docs/archive/IMPLEMENTATION_LOG.md`; this file has **no** inline Log.
  > • **Owner gates & arming ledgers** — a dedicated section; every `OWNER-GATED` task references a `§ARM-*/§DEC-*` id defined there.
  > • **Every task** carries a `**Spec:**` `{{ARCH_DOC}} §` anchor or an explicit `arch_gap` flag.
  > • **Phase-exit checklists** live in `docs/archive/`; the phase body keeps a one-line `**Gate:**` pointer."
- **Template path:** `scaffold/templates/IMPLEMENTATION_PLAN.md` header (replace the L14 sentence; also add the `## Owner gates & arming ledgers` section and convert the task-entry EXAMPLE BLOCK at L143–158 from multiple `- [ ]` acceptance bullets to the one-checkbox State-line format, so the template ships the standard `plan-lint.sh` already enforces).
- **Kills:** removes the false claim (P2), states the one-checkbox rule (P3) and the caps (P2/P5) as the doc's own contract, and makes the header match what the lint checks — no drift between prose promise and enforcement.

**Fix count: 7** (Log-removal · Step-4-append-to-archive · CIP REPLACE+cap · Carry-forward de-gate/delete-not-annotate · plan-lint wiring + add-to-template · phase-exit archive-the-checklist · doc-header convention block).

---

## 5. Anti-regression guardrails (`scripts/plan-lint.sh`)

The script **already exists** and implements the checks below; the guardrail work is **wiring + templating** (Fix 5), not authoring. Checks it enforces:

| Check | Rule | Pathology backstopped |
|---|---|---|
| Currently-in-progress cap | `≤3` items, `≤15` lines | P1, P2, P6 |
| No narrative in CIP | fails on `**◆` or `### 20YY-` inside the section | P1, P6 |
| No parked checklist in CIP | fails on `materialized checklist` text inside the section | P4 |
| Carry-forward cap | `≤7` items | P5 |
| No resolved-in-place annotation | fails on `(✅\|[x]).*(RESOLVED\|resolved\|DONE)` in Carry-forward | P5 |
| One state checkbox per task | exactly one `- [x/~/ ]` line, and it is the first content line under `### N.M` | P3 |
| State vocabulary | `DONE` needs word+`` `hash` ``+ISO date; `PARTIAL` needs `remaining:`; unticked needs `OPEN/DEFERRED/OWNER-GATED` | P3 |
| No state token on headings | fails on `✅/⏳/🔶/DONE/COMPLETE` in a `### N.M` heading | P3 |
| Spec anchor present | every task carries `**Spec:**` or `arch_gap` | (arch-drift guard) |
| Owner-gates ledger integrity | `OWNER-GATED` tasks reference a defined `§ARM-*/§DEC-*`; defined ids are referenced | (gate integrity) |
| Numeric task order | headings ascend per phase; a gap needs a `(folded: …)` annotation | P3 (phantom/late headings) |
| Log is a pointer | Log section `≤6` lines and must reference `docs/archive/IMPLEMENTATION_LOG.md` | P1, P2 |

**Where it runs:** blocking, at `/orchestrate-end` **Step 6.5** (new — Fix 5), before staging/commit. Exit non-zero blocks the round close-out. Recommended second home: a `pre-commit` hook on `IMPLEMENTATION_PLAN.md` for defense-in-depth (optional; the close-out gate is the load-bearing one). Add `plan-lint` to the `/orchestrate-end` "Forbidden" list so it can't be skipped.

---

## 6. Residual risks (what lint cannot catch)

1. **Truthfulness of a `DONE` line.** Lint checks a `DONE` line *has* a hash + ISO date; it cannot verify the hash exists, is on-branch, or that the work is actually complete. A false `DONE` still passes — Step 3's "conservative tick" discipline remains human/agent-owned.
2. **Semantic staleness under the caps.** A `≤3`-item CIP and `≤7`-item Carry-forward can still hold *wrong* or outdated items; the cap bounds size, not relevance. Step 5.5 triage judgment still matters.
3. **Spec-anchor validity.** Lint confirms a `**Spec:**` token or `arch_gap` flag is *present*; it does not confirm the `§` exists in `ARCHITECTURE.md` or covers the task. `spec-lint.sh` / arch-drift-auditor at `/phase-exit` remain the coverage check.
4. **Archive-log discipline.** Nothing forces the archived `IMPLEMENTATION_LOG.md` to actually receive the round entry (`docs/archive/TASKS-LOG.md` was *never created* under the old rule — the same silent-skip is possible). Consider a lint assertion that the log file exists and grew this round, or a Step-4 write-receipt echo.
5. **`#### Residuals` becoming the new dumping ground.** Overflow routed to per-phase Residuals is un-capped by the current script; a phase could accrete a long Residuals list, re-creating P5 one level down. Consider a per-phase Residuals cap.
6. **Format migration of the existing generated plan — ✅ DONE (2026-07-19).** The one-time compaction pass (Log→archive, checklists→`Gate:` pointers, tasks→State lines, Carry-forward drained to 7) was executed by the same cleanup that produced this RCA; `plan-lint.sh` passes (exit 0) on the rebuilt 2,249-line doc. Other projects generated from the old template would still need an equivalent migration.
7. **Cross-file divergence drift.** Three files must agree on the numbers (`≤3`/`≤7`): the plan header, `/orchestrate-end`, and `plan-lint.sh`. Lint enforces its own constants; it cannot detect that the *prose* in the other two drifted from them. Keep the caps stated once (Fix 7 header block) and referenced, not re-stated.
