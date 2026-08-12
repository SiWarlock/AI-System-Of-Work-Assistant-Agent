#!/usr/bin/env bash
# pre-commit-plan-lint.sh — gate IMPLEMENTATION_PLAN.md hot-writes on scripts/plan-lint.sh
#
# ⛔ SHIPPED NOT INSTALLED. Built, verified, and DORMANT until someone opts in — the
# same posture this codebase applies to every other dangerous capability (built ·
# dormant · armed by choice). Installing it changes commit behaviour for whoever
# owns the working copy, so it is their deliberate act, never a side effect of a pull.
#
#   INSTALL (opt-in, per working copy):
#     ln -s ../../scripts/hooks/pre-commit-plan-lint.sh .git/hooks/pre-commit
#   UNINSTALL:
#     rm .git/hooks/pre-commit
#   RUN DIRECTLY (no install required — this is what makes it testable + CI-able):
#     bash scripts/hooks/pre-commit-plan-lint.sh              # staged-set mode
#     PLAN_LINT_FORCE=1 bash scripts/hooks/pre-commit-plan-lint.sh   # lint regardless
#
# WHY (task 24.42 · Carry-forward item 6 (a0)(v), re-measured 2026-08-12):
# `plan-lint` IS invoked at /orchestrate-end — but that gates the ROUND-CLOSE commit,
# not the per-edit HOT-WRITE, and the Step-9 routing matrix directs the orchestrator
# to write IMPLEMENTATION_PLAN.md hot, many times per round. On 2026-08-12 plan-lint
# caught THREE violations in that file in ONE session (a state token in a task
# heading; a DONE line missing its backticked hash; a resolved Carry-forward item
# annotated in place) — each committed by the person who had just written the rule
# being broken. An orchestrator who "knows the conventions" is precisely who this
# catches, which is why the mitigation cannot be knowledge (contracts L109: a check
# read AFTER the action is a receipt, not a gate; L103: prefer unrepresentable to
# detected).
#
# ⚠ ACCEPTED RESIDUAL, stated rather than papered over: a git hook is REPO-LOCAL and
# is NOT shared by clone. Installing it here protects THIS working copy only. It does
# not cover teammates, CI, or a fresh clone — so the mandatory before-and-after
# plan-lint step in docs/orchestrator-briefing.md REMAINS BINDING and is a complement
# to this hook, never a thing the hook replaces (L89: a gate believed to cover more
# than it does is worse than a known gap).
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

LINTER="scripts/plan-lint.sh"
TRACKER="IMPLEMENTATION_PLAN.md"

if [ ! -f "$LINTER" ]; then
  echo "pre-commit-plan-lint: $LINTER not found — refusing to pass silently." >&2
  exit 1
fi

# Fire ONLY when the tracker is actually part of this commit (L89 — a gate that
# fires on unrelated commits gets disabled, and a disabled gate protects nothing).
if [ "${PLAN_LINT_FORCE:-0}" != "1" ]; then
  staged="$(git diff --cached --name-only --diff-filter=ACMR 2>/dev/null || true)"
  case "$staged" in
    *"$TRACKER"*) ;;
    *)
      echo "pre-commit-plan-lint: $TRACKER not in the staged set — skipping (not a defect)."
      exit 0
      ;;
  esac
fi

echo "pre-commit-plan-lint: $TRACKER is staged — running $LINTER ..."
if bash "$LINTER"; then
  echo "pre-commit-plan-lint: PASS"
  exit 0
fi

cat >&2 <<'MSG'

⛔ pre-commit-plan-lint: BLOCKED — plan-lint reported violation(s) above.

This is a gate, not a note. Fix the violation and re-stage; do not commit over it.
If you genuinely need to bypass it, `git commit --no-verify` works and is a
deliberate, visible choice — which is the point.
MSG
exit 1
