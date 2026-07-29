# Phase 9 — worker/db reachability audit (worker-side)

**AUDIT ONLY — NOT a `/phase-exit 9` gate run. No CLEAR/BLOCKED verdict is emitted.**

Verified at HEAD `86477bbf` (branch `main`, tree clean at start and end of this audit — no files were mutated; every reported observation is a `Read`/`grep`/codegraph query, no edits).

## Why no verdict

`/phase-exit 9` is not being run and this document does not imply one. Phase 9 is structurally un-exitable for reasons unrelated to code: the plan's own Acceptance-criteria block (`IMPLEMENTATION_PLAN.md:1303-1310`) records that 9.5's §4.5 managed-doc-pack leg cannot tick — it is blocked on a Google Drive connector that does not exist — and the owner ruled 2026-07-26 that nothing is deferred out of Phase 9. A BLOCKED verdict here would be *predetermined by that dependency*, not derived from this audit's analysis, and once quoted out of context it would lose the qualifier and read as an independent gate result. This document reports reachability findings only.

## Why this run exists (scope rationale)

Phase 9 is nominally the desktop track (a sibling agent audits `apps/desktop/` in parallel), but a large share of Phase 9's `[x]` tasks landed in worker/db code (§4 operational store, §6 vault binding, §7 provider matrix — all three added to Phase 9's own spec-anchor list on 2026-07-29 specifically because tasks 9.29/9.30/9.31/9.32 already cited them). A desktop-only reachability audit would silently cap the phase at exactly the surface a bounded read happens to cover. This run closes that cap for the worker/db side.

## Review-surface honesty (mandatory)

Phase 9's worker-side contribution is **not cleanly separable** from the accumulated worker-track diff — the same files (`boot.ts`, `provisionWorkspace.ts`, `queries.ts`, `egressCommands.ts`, `buildActivities.ts`) carry Phase-9, Phase-14, Phase-18, and Phase-9.29-9.33 changes interleaved, several already reconciled by the plan's own 2026-07-26/07-28/07-29 audits. **This audit's surface over-approximates**: I walked the worker composition root (`boot.ts`), the tRPC router assembly (`server.ts`/`mount.ts`), the onboarding/egress/queries/commands procedure modules, the read-model producer bindings in `buildActivities.ts`, and the `packages/db` repository interfaces + both dialect adapters for the fields Phase-9 tasks named. I did **not** re-derive Phase-9 attribution file-by-file against `git blame`/`git log --follow`; I trusted the plan doc's own task→file citations (verified several against source) plus the task prompt's named surfaces.

## Method

- Oriented with `graphify query` (workspace-config-writer trace, egress-posture trace) before any raw read, then `mcp__codegraph__codegraph_context` / `codegraph_trace` / `codegraph_callers` for the call-path work, per the mandatory tool-preference rule.
- Two codegraph gaps surfaced during the walk (`buildOnboardingRouter`, `buildProofSpineActivities`, `registerWorker`, `createCalendarProjectionPort`, `refreshTaskRollup` all initially returned "no callers found" from `codegraph_callers` even where a real caller exists in source, e.g. `buildOnboardingRouter` **is** called at `server.ts:136`) — confirmed with targeted `grep`/`Read` in every case per the tool's own escape hatch ("confirm a specific detail with a targeted read"). Codegraph is otherwise accurate; this is noted so the "no callers found" results reported below for two genuinely-uncalled symbols (`refreshTaskRollup`, `createCalendarProjectionPort`) are **not** taken on codegraph's word alone — both were independently confirmed via `grep -rn` across `apps/worker/src` with zero non-file-header/non-test hits.
- `IMPLEMENTATION_PLAN.md` lines 999-1333 (Phase 9) were read in full to anchor task numbers, status, and the plan's own file:line citations, then cross-checked against source at HEAD.

## Census

**18 symbols/surfaces walked** (production entry points `bootWorker` and the composed tRPC `appRouter` as the reachability targets):

- **14 REACHABLE** (traced to `bootWorker` via a real, non-test call chain)
- **3 DORMANT-BY-DESIGN, each cited** (in-code comment and/or a plan-doc task recording the deferral)
- **0 genuinely-unreachable / undocumented dead code** found in the walked surface
- **1 documentation-drift finding** (a file header comment claims dormancy the code no longer has — the opposite direction of a reachability gap)

## REACHABLE (14)

All chains below terminate at `bootWorker` (`apps/worker/src/boot.ts:1379-2267`), confirmed as the sole production entry point that both starts the HTTP/WS API transport and registers the Temporal worker's activities.

1. **`provisionWorkspace`** — `apps/worker/src/composition/provisionWorkspace.ts:160`
   Chain: `bootWorker` (boot.ts:1577, `createProvisionWorkspacePort({...})`) → `onboarding.ts:67` `createProvisionWorkspacePort` → its returned `OnboardingCommandPort.provisionWorkspace` closes over the module-level `provisionWorkspace` → mounted as `onboarding.createWorkspace` at `onboarding.ts:171-196`, `buildOnboardingRouter` called at **`server.ts:136`** inside `composeAppRouter` → `composeAppRouter` called by `createApiServer` (server.ts:209) → `createApiServer` called by `startApiServer` (mount.ts:177) → `startApiServer` called by `bootWorker` (confirmed sole caller via `codegraph_callers`).
   Live pin: `apps/worker/test/composition/provision-preserves-egress-posture.test.ts`.

2. **`WorkspaceConfigRepository.insertIfAbsent`** — interface `packages/db/src/repositories/interfaces.ts:241`; implemented `packages/db/src/adapters/sqlite/index.ts:388` and `packages/db/src/adapters/postgres/index.ts:407` (dual-dialect). Called from `provisionWorkspace.ts:294`. REACHABLE via (1).

3. **`WorkspaceConfigRepository.updateProvisioningFields`** — interface `interfaces.ts:229`; implemented `sqlite/index.ts:400`, `postgres/index.ts:418`. Called from `provisionWorkspace.ts:267`. REACHABLE via (1). (These are exactly the two writer methods task 9.30 introduced to close the TOCTOU/fail-open — `IMPLEMENTATION_PLAN.md:1238-1248`.)

4. **`provisionErrorToFailure`** incl. the `ONBOARDING_PARTIAL_SCAFFOLD` typed case (task 9.21) — `apps/worker/src/api/procedures/onboarding.ts:136-160`, called at `onboarding.ts:186` inside the same mounted `createWorkspace` mutation. REACHABLE via (1)'s chain.

5. **`systemHealth.egressStatus`** (task 9.10-A) — producer `createSystemHealthQueryPort` at `boot.ts:556-595`, reads `backends.repos.workspaceConfig.get(wsId)` (real DB repo, not a fake) and derives `zeroEgressOnly` via `isZeroEgressOnlyWorkspace` (task 9.22's predicate). Bound at `boot.ts:1572`; mounted as `systemHealth.egressStatus` via `buildSystemHealthRouter` at `systemHealth.ts:163-168`, mounted in `composeAppRouter` (`server.ts:135`). REACHABLE via the same `composeAppRouter`→`createApiServer`→`startApiServer`→`bootWorker` chain as (1).

6. **`egressCommand.revokeEgressAck`** (task 9.10-B) — port `createEgressCommandPort` bound at `boot.ts:1613-1617` over `backends.repos.workspaceConfig` + `backends.repos.audit`; mounted as `egressCommand.revokeEgressAck` via `buildEgressCommandRouter` (`egressCommands.ts:89-101`), called by `composeAppRouter` at **`server.ts:140`** (confirmed directly — `codegraph_callers` correctly found this one). REACHABLE.

7. **`buildQueryRouter`** and its mounted procedures `dashboard`/`workspace`(→`workspaceCards`)/`project`/`ingestionInbox`/`approvalInbox`/`copilot*`/`recentChanges`/`projectList`(→`projectDashboards`)/`taskRollup`/`global`/`calendar`/`globalDrillDown` — `apps/worker/src/api/procedures/queries.ts:596-753`, mounted at `server.ts:127`. REACHABLE via the same chain. `resolveGlobalDrillDown` (queries.ts:558) and the read-boundary sanitizers (`sanitizeCalendar`, `sanitizeIngestionInbox`, `sanitizeTaskRollup`, `sanitizeProjectDashboards`, `sanitizeRecentChanges`) are all reached from these mounted procedures.

8. **`createDbReadModelQueryPort`** — `apps/worker/src/api/adapters/readModel.ts:464`, bound at `boot.ts:1557-1560` (real `@sow/db` repos, not a fake) and passed into (7)'s `buildQueryRouter({readModel, ...})` at `server.ts:127`. REACHABLE.

9. **`buildCommandRouter`** (`commands.ts`) — `approvals`/`dispatchApproval`/`triage`/`rerouteTargets`/`now` all bound to real adapters at `boot.ts:1561-1571` (`createDbApprovalCommandPort`, `createDbTriagePort`, `createRegistryValidatedRerouteTarget`), mounted at `server.ts:128-134`. REACHABLE.

10. **`refreshRecentChanges`** (task 9.15 producer) — `apps/worker/src/composition/recentChangesProducer.ts:45`, imported and invoked at `apps/worker/src/composition/buildActivities.ts:39,1141` inside a post-commit trigger. REACHABLE via `buildProofSpineActivities` (below).

11. **`createIngestionInboxProjectionPort`** (task 9.16 producer, the `recordPark`/`recordDisposition` write-time binding) — `apps/worker/src/api/projections/ingestionInboxProjection.ts:77`, bound as the **default** `ingestionPark` inside `buildProofSpineActivities` at `buildActivities.ts:449-451` (`params.ingestionPark ?? createIngestionInboxProjectionPort({readModels: backends.repos.readModels, now})`), consumed at `buildActivities.ts:474` (park route) and `buildActivities.ts:1110` (`triageRecordDisposition` calling `ingestionPark.recordDisposition`). REACHABLE — see doc-staleness finding below; this directly contradicts the file's own header comment.

12. **`buildProofSpineActivities`** — `apps/worker/src/composition/buildActivities.ts:437`, called by `buildRegisteredActivities` at `apps/worker/src/temporal/registerWorker.ts:215`, which is invoked through `makeProofSpineRegisterHook`, imported and called inside `bootWorker` at `boot.ts:2101` and passed to `bootstrapWorker(...)` (`boot.ts:2123-2181`) — the real Temporal-worker registration path. REACHABLE. This is the chain that makes (10) and (11) production-live, not just composition-root-wired.

13. **`WORKSPACE_CONFIG_WRITE_METHODS` census** (`apps/worker/test/composition/provision-preserves-egress-posture.test.ts:543-589`) — not itself a production symbol, but a standing reachability-adjacent guard: it `git ls-files`-scans all tracked non-test production source for any additional caller of `insertIfAbsent`/`updateProvisioningFields`/`upsert` on `WorkspaceConfigRepository`, so a future silent second writer would fail this test rather than going unnoticed. Cited as supporting evidence for (1)-(3)'s reachability being singular/intentional, per task 9.29 (`IMPLEMENTATION_PLAN.md:1226-1228`).

14. **`isZeroEgressOnlyWorkspace`** (task 9.22 predicate, `packages/policy/src/processors.ts:198` area) — consumed live at `boot.ts:588` and `egressRevoke.ts:92` (per `IMPLEMENTATION_PLAN.md:1160`, independently confirmed at `boot.ts:588` above). REACHABLE via (5).

## DORMANT-BY-DESIGN, cited (3)

1. **`createCalendarProjectionPort`** (task 9.9's calendar producer) — `apps/worker/src/api/projections/calendarProjection.ts:90`. `codegraph_callers` and a repo-wide `grep -rn "calendarProjection"` both return zero production callers. **Cited dormancy**: `readModel.ts:619` in-code comment ("EMPTY-UNTIL-PRODUCER: the DEFERRED write-time calendarProjection populates it later") and the plan's own task record — `IMPLEMENTATION_PLAN.md:1052-1053` ships 9.9 DONE explicitly as "`calendarProjection + query.calendar`, dormant/empty-until-wired," naming the real availability adapter as the thing that arms it later. `query.calendar` (item 7 above) is REACHABLE and serves an honest empty schedule today; the producer that would populate it is the deferred half.

2. **`refreshTaskRollup`** — `apps/worker/src/api/projections/taskRollupProjection.ts:96`. Zero production callers (confirmed the same way). **Cited dormancy**: `readModel.ts:596` ("EMPTY-UNTIL-PRODUCER: the DEFERRED `refreshTaskRollup` populates..."). Note: this surface is labeled §13.16 in its own doc comments, not a Phase-9-numbered task in `IMPLEMENTATION_PLAN.md:999-1333` — I could not find a Phase-9 task that owns wiring it, so I am not attributing this dormancy to a Phase-9 gap; it rides in the same `queries.ts` file Phase-9 touched and is flagged here so it isn't silently missed by either audit.

3. **`Workspace.markdownRepoPath`** — zero production consumers (the runtime vault comes from `config.vaultRoot`, not the stored workspace row). **Cited**: this is not a discovery of this audit — task 9.31 (`IMPLEMENTATION_PLAN.md:1250-1256`) already found and documented this exact fact ("`Workspace.markdownRepoPath` has ZERO production consumers... confirmed NOT LIVE 2026-07-28... The deliverable is documentation") as the reason a per-vault-root uniqueness check was deliberately not built. Not a new finding; repeated here only because it is a genuinely-unreachable field this audit independently re-derived and the task instructions require dormant-vs-dead classification with a citation.

**Explicitly NOT a finding** (per the task's own project-facts constraint): the empty `providerMatrix` / unsatisfiable `zeroEgressOnly===true` in production is task 9.32, **owner-ruled DEFERRED to a later round as a scoped ARC** (`IMPLEMENTATION_PLAN.md:1258-1279`) — an empty `providerMatrix` is a correct, fail-closed state, not a missing writer to flag.

## Documentation-drift finding (not a reachability gap — the opposite direction)

`apps/worker/src/api/projections/ingestionInboxProjection.ts:13-19`'s own header comment reads: *"Ships DORMANT: the always-on wiring — invoking `recordPark` at the Temporal ingestion workflow's low-confidence park route... and `recordDisposition` at `createRecordDispositionActivity`... plus the desktop surface mount are DEFERRED... Mirrors `projectDashboardUpdate.ts`... which is built with no caller."*

This is **stale**. Task 9.16 (`IMPLEMENTATION_PLAN.md:1118-1122`, DONE `d44a1f24`, 2026-07-24) bound exactly this producer at the composition root five days before this file's comment was presumably last touched, and I independently confirmed the binding in source at `buildActivities.ts:449-451,474,1110` (item 11 above). The file's in-code claim of dormancy is **more conservative than reality** — a reader trusting only this comment would under-count reachability, the opposite failure direction from a silent cap. Worth a one-line comment fix in a future slice; not itself a reachability defect since the plan doc (task 9.16) and Lesson 77 (`apps/worker/CLAUDE.md`) both correctly record the binding — only this one file comment lagged.

## What this audit did NOT cover

- **Copilot surfaces** (`copilot.ts`, `copilotAsk`/`copilotBriefing`/`copilotConcept`, the subscription-arm machinery, tasks 9.6/9.24-9.28/9.34) — these are extensively covered by the plan's own 2026-07-26 audit round (tasks 9.24-9.28) and are adjacent to but not enumerated in this task's named scope (9.23/9.29-9.32, 9.10-A/B/C, 9.4/9.5/9.7/9.8 read paths, 9.21). Not walked here.
- **`projectRegistry`, `connectorConfig`, `crossWorkspaceLink`, `presetProfiles` routers** — confirmed mounted in `composeAppRouter` (`server.ts:137-141`) and bound to real ports at `boot.ts:1587-1607`, but these are Phase-14 tasks, not Phase-9-attributed; I did not trace their producers/consumers beyond confirming the mount.
- **`packages/workflows`** workflow *definitions* (`sourceIngestion.ts`, `disposition.ts`, `connectorSyncHealth.ts`) beyond the one activity-registration chain (item 12) needed to establish that `buildProofSpineActivities` is live, not just composition-root-constructed. I did not walk every individual workflow's own internal call graph.
- **`packages/db` migration/schema files** and the dual-dialect repository-contract test suite itself (`packages/db/test/contract/repository-contract.test.ts`) — I confirmed the two Phase-9-cited methods exist in both adapters but did not run the contract suite or audit schema/migration reachability beyond that.
- I did **not run** `pnpm typecheck`/`pnpm test`/`pnpm lint` — every classification above is from static trace (codegraph + targeted `Read`/`grep`) at HEAD, not from executing the suite. Per this project's own facts: `pnpm lint` is `tsc --noEmit` (no ESLint), and several worker tests are env-gated (`SOW_API`, `-live`, `SOW_L64_DRYRUN`) and skip by default — none of that was exercised or relied on here.
- **Desktop-side consumption** of any of these worker surfaces (whether the renderer actually calls `query.calendar`, `egressCommand.revokeEgressAck`, etc.) is the sibling desktop-track auditor's territory, not re-derived here.
