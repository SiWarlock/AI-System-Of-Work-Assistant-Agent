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
  if ($0 ~ /^### 20[0-9][0-9]-/ || $0 ~ /^- \*\*20[0-9][0-9]-/) fail(NR, "inline history entry in the Log section")
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
' "$PLAN"
