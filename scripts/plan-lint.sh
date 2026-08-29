#!/usr/bin/env bash
# plan-lint.sh — structural lint for IMPLEMENTATION_PLAN.md (post-2026-07-19 standard).
#
# Enforces the plan-doc format contract so the living sections cannot silently
# regress into narrative accretion again:
#   1. "Currently in progress"  : <=3 items, <=15 lines, no round narratives,
#      no materialized /phase-exit checklists.
#   2. "Carry-forward"          : <=7 items, no "resolved-in-place" annotations
#      (resolved items are DELETED with an archive pointer, never kept).
#   3. Task blocks (### N.M)    : exactly ONE checkbox line, first content line
#      under the heading; state vocabulary DONE/PARTIAL/OPEN/DEFERRED/OWNER-GATED;
#      DONE requires `hash` + ISO date; PARTIAL requires "remaining:".
#   4. Headings carry no state tokens (no "DONE"/checkmark suffixes).
#   5. Every task block carries a **Spec:** anchor or an explicit arch_gap flag.
#   6. OWNER-GATED tasks point at a ledger id (§ARM-*/§DEC-*) defined in the
#      "Owner gates & arming ledgers" section; defined ledger ids must be referenced.
#   7. Task headings appear in numeric order inside each phase; numbering gaps
#      need a "(folded:" annotation in the phase body.
#   8. The Log section is a pointer (<=6 lines, must reference
#      docs/archive/IMPLEMENTATION_LOG.md) — never inline history.
#
# Usage: scripts/plan-lint.sh [plan-file]   (default: IMPLEMENTATION_PLAN.md)
# Exit:  0 clean · 1 violations found · 2 usage/parse error
set -euo pipefail

PLAN="${1:-IMPLEMENTATION_PLAN.md}"
awk_rc=0
dup_rc=0
[[ -f "$PLAN" ]] || { echo "plan-lint: file not found: $PLAN" >&2; exit 2; }

awk '
function fail(line, msg) { violations++; printf "FAIL L%d: %s\n", line, msg }
function warn(line, msg) { warnings++;  printf "warn L%d: %s\n", line, msg }

function flush_task() {
  if (task_id == "") return
  if (task_boxes == 0) fail(task_line, "task " task_id ": no state checkbox line")
  if (task_boxes > 1)  fail(task_line, "task " task_id ": " task_boxes " checkbox lines (exactly 1 allowed)")
  if (task_first_content != "" && task_first_content !~ /^- \[[ x~]\]/)
    fail(task_line, "task " task_id ": first content line is not the state checkbox")
  if (!task_has_anchor) fail(task_line, "task " task_id ": missing **Spec:** anchor (or arch_gap flag)")
  task_id = ""
}

BEGIN { section = ""; violations = 0; warnings = 0 }

# ---------- section tracking ----------
/^## / {
  flush_task()
  in_phase = 0; phase_prefix = ""; last_task_num = -1
  if      ($0 ~ /^## Currently in progress/)            { section = "cip";  cip_start = NR; cip_items = 0; cip_lines = 0 }
  else if ($0 ~ /^## Carry-forward/)                    { section = "cf";   cf_items = 0 }
  else if ($0 ~ /^## Owner gates/)                      { section = "gates" }
  else if ($0 ~ /^## Log/)                              { section = "log";  log_start = NR; log_lines = 0; log_has_ptr = 0 }
  else if ($0 ~ /^## Phase ([0-9]+)/)                   { section = "phase"; in_phase = 1
                                                          match($0, /^## Phase [0-9]+/)
                                                          phase_prefix = substr($0, 10, RLENGTH - 9) + 0
                                                          phase_has_folded = 0; phase_head_line = NR }
  else                                                   { section = "other" }
  next_section_guard = 1
}

# ---------- Currently in progress ----------
section == "cip" && NR > cip_start {
  cip_lines++
  if ($0 ~ /^- /) cip_items++
  if ($0 ~ /^\*\*◆/ || $0 ~ /^### 20[0-9][0-9]-/)  fail(NR, "round narrative inside Currently-in-progress")
  if ($0 ~ /materialized checklist/)                 fail(NR, "materialized /phase-exit checklist inside Currently-in-progress")
  if (cip_items > 3)  { fail(NR, "Currently-in-progress exceeds 3 items"); cip_items = -999 }
  if (cip_lines == 16) fail(NR, "Currently-in-progress exceeds 15 lines")
}

# ---------- Carry-forward ----------
section == "cf" {
  if ($0 ~ /^- /) cf_items++
  if (cf_items == 8) { fail(NR, "Carry-forward exceeds 7 items"); cf_items = -999 }
  if ($0 ~ /(✅|\[x\]).*(RESOLVED|resolved|DONE)/) fail(NR, "resolved item annotated in place in Carry-forward (must be deleted with archive pointer)")
}

# ---------- Owner gates: collect defined ledger ids ----------
section == "gates" && /^### / {
  if (match($0, /§(ARM|DEC)-[A-Za-z0-9-]+/)) gate_def[substr($0, RSTART, RLENGTH)] = NR
}

# ---------- Log pointer ----------
section == "log" && NR > log_start {
  log_lines++
  if ($0 ~ /docs\/archive\/IMPLEMENTATION_LOG\.md/) log_has_ptr = 1
  if (log_lines == 7) fail(NR, "Log section exceeds 6 lines (must be a pointer, not inline history)")
  if ($0 ~ /^### 20[0-9][0-9]-/ || $0 ~ /^- \*\*20[0-9][0-9]-/ || $0 ~ /^- 20[0-9][0-9]-/) fail(NR, "inline history entry in the Log section")
}

# ---------- phase task blocks ----------
in_phase && /^### / {
  flush_task()
  if (match($0, /^### ([0-9]+)\.([0-9]+)/)) {
    split(substr($0, 5), parts, /[.— ]/)
    tp = parts[1] + 0
    tn = substr($0, index($0, ".") + 1) + 0
    task_id = tp "." tn; task_line = NR; task_boxes = 0; task_first_content = ""; task_has_anchor = 0
    if (tp != phase_prefix) fail(NR, "task " task_id " under Phase " phase_prefix " heading")
    if (last_task_num >= 0 && tn <= last_task_num)   fail(NR, "task " task_id " out of numeric order (prev " phase_prefix "." last_task_num ")")
    if (last_task_num >= 0 && tn > last_task_num + 1 && !phase_has_folded) gap_pending[NR] = phase_prefix "." (last_task_num + 1)
    last_task_num = tn
    if ($0 ~ /(✅|⏳|🔶|DONE|COMPLETE)/) fail(NR, "task heading " task_id " carries a state token (state lives only on the checkbox line)")
  } else if ($0 !~ /^### (Acceptance|$)/ && $0 !~ /^#### /) {
    if ($0 !~ /^### Acceptance criteria/) warn(NR, "non-task ### heading inside a phase: " substr($0, 1, 60))
  }
}

in_phase && task_id != "" && NR > task_line {
  if ($0 ~ /^- \[[ x~]\]/) {
    task_boxes++
    if (task_first_content == "") task_first_content = $0
    if ($0 ~ /^- \[x\]/ && ($0 !~ /DONE/ || $0 !~ /`[0-9a-f]{7,40}`/ || $0 !~ /20[0-9][0-9]-[0-9][0-9]-[0-9][0-9]/))
      fail(NR, "task " task_id ": DONE line missing word/`hash`/ISO-date")
    if ($0 ~ /^- \[~\]/ && ($0 !~ /PARTIAL/ || $0 !~ /remaining:/))
      fail(NR, "task " task_id ": PARTIAL line missing remaining: clause")
    if ($0 ~ /^- \[ \]/ && $0 !~ /(OPEN|DEFERRED|OWNER-GATED)/)
      fail(NR, "task " task_id ": unticked state line missing OPEN/DEFERRED/OWNER-GATED word")
    if ($0 ~ /OWNER-GATED/) {
      if (match($0, /§(ARM|DEC)-[A-Za-z0-9-]+/)) gate_ref[substr($0, RSTART, RLENGTH)] = NR
      else fail(NR, "task " task_id ": OWNER-GATED without a §ARM-*/§DEC-* ledger pointer")
    }
  } else if ($0 !~ /^\s*$/ && task_first_content == "") {
    task_first_content = $0
  }
  if ($0 ~ /^\*\*[A-Za-z-]+:\*\*/ && $0 ~ /\[[x~ ]\]/) fail(NR, "task " task_id ": metadata line contains a checkbox")
  if ($0 ~ /\*\*Spec:\*\*/ || $0 ~ /arch_gap/ || $0 ~ /\*\*Spec anchors?:\*\*/) task_has_anchor = 1
  if ($0 ~ /\(folded:/) phase_has_folded = 1
}

END {
  flush_task()
  for (l in gap_pending) if (!phase_has_folded) warn(l, "numbering gap before this task (expected " gap_pending[l] ") without a (folded: …) annotation")
  for (g in gate_ref) if (!(g in gate_def)) { violations++; printf "FAIL L%d: OWNER-GATED pointer %s has no ledger definition in Owner-Gates\n", gate_ref[g], g }
  for (g in gate_def) if (!(g in gate_ref)) warn(gate_def[g], "ledger " g " defined but no task references it")
  if (section_log_seen && !log_has_ptr) print "FAIL: Log section lacks the docs/archive/IMPLEMENTATION_LOG.md pointer"
  if (log_start && !log_has_ptr) { violations++; printf "FAIL L%d: Log section lacks the docs/archive/IMPLEMENTATION_LOG.md pointer\n", log_start }
  printf "plan-lint: %d violation(s), %d warning(s)\n", violations, warnings
  exit (violations > 0 ? 1 : 0)
}
' "$PLAN" || awk_rc=$?

# ⛔ `set -euo pipefail` is on, so a NON-ZERO awk exit used to abort the script HERE — meaning every
# check below was SKIPPED exactly when the plan already had a violation. The one condition under which
# you most want the remaining guards to run was the one that silenced them. Captured, not aborted.

# ---- session-doc duplicate-NNN guard (added 2026-08-18) --------------------------------------------
# WHY: the numbered-doc convention computes the next NNN as `max+1` from a directory read. That is a
# read-modify-write with NO LOCK, so N sessions closing out concurrently all compute the same number.
# It has now fired at least three times: 114 (two-way, SILENT, survived ~3 weeks unnoticed), 173, and a
# three-way collision at the 2026-08-18 close-out. See contracts L203.
# ⛔ DETECTION CURRENTLY SCALES WITH COLLISION MULTIPLICITY, NOT WITH ANY CONTROL — a three-way collision
# is unmissable, a two-way one is silent. This check is that missing control, and it needs no
# concurrency assumption at all.
# PROMOTED WARN -> VIOLATION 2026-08-28 (task 24.107), in the same commit that dispositioned `114`.
# It shipped as a WARN only because `114` was a live pre-existing duplicate and failing on it would
# have blocked every tracker commit. That duplicate is now renamed forward (114 -> 190, the doc with
# ZERO measured inbound links), so the guard has nothing outstanding to forgive.
# A guard left permanently at warn is a completion badge (`L82`): it makes the problem look handled
# while allowing the next instance through unchanged.
if [ -d docs/sessions ]; then
  dup_nnn=$(ls docs/sessions 2>/dev/null | sed -nE 's/^([0-9]{3})-.*/\1/p' | sort | uniq -d)
  if [ -n "$dup_nnn" ]; then
    for n in $dup_nnn; do
      printf 'FAIL: docs/sessions/ has DUPLICATE number %s — the max+1 counter is not concurrency-safe (contracts L203).\n' "$n"
      printf '      Rename the copy with NO inbound links FORWARD to the next free number; measure inbound first.\n'
      ls docs/sessions | sed -nE "s/^($n-.*)$/    \1/p"
      dup_rc=1
    done
  fi
fi

# ---- stale-parent guard: a `[ ]` parent with NO actionable sub-slice (added 2026-08-28) -------
# WHY: four tasks were found marked `[ ]` OPEN while shipped, deferred, or owner-gated — 12.22,
# 24.4, 19.8 and 13.8. ⛔ 13.8 was the worst shape: a 15-slice arc where FOURTEEN sub-slices had
# shipped and the fifteenth was owner-gated, while the parent still advertised the whole thing as
# unstarted. A reader scanning for available work cannot see that without opening every sub-slice.
#
# ⭐ THE PREMISE IS "NO SUB-SLICE IS ACTIONABLE", NOT "ALL ARE DONE" — and that distinction was
# found by POSITIVE-CONTROLLING the first draft, which asserted all-done and therefore did NOT fire
# on 13.8, the very instance that motivated it. A guard that cannot flag its own founding case is
# worse than none: it reports a clean plan and reads as coverage.
#
# ⚠ WHAT IT CANNOT CATCH, stated because implying broader coverage is this repo's recurring defect:
# the other three. 19.8 was shipped and LIVE with no sub-slices at all — only tracing the code found
# it, and no linter would have.
#
# WARN, not FAIL: a parent may legitimately hold residual work its sub-slices do not represent.
# It flags for a human; it does not decide.
if [ -f "$PLAN" ]; then
  /usr/bin/awk '
    /^### [0-9]+\.[0-9]+ / { cur=$2; next }
    /^#### [0-9]+\.[0-9]+[a-zA-Z-]+ / { sub_of=$2; parentof[sub_of]=cur; subs[cur]++; expect=1; next }
    expect && /\*\*State:\*\*/ { p=parentof[sub_of]; if ($0 ~ /DONE|OWNER-GATED|DEFERRED|BLOCKED/) settled[p]++; expect=0; next }
    { if (cur!="" && $0 ~ /^- \[ \]/ && !seenbox[cur]++) isopen[cur]=1 }
    END {
      for (t in subs)
        if (isopen[t] && subs[t] > 0 && subs[t] == settled[t])
          printf "  warn: task %s is [ ] OPEN but NONE of its %d sub-slices is actionable (all DONE / owner-gated / deferred) — the parent is probably stale\n", t, subs[t]
    }
  ' "$PLAN"
fi

if [ "$awk_rc" -ne 0 ] || [ "$dup_rc" -ne 0 ]; then exit 1; fi
exit 0
