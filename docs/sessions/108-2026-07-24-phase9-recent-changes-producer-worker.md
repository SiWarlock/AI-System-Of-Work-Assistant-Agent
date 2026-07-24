# Session 108 — Phase-9 §9.15: real recent-changes read-model producer (audit projection + fail-safe post-commit trigger)

- **Date:** 2026-07-24
- **Phase:** 9 ("make the daily briefing real" arc — worker slice-1: the real read-model PRODUCER wiring)
- **Track:** main (single-track, worker area)
- **Predecessor:** [107-2026-07-24-osb-parity-amendment-integration-orch.md](107-2026-07-24-osb-parity-amendment-integration-orch.md)
- **Successor:** _(none yet)_

## Why this session existed

The dashboard READ path for Recent Changes was already real (`queries.recentChanges` → `readModel.recentChanges` → `sanitizeRecentChanges`) and the PROJECTOR was already real + unit-tested (`projectRecentChanges`, WS-8 fail-closed, redact-by-type) — but they read an EMPTY read-model (only a dev-only `buildSyncRecentChange` writer, OFF by default). This slice built the real PRODUCER that reads audit rows → projects → writes the `recent_changes` row, and wired it to a bounded fail-safe trigger so real ingest activity surfaces. Implements plan task **9.15**. The load-bearing "real data appears" first slice of Phase-9 producer wiring.

## What was built (one commit `8a35cc2e`)

**Files created:**
- `apps/worker/src/composition/recentChangesProducer.ts` — the pure producer `refreshRecentChanges(input, deps)` over injected `AuditRepository` + `ReadModelRepository` + `now`: `audit.query({ workspaceId }, RECENT_CHANGES_AUDIT_SCAN_BOUND)` → `projectRecentChanges(records, workspaceId)` → `readModels.put({ readModelKey: recentChanges, workspaceId, data: { changes }, rebuiltAt: now() })`. Exports `RECENT_CHANGES_AUDIT_SCAN_BOUND = 1000`. WS-8-safe by construction; fail-closed both directions; never-throws typed `Result` (§16).
- `apps/worker/test/composition/recentChangesProducer.test.ts` — 6 unit tests (core contract, WS-8 safety pin, empty-row, both fault directions incl. throw-totality, scoped-query).
- `apps/worker/test/integration/recentChangesProducer-live.test.ts` — 1 reachability integration test: a REAL activity-direct source commit (armed $0 fake completion, no Temporal/network) → the wired `sourceCommit` fires the refresh → a non-empty `recent_changes` row.

**Files modified:**
- `apps/worker/src/composition/buildActivities.ts` — the exposed `sourceCommit` activity (~:1080) now wraps the commit: on `isOk(result)` it fires a bounded **fail-safe** `refreshRecentChanges` for `String(plan.workspaceId)` inside a try/catch; a refresh fault NEVER fails/blocks the commit; `return result` is unconditional. (+ `isOk` and the producer import.)

## Decisions made

- **Trigger = (a) post-commit refresh at the `sourceCommit` seam** (chosen over an always-on Temporal schedule or rebuild-on-read). Incremental, no schedule infra, immediate, stays in `apps/worker` territory, bounded (one scoped refresh), and fail-SAFE — a refresh fault surfaces (Future-TODO: a HealthItem) and never blocks the sole-writer KW commit (durable truth; the read-model is rebuildable-derived).
- **Unconditional empty-row put** (diverged from the brief's "leave absent" vote, orchestrator-accepted). A full REFRESH producer writes the whole projection every time — simpler (no special-case), always reflects current state + a fresh `rebuiltAt` (freshness signal). Full-refresh REPLACES (not the sibling dev-writer's sibling-preserving upsert): on the real path the audit feed is the source of truth, superseding dev-only `project-synced` placeholder rows (documented at the put site).
- **⚠ Q3 audit-ordering finding (refined the brief, orchestrator-accepted):** `audit.query(filter, limit)` orders by `rowid` ASC (append/OLDEST-first) then `.slice(0, limit)` — an explicit arch_gap (forward order under-specified until task 2.9). A fixed SMALL "recent limit" would surface STALE oldest changes for a busy workspace. Resolution: scan a GENEROUS named bound (`RECENT_CHANGES_AUDIT_SCAN_BOUND = 1000`) so a personal-scale workspace's full audit history returns → the projector DESC-sorts and the read-side caps 50 → correct most-recent. A workspace beyond the bound shows stale-oldest until `audit.query` gains recency ordering (FUTURE-TODO task 2.9).

## Decisions explicitly NOT made (deferred)

- **The audit.query recency ordering** — a workspace with >1000 lifetime audit rows shows stale-oldest until this lands (arch_gap → task 2.9). Not fixed here.
- **HealthItem on a persistent refresh fault** — the fail-safe currently swallows a refresh Err (commit never fails); routing a persistent fault to a HealthItem is `FUTURE-TODO(9.15-health)`.
- The served `queries.recentChanges` known-workspace registry gate is orthogonal to the producer (the integration test asserts the written row directly).

## TDD compliance

**Clean.** RED test written + confirmed-failing-for-the-right-reason (module-missing) BEFORE GREEN; Step-2.5 orchestrator review (`APPROVED.` after the 3 design-question answers); minimum implementation; full-suite green. The integration test was iterated (non-armed KMP-stub path yields an EMPTY extraction that `validateNoInference` rejects → switched to the proven armed $0-fake-completion assembly). No TDD violations. The WS-8 safety pin (`ws8_foreign_record_never_lands`) is the safety-relevant assertion; the slice is one focused commit (brief-allowed bundle: the wiring is a few lines sharing the WS-8 context).

## Cross-doc invariant audit

**No frozen-contract (Appendix-A) model field changed** — reuses `UiSafeRecentChange`/`AuditRecord`/`AuditQuery`/`ReadModelRepository`/`READ_MODEL_KEYS`. No `ARCHITECTURE.md` cross-doc-invariant edit is owed from code. The §11/§10 arch note (Recent Changes now producer-populated + the `sourceCommit` seam the next producer legs mirror + the audit.query recency arch_gap) + the worker LESSON (read-model producer pattern, L76) are orchestrator-territory, written at `/orchestrate-end` (in the orchestrator's staged batch).

## Reviews (Step 8)

- **security-reviewer — CLEAN.** All 4 project safety invariants PASS: WS-8 isolation (scoped query AND projector fail-closed drop; write key = served ws, never record-derived; wiring derives ws from `plan.workspaceId`), §16 never-throws totality (audit/put faults returned-Err OR thrown → typed Err, no partial write), fail-safe-never-blocks-commit, redaction (only safe display tokens). 0 crit/high/medium; 2 low (defer).
- **code-quality-reviewer — 0 high, 2 medium, 3 low.** Mediums: (a) full-refresh clobbers dev-only `project-synced` rows — intentional, now documented at the put site; (b) the scan-bound stale-window ceiling — the Q3 arch_gap (2.9). Lows (defer): refresh Result discarded (fail-safe intended; HealthItem Future-TODO); inline-await per-commit latency (fine at personal scale); `String(plan.workspaceId)` coercion (unreachable — required field, WS-8-safe). Test quality clean (no vacuous `.catch`; loud-fail guards).

## Reachability (Step 7.5)

**CONFIRMED.** `refreshRecentChanges` is reachable from `buildProofSpineActivities.sourceCommit` (a production composition root Temporal registers). The integration test proves the end-to-end real path: a real source commit appends a `knowledge_writer.commit` audit row → the wired `sourceCommit` fires the refresh → a non-empty `recent_changes` read-model row for the committing workspace. No tested-but-unwired gap.

## Open follow-ups (orchestrator hot-routed this round)

1. **§11/§10 ARCHITECTURE note** — Recent Changes is now PRODUCER-populated from real audit on the real path; the `sourceCommit` post-commit trigger seam is the pattern the daily-brief / task-rollup / ingestion-inbox producer legs mirror; the audit.query recency arch_gap.
2. **Worker LESSON (L76)** — a read-model producer = a pure port over injected audit-read + read-model-put + now; WS-8 by construction; fail-closed both ways; full-refresh supersedes the dev-writer; the trigger is a bounded fail-SAFE post-commit seam that never blocks the sole-writer commit.
3. **Residuals(9) → task 2.9** — the >1000-bound stale window (audit.query needs recency/DESC ordering).
4. **Residuals(9) → 9.15-health** — the persistent-refresh-fault → HealthItem observability follow-up.
5. **Next Phase-9 producer legs** — daily-brief / task-rollup / ingestion-inbox park-sink bindings mirror this bounded fail-safe producer+trigger pattern; the desktop "static Today sections → live" slice renders the now-populated read-model.

## How to use what was built

Nothing to run — the producer fires automatically on every real source commit (fail-safe). The Recent Changes surface now renders real ingest activity for a provisioned workspace. `pnpm test` covers the unit + reachability tests.
