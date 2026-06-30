<!--
  TEMPLATE: .claude/agents/README.md → write to .claude/agents/.
  Lists the starter subagents the user opted into at bootstrap + the "build
  reactively" guidance for future additions. If the user opted out of all 5
  starter subagents, this README is the only file in .claude/agents/; the
  "Active inventory" table shows "none — opt-in starter set was declined."
  Delete this comment.
-->

# Subagents

This directory holds **subagents** — specialized roles delegated mid-session for focused work, to keep niche conventions out of the main session's context.

## Active inventory

<!-- ▼ EXAMPLE BLOCK [id=starter-subagent-inventory]: starter subagent inventory — show what the user opted into at bootstrap. If the user opted out of all five, replace this table with "none — opt-in starter set was declined; build subagents reactively per the guidance below." ▼ -->
This project includes all 5 starter subagents (production-grade + heavy safety invariants):

| Subagent | Role | When |
|---|---|---|
| `code-quality-reviewer` | Step-8 diff review (reuse/simplify/clarity) | `code-quality-reviewer = every-slice` |
| `security-reviewer` | Step-8 review on invariant/trust-boundary slices | `security-reviewer = invariant` |
| `reachability-auditor` | phase-exit dead-code/wiring audit | every `/phase-exit` |
| `arch-drift-auditor` | phase-exit spec-vs-code over the phase's anchors | every `/phase-exit` |
| `brief-drafter` | orchestrator brief-skeleton tool (definition shipped; integrate after a quality trial) | opt-in |
<!-- ▲ END EXAMPLE BLOCK [id=starter-subagent-inventory] ▲ -->

Each subagent file (`<name>.md`) carries its own scope, forbidden patterns, mandatory protocol, and output format. The forbidden-patterns section is its only guard — subagents aren't sandboxed.

**Reviewer policy (the toggle).** The Step-8 reviewer fan-out is gated by the **reviewer policy** in root `CLAUDE.md` "Reviewer subagents — Step-8 policy" — one of `off` · `invariant` · `every-slice` · `phase-boundary` per reviewer (default: security `invariant`, code-quality `every-slice` lite). Per-slice reviews cover the slice **diff**, not whole files; at `phase-boundary` the surface is the **phase's accumulated branch diff + crossed trust boundaries** (root `CLAUDE.md` states the same rule). Tune it to trade review depth for per-slice tokens.

## How subagents fit the slash-command workflow

```
/tdd cycle (implementer)
  Step 7: full suite green
  Step 7.5: reachability check (per-slice; `/wired <symbol>` for specific traces)
  Step 8: lint + typecheck, then policy-gated reviewer fan-out:
    ├── code-quality-reviewer (per policy — default every slice, lite)
    └── security-reviewer     (per policy — default invariant-/security-touching only)
  Step 9: implementer aggregates reviewer findings into categorized list, sends to orchestrator
  Step 10: commit

phase-exit gate (orchestrator — /phase-exit <phase> executes the tracker's checklist rows)
  ├── reachability-auditor (one per touched area)
  ├── arch-drift-auditor   (the phase's Spec anchors vs shipped code)
  └── security-reviewer    (only when its policy is `phase-boundary` — phase-diff surface)
  + scripts/spec-lint.sh tests <phase> (tagged-test coverage row)
  reports → docs/audits/<phase>-<agent>.md; ≤10-line summaries return; CLEAR gates the phase tick
```

The parallel fan-out pattern (Step 7→8) launches multiple `Agent` calls in a single message so reviewers run concurrently; the implementer waits for both, aggregates findings, and surfaces them in Step 9.

## How to invoke a subagent

From a teammate's session, use the `Agent` tool with `subagent_type: <subagent-name>`. The dispatching message should carry the minimum context the subagent needs (per its protocol section):

- `code-quality-reviewer` + `security-reviewer`: `files_touched` list, `brief_path` (optional), `area`, `invariant_touching` (boolean). (Phase-boundary dispatch: the phase diff instead of `files_touched`.)
- `reachability-auditor`: `area`.
- `arch-drift-auditor`: `phase`, `anchors` (the phase's `Spec anchors:` list), `area(s)`.
- `brief-drafter`: `task_id`, `topic`, `active_context` (one-liner).

## Brief-drafter quality trial (before standard adoption)

The `brief-drafter` definition file ships with the scaffolding, but is **not integrated into the standard orchestrator workflow** at bootstrap. Briefs are load-bearing design-decision audit trails; a sub-quality draft can mis-route an implementer.

**Trial protocol** before adopting as standard tool:

1. For the next 2-3 real briefs, **run the drafter in parallel** with the orchestrator authoring the brief normally (independent outputs).
2. Compare section-by-section:
   - Did the drafter cite the right architecture anchors?
   - Did it identify the same invariant-touching impact?
   - Did its default votes for Step-2.5 questions match the orchestrator's reasoning?
   - Did it surface the same Files-expected-to-touch list?
   - Did it miss design questions the orchestrator caught?
3. **Adoption threshold:** if drafter output requires <30% rewriting to match orchestrator quality, ship as standard tool (orchestrator's workflow becomes "request drafter → review draft → finalize"). If >30%, iterate the drafter's prompt + context loads before relying on it.

The 30% threshold is a heuristic — the actual signal is "is the orchestrator spending more time rewriting than they would have authoring from scratch?" If yes, the drafter is net-negative.

## When to build a new subagent

**Reactively, when friction surfaces** — typically when:

- You've manually done the same specialized work **~3 times**.
- The context bloat or repetition is real.
- A clear narrow scope can be defined (avoid generalist subagents).

When adding a new subagent: file in this directory + entry in the "Active inventory" table above + integration-point note in `docs/orchestrator-briefing.md` "Tools" section + (if implementer-side) entry in the area `CLAUDE.md` "Subagents" pointer.

## Common categories (build reactively, if friction surfaces)

| Category | When it earns its keep | What its body owns |
|---|---|---|
| Invariant / property-test writer | A safety or economic invariant needs adversarial / property coverage | Invariant conventions, the property-test format, the gate test |
| External-integration implementer | Adding code that wraps an external API / SDK / contract | Call conventions, response→type mapping, fixture/mock recording |
| Contract / type syncer | Keeping generated types / ABIs / schemas in sync across packages | Generation flow, the cross-package parity check, source-of-truth boundary |
| Fixture / data curator | Recording or refreshing deterministic fixtures | Recording flow, redaction grep, secret rotation |
| Observability instrumenter | Adding tracing / logging without behavior change | Trace-field conventions, redaction posture, span keys |

## Subagent file shape

Each subagent is one `.claude/agents/<name>.md` with frontmatter + a body defining scope, mandatory protocol, forbidden actions, and output format.

```markdown
---
name: <subagent-name>
description: |
  When to use this subagent. Be specific so the dispatching session knows
  whether to delegate. Two or three sentences max.
tools: Read, Edit, Write, Bash, Grep
model: sonnet
---

You <do-this-narrow-thing>.

## Scope
For one <unit-of-work> at a time:
1. Read the spec / docs that govern this work.
2. Implement / record / write.
3. Run the appropriate gate.

## You do NOT
- <forbidden action 1>
- <forbidden action 2>

## Mandatory protocol
1. Read first.
2. <Each step the subagent must follow.>

## Output
End each task with:
- <thing 1 the subagent must report>
- <thing 2>
```

The forbidden-patterns section is the subagent's only guard — it isn't sandboxed. Write it strictly.
