#!/usr/bin/env bash
# git-guard.test.sh — hermetic pin for scripts/guards/git-guard.sh (### 24.125).
#
# There is no package/pnpm harness for shell hook scripts, so this runs standalone:
#   bash scripts/guards/git-guard.test.sh
#
# Each check feeds a synthetic PreToolUse[Bash] JSON payload to the guard over stdin (exactly the
# shape the harness feeds it in production: {tool_input:{command}, session_id}) inside a hermetic
# `env -i` + temp HOME, so team-registry role lookups and CODEX_* fallbacks never leak from the real
# environment, and asserts the guard's exit code.
#
# ### 24.125 is the defect this file pins: the guard string-matched the WHOLE raw command text, so
# it could not tell an executed command from a document quoting it (a heredoc body naming the banned
# form — the repo's own commit-message convention, root CLAUDE.md: "Always pass the commit message
# via a HEREDOC"), and separately could not tell `git push` from an unrelated subcommand that merely
# contains the word (`git stash push`). Three shapes are pinned per rule: a real invocation still
# BLOCKED, a document quoting it ALLOWED, and (rule 2 only) a legitimate unrelated command containing
# the banned token ALLOWED.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
GUARD="$REPO_ROOT/scripts/guards/git-guard.sh"
[ -f "$GUARD" ] || { echo "FATAL: guard not found at $GUARD" >&2; exit 1; }

TMP_HOME=$(mktemp -d)
OUT_FILE=$(mktemp)
ERR_FILE=$(mktemp)
trap 'rm -rf "$TMP_HOME" "$OUT_FILE" "$ERR_FILE"' EXIT

SID="test-impl-session"
mkdir -p "$TMP_HOME/.claude/team-registry"
printf '{"role":"implementer"}' > "$TMP_HOME/.claude/team-registry/${SID}.json"

pass=0
fail=0

# check LABEL COMMAND_TEXT EXPECTED_EXIT [SESSION_ID]
check() {
  local label="$1" cmdtext="$2" expected="$3" sid="${4:-}"
  local payload actual=0
  payload=$(jq -n --arg cmd "$cmdtext" --arg sid "$sid" '{tool_input: {command: $cmd}, session_id: $sid}')
  printf '%s' "$payload" | env -i HOME="$TMP_HOME" PATH="$PATH" bash "$GUARD" >"$OUT_FILE" 2>"$ERR_FILE" || actual=$?
  if [ "$actual" -eq "$expected" ]; then
    echo "PASS: $label (exit $actual)"
    pass=$((pass + 1))
  else
    echo "FAIL: $label — expected exit $expected, got $actual"
    echo "  --- command sent ---"
    printf '%s\n' "$cmdtext" | sed 's/^/  | /'
    echo "  --- guard stderr ---"
    sed 's/^/  | /' "$ERR_FILE"
    fail=$((fail + 1))
  fi
}

# ---------------------------------------------------------------------------
# Rule 1: blanket-stage ban (`git add -A` / `git add .` / `git add --all`)
# ---------------------------------------------------------------------------

check "real 'git add -A' is still blocked" \
  "git add -A" 2

check "real 'git add .' is still blocked" \
  "git add ." 2

check "real 'git add --all' is still blocked" \
  "git add --all" 2

check "explicit 'git add <path>' is allowed" \
  "git add packages/contracts/CLAUDE.md" 0

# The repo's own commit convention (root CLAUDE.md): message body built via a quoted heredoc. A
# heredoc that merely NAMES the banned literal in prose must not be read as an invocation.
read -r -d '' HEREDOC_ADD_DOC <<'PAYLOAD' || true
cat <<'EOF' > /tmp/git-guard-test-note.md
Do not run git add -A or git add . — stage files explicitly.
EOF
echo wrote note
PAYLOAD
check "a heredoc quoting 'git add -A' as prose is allowed" \
  "$HEREDOC_ADD_DOC" 0

read -r -d '' COMMIT_MSG_CMD <<'PAYLOAD' || true
git commit -m "$(cat <<'EOF'
fix(guards): tighten git-guard so it can quote git add -A safely

Co-Authored-By: Claude Opus 5 (1M context) <noreply@anthropic.com>
EOF
)"
PAYLOAD
check "a commit -m built from a heredoc mentioning 'git add -A' in prose is allowed" \
  "$COMMIT_MSG_CMD" 0

# A real invocation elsewhere in the SAME compound command must still be caught — the heredoc
# exemption must not blind the scanner to text after the heredoc closes.
read -r -d '' COMBINED <<'PAYLOAD' || true
cat <<'EOF' > /tmp/git-guard-test-note2.md
some prose mentioning git add -A
EOF
git add -A
PAYLOAD
check "a real 'git add -A' after an unrelated heredoc is still blocked" \
  "$COMBINED" 2

# `<<-'EOF'` form with a tab-indented terminator must also be recognized as a heredoc body.
read -r -d '' DASH_HEREDOC <<'PAYLOAD' || true
cat <<-'EOF'
	git add -A is banned by policy
	EOF
PAYLOAD
check "a tab-indented '<<-' heredoc quoting the literal is allowed" \
  "$DASH_HEREDOC" 0

# ---------------------------------------------------------------------------
# Rule 2: implementers never push
# ---------------------------------------------------------------------------

check "real 'git push' is blocked for an implementer" \
  "git push" 2 "$SID"

check "real 'git push origin main' is blocked for an implementer" \
  "git push origin main" 2 "$SID"

check "'git push' is a no-op with no resolvable role (unchanged prior behavior)" \
  "git push" 0 ""

# Witness 3: a DIFFERENT git subcommand that merely contains the word "push" must not be read as
# `git push`.
check "'git stash push' is not a push and is allowed for an implementer" \
  "git stash push -- packages/contracts/CLAUDE.md" 0 "$SID"

# A document quoting "git push" in prose must also be allowed.
read -r -d '' HEREDOC_PUSH_DOC <<'PAYLOAD' || true
cat <<'EOF' > /tmp/git-guard-test-note3.md
Implementers must never run git push — that happens at /orchestrate-end.
EOF
PAYLOAD
check "a heredoc quoting 'git push' as prose is allowed" \
  "$HEREDOC_PUSH_DOC" 0 "$SID"

echo
echo "$pass passed, $fail failed"
[ "$fail" -eq 0 ]
