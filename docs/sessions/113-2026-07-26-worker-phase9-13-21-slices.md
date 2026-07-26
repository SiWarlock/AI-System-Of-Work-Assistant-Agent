# Session 113 — worker: Phase-9/13/21 slices (egress flip+revoke · read-model producers · write-adapter binding)

- **Date:** 2026-07-26
- **Track / area:** `main` (single-track) · worker (`apps/worker`)
- **Role:** worker-implementer
- **Phase:** Phase-9 (egress + read-model surfaces) · §13.16 (task rollup) · §21.1/2 (write-adapter routing)
- **Predecessor:** `docs/sessions/112-2026-07-26-arc5-dormant-machinery-provint-wave2.md` (numeric; different area)
- **Successor:** _(pause — team paused after this session per owner directive)_

## Why this session existed
Respawn of `worker-implementer` (the prior `worker-implementer-2` was terminated by an erroneous lead shutdown; no committed work lost). Resumed the orphaned #39 employer-egress FLIP WIP, then took the remaining worker legs of the wave-2 build order: two dormant read-model producers (calendar, task-rollup), the write-adapter routing composition binding, and the egress-ack REVOKE command. Session ended on an owner-directed PAUSE.

## What was built (5 slices, all committed to `main`)

| Task | Slice | Commit |
|---|---|---|
| #39 | employer-egress default-seed FLIP (⛔ rule-5 crossing) | `bcde3d61` |
| #28 | 9.9a calendar read-model producer (dormant/empty-until-wired) | `8b4e3537` |
| #29 | 21.1/2 write-adapter routing composition binding | `ed9faa26` |
| #47 | 13.16 task-rollup read-model producer (dormant/empty-until-data) | `0e6e1662` |
| #53 | 9.10-B egress-ack REVOKE command (⚠ rule-5 fail-safe OFF) | `225c10ca` |

### Files created
- `apps/worker/src/api/projections/calendarProjection.ts` — #28 write-time calendar producer (GCL busy windows → `UiSafeSchedule`; WS-8 drop; REQ-F-009 no-silent-free; dormant).
- `apps/worker/src/api/projections/taskRollupProjection.ts` — #47 `refreshTaskRollup` (TaskRepository → `UiSafeTaskRollup`; deterministic priority/dueDate/id rank; REQ-F-017 no-inference; WS-8 positive-keying; dormant).
- `apps/worker/src/composition/egressRevoke.ts` — #53 `createEgressCommandPort.revokeEgressAck` (get-before-upsert L30 fail-closed → flip ack→false + clear acknowledgedAt → upsert → summaries-only audit).
- `apps/worker/src/api/procedures/egressCommands.ts` — #53 `EgressCommandPort` seam + `revokeEgressAck` mutation (behind `authedResolver`, owner) + redaction-safe boundary-error mapping.
- Tests: `calendarProjection.test.ts`, `taskRollupProjection.test.ts`, `egressCommands.test.ts`.

### Files modified
- `apps/worker/src/composition/provisionWorkspace.ts` (#39) — `seedPersonalCloudCopilotAllowlist` → `seedCloudCopilotAllowlist(ws, now)`; also seeds `employer_work` `[claude]` + ack=true + acknowledgedAt (scoped flip).
- `apps/worker/src/api/procedures/copilotClaudeSynthesis.ts` (#39) — comment-only (renamed-symbol ref + superseded-mechanism doc-nit).
- `apps/worker/src/composition/backends.ts` (#29) — single `makeTargetWriteAdapter('todoist')` → `buildWriteAdapterRegistry` over the same stub deps; bundle field `writeAdapter` → `writeAdapters` (7-target registry).
- `apps/worker/src/composition/buildActivities.ts` (#29) — both dispatch sites route via `dispatchRouted`; `createUnroutedWriteAdapter()` sentinel.
- `apps/worker/src/api/adapters/readModel.ts` (#28/#47) — `READ_MODEL_KEYS.schedule` + `.taskRollup`; `readScheduleEntries`/`readTaskRollupItems` narrowers; async `calendar()`/`taskRollup()` readers.
- `apps/worker/src/api/procedures/queries.ts` (#28/#47) — `ReadModelQueryPort.calendar`/`.taskRollup`; `sanitizeCalendar` (whole-degrade-to-empty) / `sanitizeTaskRollup` (per-row-drop); `query.calendar`/`query.taskRollup`.
- `apps/worker/src/api/server.ts` + `apps/worker/src/boot.ts` (#53) — mount `revokeEgressAck` + build the real `EgressCommandPort` over `repos.{workspaceConfig,audit}`+`now`.
- Sibling fake-port ripples: `queries.test.ts`, `uiSafe.test.ts`, `api-live.test.ts` (calendar/taskRollup/egressCommand fake members).

## Decisions made
- **#39 flip = scoped default-seed** — `employer_work` + `[claude]` ONLY (non-claude still DENIES); the store-backed 9.10-A resolver stays the sole posture; owner-authorized, login=company confirmed.
- **#28 sanitizeCalendar whole-degrade-to-empty** — a partial calendar would falsely show dropped slots FREE (REQ-F-009); honest-empty is the safe posture (diverges from the whole-err siblings, orch-ratified).
- **#47 sanitizeTaskRollup per-row-drop** — a task-rollup snapshot has no silent-free hazard, so a leaky row is dropped and a partial priority list stays useful (orch-ratified).
- **#29 registry over the same stub deps** — dormancy preserved (`selectAdapterTransport(undefined)`→stub); both dispatch sites routed; `createUnroutedWriteAdapter()` fail-closed sentinel.
- **#53 upsert-then-audit, fail-closed-on-audit** — the audit trail is part of "done" (§4/rule-7); the command is idempotent so a retry completes it; the fail-safe OFF state is durable regardless (orch-ratified).

## Decisions explicitly NOT made (deferred)
- Producer trigger bindings + populators (calendar availability adapter; TaskRow writer) — deferred to later composition slices.
- 9.10-C desktop egress-settings surface + owner-gated re-ACK path + 9.10-D audit-link.
- A router-level boundary-mapping regression test for `egressCommands.toBoundaryError` (behavior confirmed by security review; unpinned).
- Per-workspace subscription/credential SPLIT (§ARM-18 end-state) — not this session.

## TDD compliance
**Clean.** Every slice was RED→GREEN (failing test written + confirmed RED via module-load failure before the impl existed), Step-2.5 approved, mandatory `security-reviewer=invariant` (all CLEAN) + `code-quality` (findings fixed in-slice or deferred). No TDD violations.

## Reachability
- #28 `query.calendar` — mounted via `buildQueryRouter` (serve wired, empty-until-producer); `calendarProjection` dormant/unbound.
- #47 `query.taskRollup` — mounted via `buildQueryRouter`; `refreshTaskRollup` dormant/unbound (grep-pinned by `dormant_producer_unbound`).
- #29 `dispatchRouted` — reachable from both `buildActivities` dispatch sites (`:575` propose, `:656` approvedGateway); no lingering single-adapter path.
- #53 `revokeEgressAck` — mounted via `composeAppRouter` behind `authedResolver`; real port built at boot. LIVE (fail-safe OFF).
- **No tested-but-unwired gaps** beyond the intentional dormant producers (empty-until-data by design).

## Open follow-ups (Step-9 flags routed hot to orch/lead)
- **Arch-doc notes (orch/lead write):** §5/§16 employer cloud egress OPEN-by-default-seed for `[claude]` (#39) + egress owner-revocable fail-safe OFF (#53); §19.8/§8 composition-root external-write adapter-selection seam (#29); §11 Today/Copilot highest-priority served off a WS-8 read-model (#47); §ARM-18 flip EXECUTED ledger.
- **Carry-forwards:** calendar `.cause` redaction + `genericReason` via GCL Gate at the wiring slice; §ARM-21 WS-8 Approval-workspaceId sourcing at 21.5/21.6; task-rollup drop-count health signal; egress `store_fault` distinct-code refinement + router-boundary test; L30 grep surface grew (egressRevoke direct upsert — binding-preserving by construction).
- **Cross-track:** evalsec owns the `@sow/evals` `egressCommand`/read-model fake reconciliation (routed to #55).

## Cross-doc invariant audit
**No frozen-model field changes this session.** All slices consume frozen contracts as-is (`EgressPolicy`, `UiSafeSchedule`, `UiSafeTaskRollup`, `Workspace`, `Task`/`TaskRepository`, `WriteAdapterRegistry`, `AuditRecord`). `READ_MODEL_KEYS.schedule`/`.taskRollup` are internal registry keys (confirmed not mirrored in a cross-doc table). No snapshot change; no `ARCHITECTURE.md` model-row edit required. The arch NOTES above are additive prose, not model-field mirrors.
