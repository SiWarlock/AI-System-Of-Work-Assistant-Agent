---
description: Orchestrator-only — execute the phase-exit checklist for a phase, row by row, ticking each as it passes. Usage: /phase-exit <phase-id>
allowed-tools: Read, Grep, Bash, Agent, Edit
argument-hint: "<phase-id>"
---

<!--
  TEMPLATE NOTE (delete when generating):
  Highly portable — fill placeholders; keep the mapper discipline VERBATIM. This command
  deliberately hardcodes NO checklist rows: it executes whatever rows the generated
  IMPLEMENTATION_PLAN.md checklist carries, so posture-gated rows (audit/security/perf) added or
  removed later are picked up without editing this file.
-->

> **Role guard — ORCHESTRATOR only.** `/phase-exit` is the orchestrator's gate executor. Implementers finish slices; the orchestrator closes phases.

Argument: `$ARGUMENTS` — the phase ID to gate (e.g. `P3`).

**What this command is:** a **row → executor mapper** over the phase-exit checklist **as written in `IMPLEMENTATION_PLAN.md`** ("Phase exit checklist (template)" applied to the phase). It never invents, reorders, or skips rows; it never hardcodes its own list. A row this file doesn't know how to execute is run as a judgment check (read + verify + record evidence).

**When to run:** at the **START** of a round, not appended to the end of one — gate findings become that round's work instead of stalling a close-out.

## Step 1 — Read the rows

Read the phase's section + the checklist template in `IMPLEMENTATION_PLAN.md`. Materialize the checklist for `$ARGUMENTS` under the phase (if this phase doesn't already carry one) by copying the template's rows verbatim. Identify which rows are already ticked from a prior partial run — **resume from the first unticked row** (mid-gate auto-cycle re-entry is expected).

## Step 2 — Execute each row, in order

Map each row to its executor. The canonical mappings:

| Row (as written in the tracker) | Executor |
|---|---|
| All phase task checkboxes ticked | Read the phase section; verify every `- [ ]` under its tasks is `[x]` (or carries a partial-note + Log entry) |
| Acceptance criterion met | Judgment check against the phase's `Acceptance criteria` block; run the named smoke if one exists |
| `/preflight` clean | Run `/preflight` **per touched code area** |
| Cross-doc invariants verified | Diff Appendix A + area `CLAUDE.md` table vs the phase's model changes |
| Reachability audit clean per touched area | Dispatch `reachability-auditor` (one per touched area) |
| Arch-drift audit clean over the phase's Spec anchors | Dispatch `arch-drift-auditor` with the phase's `Spec anchors:` list |
| Spec coverage (tagged test or waiver per anchor) | `scripts/spec-lint.sh tests $ARGUMENTS` via Bash |
| Dependency audit row (posture-gated, when present) | Run `pnpm audit --prod` once; new-vs-baseline summary (full output → `docs/audits/`) |
| Security review row (posture-gated, when present) | Resolve from `invariant` — see the row's own text |
| Perf budgets row (posture-gated, when present) | Run the phase's benchmark task(s); compare to budgets |
| Session doc(s) exist | `ls docs/sessions/` + verify coverage of the phase's slices |
| Commits pushed | **VERIFY-only** (`git status -sb` not-ahead) — the push itself stays at `/orchestrate-end` |

**Subagent dispatch discipline:** launch the auditor fan-outs (+ `security-reviewer` when the policy is `phase-boundary`) in **ONE message, in parallel**. Every fan-out subagent writes its full report to **`docs/audits/<phase>-<agent>.md`** and returns a **≤10-line summary + CLEAR/BLOCKED verdict** — full reports live in files, not in your context (state lives in files).

## Step 3 — Tick as you go

Record each row's tick in `IMPLEMENTATION_PLAN.md` **as it passes** (with a one-line evidence note where useful — e.g. the spec-lint PASS line, the audit report path). A mid-gate interruption (auto-cycle) resumes from the last ticked row — never re-runs passed rows.

## Step 4 — Verdict

Append the gate outcome to the `IMPLEMENTATION_PLAN.md` Log:

- **CLEAR** — every row ticked. The phase may be ticked complete at the next `/orchestrate-end`.
- **BLOCKED** — name the failing row(s) + the report path(s). Findings raised here escalate as **Findings (category 2)** via orchestrator → lead → human; the fixes become the round's work. A row may be **explicitly waived only by the human** (record `waived: <who/why>` on the row).

## Forbidden in this command

- **Hardcoding or reordering rows.** The generated tracker's checklist is the single source; this file only maps rows to executors.
- **Ticking a row without executing it** (or without recorded human waiver).
- **Pushing.** The Commits-pushed row is verify-only; pushes happen at `/orchestrate-end`.
- **Dumping full audit reports into context.** Reports go to `docs/audits/`; summaries come back.
- **Labeling gate findings "Step-9 …".** Step 9 is the implementer's mid-slice checkpoint; gate findings are **Findings (category 2)** on the escalation taxonomy.
