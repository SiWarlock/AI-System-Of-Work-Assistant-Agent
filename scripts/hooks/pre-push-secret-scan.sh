#!/usr/bin/env bash
# pre-push-secret-scan.sh — full-history secret scan on the commits being pushed.
#
# ⭐ OWNER-AUTHORIZED 2026-08-29. ⛔ THE REMOTE IS PUBLIC
# (github.com:SiWarlock/AI-System-Of-Work-Assistant-Agent), which is the entire reason this
# exists: a secret pushed to a public repo is scraped by bots within MINUTES, well before
# anyone rotates it, and rewriting history does not recall it. Rotation covers a key sitting
# in a Keychain or scrolling past in a log; it does NOT cover one that reached `origin`.
#
# ⛔⛔ THE GAP IT CLOSES, MEASURED 2026-08-29 RATHER THAN IMAGINED. The existing
# `scripts/guards/secrets-guard.sh` runs `gitleaks protect --staged` — it sees ONE COMMIT'S
# STAGED DIFF and nothing else. So it never saw:
#   • any commit made before that guard existed;
#   • any commit made with `--no-verify`;
#   • anything reaching the remote by any path other than a fresh `git commit`.
# On 2026-08-29, a by-hand `gitleaks detect` over 1838 commits found 30 findings that the
# staged-diff guard had never once looked at. (All 30 classified clean — 5 were the prose
# "Temporal…brain" tripping a generic rule, 1 an idempotency-key fixture, 24 synthetic
# fixtures in redaction/secret-detection suites, which necessarily contain credential-shaped
# literals. Zero real credentials, zero in production source.) ⭐ THE POINT IS NOT THAT IT
# FOUND NOTHING — it is that NOTHING HAD EVER LOOKED, and the check that would look ran only
# because a human happened to run it by hand before one particular push.
#
#   INSTALL / RE-INSTALL (needed after a fresh clone — hooks are NOT shared by clone):
#     ln -s ../../scripts/hooks/pre-push-secret-scan.sh .git/hooks/pre-push
#   UNINSTALL:
#     rm .git/hooks/pre-push
#   RUN DIRECTLY (no install required — this is what makes it testable):
#     echo "refs/heads/main <local-sha> refs/heads/main <remote-sha>" \
#       | bash scripts/hooks/pre-push-secret-scan.sh origin <url>
#
# ⛔ WHY core.hooksPath IS NOT USED: this repo already has a LIVE `.git/hooks/pre-commit`
# (plan-lint). Setting `core.hooksPath` redirects ALL hooks to the new directory and would
# have SILENTLY DISABLED it — a safety gate removed as a side effect of adding one. Symlink
# per-hook instead, exactly as the pre-commit hook documents.
#
# ⚠ SCOPE — WHAT IT SCANS, stated because a gate believed to cover more than it does is worse
# than a known gap (`contracts L89`): the commit RANGE being pushed (`<remote-sha>..<local-sha>`),
# NOT all of history on every push. That is the correct scope — commits already on the remote are
# already public, so re-scanning them cannot prevent anything, and re-reporting them every push
# is how a check trains people to bypass it. On a NEW branch (remote sha all-zero) there is no
# prior state, so it scans the full history reachable from the tip.
#
# ⚠ ACCEPTED RESIDUALS, named rather than glossed:
#   • REPO-LOCAL. Not shared by clone, not CI. It protects THIS working copy only.
#   • It cannot prove a value is not a secret — `gitleaks` is a pattern matcher with a real
#     false-positive rate (5 of the 30 above were not secrets at all). A HIT IS A CANDIDATE TO
#     CLASSIFY, never a verdict (`contracts L104`), and a MISS is not a clean bill.
#   • It scans COMMITS. A secret in an untracked file is invisible to it and always was.
set -euo pipefail

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$REPO_ROOT"

ZERO="0000000000000000000000000000000000000000"

# Deliberate, visible escape hatch. `git push --no-verify` also works and is standard; both are
# fine BECAUSE they are explicit. An override nobody can find is how a fail-closed gate becomes
# a reason to disable the hook entirely.
if [ "${SOW_SKIP_SECRET_SCAN:-0}" = "1" ]; then
  echo "pre-push-secret-scan: SKIPPED via SOW_SKIP_SECRET_SCAN=1 (deliberate)." >&2
  exit 0
fi

if ! command -v gitleaks >/dev/null 2>&1; then
  cat >&2 <<'MSG'

⛔ pre-push-secret-scan: BLOCKED — `gitleaks` is not installed.

This hook FAILS CLOSED on purpose. Its whole job is to stand between this repo and a PUBLIC
remote; passing silently when the scanner is missing would make it a gate that reports success
without executing (`contracts L89`) — the exact shape it exists to prevent.

  install:  brew install gitleaks
  bypass:   SOW_SKIP_SECRET_SCAN=1 git push ...   (or `git push --no-verify`)
MSG
  exit 1
fi

# git feeds the pre-push hook one line per ref on stdin:
#   <local ref> <local sha> <remote ref> <remote sha>
status=0
scanned_any=0
while read -r _local_ref local_sha _remote_ref remote_sha; do
  # Branch deletion — nothing is being added, nothing to scan.
  [ "$local_sha" = "$ZERO" ] && continue

  if [ "$remote_sha" = "$ZERO" ]; then
    # New branch on the remote: no prior state, so scan everything reachable from the tip.
    range="$local_sha"
    label="full history reachable from ${local_sha:0:8} (new remote branch)"
  else
    range="$remote_sha..$local_sha"
    label="$range"
  fi

  # Count first — an empty range is a no-op, and reporting "scanned 0 commits" as a PASS is the
  # vacuous-green shape this project keeps finding (`contracts L90`).
  n_commits="$(git rev-list --count "$range" 2>/dev/null || echo 0)"
  if [ "$n_commits" -eq 0 ]; then
    echo "pre-push-secret-scan: nothing new in $label — skipping (not a defect)."
    continue
  fi

  scanned_any=1
  echo "pre-push-secret-scan: scanning $n_commits commit(s) — $label ..."

  # `--log-opts` scopes the history walk to exactly the range being pushed.
  # Branch on the EXIT CODE, never on the rendered output (`contracts L243`).
  if gitleaks detect --no-banner --redact --log-opts="$range" >/tmp/sow-gitleaks-$$.log 2>&1; then
    echo "pre-push-secret-scan: clean ($n_commits commit(s))."
  else
    status=1
    {
      echo
      echo "⛔ pre-push-secret-scan: BLOCKED — gitleaks reported findings in $label"
      echo
      tail -25 /tmp/sow-gitleaks-$$.log
      cat <<'MSG'

⛔ THE REMOTE IS PUBLIC. A real secret pushed here is scraped within minutes — before you could
rotate it — and a history rewrite does NOT recall it. Treat this as blocking until classified.

A HIT IS A CANDIDATE, NOT A VERDICT. Classify every finding before doing anything else:
  • REAL secret        → do NOT push. Rotate it at the provider FIRST, then purge it from history.
  • synthetic fixture  → add an inline `gitleaks:allow` comment on that line (preferred — it is
                         co-located, so it cannot rot the way a line-numbered fingerprint does),
                         or add the finding's Fingerprint to .gitleaksignore.
  • not a secret       → same as above; several existing findings are ordinary prose that happens
                         to match a generic rule.

  re-run by hand:  gitleaks detect --no-banner --redact --log-opts="<range>"
  bypass:          SOW_SKIP_SECRET_SCAN=1 git push ...   (deliberate and visible — say so at close-out)
MSG
    } >&2
  fi
  rm -f /tmp/sow-gitleaks-$$.log
done

if [ "$scanned_any" -eq 0 ] && [ "$status" -eq 0 ]; then
  echo "pre-push-secret-scan: no new commits on any pushed ref — nothing to scan."
fi

exit "$status"
