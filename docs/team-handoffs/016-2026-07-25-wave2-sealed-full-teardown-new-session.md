# Team Handoff 016 — Wave-2 round SEALED + full team teardown → fresh agent-teams session

**Date:** 2026-07-25 · **Track:** single-track `main` (no worktree — root checkout)
**Predecessor handoff:** `015-2026-07-25-remaining-build-order-wave2-lead-compaction.md`
**Successor handoff:** _(next `/team-end`)_
**HEAD at handoff:** `f5cd300c` · **origin/main:** `f5cd300c` (IN SYNC — everything pushed) · **ahead:** 0

> **⭐ READ THIS FIRST, then `docs/planning/remaining-build-order.md` (the 8-arc plan) + `IMPLEMENTATION_PLAN.md` "Currently in progress" + task #31 (the orch's deferred-doc inventory) + `docs/team-protocol.md` (lead playbook — NOT auto-loaded).**

## Why this handoff exists
Owner-directed **full teardown to start a whole NEW agent-teams session** (not a cycle-in-place). The entire Wave-2 round is sealed, committed, and **pushed to origin**. All 7 sessions (orch + 6 impls) are `/session-end`/`/orchestrate-end`-closed and shut down. The next session's lead runs `/team-start main`, reads this doc, and re-spawns the team from the prompts at the bottom.

## Where we are — one-paragraph state
The **owner-authorized rule-5 employer-egress FLIP is EXECUTED** (`bcde3d61`: employer_work default-seeded `[claude]`-scoped cloud egress, ack=true, provisioning-time only; the fail-safe **REVOKE** command shipped too — `225c10ca`). The **⭐ ARC-4 living-vault keystone chain 13.8a→b→c→d is COMPLETE** (EntityResolver → LinkHealer → confined synthesis planner → ingest-rewrite + structural-file parity — the OSB-parity/smart-vault core). Phase-9 is nearly done (9.9/9.10/9.12/9.14 landed). All frozen contracts, retrieval, and most dormant machinery + eval suites are in. **Everything is committed + pushed; the working tree is clean.** Remaining headline work: keystone legs **13.8f (meeting) + 13.8g (attendee→person) + the 13.8d worker-binding**, **9.10-C** (desktop egress-settings surface), and the **#31 doc-completion** (arch-notes + ~9 lessons + runbook mirror).

## Arc status (owner-approved 8-arc REMAINING-BUILD-ORDER)
| Arc | Status | Detail |
|---|---|---|
| ARC-0 integrity | ✅ DONE | 7.19 retention · 11.2 schema-refusal |
| ARC-1 Phase-9 → /phase-exit 9 | 🔶 ~DONE | 9.9a/b · 9.10-A/B · 9.12r/A1 · 9.14 all landed. **Remaining: 9.10-C egress-settings surface (desktop), any 9.8/9.5 follow-ups, then the FIRST `/phase-exit 9`.** |
| ARC-2 frozen contracts | ✅ DONE | 13.15 Task+priority+TaskRepository+FailureClass (#15) · ProviderId (#26) · UiSafe types (#21) · UiSafeTaskRollup (#37) |
| ARC-3 retrieval | ✅ DONE | 13.3a local-embed · 13.3b eval harness · 13.17 re-ranker |
| ⭐ ARC-4 keystone | 🔶 CORE DONE | **13.8a→b→c→d COMPLETE** + 13.16 producer+renderer + 13.8c-eval. **Remaining: 13.8f meeting-path · 13.8g attendee→person · 13.8d worker-binding (wire `rewriteVaultForSource`→`runSourceIngestion` + realpath containment (⚠ CORRECTED 2026-07-26: the "L17" citation here was WRONG — worker L17 is coverage-leg seams. The containment primitive is `apps/worker/src/api/procedures/copilotVaultRead.ts:104` — realpath BOTH target and root, re-check on the REAL paths; desktop L16 `guardVaultPath` is the pure analog)).** |
| ARC-5 dormant machinery | 🔶 | 21.1/2 logic+binding · 13.13/13.13-provider · 21.10-core credential seam · 13.2a web transport (real-fetch=§ARM-23) · todoist+telegram READ connectors (#48/#49) · 12.20 doctor-prereqs (PARTIAL, e2e=it.todo). **Remaining: 13.2 more extractors · 25.x output-workflows · connector arming (owner-gated).** |
| ARC-6 eval suites | 🔶 | 12.16 · 12.18 · 12.20(partial) · 13.3b · 13.13r · 13.8c-eval · #55 (L12+egressCommand). **@sow/evals gate GREEN.** Remaining: more §20.1 suites · 12.20 e2e. |
| ARC-7 hardening (Phase 24) + phase-exits | ⬜ LATER | after the above |

## Team composition at close (all shut down, clean)
Single-track `main`, `<area>-implementer` naming. Each self-committed its session doc:
| Role | Session doc | Key commits this round |
|---|---|---|
| orch (`main-orchestrator`) | seal 34e7e02d | Round sealed `225c10ca`+`34e7e02d`; #27 closed; #31 = deferred-doc inventory |
| worker (`worker-implementer`) | 113 `fb2751f7` | ⛔#39 FLIP `bcde3d61` · #28 9.9a `8b4e3537` · #29 21.1/2-binding `ed9faa26` · #47 13.16 producer `0e6e1662` · ⚠#53 9.10-B REVOKE `225c10ca` |
| knowledge (`knowledge-implementer`) | 114 `c4286bf8` | ⭐#40 13.8b `262df7b8` · #44 13.8c `461a0186` · #51 13.8d `04e01eed`+`3d2d24f9` |
| desktop (`desktop-implementer-2`) | 114 `14db7885` | 9.14 `25029a76` · 9.12r `b95aa3cf` · 9.12-A1 `0f20c3bb` · 9.9b `f9d86536` · #50 13.16 renderer `985c1dda` |
| provint (`provint-implementer`) | 112 `d16ad81c` | #23 `07145feb` · #34 `4a3ea13e`+`727f3bd2` · #41 21.10-core `e023f682` · #45 13.2a `3c501687` · #48 todoist `6facc356` · #49 telegram `15a90ed4` |
| evalsec (`evalsec-implementer`) | 116 `f5cd300c` | 12.16 · 12.18 · 12.20 `6b38f022` · 13.3b · 13.13r `1aaa575a` · 13.8c-eval `a34de8e1` · #55 `2c5ac552`+`3a881899` |
| contract (`contract-implementer`) | 115 `f1a37665` | #15 `54b052a7` · #21 `28dd42ba` · #26 `50b302b0` · #37 `41e0dcca` |

**In-flight at close: NONE.** Working tree clean; `@sow/evals` gate GREEN; all packages green at their last preflight.

## Next-legs (the un-pause dispatch list, per area)
- **worker:** ⭐ **13.8d worker-binding** (wire `rewriteVaultForSource`→`runSourceIngestion` + realpath containment, Lesson 17) · **#54** re-point `workflows/noteSlug.ts neutralizeRegionMarkers`→re-export from `@sow/knowledge` (canonical def now landed in #51) · any 9.10-C-producer follow-ons.
- **desktop:** **9.10-C egress-settings surface** — consumes worker #53's revoke (`225c10ca`); shows per-workspace egress status + revoke/re-ack. (Then desktop can drive `/phase-exit 9`.)
- **knowledge:** ⭐ **13.8f meeting-path · 13.8g attendee→person** — completes the keystone chain.
- **provint:** ARC-5 continuation — 13.2 more extractors · 25.x output-workflows · connector-arming prep.
- **evalsec:** ARC-6 continuation — more §20.1 suites · 12.20 e2e (currently it.todo) · the deferred **backtick-import-specifier upgrade** (non-idiomatic `import(\`@sow/knowledge\`)` keyword-anchored guard; runtime one-writer backstops it).
- **contract:** candidate **13.5 typed Project** frozen-contract · any 13.8f/g contract needs · the `living_vault_synthesis` provenanceOrigin decision.

## #31 = the authoritative un-pause DOC-COMPLETION task (do this FIRST next session)
The orch banked the round under context pressure and **honestly deferred** the doc-heavy items to task #31 (durable). The fresh orch's first `/orchestrate-end`-adjacent pass completes them:
- **Arch notes** → `ARCHITECTURE.md`: §6 KN-10 tiered-autonomy stance + symmetric-allowlist confinement · §6 KN-12 structural-parity · §8 connectors + pathAuth mode · §5/§16 egress-revoke.
- **~9 multi-track lesson candidates** → the per-area `LESSONS.md` files.
- **#27 gmail/granola read-only attestations** → the **24.5 arming runbook** mirror. (The attestations THEMSELVES are already recorded in `IMPLEMENTATION_PLAN.md` §21.3 — this is the runbook copy.)
- The **backtick-import upgrade** (evalsec, above).
These are documentation completion, not lost code — all code is committed + green.

## Owner-gated crossings / pending decisions (bring to owner)
1. **Employer-egress FLIP = EXECUTED** (`bcde3d61`). ⚠ Standing residual: employer egresses under whatever `claude` login is ACTIVE — "company-sanctioned" holds **only while the COMPANY login is active**; there is NO re-confirm on a login switch. If the owner switches back to a personal login, employer content would ride the personal account → re-confirm before relying on it. See memory `[[employer-egress-company-subscription]]`.
2. **Per-workspace subscription/credential SPLIT** — NEW planned scope, dormant. The clean end-state (employer→company sub, personal→personal sub) that removes the single-login interim. Owner-gated.
3. **§ARM-23** — real web fetch arming for 13.2a (currently dormant/faked transport). Owner-gated.
4. **§ARM-RESEARCH / §ARM-21** residuals · **telegram/todoist connector arming** (both dormant/owner-gated, ING-7 + candidate-gate on ingest).
5. **9.10-C** egress-settings surface + owner-gated re-ACK + 9.10-D audit-link (desktop follow-ons).

## Standing rules (enforce these next session)
- **Producer-first** — a cross-area vertical splits into producer (worker) → renderer (desktop), producer lands first. **No cross-track single-implementer vertical slices** (territory-guard blocks cross-area writes + two impls in one area = single-tree collision).
- **Composition-root touches = WORKER** — build LOGIC in the owning package, WIRE at boot by worker (logic-in-package, wire-at-boot).
- **Safety/rule-5 commits route Step-9 → the LEAD** (e.g. the flip #39, the revoke #53 both gated at the lead). security-reviewer=invariant on those.
- **Push = round-close-out only** (`/orchestrate-end`); the auto-mode classifier blocks agent pushes → the **owner runs `git push origin main`** at seals.

## ⚠ CORRECTED SHUTDOWN DISCIPLINE (hard-won this session — see memory `[[cycle-terminate-drained-teammate]]`)
- **NEVER `shutdown_request` without close-out first** — impl runs `/session-end`, orch runs `/orchestrate-end`, THEN shutdown. The only exception is a **probe-confirmed-dead** session (orphaned).
- **Heartbeat "stale" ≠ dead.** `check-team-context` lags badly (Agent-tool sessions render their status line only sporadically, sometimes >30 min apart), so a live teammate reads as "stale." **Confirm liveness by a reachability PROBE** (a benign `SendMessage`: `success:false "not reachable"` = dead), NEVER by heartbeat. This session the lead twice misread stale heartbeats as death and sent shutdowns to LIVE sessions — retracted 2/3, but one round killed knowledge+worker (respawned cleanly). Do not repeat.
- **`shutdown_approved` (structured) is conclusive** — spawn the successor / proceed immediately; don't over-wait for the system `teammate_terminated` (often never fires for the orch).

## Context-monitoring reality
- The canonical `check-team-context.sh` (heartbeats) is **unreliable for on-demand liveness/ctx** — render-lag. The **owner reading %s directly from the panes was the reliable signal all session.** The deeper fix (write the heartbeat from a per-turn Stop/PostToolUse hook, decoupled from status-line render) is a **tracked follow-up → the scaffolding repo** `templates/scripts/` (same as the spec-lint `[~]` port, task #19).
- Tiers: WARN 70 / ACTION 75 / HARD-STOP 80.

## Rough-round history (context for the fresh lead — why this was a hard round)
- **Two account-wide usage-limit hits** (~16:44 UTC, ~00:57 UTC). Sessions showed `idleReason: failed "session limit"` then **auto-recovered after the reset** (they weren't terminated — they resumed on their next turn). Don't treat a limit-`failed` teammate as dead until a probe confirms it.
- **evalsec overflowed twice** ("Prompt is too long") at ~93% mid-close-out → **owner compacted it → it recovered at 9% + committed #55 + `/session-end` cleanly.** Compaction-to-recover is a valid move for an overflowed impl with WIP.
- **Commit-race:** `225c10ca` is a MIXED commit (worker #53 feat + orch routing docs) from a concurrent-commit race — imperfect hygiene, all content verified durable + plan-lint green; not rebased (risky mid-instability). Noted, not a defect.

## Pending non-arc tasks
- **#19** — port the spec-lint `[~]` PARTIAL-task fix to the **scaffolding repo** `templates/` (owner directive: tooling fixes → scaffolding, not silent in-target).
- **#31** — the doc-completion above.
- **#54** — worker noteSlug re-point (above).
- (context-monitoring per-turn-hook fix → scaffolding, above.)

---

## Spawn prompts for the next team session (the load-bearing handoff content)

> Lead: after `/team-start main`, spawn the orchestrator first, then implementers as their next-leg work begins (worker + knowledge + desktop are the immediate three; provint/evalsec/contract as ARC-5/6/contract work resumes). Each teammate's FIRST action is the `team-register.sh` line, then the start command.

### Orchestrator
```
You are main-orchestrator on the System of Work Assistant agent team.
Track: main (single-track — repo root, NOT a worktree). Track label: main. All commits land on `main`. Confirm a teammate's name before any peer send.
Activated because: fresh team session resuming from handoff 016 (Wave-2 sealed + pushed at f5cd300c). Re-derive state from IMPLEMENTATION_PLAN.md "Currently in progress" + task #31 + git log. FIRST substantive pass: complete task #31 (deferred arch-notes §6/§8/§5-16 + ~9 lessons + #27 gmail/granola 24.5-runbook mirror + backtick-import upgrade). Then dispatch the next-legs: worker 13.8d-binding + #54; knowledge 13.8f + 13.8g (keystone completion); desktop 9.10-C → then /phase-exit 9; provint ARC-5; evalsec ARC-6.
Standing rules: producer-first; composition-root=worker; no cross-track single-impl verticals; safety/rule-5 commits Step-9→LEAD; push=owner-run at seals. Employer-egress FLIP (bcde3d61) is EXECUTED — do NOT re-open. Owner gates (subscription-split, §ARM-23, connector arming) stay owner-gated — surface via lead.

FIRST ACTION — register: ~/.claude/scripts/team-register.sh "main-orchestrator" orchestrator "main" "" "main" "main"
Then run /orchestrate-start (NOT /session-start).
Confirm in your first reply: (1) start command, (2) registry written, (3) re-derived state summary + first dispatch.
```

### Implementer — worker (`apps/worker/`)
```
You are worker-implementer on the System of Work Assistant agent team.
Track: main (single-track — repo root). Track label: main. cwd: apps/worker/. All commits land on `main`. Talk only to main-orchestrator.
Activated because: fresh session from handoff 016. Next legs: ⭐13.8d worker-binding (wire rewriteVaultForSource→runSourceIngestion + realpath containment L17) · #54 re-point workflows/noteSlug.ts neutralizeRegionMarkers→re-export from @sow/knowledge (canonical def landed in #51). Composition-root=worker (logic-in-package, wire-at-boot). Safety/rule-5 slices Step-9→lead.
FIRST ACTION — register: ~/.claude/scripts/team-register.sh "worker-implementer" implementer "main" "worker" "main" "main"
Then run /session-start. Confirm: start command, registry written, next-leg understood.
```

### Implementer — knowledge (`packages/knowledge/`)
```
You are knowledge-implementer on the System of Work Assistant agent team.
Track: main (single-track — repo root). Track label: main. cwd: packages/knowledge/. All commits land on `main`. Talk only to main-orchestrator.
Activated because: fresh session from handoff 016. ⭐ Complete the ARC-4 keystone chain: 13.8f meeting-path + 13.8g attendee→person (13.8a→d already COMPLETE). Pure/dormant over faked ports; WS-8 resolve-or-stub, never fabricate; security-reviewer=invariant on safety slices.
FIRST ACTION — register: ~/.claude/scripts/team-register.sh "knowledge-implementer" implementer "main" "knowledge" "main" "main"
Then run /session-start. Confirm: start command, registry written, next-leg understood.
```

### Implementer — desktop (`apps/desktop/`)
```
You are desktop-implementer on the System of Work Assistant agent team.
Track: main (single-track — repo root). Track label: main. cwd: apps/desktop/. All commits land on `main`. Talk only to main-orchestrator.
Activated because: fresh session from handoff 016. Next leg: 9.10-C egress-settings surface (consumes worker #53 revoke 225c10ca — per-workspace egress status + revoke/re-ack). Then desktop drives /phase-exit 9. Renderer NEVER mutates policy locally — only via the authed worker command. Run `pnpm build:sow` before preflight (desktop dist).
FIRST ACTION — register: ~/.claude/scripts/team-register.sh "desktop-implementer" implementer "main" "desktop" "main" "main"
Then run /session-start. Confirm: start command, registry written, next-leg understood.
```

### Implementers — provint / evalsec / contract (spawn as their work resumes)
```
provint (packages/providers/, owns providers+policy+integrations): ARC-5 — 13.2 extractors · 25.x output-workflows · connector-arming prep. register: team-register.sh "provint-implementer" implementer "main" "providers" "main" "main"
evalsec (packages/evals/): ARC-6 — more §20.1 suites · 12.20 e2e · backtick-import upgrade. register: team-register.sh "evalsec-implementer" implementer "main" "evals" "main" "main"
contract (packages/contracts/, owns contracts+domain): 13.5 typed Project · 13.8f/g contract needs · living_vault_synthesis provenanceOrigin. register: team-register.sh "contract-implementer" implementer "main" "contracts" "main" "main"
(each: then /session-start)
```

## How to resume
New session: lead runs **`/team-start main`**, reads THIS doc + `IMPLEMENTATION_PLAN.md` "Currently in progress" + task #31, spawns the orchestrator + worker/knowledge/desktop from the prompts above (others as work resumes), verifies read-backs. First arc goal: **complete #31 doc-debt**, then **finish the keystone (13.8f/g + binding)** and **close Phase-9 (9.10-C → /phase-exit 9)**. Everything is pushed at `f5cd300c` — this doc IS the orient.
