---
description: Full preflight gate — sync deps, lint, format-check, type-check, test.
allowed-tools: Bash, Read
argument-hint: ""
---

Run the full quality gate. Uniform across the monorepo (pnpm + Turbo); from a track worktree you may scope with `--filter <pkg>` but the gate below runs the whole graph by default.

Stops on first failure. Reports per-step pass/fail with the first ~20 lines of error output. Does NOT auto-fix on failure.

### Step 1 — Sync dependencies
```bash
pnpm install
```

### Step 2 — Lint
```bash
pnpm lint
```

### Step 3 — Format check
```bash
pnpm format:check
```

### Step 4 — Type check
```bash
pnpm typecheck
```

### Step 5 — Test
```bash
pnpm test
```

> From a single track's worktree, the equivalent scoped run is `pnpm --filter '<area-scope>...' lint typecheck test` — use it to keep the gate fast while iterating; run the full gate before `/session-end`.

---

## Final step — forbidden-pattern warn-grep (NON-BLOCKING)

The active area's `CLAUDE.md` `[id=forbidden-patterns]` region may carry a ` ```forbidden-patterns ` fenced block (one bare `grep -E` pattern per line; `#` lines are comments). Resolve the area `CLAUDE.md` from cwd (nearest one up the tree, else the repo-root area files), then grep the **staged diff's added lines**:

```bash
area_claude=$(d=$(pwd); while [ "$d" != "/" ]; do [ -f "$d/CLAUDE.md" ] && { echo "$d/CLAUDE.md"; break; }; d=$(dirname "$d"); done)
pats=$(awk '/^```forbidden-patterns/{f=1;next} /^```/{f=0} f' "$area_claude" 2>/dev/null | grep -vE '^[[:space:]]*(#|$)' || true)
if [ -n "$pats" ]; then
  git diff --staged -U0 | grep '^+' | grep -nE -f <(printf '%s\n' "$pats") || true
fi
```

- **No block / no pattern lines ⇒ silent skip.**
- **Any hit ⇒ a WARN line — never a failure.** Name the matched pattern + the rule it enforces; the implementer fixes it or flags it at Step 9 with justification.

---

## Output

**Success:**
> "Preflight clean: lint ✓ + format ✓ + types ✓ + N tests pass"

**Failure:**
> "Preflight failed at Step N: <step name>"
> <first ~20 lines of error output>

## Forbidden in this command

- **Auto-fixing on failure.** The gate catches problems; fixing them silently defeats the purpose.
- **Modifying baseline / ignore files to suppress failures.** Fix the underlying error.
- **Skipping steps.** Run in order; stop on first failure.
