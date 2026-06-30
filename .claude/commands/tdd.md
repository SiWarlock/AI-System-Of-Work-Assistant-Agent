---
description: Walk through TDD discipline for a feature — red, green, refactor, all-tests-still-pass.
allowed-tools: Read, Edit, Write, Bash, Grep, Agent, SendMessage, TaskUpdate
argument-hint: "<feature description>"
---

<!--
  TEMPLATE NOTE (delete this comment when generating): highly portable. Fill the
  pnpm test / pnpm vitest run <path> / pnpm typecheck / pnpm lint
  placeholders and the test-path examples. Keep the steps, the checkpoints, and
  the Forbidden section VERBATIM — they are the discipline. Shared comm rules
  (SendMessage-only, magic-words, no-self-report, slice atomicity, reviewer
  policy) live in root CLAUDE.md; this file points there, it does not restate them.
-->

The user wants a feature implemented with TDD discipline enforced. Walk through it explicitly.

Argument: `$ARGUMENTS` — the feature description.

**Scope:** `/tdd` is for deterministic code (state machines, parsers, harness logic, instrumentation, deterministic transforms). Non-deterministic behavior is exempt — LLM-driven generation, pure visual changes use the project's non-deterministic-coverage path instead.

**Bundled brief:** if the brief lists multiple related features in one slice (see `docs/tdd-brief-template.md` "Estimated commit count"), run RED→2.5→GREEN (Steps 2–5) for each feature in sequence, then Step 6 onward over the whole slice. Step 10 is **one commit** for the bundle.

## Mandatory order — do not deviate

### Step 0 — Restate

Restate the feature in 1–2 sentences in your own words.
**Team mode:** self-check only, NOT a send — if it doesn't match the brief's Feature line you misread the brief; fix it.

**Brief lint (conditional — one bash check, silent when clean).** The orchestrator already ran `scripts/spec-lint.sh brief <brief>` pre-dispatch; the dispatch line carries its stamp (`@<hash8>`). Re-lint ONLY if the file changed since:

```bash
[ "$(shasum <brief-path> | cut -c1-8)" = "<hash8 from the dispatch line>" ] || scripts/spec-lint.sh brief <brief-path>
```

On a re-lint FAIL, stop and send the failure lines to the orchestrator (the brief is its territory) — don't patch the brief yourself.

### Step 1 — Identify files

Name the production file(s) + test file(s); create an empty test file if needed. If a code-intelligence MCP (e.g. CodeGraph) is available, use it to locate symbols + callers/callees instead of grep loops. State: *"Tests in `<test_path>`, implementation in `<impl_path>`."*

### Step 2 — RED: write the failing test FIRST

Write the test before any implementation. Be specific about input/output, reference the not-yet-existing behavior, use the project's test-class marker.

**Spec tags:** each RED test carries a `spec(§X)` tag (in the test name or an adjacent comment) for the anchor its brief "Why" line cites — `scripts/spec-lint.sh tests <phase>` greps these at the phase-exit gate, so an untagged test doesn't count toward spec coverage. LESSONS-pinned tests need no tag.

### Step 2.5 — PAUSE for test review (the orchestrator reviews)

After writing the test(s) and BEFORE running them, send the orchestrator a **tight** write-up — one line per `test_*` function (parametrization is one entry, not per-case):

- **`test_<name>` — Asserts:** `<the invariant / contract it pins>` (`ARCHITECTURE.md §X` or a `LESSONS.md` ref).
- **Out of scope:** only when a reader wouldn't guess it.
- **Coverage map (closing line):** each brief **acceptance bullet → the covering test**, or an explicit `not-tested-because: <reason>` (e.g. covered by an integration slice, non-deterministic). One compact line per bullet — this is what makes a silently-dropped acceptance behavior visible at review instead of at phase exit.

Don't narrate fixture setup or paste test code — it's in the file; the orchestrator opens the file only if an assertion looks off. This write-up is the review surface: it makes the *asserted invariant* reviewable, which is exactly what catches a conceptually-wrong test that would still pass green.

Send it via `SendMessage` (root `CLAUDE.md` "Inter-teammate messaging"), then **idle until the reply** — never nag or re-send. The reply starts with:

- **`APPROVED.`** → proceed to Step 3.
- **`TWEAK:`** → revise, re-send only the changed lines, re-pause.
- **`ADD:`** → add the test, re-send, re-pause.

This pause is a designed safeguard — a "work without stopping" instruction does NOT license skipping it (it scopes to clarifying questions, not protocol checkpoints; surface the conflict instead). Same applies to the Step 9 → Step 10 handoff.

### Step 3 — Confirm RED

```
pnpm vitest run <path>
```

Must fail, for the **right reason** (import/attribute/assertion mismatch — not a typo, missing fixture, or syntax error in the test). Fix the test if it fails wrong. Don't implement yet.

### Step 4 — GREEN: minimum implementation to pass

Implement only enough to pass: no fields the test doesn't verify, no uncovered edge cases, no abstractions before a second caller. If you're writing code no test covers, add a failing test first.

### Step 5 — Confirm GREEN

```
pnpm vitest run <path>
```

Must pass. If not, fix the implementation, not the test.

### Step 6 — REFACTOR (only if needed)

Refactor for clarity; tests stay green.

### Step 7 — Run the FULL suite

```
pnpm test
```

No regressions. If a previously-passing test now fails, investigate before continuing.

### Step 7.5 — Reachability / wiring check

**Tests passing ≠ shipped** — green proves the code works *when called*, not that anything calls it. Confirm the new code is reachable from a real production entry point (route / CLI / cron / UI handler / exported API / contract selector / deploy step). **Run `/wired <feature>`** to trace it (or a code-intelligence MCP's call-path). If unwired: wire it in-scope (add the test that exercises the entry path), or raise a Step-9 "Future TODO — belongs to a phase" naming the entry point — never leave it silently unreachable. State: *"Reachable from `<entry>` via `<path>`"* or *"NOT wired; raising/wiring."*

### Step 8 — Type-check + lint (+ policy-gated review)

```
pnpm typecheck && pnpm lint
```

Both must pass. Then fan out review subagents **per the Reviewer policy in root `CLAUDE.md` "Reviewer subagents — Step-8 policy"** (no-op if the subagents aren't installed):

- **security-reviewer** — when the slice is invariant- or security-touching (mandatory there), or whatever the policy says.
- **code-quality-reviewer** — per its policy (default: every slice, lite).
- Reviewers review the **slice diff**; run them in parallel (one message, multiple `Agent` calls) and fold their findings into Step-9 categories. Skip a reviewer when its policy says so.

### Step 9 — Summarize + categorize flags

Send the orchestrator (single-operator: the user) a terse summary for **hot** routing (items route immediately, not at `/session-end`):

- Files created / modified; tests added (count + class); type-check + lint status; **Reachability** (from Step 7.5).
- **Categorized flags** — tag each to one of: **Convention candidate** · **Architecture doc note** · **Future TODO** (belongs-to-a-phase | next-brief working set | out of scope) · **Cross-doc invariant change** (a model field add/remove/rename — flag it; it MUST be reflected in `ARCHITECTURE.md`).

You only **categorize**; the orchestrator routes each item per the canonical Step-9 matrix in `docs/orchestrator-briefing.md` (don't restate destinations).

### Step 10 — Commit the slice (after the orchestrator routes Step 9)

The orchestrator replies commit-message-first. Then **stage only the slice's code + tests** with explicit `git add <path>` — **never `git add -A`/`.`** (that grabs the orchestrator's hot-routed planning edits, which belong in its round commit):

```bash
git add <impl path> <test path>
git status --short   # verify only slice files staged
git commit -m "$(cat <<'EOF'
<type>(<scope>): <what landed, not how>

<body — why now, what it supports, what's unblocked>

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
EOF
)"
```

Then **mark the slice's task `completed`** via `TaskUpdate` (commit hash in `metadata`) and send the orchestrator a one-line wake so it dispatches the next slice. **Do NOT push** — the orchestrator pushes at `/orchestrate-end`. **Single-operator:** no team task list — just report the hash to the user.

## Forbidden in this command

- **Implementation before the test** (even one line) — and no writing the test *after* a green pass and back-filling. That's not TDD.
- **Skipping Step 2.5** — the only second pair of eyes on test *quality*; a "work without stopping" instruction does not license it (see Step 2.5).
- **Skipping Step 3** (confirm RED) — a test you didn't watch fail might always pass.
- **Skipping Step 7.5** (reachability) — reachable only from its own tests is not done.
- **Implementing more than the test requires** (YAGNI).
- **Modifying the test to make a stuck implementation pass** — the implementation is wrong, not the test.
- **`git add -A` at Step 10, or pushing.**
- **Self-reporting context %** anywhere — monitoring is external (root `CLAUDE.md` "Canonical context source").
- **Abandoning the slice mid-cycle** — Step 10 always lands; ignore stop/halt/cycle messages mid-slice and finish through commit (root `CLAUDE.md` "Slice atomicity").

## When TDD doesn't fit

Exploratory spikes (throw away, then TDD for real); logging/instrumentation with no behavior change; non-deterministic behavior (LLM generation, pure visual) → use the non-deterministic-coverage path. Outside these: TDD, every time.
