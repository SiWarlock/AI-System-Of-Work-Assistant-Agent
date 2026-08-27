# Resume prompt — paste this into a fresh session

> Self-contained by design. Everything below is either true-at-HEAD or tells you how to re-derive it.

---

You are resuming the **System of Work Assistant** build at
`/Users/dreddy/Documents/Dev/AI-tools/SoW/SoW-build` (git repo, branch `main`).

**Read `docs/team-handoffs/031-2026-08-27-autonomous-build-round-resume.md` FIRST.** It is the
authoritative resume doc. This prompt is the compressed form; 031 has the evidence.

---

## 1. Mode

Run as a **single operator driving `Workflow` fan-outs** (Sonnet 5 implementation agents, session
model for verification). **NOT agent-teams** — no `/team-start`, no orchestrator, no implementer
panes. The last round ran ~190 subagents across 14 Workflow invocations this way.

Owner directive: implementation nodes get `model: 'sonnet'`; keep adversarial verifiers on the
session model so the gate stays independent.

---

## 2. ⛔ Instruments — read before running anything

**`rtk` is a `PreToolUse` Bash hook that REWRITES your command before the shell sees it.**
This is solved, and it explains three anomalies that cost this project weeks:

| Probe | Result |
|---|---|
| `rtk git status --porcelain` | literal **`ok`** |
| `/usr/bin/git status --porcelain` | empty (the truth) |
| `rtk git log` \| `wc -l` | **50** |
| `/usr/bin/git log` \| `wc -l` | **47,143** |
| hook fed `{"command":"pnpm lint"}` | → **`rtk lint`** |

The rewrite keys on the **command string**; any flag suppresses it (`pnpm lint` rewrites,
`pnpm -w turbo lint --force` does not).

⛔ `type git` shows `/usr/bin/git` and that is TRUE — the wrap is one layer above the shell. A prior
handoff killed the "something wraps git" hypothesis on that correct evidence and drew the wrong
conclusion. **Check the hook, not the binary.**

**Rules:** `/usr/bin/git` for true git readings · branch on **EXIT CODES**, never parse rendered
output · `/opt/homebrew/bin/rg` or the Grep/Read tools, never shell `grep`/`find` (they are wrappers;
`find` silently returns empty on compound predicates) · **positive-control every empty result** and
report the control's identity, value, and that it appeared.

---

## 3. ⛔ Gate discipline — assert tree == HEAD BEFORE measuring

The last round reported "20/20 green" while HEAD carried 3 type errors, because a fix was verified
and never staged. Every gate run must first prove it is measuring the committed artifact:

```bash
/usr/bin/git diff --quiet && /usr/bin/git diff --cached --quiet \
  && [ "$(/usr/bin/git ls-files --others --exclude-standard | wc -l)" -eq 0 ] \
  && echo "tree == HEAD"

pnpm -w turbo typecheck --force     # expect 20/20, 0 errors
pnpm -w turbo lint --force          # expect 11/11  ⛔ NOT bare `pnpm lint`
pnpm -w turbo test --force          # expect 11/11 packages green
bash scripts/plan-lint.sh           # expect 0 violations
```

Paid tests sit behind `SOW_GBRAIN_LIVE=1`; a default run is **$0**.

---

## 4. State at handoff — RE-DERIVE, do not trust

- Round base tag: **`pre-autobuild-2026-08-24`** (recovery point; `git reset --hard` returns here)
- **195 commits** this round · **~535 unpushed**
- Plan: **DONE 362 · PARTIAL 50 · OPEN 23 · OWNER-GATED 18 · DEFERRED 3** (456 total)
- All gates green at handoff

⛔ **PUSH POSTURE: NEVER PUSH.** Owner-run only, at round close-out. Never `--amend`.
⛔ **NOTHING IS ARMED, and nothing arms without an explicit owner confirmation per crossing.**

---

## 5. First moves, in order

1. **Re-measure §4.** Derive every count (`/usr/bin/git rev-list --count pre-autobuild-2026-08-24..HEAD`).

2. ⛔ **THE PHASE-25 SCHEDULES ARE REGISTERED BUT INERT — this is the top real gap.**
   `25.2`/`25.3`/`25.4`/`25.5` each emit `action.args: []`, which the source itself calls a
   placeholder: *"not a functioning daily brief"*. They were reported as landed and are not.
   A registered schedule that runs nothing is not a schedule. **Start here.**

3. **Resolve the foreign-repo edit.** `/Users/dreddy/gbrain/src/core/ai/gateway.ts:25` carries an
   uncommitted `getRecipe` import with no consumer (an edit blocked mid-change by the permission
   classifier, which forbids writes outside this project's cwd). **Either** revert
   (`git checkout -- src/core/ai/gateway.ts`) **or** complete it — handoff 031 §6 has the function.
   ⇒ It blocks `12.7` GO#3's live injection, and any NEW PGLite brain is built `vector(1536)` and
   permanently disagrees with its own provider until fixed.

4. **Three more held back by the final reconcile** (they did not meet their Done-when):
   `24.1` (the lock is an acquisition, not the *physical write block* the criterion demands),
   `24.69` (no artifact in the tree), `24.101` (85 census candidates undispositioned).

5. **Owner-gated work** — read `docs/runbooks/owner-arming-inventory.md` before any crossing.

---

## 6. Arming — 18 tasks, 7 ledgers, order is load-bearing

**Sequential chain:** `§ARM-17` (Keychain) → `§ARM-GBRAIN` (7 steps; gates `20.1`–`20.4`,
`22.2`–`22.4`, `11.7`) → `§ARM-21` (gates `21.5`–`21.9`) → `§ARM-REBUILD`.
**Independent arcs:** `§ARM-23` (gates `23.1`, `23.2`, `23.7`, `23.8`) · `§ARM-RESEARCH` (gates
`26.1`, `26.2`, `13.14`). `§ARM-18` is partly executed.

⛔⛔ **Crossing 3 (reconcile) MUST precede crossing 4 (serving oracle).** Phase 4 turns on the
mechanism that declares facts TRUSTED — and trusted is what unlocks the write/propose path. Phase 5
is the mechanism that VERIFIES those facts match canonical Markdown. Arming 4 first means an
unverified fact can become an approved write into the vault. The runbook's *section* order
contradicts its own dependency order; task `24.28` added ⛔⛔ STOP blocks at both entry points rather
than reordering ~1,300 cross-referenced lines.

**Cheap/local:** `§ARM-17`. **Genuinely consequential:** `§ARM-21` (first irreversible external
write) and `§ARM-RESEARCH` (paid key).

---

## 7. The seven safety invariants (root `CLAUDE.md` — do not paraphrase)

1. **One writer** — KnowledgeWriter is the ONLY autonomous writer of canonical Markdown.
2. **Candidate-data gate** — model output is candidate data until it passes the JSON-Schema gate +
   validator. No side effect before validation. Never invent owners/dates; emit `TBD`.
3. **External-write envelope** — idempotency key + canonical object key + pre-write existence check +
   write receipt; replay reuses the receipt ⇒ zero duplicate external writes.
4. **Workspace isolation** — no raw cross-workspace retrieval; the GCL Visibility Gate is the only
   cross-workspace read path.
5. **Employer-Work egress veto** — raw employer content with ack OFF goes only to a local zero-egress
   provider, else fail closed. Never a cloud fallback.
6. **Untrusted-content tool-stripping (ING-7)** — agents consuming untrusted content run read-only.
7. **Secrets** — only via SecretsPort/Keychain; redaction strips secrets, raw content and prompts
   before any log sink.

---

## 8. ⭐ Behavioural rules the last round paid for

- **The plan's `remaining:` clauses ROT.** EIGHT tasks last round had already shipped while their
  clauses said otherwise; three sat OPEN for up to two weeks while fully satisfied in code.
  **Verify at source before building.**
- **A commit naming a task id is a POINTER, not evidence.** `24.50` is cited by six commits, five of
  which are consumers adopting its type change.
- **Never weaken a test to go green.** If an existing assertion must change, state why the OLD one
  was wrong. Mutation-prove new assertions by mutating production code so THAT assertion alone fails
  (vitest aborts at the first failure, so a mutation over a multi-assertion block proves one).
- **Check dispositions against each task's own Done-when.** That control caught "registered" being
  sold as "running" last round (§5.2).
- **Owner pushback has twice been right against my recommendation** — `replayed` (deleting it would
  have removed the sole proof of a safety-rule-3 invariant, with every test green) and the
  provider-secrets seam (it already existed). **Dig before deleting; research before deferring.**
- **Availability policy** (recorded on `24.130`): any new refusal added to the sole-writer path must
  MEASURE the rejection rate before and after and report both. Refusing to write is not a safe
  default on a knowledge system — it is the product failing quietly.

---

## 9. What is genuinely out of reach

- `24.4` signing — Apple Developer ID cert. **V1.1 by resolved decision (OQ-001); NOT a V1 gap.**
- `23.7` — live vendor APIs + provisioned credentials (`§ARM-23`).
- `13.4` — a live read-scoped Obsidian MCP endpoint per workspace vault.
- `24.106` — owner must choose: re-key migration vs compatibility read path.
- `24.118` — **HELD by lead ruling; backup lives outside the repo; precondition measured FALSE.
  Never tick it.**
- `24.6` — an audit PARTITION dispatch, not an implementable slice.

---

## 10. Running the app

```bash
pnpm install
./dev.sh     # Electron dev; loads repo-root .env via the SOW_* allowlist (never a blanket source)
```

`gbrain` 0.35.1.0 is installed and matches `config/gbrain.pin`'s tag. The owner's live brain is
healthy (`embedding_provider ✓ voyage:voyage-code-3, 1024 dims, DB aligned`) after adding
`"embedding_dimensions": 1024` to `~/.gbrain/config.json`.
