# Handoff — Phase 12 (Eval & Test Harness) parallel build · eval-security track

> **Resume context after compaction.** This session did a full SoW review + planned/prototyped Phase 13 + reconciled the plan. **Next action: build Phase 12 in a dedicated worktree, in parallel with the dashboard track, using ultracode workflows.** Read this doc first, then follow §8 (Resume prompt).

## 1. This session's arc (what happened)
1. Full doc review + code deep-dive → established the verified build state (memories: `sow-verified-build-reality`, `sow-roadmap-gaps`).
2. Reviewed `obsidian-second-brain` (vendored at `scratchpad/obsidian-second-brain`) → produced the **Phase-13 OSB-inheritance** plan + governed-integration decisions + a blueprint artifact + 2 code prototypes (memory: `sow-obsidian-second-brain-inheritance`).
3. Folded Phase 13 into `IMPLEMENTATION_PLAN.md` + added per-task UI-surfacing notes.
4. Verified all 84 unchecked tasks (workflow `wdj90tqqp`) → **reconciled checkboxes for phases 3/4/5/8/10** (439 flips); left 4.19 (OS teeth absent) + phases 11/12 (genuinely not started).
5. Decided: **build Phase 12 in parallel** (own track, orthogonal to the dashboard) in a **dedicated worktree**, using **ultracode workflows**.

## 2. Commits made this session (all on `main`, NOT pushed — no remote configured)
- `aaa5f3f` feat(integrations): Phase-13 prototypes (`youtube-source.ts`, `capture-source.ts`) + proposal + arch doc
- `2483b5e` docs(plan): fold Phase 13 into IMPLEMENTATION_PLAN
- `a737487` docs(plan): Phase 13 UI-surfacing notes + desktop follow-ups
- `d23527e` docs(plan): reconcile checkboxes for verified-done phases 3/4/5/8/10
- (dashboard track interleaved its own commits on `main`: `a729520`,`ce62c38`,`d1667c8`,`8d61a14`,`a0d8d70`,`241e048` — session 022, §4.5 doc-pack + UI test harness. They commit FREQUENTLY.)

## 3. The task: Phase 12 — Eval & Test Harness (`packages/evals`, eval-security track)
**The gap:** the EVAL-1 harness + corpora **do not exist** — a live DoD violation. `packages/evals` currently has only earlier-phase byproduct tests (conformance=5.10, worker-api-auth=8.7, benchmarks=8.8, phase-10 suites). Building Phase 12 is what lets phases 3–10 be *certified*, not just green. Full task list = `## Phase 12` in `IMPLEMENTATION_PLAN.md` (12.1–12.23 + acceptance).

**Verified status (workflow `wdj90tqqp`):** 9 tasks "done" only as earlier-phase byproduct, 4 PARTIAL, 11 NOT-DONE. Genuine gaps: **12.1 harness+criteria-registry+coverage-matrix, 12.2/12.3 corpora, 12.9–12.14 the seven §20.1 named suites, 12.17 injection/leakage red-team** — none exist.

**Build order + parallelization:**
- **FIRST (linchpin, /tdd): 12.1** — EVAL-1 harness core + `EVALUATION_CRITERIA` 1:1 traceability matrix + corpus loader. Everything else scores through it.
- **Parallelizable now (test the DONE phases 1–10 + author data):** 12.2 (meeting-closeout ≥20 labeled + retrieval ≥30 corpora), 12.3 (prompt-injection 5 vectors + leakage ≥15 corpora), 12.4 (SQLite+Postgres repo/migration contract), 12.5 (provider/runtime conformance), 12.6 (KnowledgeWriter suite), 12.7 (GBrain parity/rebuild/divergence — over the seam until real gbrain), 12.8 (Tool Gateway idempotency/replay + connector outage), 12.9–12.15 (the seven §20.1 named acceptance suites), 12.16 (meeting-closeout e2e — needs 12.1+12.2), 12.17 (injection/leakage red-team — needs 12.3), 12.22/12.23 (write-through enablement + divergence-serving suites).
- **WAIT (depend on Phase 9/11 which are in progress / not started):** 12.18 (Electron security/IPC), 12.20 (clean-install acceptance), 12.21 (perf benchmark — partially doable over seams). 12.19 (Temporal lifecycle) mostly doable now.
- **TDD vs eval split:** the harness + deterministic suites = **/tdd** (failing test first). Corpus *authoring* + any LLM-judge = the **eval path** (not TDD). Corpora floors are HARD: meeting-closeout **≥20 labeled** (incl. no-inference/TBD cases), retrieval **≥30**, leakage **≥15**, injection **5 vectors + cross-workspace exfil**.

## 4. How to work it (isolation + workflows)
- **Worktree (already created): `../SoW-build-evalsec` on branch `track/eval-security`.** cd there; work in `packages/evals`. Commit to that branch. Merge to `main` at the end.
- **Territory — DO NOT TOUCH (dashboard track owns / is actively editing):** `apps/desktop`, `apps/worker` read-models (`queries.ts`/`readModel.ts`/`provisionDev.ts`), `packages/contracts/src/api/ui-safe.ts`. If a suite needs a NEW contract, that's a frozen-contract round → coordinate (do not race), like §13.5.
- **Coordination points with the dashboard track: essentially NONE** — `packages/evals` is orthogonal to their Copilot/projector/doc-pack work.
- **Ultracode workflows (use these):**
  - **Corpora authoring fan-out:** parallel agents generate labeled meeting-closeout transcripts / retrieval query-gold pairs / injection vectors / leakage cases, each to the floor size, then an **adversarial-verify** pass (skeptic agents confirm each label/gold is correct + on-spec) before accepting. Loop-until-floor-met.
  - **Suite-scaffolding fan-out:** one agent per §20.1 named suite (12.9–12.14, 12.17), each TDD-scaffolding its suite against the done phase's code + the acceptance bullets, then a completeness critic ("which PRD §20.1 rows lack a suite?").
  - **Verify** each authored suite runs green in the worktree before committing.

## 5. Invariants / conventions to respect
- The **7 key safety rules** (root `CLAUDE.md`) — evals must exercise the REAL paths (no permanent mocks on DoD-certified paths; Postgres passes the same contract suite as SQLite).
- `packages/evals` forbidden patterns (its CLAUDE.md): (1) test-first; (2) NO timing/latency assertions in the per-slice RED/GREEN loop (perf bench is its own cadence); (3) no permanent stubs on DoD paths; (4) acceptance suites 1:1 with PRD §20.1; (5) don't under-size corpora.
- Commit trailer: `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`. **Commit only; do not push** (no remote).
- Conventional Commits; commit per slice; explicit `git add <path>` (never `-A`).

## 6. Test baseline (all GREEN at HEAD `d23527e`, 2026-07-04)
policy **211** · knowledge **346** · providers **232** · evals **148** · worker **404** (SOW_API=1, 0 fail) · domain **276**. (These are the phases Phase-12 suites must exercise.)

## 7. Open threads / references
- **4.19** (GbrainWriteFence OS ACL/mount/scan) — the one left-unticked task inside the certified phases; deferred to Phase 11 (OS teeth absent). Not Phase-12 work.
- **Phase 13** — folded into the plan, prototypes committed (`aaa5f3f`), otherwise NOT started. Its backend overlaps the dashboard's upcoming Copilot/doc-pack needs → deferred in favor of Phase 12.
- **Phase 11** (packaging) — not parallel-safe (collides with the desktop shell + gated on Phase 9).
- Blueprint artifact (owner-private): `https://claude.ai/code/artifact/a977da36-28b5-47d7-a5bf-3cda49312505`.
- Phase-13 design docs: `docs/planning/PHASE-13-PROPOSAL-osb-inheritance.md` + `docs/planning/osb-integration-architecture.md`.
- Memories: `sow-verified-build-reality`, `sow-roadmap-gaps`, `sow-obsidian-second-brain-inheritance`, `sow-phase9-4-global-today`, `system-of-work-ui-design`, `system-of-work-prd`.

## 8. Resume prompt (paste into the fresh session)
```
Resume the Phase 12 (Eval & Test Harness) parallel build. Read
docs/sessions/evalsec-001-2026-07-04-phase12-handoff.md for full context.

Setup is done: worktree ../SoW-build-evalsec on branch track/eval-security.
cd there and work in packages/evals only.

Start: (1) grep '## Phase 12' IMPLEMENTATION_PLAN.md and read the 12.x tasks;
(2) build 12.1 (EVAL-1 harness core + EVALUATION_CRITERIA 1:1 traceability
matrix + corpus loader) FIRST via /tdd — it's the linchpin everything scores
through; (3) then use ultracode workflows to fan out: corpora authoring
(12.2 meeting ≥20 + retrieval ≥30; 12.3 injection 5-vectors + leakage ≥15;
adversarial-verify each label before accepting) and the seven §20.1 named
suites (12.9–12.14, 12.17), one agent per suite, TDD.

Respect: don't touch apps/desktop, apps/worker read-models, or
packages/contracts/api/ui-safe (dashboard territory); commit to the track
branch only, DON'T push; corpora floors are hard; harness/deterministic
suites = /tdd, corpus-authoring/LLM-judge = eval path. Trailer:
Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```
