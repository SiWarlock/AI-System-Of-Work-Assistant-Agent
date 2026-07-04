# Session evalsec-002 — Phase 12 EVAL-1 harness + corpora + §20.1 acceptance suites

**Track:** eval-security (worktree `../SoW-build-evalsec`, branch `track/eval-security`).
**Date:** 2026-07-04. **Predecessor:** `evalsec-001-2026-07-04-phase12-handoff.md`.
**Baseline at start:** `1044de5`. **State:** 4 commits, tree clean, **349 evals tests green**, `tsc --noEmit` clean.

## What landed (commits on `track/eval-security`, NOT pushed — no remote)

| Commit | Task | Deliverable |
|---|---|---|
| `e51988c` | **12.1** | EVAL-1 harness core — `src/harness/{criteria-registry,runner,corpus-loader,corpus-schemas}.ts` + `EVALUATION_CRITERIA.md` + `test/coverage-matrix.test.ts` (28). The registry maps all **19 PRD §20.1** tests 1:1 → suite/threshold (+ §5.4 metrics + §20.2 DoD gates); runner scores against explicit thresholds with **DoD honesty** (mock-backed real-required criterion ⇒ `dodPass=false`); loader rejects unversioned/hash-mismatched/below-floor corpora. |
| `828c031` | **12.2/12.3** | Versioned, content-hashed corpora to the hard floors: meeting-closeout **23** (12 no-inference/TBD), retrieval **35**, injection **6** (5 §16.1 vectors + cross-workspace exfil), leakage **16**. `scripts/stamp-corpora.mjs` re-stamps; `test/corpora/corpora-floors.test.ts` (10) loads each through the real loader + pins TBD⟺clarification, vector coverage, 0-leak. |
| `ccdfbc7` | **12.14** | egress-ack §20.1 suite (11) — real broker `vetoJobEgress` seam; OFF fails closed (no cloud fallback), ON permits, OpenRouter own processor; **honest DoD scoring** (seam run ⇒ `dodPass=false`). Added `suites/` to vitest + tsconfig includes. |
| `1377973` | **12.9-12.13, 12.15, 12.17** | Seven §20.1 acceptance suites over real done-phase code (152 tests): calendar-conflict (15), project-progress (18), deletion+prune (12+7), budget-cap (8), hermes-standalone (11), system-health (11), injection (18) + leakage (52). Authored via build+verify fan-out; all rated *solid*. |

### How it was built
- **12.1 + 12.14** built inline via TDD/direct (12.14 was the reference exemplar).
- **12.2/12.3 corpora** — workflow `eval1-corpora-authoring` (10 author + 10 skeptic-verify agents; one cross_workspace_exfil vector was authored inline after the verifier correctly dropped a weak one).
- **The 7 suites** — workflow `eval1-acceptance-suites` (7 build @high + 7 verify @medium). Post-merge, fixed 2 fake-port typecheck errors (`makeDeps` param loosened to accept fakes; `fakeAgentRejected` return cast; a `HealthItem`→`Record` cast). Agents run vitest (esbuild) so full-package `tsc` is the merge gate — **always run it after a suite fan-out.**

## §20.1 criteria status (from the 12.1 registry)

**Suite BUILT + green (10 of 19):** Cross-calendar scheduling, Project progress, Prompt injection, Workspace leakage, Retention purge, Budget cap, System Health surfacing, Hermes standalone, Egress acknowledgment, Evaluation set (the coverage-matrix meta-test itself).

**Suite NOT yet built (registered, pending):** Meeting closeout replay, Workspace routing, Knowledge write (→ 12.16 meeting-closeout e2e, real-integration), Approval flow (no dedicated suite yet), Open-source install (→ 12.20, Phase-11-gated), Sleep-through-brief & resume (→ 12.19 lifecycle, mostly doable now), Retrieval relevance (→ real gbrain), GBrain parity (→ 12.7, real gbrain), Human-section preservation (→ 12.6, packages/knowledge).

## Remaining Phase-12 tasks + guidance for the next session

- **Clean & non-colliding (do next, in `packages/evals`):**
  - **12.19** Temporal sleep/wake/restart + worker-supervision → `suites/lifecycle/sleep-wake-restart.test.ts` (+ supervision). Builds the SLEEP_THROUGH_BRIEF_RESUME §20.1 criterion's suite over `@sow/workflows` lifecycle. Plan says "mostly doable now."
  - **12.5** provider/runtime conformance — extend the existing `src/conformance/*` with pinned-models + the release-gate assertion (≥1 conformant for `meeting.close`).
  - **12.21** perf benchmark — `knowledge-sync-latency.bench` + `dashboard-warmload.bench` already exist; wire their thresholds as EVALUATION_CRITERIA rows (the metric criteria are registered). The *real-integration* measurement is DoD-gated on live I/O.
- **Cross-package — COORDINATE (dashboard track reaches into knowledge/integrations/providers for real-GBrain/projectors/doc-pack):** 12.6 (packages/knowledge KnowledgeWriter), 12.7 (packages/knowledge gbrain parity — needs **real gbrain**), 12.8 (packages/integrations Tool Gateway), 12.4 (packages/db SQLite+Postgres — needs **real Postgres**). Confirm the dashboard track isn't mid-edit before touching these files.
- **Blocked / WAIT:** 12.16 (meeting e2e — needs real integrations + 12.5), 12.18 + 12.20 (apps/desktop = **dashboard territory** + Phase-11-gated), 12.22/12.23 (write-through enablement/fail-closed — real gbrain + Phase-4 4.19/4.20).

## Invariants honored / notes
- Only touched `packages/evals` + this session doc. Did **not** touch `apps/desktop`, `apps/worker` read-models, `packages/contracts/api/ui-safe`, or **`IMPLEMENTATION_PLAN.md`** (shared with the dashboard track on `main` — Phase-12 checkbox reconcile is deferred to merge to avoid a conflict).
- No new contract surface (no frozen-contract round). Explicit per-path `git add`; commits carry the AI trailer. Not pushed (no remote).
- Registry design choice: coverage-matrix asserts 1:1 §20.1 mapping + threshold presence + DoD-honesty, but **not** suite-file existence (so 12.1 could land first). At Phase-12 acceptance, add a stricter meta-test asserting every registered suite file exists + is green.

## Resume prompt (next session)
```
Continue Phase 12 in worktree ../SoW-build-evalsec (branch track/eval-security),
packages/evals only. Read docs/sessions/evalsec-002-2026-07-04-phase12-harness-corpora-suites.md.
Next: build 12.19 (Temporal sleep/wake/restart + supervision → suites/lifecycle/)
then 12.5 (conformance pinned-models + release-gate) then wire 12.21 perf thresholds
into EVALUATION_CRITERIA. Coordinate before touching packages/{knowledge,integrations,db}
(dashboard track reaches there); don't touch apps/desktop or IMPLEMENTATION_PLAN.md.
After any suite fan-out, run the FULL-package tsc (agents only vitest their own file).
Trailer: Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>
```
