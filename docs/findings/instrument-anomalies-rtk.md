# The instrument anomalies: the wrapper is a PreToolUse HOOK, above the shell

**Closes the central unknown of `### 24.122`** ("WHAT SETS IT REMAINS UNKNOWN, AND IS
STATED AS UNKNOWN") and gives that entry the durable home it says it never had.

**Session:** 2026-08-28, autonomous run. Per that entry's own scope correction, every
instrument claim below is *measured in the session that measured it*.

---

## The answer

`rtk` — `/opt/homebrew/bin/rtk` — is registered as a **`PreToolUse` hook on the `Bash`
matcher** in `~/.claude/settings.json`:

```json
{ "matcher": "Bash", "hooks": [ { "type": "command", "command": "rtk hook claude" } ] }
```

Its own `--help` describes it in one line:

> A high-performance CLI proxy designed to filter and summarize system outputs before they
> reach your LLM context.

Its subcommands include `git` ("Git commands with compact output"), `pnpm` ("ultra-compact
output"), `ls`, `read`, `err`, `test`, `env`.

And `.claude/settings.local.json` carries permission entries that can only exist because
commands were actually presented in rewritten form:

```
"Bash(rtk wc *)", "Bash(rtk grep *)", "Bash(rtk ls *)", "Bash(rtk git *)"
```

---

## Why every previous hunt came back clean

⭐ **This is the transferable part.** `### 24.122` established, correctly and by direct
test, that **`git` is not wrapped**: `type git` → `/usr/bin/git`, `git --version` → real
Apple git, no shim, no Homebrew path entry. That measurement was right, and it was
right *because the shell genuinely is not wrapped.*

The rewrite happens **one layer above the shell** — in the tool-call pipeline, before a
shell exists to interrogate. So:

- Every in-shell question ("is git a function? a shim? on a weird PATH?") is asking the
  wrong layer and will always return clean.
- `type git` reporting `/usr/bin/git` and the output being transformed are **both true at
  once**, which is exactly the shape that made this look contradictory for weeks.

⇒ **When a tool's output is wrong but the tool interrogates clean, check the layer that
invokes it, not the tool.** The entry's search space never included the hook config.

---

## What this explains, and how confidently

**Established this session (direct measurement):**

| Claim | Evidence |
|---|---|
| `rtk hook claude` is a live `PreToolUse` Bash hook | read from `~/.claude/settings.json` |
| `rtk` is an output-summarizing CLI proxy with dedicated `git` / `pnpm` / `ls` modes | `rtk --help` |
| Commands have been presented in `rtk`-prefixed form in this project | the four `Bash(rtk …)` allow-rules |
| A `PreToolUse` hook runs before the shell, so `type git` is unaffected by it | mechanism, from the hook contract |
| ⚠ **The 50-line `git log` cap does NOT reproduce in this session** | bare `git log` → **54657** lines; `/usr/bin/git log` → 54657; `git log --oneline` → 1764; `seq 200` → 200 |

**Strongly indicated, not proven:** that `rtk` is the cause of each of the six recorded
anomalies individually — the 50-line `git log` cap, the literal `ok` from `git status` /
`git commit` / `pnpm install`, and `[ok] Files are identical` from `diff`. The `[ok]`
token is *rtk's own summary format*, and the affected tools are exactly the ones rtk has
modes for. ⛔ But `### 24.122` is explicit that proposing one unifying cause for all six
"is the move that cost this project weeks", so this is recorded as a strong hypothesis
with its mechanism named, **not** as a closed attribution.

---

## What to do about it

The entry's enforcement already works and does not depend on any of this:

- Use absolute paths — `/usr/bin/git`, `/opt/homebrew/bin/rg` — which bypass the rewrite.
- Never enumerate with bare `git log`; use `rev-list --count`, `--numstat`, or an explicit
  `-n` above the expected range.
- Branch on exit codes inside the shell; do not parse rendered output (`L243`).

One addition this finding earns: **an unexpected output shape is now a hook question
first.** Before characterizing a tool, check whether something rewrote the command.

⚠ And the reason the cap not reproducing matters: a recorded instrument fact is a claim
about the session that took it. This one has already expired once.

---

# Addendum: the `grep` contradiction is a RESOLUTION-PATH difference, not a session difference

**Closes `### 24.131`**, which recorded two sessions on one machine getting two different
answers for `grep --version` — `ugrep 7.5.0` versus `BSD grep (GNU compatible)
2.6.0-FreeBSD` — called it *"currently the most interesting open datum in the toolchain
family"*, and wrote down the obvious test **UNRUN**.

## Measured, 2026-08-28, both in the SAME session, seconds apart

```
type grep            → grep is a shell function from
                       /Users/dreddy/.claude/shell-snapshots/snapshot-zsh-1787951049382-h1t32e.sh
grep --version       → ugrep 7.8.4 aarch64-apple-macosx
/usr/bin/grep --version → grep (BSD grep, GNU compatible) 2.6.0-FreeBSD
```

⇒ **Both recorded answers are true at once, on one machine, in one session.** Which one you
get depends entirely on whether the command resolves through the shell-snapshot function or
goes straight to the binary.

## What this establishes, and what it does not

**Established:** a bare-vs-absolute path difference is *sufficient* to produce the entire
contradiction. No session-scoped tool identity is required to explain it, and the simpler
explanation is now demonstrated rather than hypothesised.

⚠ **Not established:** which form the second session actually ran. I cannot know that, so
this does not *prove* the reconciliation for that specific instance — it removes the need
for an exotic one. The entry was right to refuse to reconcile the two readings on the
evidence it had.

⭐ **New datum:** `ugrep` has moved **7.5.0 → 7.8.4** since the lead's reading. Even the
same resolution path does not return a stable answer over time — so "state your session"
was not conservatism, and the version belongs in the statement too.

## ⭐ The same shape as the rtk finding above

Both are one structure: **two true answers at different layers, read as a contradiction.**

- `git` is genuinely unwrapped *and* the command is rewritten — the rewrite is above the shell.
- `grep` is genuinely `ugrep` *and* genuinely BSD grep — different resolution paths.

⇒ When two careful measurements of "the same thing" disagree, the first question is not
*which is wrong* but **whether they are measuring the same thing at all.** In both cases
here, they were not, and in both cases the search stalled while everyone assumed they were.

Enforcement is unchanged and never depended on the answer: absolute paths, `awk`/`sed` with
`FNR`, positive-control every empty result, branch on exit codes.
