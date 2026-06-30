---
description: Report per-teammate context usage (team mode). Usage: /context-check [team] [--brief | --snapshot <hash>]
allowed-tools: Bash, Read, SendMessage
argument-hint: "[team] [--brief | --snapshot <hash>]"
---

<!--
  TEMPLATE NOTE (delete when generating): TEAM PATTERN ONLY — skip in
  single-operator-fallback mode. Wraps ~/.claude/scripts/check-team-context.sh
  (installed once from templates/scripts/). Tiers + thresholds are the script's
  (env-overridable); this command does not restate them.
-->

Report per-teammate context usage by wrapping the canonical helper. The helper joins `~/.claude/team-registry/` + `~/.claude/heartbeats/` — the ONLY canonical context source; no agent self-reports (root `CLAUDE.md` "Canonical context source").

Argument: `$ARGUMENTS` — optional team name (default `$TEAM_NAME`, else all teams) + optional flag.

## Run the helper

```bash
[ -x "$HOME/.claude/scripts/check-team-context.sh" ] || {
  echo "ERROR: check-team-context.sh not installed."
  echo "Install: cp templates/scripts/check-team-context.sh ~/.claude/scripts/ && chmod +x ~/.claude/scripts/check-team-context.sh"; exit 1; }

~/.claude/scripts/check-team-context.sh ${ARGUMENTS:-}
```

**Flags:** `--brief` = one-line per-team aggregate (the orchestrator's per-slice form). `--snapshot <hash>` = append this slice's per-member ctx to the trajectory history **and** print the `--brief` line (one call does the snapshot + the check — use it in the orchestrator's per-slice flow). `--json` / `--history` = machine / trajectory output.

## Orchestrator per-slice use (the common path)

After Step-10, run `~/.claude/scripts/check-team-context.sh <team> --snapshot <commit-hash>` — a **local read, no message**. Then:

- **Ping the lead ONLY if the line is `WARN` / `ACTION` / `HARD-STOP`** — `SendMessage` the line **verbatim** (no paraphrase). On `OK`, send **nothing** (the lead's free idle-notifications + the task list already show the slice landed).
- Then dispatch the next slice (don't wait on the lead).

The lead acts on a tier line per `docs/team-protocol.md` "Context monitoring + auto-cycle," and may run this command directly any time for an ad-hoc snapshot.

## Forbidden

- **Acting on a tier yourself** beyond the orchestrator's conditional send — this command REPORTS; the lead adjudicates close-out.
- **Paraphrasing or fabricating ctx** — send the helper line verbatim; if it's empty/stale, say so.
- **Editing heartbeat / registry files.**
