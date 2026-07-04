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

---

## Addendum — same session continued (12.19 / 12.5 / 12.21)

Three more tasks landed after the checkpoint above:

| Commit | Task | Deliverable |
|---|---|---|
| `73daf1b` | **12.19** | Temporal sleep/wake/restart + worker-supervision (`suites/lifecycle/`, 18) — real `@sow/workflows` catchUpWindow (collapse-to-one, NTP-backward survival) + `@sow/worker` recovery/supervision/lease/degraded controllers. Builds **SLEEP_THROUGH_BRIEF_RESUME** (dodPass=true, deterministic). |
| `73daf1b` | **12.5** | Conformance pinned-models + release-gate (`suites/conformance/` + `src/conformance/pinned-models.ts`, 12) — real matrixEligibility/releaseBlockingFailures/meetingCloseDoD; ≥1-conformant-for-`meeting.close` gate, no OpenAI↔OpenRouter contagion, local optional. Scores PROVIDER_CONFORMANCE + RUNTIME_CONFORMANCE honestly (real-required → dodPass=false from fixture gate). |
| `f7db2bd` | **12.21** | Latency budgets wired to EVAL-1 (`test/perf/latency-budgets.test.ts`, 9) — registered thresholds mirror the bench budget consts (drift guard), regression-past-budget fails, value derived from the real `assess*` cores, DoD honesty (real-required → dodPass=false; real-timing stays on the `*.bench` cadence). |

**State now:** **388 evals tests green**, `tsc` clean, tree clean. **§20.1 acceptance suites built: 11/19** (added SLEEP_THROUGH_BRIEF_RESUME). 12.5 + 12.21 complete the conformance-gate + latency-metric wiring.

**Remaining §20.1 acceptance rows without a suite (8):** Meeting closeout replay, Workspace routing, Knowledge write (→ 12.16 e2e, real-integration), Approval flow (no dedicated suite yet — buildable deterministically over the approval state machine), Open-source install (→ 12.20, Phase-11-gated), Retrieval relevance (real gbrain), GBrain parity (→ 12.7, real gbrain), Human-section preservation (→ 12.6, packages/knowledge — coordinate w/ dashboard track).

**Cleanest next (packages/evals, no collision):** **Approval flow** suite (deterministic, over the approval state machine + Tool Gateway — closes another §20.1 row) is the last big one buildable without real integrations or cross-track coordination. After that, the remaining rows are real-integration-gated (12.16/retrieval/12.7) or cross-package (12.6/12.8/12.4) or Phase-11-gated (12.18/12.20).

### Approval flow (`519d229`) + final state
Added the **Approval flow** §20.1 suite (`suites/approval-flow/`, 10) over the real `@sow/domain` approvalMachine — surfaced-pending → approve/edit/reject/defer, exactly-once across Mac+Telegram (idempotentTerminalReentry no-op), frozen terminals, deferred re-surface, typed illegal-move rejections. Scores APPROVAL_FLOW (dodPass=true).

**FINAL:** **398 evals tests green**, `tsc` clean, tree clean. **§20.1 suites built: 12/19.** This closes out every Phase-12 task buildable **in isolation** on the eval-security track (harness, corpora, all deterministic §20.1 suites, conformance release-gate, latency budgets).

**All remaining Phase-12 work is gated** (not doable on this track alone):
- **Real-integration-gated** (build runs over stubs): 12.16 meeting-closeout e2e (+ Meeting closeout replay / Workspace routing / Knowledge write §20.1 rows), Retrieval relevance, 12.7 GBrain parity (real gbrain), 12.4 SQLite+**Postgres** contract.
- **Cross-package, coordinate with dashboard track** (they edit knowledge/integrations/providers): 12.6 (packages/knowledge KW ownership/secret/human-section), 12.8 (packages/integrations Tool Gateway replay/outage). Human-section preservation §20.1 row lives here (12.6).
- **Phase-11-gated / dashboard territory:** 12.20 clean-install (+ Open-source install row), 12.18 Electron/IPC (apps/desktop), 12.22/12.23 write-through enablement/fail-closed (real gbrain + 4.19/4.20).

**Recommended next move:** merge `track/eval-security` → `main` (coordinate with the dashboard track), reconcile the Phase-12 checkboxes at merge, then tackle the real-integration suites once live vendor I/O / real gbrain / Postgres are wired (that's a Phase-11-adjacent effort, not an isolated-track one).
