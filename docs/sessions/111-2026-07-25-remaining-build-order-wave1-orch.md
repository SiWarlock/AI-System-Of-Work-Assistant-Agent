# Session 111 — Remaining-build-order Wave 1 (orchestrator) — 2026-07-25

> Orchestrator-side round-close + **fresh-orchestrator handoff** (orch-only cycle on a fan-out team; implementers stay up). Predecessor: `110-2026-07-24-phase9-round2-orch.md`. Successor: _(next orchestrator session)_.

## Round summary
Owner approved a full REMAINING-BUILD-ORDER plan (`docs/planning/remaining-build-order.md`) executed IN PARALLEL. **Wave 1 across 3 areas SEALED** (all Step-2.5-reviewed, dual-reviewed, committed on `main`):

| Slice | Commit | What |
|---|---|---|
| **13.15** (ARC 2, contract) | `54b052a7` | Typed Task Appendix-A model (optional never-inferred priority + optional projectId, TaskLifecycle/Priority enums, TaskId brand) + **dual-dialect TaskRow ROLLUP INDEX (NOT a 2nd writer — rule 1)** + TaskRepository; 4 operational FailureClass members (db_unavailable/provider_routing_unavailable/outbox_blocked/write_through_blocked) + `defaultSeverityForFailureClass` arms + regen health-item schema. Repo-wide typecheck 20/20. **The frozen-contract bottleneck — unblocked Wave 2.** |
| **7.19** (ARC 0, worker) | `addd616f` | Retention-prune driver + prunePolicy activity rebuilt **DORMANT** (false-tick corrected). RET-3 one-writer via KW tombstone; security-reviewer 7/7 PASS. Live schedule = §19.12. |
| **11.2** (ARC 0, worker) | `5ad722a8` | Startup app↔schema-version compat refusal wired at `openDatabase` before `applyMigrations` (fail-closed refuse-to-boot, genesis-safe, WORKER_APP_VERSION drift-guard). |
| **9.14** (ARC 1, desktop) | `25029a76` | Renderer-isolation + redaction adversarial specs (test-only, security-reviewer STRONG, zero prod change). |

Suites green: contracts 737 · db 447 · workflows 570 · worker 1898 · desktop 403.

## Decisions made
- **§DEC-CAT4 RESOLVED** — the FailureClass *security* members already existed (`shared-enums.ts:124-127`, 11.8 C-enum); the plan "PENDING" text was stale (reconciled).
- **9.10 egress-ack: owner-approved D1=A** — build the full Employer-Work egress-ack control (durable per-workspace ack + owner-only two-step-confirm acknowledge/revoke + workspace-settings surface; default fail-closed). **Scout verdict: NO frozen-contract change** — reuses frozen `EgressPolicy` (already carries `employerRawEgressAcknowledged`/`acknowledgedAt`) + existing `WorkspaceConfigRepository` (persists `Workspace.egressPolicy` dual-dialect); `actor` rides `AuditRecord`. Design: `docs/design/9.10-egress-ack-surface-design.md`.
- **spec-lint⇄plan-lint gate fix (lead-authorized)** — spec-lint's brief task-check only accepted `- [ ]`, rejecting `[~] PARTIAL` tasks that plan-lint *mandates*. Applied the one-line fix `scripts/spec-lint.sh:92` (`/^- \[ \]/` → `/^- \[[ ~]\]/`; still excludes `[x]`, regression-verified). **MANDATORY follow-up: port to the scaffolding-repo template** (Carry-forward #5 / task #19) so scaffold-upgrade doesn't clobber it.
- **Commit-split / structural deviations approved** — 13.15 single bundled commit (shared files straddle both features); the implementers' TaskRow-as-index, RetentionPolicy reuse, node-tier/electron-mock, readOnDiskSchema-atomic, 9.9-no-workspaceId calls were all improvements over the brief defaults.

## Decisions explicitly NOT made / deferred follow-ups (NOT Carry-forward — noted here + in the Log)
- **7.19 §19.12/Phase-25 arming residuals** — bind real TombstoneMarkdownPort(KW)/PrunablePayloadStore/PruneAuditPort/PrunableRecordSource + sandbox registration + `createSchedule`; **security-reviewer WS-2**: add a defensive `r.workspaceId===request.workspaceId` guard when the real PrunableRecordSource binds.
- **11.2 `record_failed` recovery refinement** — a marker-0-WITH-history state (migrate ok but marker-write failed) fails closed (`schema_below_minimum`, forces restore-from-backup); a marker-0-populated recovery refinement is a deferred fail-SAFE follow-up.
- **UiSafe `changeId` grammar-tightening** — the `uiSafeOpaqueRef` grammar (no path/URL) risks the existing recentChanges producer; deferred (verify producer first).
- **PENDING LESSON BANKING (fresh orch — bank at your first `/orchestrate-end`):**
  1. **(contract/LESSONS)** A new Appendix-A model = the FULL set in ONE round: model+generated-schema+field-snap+test+barrel-export-the-SCHEMA_ID **PLUS a seam fixture** (`fixtures/valid.ts` + `fixtures/index.ts` + the domain `fixtures.test` ZOD_BY_ID map) AND the shared-enum membership-guard row. Missing the fixture/ZOD_BY_ID breaks the DOMAIN seam-fixtures meta-test (not the contracts suite) — **green-in-contracts ≠ done.**
  2. **(desktop/LESSONS)** Renderer security specs assert bridge==inventory + main-handler-set==inventory + real webPreferences (via a mocked electron ctor) + no-Node-escape + UI-safe-only store via the REAL `validateStreamEvent`→`onData` drop path — deterministic renderer-global altitude, not a full Electron runtime.
  3. **(worker/LESSONS, optional)** compiled-in `WORKER_APP_VERSION` + a cross-package drift-guard test (bump in lockstep with `CURRENT_SCHEMA_VERSION` + a compat-table row) — mirrors worker L55.

## Hot-routing landed this round (verify)
- ARCHITECTURE.md Appendix A: **Task row** added + HealthItem row **+4 operational members**. contracts/CLAUDE.md cross-doc table: **Task row** + HealthItem members + count `28→29`. (Both written hot; ride this round commit.)
- Plan: 13.15/7.19/9.14/11.2 ticked `[x]` with hashes; §DEC-CAT4 reconciled; Currently-in-progress replaced; Carry-forward triaged (3 deleted, 3 added, 4 kept = 7).

## ⭐ LIVE ROSTER + WAVE-2 HANDOFF STATE (fresh orch: resume here)
**Team `main`, single-track. Live teammates (SUFFIXED names — day-gap stale base-names exist; the LEAD is authoritative on names):**
- **`contract-implementer`** (clean name) — **IN FLIGHT: task #21 UiSafe-types round** (brief 167, Step-2.5 APPROVED by me, GREEN pending). ⚠ **Its Step-9 routes to YOU (the fresh orch)** — expect it; write the cross-doc rows if any (likely none — additive UI-safe, no snapshot). Then contract is FREE.
- **`worker-implementer-2`** — queue: **task #20 9.10-A** (brief 166 `@c8a73075`, ⚠SAFETY rule-5 store-backed egress posture; hold its Step-2.5 for you) → then **9.10-B** (you author: acknowledge/revoke command, server two-step-confirm, the only writer of ack=true; own commit, security-reviewer=invariant; **Step-9 re-routes to the LEAD** before ship).
- **`desktop-implementer-2`** — **IDLE**, unblocks when UiSafe-types (#21) lands: then dispatch **9.9 Calendar** (consumes UiSafe schedule type), **9.8** (UiSafeApproval editor), **9.5** (audit-link changeId). **9.21** scaffold-repair additionally needs a worker `createWorkspace` partial-result shape (small worker+contract leg — author it). Then **`/phase-exit 9`** (desktop's first formal gate) + the owed LIVE `/design-review`.

**WAVE 2 (lead staffs; fan out when spawned):**
- **knowledge** → ARC 3 retrieval (13.3 + 13.17) → ARC 4 §13.8 keystone (13.8a→g) + **the ARC-6 Phase-19 knowledge-heavy legs** (lead's offload so worker keeps only its worker-half).
- **prov-int** → ARC 5 dormant machinery (extractors 13.2, write-registry 21.1-4, research provider 13.13/14, output-workflow legs 25.x).
- **eval-security** → ARC 6 suites (non-gbrain-gated 12.x).
- Owner-gated crossings (§ARM-17/18/GBRAIN/21/23/RESEARCH) are NOT build order — build dormant only; live arming = owner's per-crossing call (→ lead).

**9.10 arc plan (4 briefs, dep order store-read→command→surface):** A (166, worker, done-authored/queued) → B (worker, author) → C (desktop, after B) → D (worker+desktop audit-link, co-designs w/ 9.5, anytime). All rule-5-touching legs (A/B) = own commit + security-reviewer=invariant + Step-9 re-routes to lead. Optional follow-up: full REQ-S-002 allow/deny decision-stream carrier (separate).

## Open follow-ups
- Carry-forward (7, triaged): SPINE arc · Phase-9→`/phase-exit 9` · 9.10 egress-ack arc · selection_failed→db_unavailable reclassification (7.19, now buildable) · spec-lint scaffolding-repo port (#19) · LIVE `/design-review` · ESLint config.
- Push posture: round-close-only; this round pushed to `origin/main`.
