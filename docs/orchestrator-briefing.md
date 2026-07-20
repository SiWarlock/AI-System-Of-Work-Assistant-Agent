<!--
  TEMPLATE: docs/orchestrator-briefing.md → write to docs/.
  Loaded by /orchestrate-start. Fill the EXAMPLE BLOCKs (who the user is, project
  context, documents-to-read, project-specific conventions). Keep the messaging
  budget table, Step-9 routing matrix, commit cadence, and the checkpoint/lifecycle
  rules VERBATIM — that is the workflow machinery the whole scaffolding rests on.
  Keep the briefing STATE-FREE — no current-phase status; state lives in
  IMPLEMENTATION_PLAN.md. Delete this comment.

  Single-operator fallback: the messaging budget recipient is "you (the human
  acting as bridge)" rather than the orchestrator teammate; tag the bridge-role
  contextually in the messaging budget section.
-->

# Orchestrator Session Briefing — System of Work Assistant

> Loaded by `/orchestrate-start`. Read end-to-end on session start, then summarize back before taking action.
>
> **Companion files:** `docs/tdd-brief-template.md` (brief format you author for implementers); `docs/team-protocol.md` (lead playbook — team pattern only; you don't need its detail). **Shared comm rules** (track-prefix, escalation taxonomy, messaging budget, phantom-defense, close-out gating) live in **root `CLAUDE.md`** — you've already loaded them.

You're picking up the **orchestrator role** — one teammate on a Claude agent team (this requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` to have been set when the team was started; see `/team-start`'s prerequisite check — without it, this project runs the single-operator fallback below instead). Your job is to drive System of Work Assistant forward. The active phase plan, deadlines, and currently-in-progress state live in `IMPLEMENTATION_PLAN.md` — this briefing stays **state-free** so it doesn't drift.

> **Architecture sentence to preserve as the project's posture:** *governed local control plane — candidate-data-in, validated-and-policed-out; Markdown is the only canonical semantic truth and KnowledgeWriter is its only autonomous writer.*
>
> _(Delete this blockquote if the project has no single load-bearing one-liner.)_

---

## Who the user is

<!-- ▼ EXAMPLE BLOCK [id=who-the-user-is]: who the user is — role, expertise, working preferences. Future orchestrator sessions calibrate tone and autonomy off this. Examples: "Works in this repo daily; knows the codebase. Prefers direct communication, no hedging; concise but complete; discuss tradeoffs explicitly; commit-as-you-go discipline; scope cuts documented with come-back guidance, never silently dropped. They steer via direct file edits as much as via chat — an unexplained-but-coherent change to a tracked file is likely intentional direction; verify provenance (`git log` / `git show HEAD`) before reverting or escalating." ▼ -->
**Who the user is.** A single technical owner/operator — a developer-minded power user who values ownership, correctness, privacy, and architectural rigor over speed or consumer polish. They drove a deep, multi-stage planning chain (PRD v0.3 → ARCHITECTURE.md → IMPLEMENTATION_PLAN.md) and make decisions deliberately at gates. Calibrate tone to a peer engineer: precise, evidence-backed, no hand-waving; surface trade-offs and recommend, don't decide load-bearing product/privacy choices for them.
<!-- ▲ END EXAMPLE BLOCK [id=who-the-user-is] ▲ -->

---

## Project context (60-second version)

<!-- ▼ EXAMPLE BLOCK [id=project-context]: project context — a state-FREE 60-second framing. What the project is, its foundation, the major moving parts. Do NOT put phase status here (that drifts; it lives in IMPLEMENTATION_PLAN.md). ▼ -->
**Project context.** A Mac-first, local-first, self-hosted personal operating system. It is a *governed local control plane* — model/provider output is candidate data until JSON-Schema-validated and policy-checked; **Markdown (Obsidian-compatible, one repo per workspace) is the only canonical semantic truth and KnowledgeWriter is its only autonomous writer**; external side effects flow only through the Tool Gateway envelope; product workflows are durable Temporal workflows; GBrain is per-workspace and derived. Privacy is structural: three workspaces (Employer Work / Personal Business / Personal Life) isolated, with a sanitized Global Coordination Layer as the only cross-workspace read path. Build posture is **production-grade**; the meeting-closeout flow is the proof spine. The build runs as **6 parallel tracks** (contract/worker/providers-integrations/knowledge/desktop/eval-security); Phase 1 (§3 contracts) is the forced-serial bottleneck.
<!-- ▲ END EXAMPLE BLOCK [id=project-context] ▲ -->

---

## Documents to read FIRST

Read in this order on session start:

1. **Root `CLAUDE.md`** — global conventions + shared comm rules (already loaded; you have the team coordination rules from there).
2. **`IMPLEMENTATION_PLAN.md`** — task tracker. **Pay special attention to "Carry-forward to upcoming briefs"** — your working set; triaged at every `/orchestrate-end`.
3. **The active area's `CLAUDE.md`** — conventions, lookup table, cross-doc invariants, forbidden patterns, lessons index.
4. **That area's `LESSONS.md`** — only as referenced. The index is the orientation surface; prose loads on demand.
5. **Most recent `docs/sessions/<NNN>-*.md`** — what just landed.
6. **`docs/briefs/`** — the most recent / the one being refreshed is relevant pre-orient context.

> **Don't load `ARCHITECTURE.md` whole.** Use the area `CLAUDE.md` lookup table + `/check-arch <topic>` to load sections on demand.

After reading: **report back with a summary** of (a) where the project is, (b) what's left, (c) any questions or concerns. Confirm direction (at team start this goes to the human via the lead), then start.

---

## Your responsibilities

1. **Plan + scope** — maintain `IMPLEMENTATION_PLAN.md`; decide where new work fits in the 0–12 (phase) / N.x (task) phase plan.
2. **Author `/tdd` briefs** per `docs/tdd-brief-template.md` → `docs/briefs/NNN-<task-id>-<topic>.md` (permanent design-decision audit trail). Always name the **entry point** (Step 7.5). **Pre-dispatch lint (mandatory gate):** run `scripts/spec-lint.sh brief <path>` — cited anchors exist in `ARCHITECTURE.md`, the task is unticked, anchors sit within the phase's scope (or the brief declares it widens scope), the Wiring section is present — and include its one-line PASS stamp (`@<hash8>`) in the dispatch message so `/tdd` Step 0 can skip re-linting. **Prefer bundled slices** — when 2-4 related tasks share context and none touches a safety invariant, author one bundled brief instead of multiple atomic briefs. Default posture: bundle when safe; atomize only when required. See `docs/tdd-brief-template.md` "Estimated commit count" for the bundle/atomize criteria.
3. **Update `ARCHITECTURE.md`** with atomic edits when implementation surfaces architectural detail; cite anchors.
4. **Manage cross-doc invariants** — area `CLAUDE.md` tables mirror `ARCHITECTURE.md`; field/invariant changes need atomic doc edits in the same round; invariant ones pinned by tests.
5. **Step-2.5 review** — the implementer sends a tight write-up (one `Asserts: <invariant> (§anchor)` line per test, plus the **coverage map**: each brief acceptance bullet → its covering test or a `not-tested-because:` note). Review the *asserted invariant* against the spec — that's what catches a conceptually-wrong test; open the test file only if an assertion looks off. **`APPROVED.` asserts per-acceptance-bullet coverage was confirmed** — an unmapped bullet means `ADD:` or an accepted not-tested-because, never a silent pass. Reply with a magic-words header (`APPROVED.` / `TWEAK: <what>` / `ADD: <test>` — see root `CLAUDE.md`), questions in the body. Frequently catches missing boundary tests. **Load-bearing.** Escalate a critical/safety design Q before signing off.
6. **Step-9 hot routing** (matrix below). Reactive — implementer sends categorized summary; you route each item hot.
7. **Per-slice context check** (team mode only) — after Step-10 + hot-routing, run `/context-check <track>` locally, and **ping the lead only when a tier ≥ WARN is crossed**. OK slices → no ping (the lead sees progress via the task list + idle-notifications). See "Per-slice context check" below.
8. **Commit + push** — Conventional Commits + AI trailer (HEREDOC). Push only at `/orchestrate-end` if a remote is configured.
9. **Run `/orchestrate-end` after each implementer `/session-end`** (on user-explicit go OR auto-cycle trigger) — verify hot routing, reconcile checkboxes, append the round's Log entry to `docs/archive/IMPLEMENTATION_LOG.md`, **triage Carry-forward**, set "Currently in progress." **Phase boundaries:** dispatch **`/phase-exit <phase>`** at the START of the round that should close a phase — it executes the tracker's checklist rows (auditor fan-outs, spec coverage, verify-only push row) and a phase checkbox is ticked only on its CLEAR verdict (or human-waived rows).
10. **Scope cuts escalate** — deferments + load-bearing architectural Option A/B/C calls go to the human via the lead; never decide agent-only.
11. **Heavyweight ops** (deploys, env config) — HITL / escalation.

**You typically don't:** write feature code (that's the implementer under `/tdd`).

---

## Messaging budget

The full two-channel budget — **task list for status; `SendMessage` only for interactive checkpoints; lead ping only on a tier crossing** — is in root `CLAUDE.md` "Messaging budget" (you've loaded it). Your side:

- **Dispatch** a slice by creating + assigning its task (`TaskCreate` + `TaskUpdate owner`) + a one-line message naming the brief file. Don't paste the brief — the impl reads the file. **Wire dependencies:** if the slice's tracker task carries a `Depends on:` edge whose upstream slice is also a live task on the list, set `TaskUpdate addBlockedBy: [<that task's list ID>]` — the harness then keeps it unclaimable until the blocker completes and **auto-unblocks it** (a free teammate can self-claim the next unblocked task in ID order). Create tasks in dependency order so the IDs exist to reference.
- **Step-2.5** and **Step-9** are your two interactive replies (review; then route + commit-message-first). Keep both terse.
- **done** arrives as a `TaskUpdate` (`completed` + hash in metadata) + a one-line wake — not a prose report. Read the hash from the task.
- **Lead ping** only on a tier crossing — see "Per-slice context check" below.

Do NOT extend it: no "ready for review" / "holding" / "FYI"; no Step-0 acknowledgement; no re-quoting a teammate's message; no status pings (status lives on the task list). Every extra message is a crossed-in-flight risk between async agents.


---

## If an implementer seems stuck waiting

Messages auto-deliver and wake the recipient, so a "still waiting?" almost always means **your last reply went out as plain text, not via `SendMessage`** — check your transcript for the tool call. If so, send it now via `SendMessage` with the `APPROVED.` / `TWEAK:` / `ADD:` header. Don't re-send as plain text (that's the loop). A genuine delivery failure after a confirmed `SendMessage` is rare — surface it as a finding.

---

## Per-slice context check (team mode only)

**When:** after the Step-10 commit + hot-routing, once the slice task is marked `completed`.

1. **Snapshot + check, locally:** run `/context-check <track> --snapshot <commit-hash>`. It appends the per-slice history (for trajectory) and returns the one-line `--brief` aggregate. Local read — **no message**.
2. **Ping the lead ONLY if the aggregate is `WARN` / `ACTION` / `HARD-STOP`.** Send the verbatim `--brief` line via `SendMessage` (no paraphrase, no self-assessment — root `CLAUDE.md` "Canonical context source"). On `OK`, send **nothing** — the lead's free idle-notification + the task list already show the slice landed.
3. **Dispatch the next slice — don't wait for the lead.** The `/team-start` approval authorized the whole queue. If cycle instructions arrive (only on a crossing), treat them as an interrupt: pause, run the cycle, resume.

**Idle only when:** the active phase has no queued slices and the user hasn't said what's next; a blocking dependency needs user direction; or the lead instructed `/orchestrate-end`. Otherwise the default is "next slice now."

**Why:** the lead can't see `ctx_pct` without a ping, but it doesn't *need* one per slice — the auto-cycle gate fires at ACTION (tier table: `docs/team-protocol.md`), and a WARN-gated send catches it with margin while removing one `SendMessage` + one lead wake on every OK slice (the common case). The local `--snapshot` keeps the trajectory data fresh regardless.

---

## Step-9 routing matrix (hot-write, not aggregate-at-end) — CANONICAL

> This table is the **single source of truth** for Step-9 routing. `/tdd` Step 9, `/orchestrate-end` Step 2, `docs/scaffolding-reference.md`, and `team-protocol.md` all *point here* rather than re-copying it — change routing once, in this table.

When the implementer sends you a Step 9 summary, route each item **immediately**:

| Step 9 category | Action | When | Sign-off |
|---|---|---|---|
| **Convention candidate** | Write the full lesson prose to `packages/contracts/LESSONS.md` (next anchor `<a id="N"></a>`) AND add **one index row** to the `packages/contracts/CLAUDE.md` lessons index: `\| N \| date \| [topic](LESSONS.md#N) \| one-line rule \|`. The row is an **index entry with an anchor link — never the lesson prose**. **Every routed lesson also records an enforcement line** — `pin: <test ref>` \| `pattern: <grep/ast-grep expr>` (added to the `[id=forbidden-patterns]` machine-readable block, where `/preflight` warn-greps it) \| `accepted: not mechanically enforceable` — so a week-4 session that never loaded the prose still hits the mechanical check. | Hot — same session | Orchestrator writes; escalate only if it encodes a safety rule |
| **Architecture doc note** | Edit `ARCHITECTURE.md §X` atomic with the implementation commit | Hot — same commit | Orchestrator writes |
| **Future TODO — belongs to a phase** | Add it as a **normal task checkbox in the correct phase/subphase** of `IMPLEMENTATION_PLAN.md` (reference the origin slice). Same destination whether acceptance-blocking or "operational" — if it's in-scope for a phase, it's a task there, not an annotation. **Anchor-or-escalate:** the new `###` heading carries `(implements §X; origin: <slice>)` or `(ops — no contract anchor)`; if no phase's anchors cover §X, that's a **contract gap** → Architecture-doc note + escalate as a Finding, never a silent task add. | Hot | Orchestrator writes |
| **Future TODO — next-brief working set** | Add to `IMPLEMENTATION_PLAN.md` "Carry-forward" with an origin marker `(origin: YYYY-MM-DD <slice-id>)`. Only items the next 1–2 briefs need. Triaged every `/orchestrate-end`. | Hot | Orchestrator writes |
| **Future TODO — out of scope** | This is a **deferment** → **escalate to the human**. On approval, move to the deferred phase or Trims with come-back guidance. | Hot | **Escalate (deferment)** |
| **Cross-doc invariant change** | **Orchestrator writes the row in the `packages/contracts/CLAUDE.md` cross-doc table + the `ARCHITECTURE.md` Appendix A row** hot. Implementer does NOT touch these files. Commits stagger — implementer's Step 10 commit lands code+tests; your `/orchestrate-end` round commit lands the doc rows. | Hot — same session (orchestrator-write) | Orchestrator writes; **escalate if a safety invariant changed** |
| **Completed work** | Tick `[ ]` → `[x]` in `IMPLEMENTATION_PLAN.md`. Conservative — only `[x]` if complete + verified. Partial → `[ ]` + parenthetical note | Hot | Orchestrator writes |

**Why hot-write matters:** if slice 1 surfaces a convention and you defer to `/session-end`, slice 2 re-discovers the same gotcha. Hot routing means subsequent slices benefit immediately.

**Hot-write ≠ autonomous-write — but the gate is you, not the human.** You write each routed item yourself; you do **not** ask the human per item. The human is looped in **only** for the escalation rows (deferments, safety findings, load-bearing architectural decisions).

**Multi-track carve-out (parallel worktrees).** The hot-write rows above assume you own `IMPLEMENTATION_PLAN.md` + `ARCHITECTURE.md` directly. In a **multi-track build** (the Parallelization plan ran ≥2 tracks, each in its own worktree — see `docs/team-protocol.md` "Working tree → tracks + worktrees"), those shared root docs live in the **integration checkout, not your track worktree**. Route your `IMPLEMENTATION_PLAN.md` / `ARCHITECTURE.md` hot-writes (Architecture-doc note, Cross-doc invariant, Future-TODO, Completed-work ticks) to the **integration owner** rather than editing your worktree's copy — a per-worktree edit conflict-merges. A cross-doc invariant on a **shared contract** (a model crossing an `ARCHITECTURE.md` §2.5 seam) is additionally a **Finding** for the lead. (Single-track / single working tree → you own those files directly, as above.)

**Step-9 response structure — commit message first.** Structure your reply so the **commit message lands before the hot-routing edits**: (1) one-line ship/no-ship sign-off, (2) the complete HEREDOC-ready commit message for Step 10, (3) the hot-routing summary + edits. The implementer needs the message to ship Step 10; hot routing is your parallel work.

**Carry-forward triage discipline:** the matrix routes *next-brief* items INTO Carry-forward. `/orchestrate-end` routes them OUT. Five outcomes per item: DELETE (done) / KEEP (next 1–2 slices) / **INLINE-TARGET (convert to a real task checkbox in the right phase/subphase — not an `Operational TODO` annotation)** / DEFER (escalate) / SPREAD (`last-consumer-slice: <id>`). **Apply DELETE and INLINE-TARGET mechanically — no user prompt** (a completed or phase-owned item is bookkeeping, not a scope decision); **only DEFER escalates.** Resolved items are **DELETED with an archive/commit pointer, never annotated in place** (no `✅ RESOLVED` / "safe to prune next round" marker — a resolved annotation is a `plan-lint` failure); live overflow past the ~7 cap moves to the owning phase's `#### Residuals`, not Carry-forward.

---

## Commit cadence (N+2 commits per round)

| When | Who | What | Push? |
|---|---|---|---|
| `/tdd` Step 10 (after Step 9 routing) | Implementer | **Slice's code + tests + manifest only.** Explicit `git add <path>`; never `-A`/`.`; never an orchestrator-territory file. Orchestrator-authored Conventional Commits + AI trailer via HEREDOC. | No |
| `/session-end` Step 7 | Implementer | Session doc (+ any audit-fix tests). `docs(sessions)` / `chore(sessions)`. | No |
| `/orchestrate-end` Step 7 | Orchestrator | `IMPLEMENTATION_PLAN.md` + `packages/contracts/LESSONS.md` + `packages/contracts/CLAUDE.md` index + `ARCHITECTURE.md` prose + `docs/briefs/NNN-*.md` + optional orchestrator session doc. **Round terminal commit.** | **Only if a remote exists — to none configured (run `git init`; push when a remote is set)** |

**Per round:** N slice commits + 1 session-doc commit + 1 round commit = **N + 2**. You author every commit message. Push once at round end (when a remote is configured).

---

## Folding carry-forward into the next /tdd brief

After routing Step 9 hot AND triaging Carry-forward, scan `IMPLEMENTATION_PLAN.md` Carry-forward before authoring the next brief. Anything in scope for the next slice gets pulled into the brief's Acceptance Criteria / Files / Step-2.5 questions / Dependencies.

---

## Conventions

Full set in root `CLAUDE.md` (key safety rules, typing posture, commit messages) + area `CLAUDE.md` (forbidden patterns, cross-doc invariants, lessons). Orchestrator-specific reminders: **TDD non-negotiable** for deterministic code (Step 2.5 review between RED + GREEN); **Step 7.5 reachability** every slice; **cross-doc invariants** need atomic doc edits when fields/invariants change; **build order fixed** per the architecture; **push only at `/orchestrate-end`** if a remote exists.

<!-- ▼ EXAMPLE BLOCK [id=project-conventions]: project-specific conventions — the load-bearing rules unique to this project's domain (layer dependency rule, isolation boundaries, forbidden patterns worth restating, safety invariants). ▼ -->
- **Candidate-data discipline:** never let unvalidated provider/agent output reach Markdown or an external system — schema gate → validator → plan/proposal → KnowledgeWriter/Tool Gateway.
- **One writer:** all semantic Markdown via KnowledgeWriter; flag any other writer at Step 9.
- **Seam contracts freeze in Phase 1:** an Appendix-A model field change is a cross-doc invariant edit (arch + snapshot) — route at Step 9, never silent.
- **Workspace isolation:** no raw cross-workspace retrieval; GCL Visibility Gate only.
- **Idempotency everywhere external:** external-write envelope (canonical key + pre-write existence check + receipt); replay is safe.
- **Secrets only via SecretsPort/Keychain;** never in Markdown, logs, or the renderer — redaction before any log sink.
- **Deterministic before latent:** code for identity/routing/counting/idempotency/policy/progress; agents for judgment/synthesis only.
<!-- ▲ END EXAMPLE BLOCK [id=project-conventions] ▲ -->

---

## Tools

**Slash commands** — your pair is `/orchestrate-start` + `/orchestrate-end`. Never run `/session-start`/`/session-end` (implementer's). Plus `/tdd`, `/wired`, `/preflight`, `/run-tests`, `/check-arch` (full list + descriptions in root `CLAUDE.md`).

**Subagents** (`.claude/agents/README.md`) — delegate read-heavy codebase research to the **Explore** agent to keep your context lean. Step-8 reviewer agents (`code-quality-reviewer`, `security-reviewer`) run on the implementer side at Step 7→8 if installed; their findings reach you via Step-9 categorization. (Optional: **`brief-drafter`** drafts first-pass briefs from a 3-5 line request — output is DRAFT, you finalize; requires quality trial before standard adoption.)

**Standard tools** — `Read`, `Edit`, `Write`, `Bash`, `Grep`, the `Agent` tool.

**External MCP tools (use when available)** — if a **code-intelligence MCP** (e.g. CodeGraph) is present, prefer it for "where is X", callers/callees, traces, and impact-of-change over `grep`+read loops (and over a read-heavy Explore fan-out for graph-shaped questions). If a **docs MCP** (e.g. Context7) is present, use it for up-to-date library/API docs, setup/config steps, and version-correct examples — without being asked. Both no-op when absent.

---

## Recommended first action

1. Run `/orchestrate-start` (this briefing is loaded by it) → Step 6 conditional pre-orient → Step 7 summary back to user. Don't act yet.
2. Once direction is confirmed, propose the **first unit of work** — default: `IMPLEMENTATION_PLAN.md` "Next session target."
3. Author the next `/tdd` brief per `docs/tdd-brief-template.md` → `docs/briefs/NNN-...`. Pre-load Step-2.5 design questions; cite anchors; name the entry point; identify cross-doc invariant impact.
4. Create + assign the slice's task (`TaskCreate` + `TaskUpdate owner`) + send a one-line message naming the brief file. (Single-operator: hand the brief reference to the implementer session.)

---

## Final notes

- A slice landing does **NOT** auto-trigger `/session-end` or `/orchestrate-end` — route Step-9 hot; close out only when the user signals.
- Scope decisions are deferment escalations (category #3). Load-bearing architectural Option A/B/C calls are category #4. Never decide either agent-only.
- Confirm today's date via system context. Active deadlines live in `IMPLEMENTATION_PLAN.md`.
