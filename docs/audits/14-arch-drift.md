# Phase 14 — Architecture Drift Audit (spec-vs-code at the phase-exit gate)

**Phase:** 14 — Onboarding, Config Surfaces & Runtime Substrate
**Area(s):** worker (`apps/worker`, `packages/db`), desktop (`apps/desktop`)
**Anchors audited:** ARCHITECTURE.md §19.1 (primary), §11, §13, §5, §8, §6, §4, §16 + IMPLEMENTATION_PLAN `### 14.1`–`### 14.7`
**Auditor:** arch-drift-auditor (read-only) · 2026-07-15
**Verdict:** **BLOCKED** — 1 DRIFT / 1 STALE-DOC / 0 ambiguous

Method: read only the cited anchor sections + the Phase-14 task blocks; located implementing symbols
via codegraph/graphify + targeted reads; confirmed the verified-by-test shortcut by running the
Phase-14 targeted test files ONLY (not the suite): worker composition/procedures **52 ✓**, worker
onboarding/connector/temporal/health/uiSafe **67 ✓** + **32 ✓**, db schema **48 ✓**, desktop
Phase-14 surfaces **71 ✓** — all green.

Note on EXPECTED-not-drift (per dispatch): the 14.7 read gate `resolveApprovedCrossWorkspaceSlice`
is reachability-WAIVERED (prod consumers 25.2/25.4 dormant, Lesson 11) — verified consistent, NOT a
finding; G62 (14.4 loopback Temporal) is the OWNER-RATIFIED hard-line→substrate downgrade (§14.4),
NOT a hard-line violation.

---

## §19.1 — Onboarding, Config Surfaces & Runtime Substrate (primary)

| # | Stated contract | Verdict | Evidence |
|---|---|---|---|
| 1 | `provisionWorkspace` replaces `provisionDev`; upsert-into-config PRECEDES registry union (no registry-known-but-config-less workspace) | OK | `apps/worker/src/composition/provisionWorkspace.ts:137-145` |
| 2 | Fail-closed WS-8 registry union; a genuine store fault is a typed err, never fold-to-empty | OK | `apps/worker/src/composition/workspaceRegistry.ts:49-66` |
| 3 | `onboarding.createWorkspace` tRPC mutation — candidate-gate + auth + redaction-safe errors | OK | `apps/worker/src/api/procedures/onboarding.ts:109-130, 172-186` |
| 4 | Workspace isolation-class (`type`) immutable through onboarding (`workspace_type_immutable`) | OK | `provisionWorkspace.ts:122-133` |
| 5 | Preset CAPTURED as onboarding input, NOT persisted to the frozen `Workspace` seam (vaultRoot→`markdownRepoPath`) | OK | `provisionWorkspace.ts:49-56, 100-106` |
| 6 | Connector-instance config surface + per-workspace registry (14.2) | OK | `composition/connectorConfig.ts`, `db/schema/connector-instance.ts` |
| 7 | Durable typed-Project registry + production `ResolveRegistryPort` (14.6) | OK | `composition/projectRegistry.ts`, `db/schema/project-registry.ts` |
| 8 | Cross-workspace link model + owner-approval flow feeding the GCL Visibility Gate (14.7) | OK | `composition/crossWorkspaceLink.ts` + `crossWorkspaceRead.ts` |
| 9 | System Health panel surfaces the already-minted `HealthItem` producers (14.3) | OK | `api/procedures/systemHealth.ts` + `renderer/surfaces/system-health/` |
| 10 | App supervises a loopback local Temporal dev-server, mirroring `MANAGE_GBRAIN_SERVE` (14.4) | **PARTIAL → see DRIFT-1** | `worker-host/temporal-supervisor.ts`, `worker-host/index.ts:118-127` |
| 11 | Invariant: fail-closed registry + approved-link-only cross-read + loopback+session-token auth on EVERY new surface | OK | every new procedure wraps `authedResolver`; `crossWorkspaceRead.ts:46` zero-bleed default |

All new command/query procedures (onboarding, connectorConfig, projectRegistry, crossWorkspaceLink,
presetProfiles) are boot-bound (`boot.ts:1167-1198`) + mounted (`server.ts:125-130`) behind
`authedResolver` — the "auth on every new surface" invariant holds.

## §4 — Operational Storage

| Stated contract | Verdict | Evidence |
|---|---|---|
| Workspace/connector config stores Keychain **references** only, never secret bytes | OK | `db/schema/connector-instance.ts:22-24` (`tokenRef` text ref; no secret column); parser whitelists — `procedures/connectorConfig.ts:56-72` |
| Dual-dialect Drizzle migrations + one repo-contract suite BOTH adapters pass | OK | `migrations/{sqlite,pg}/0007_project_registry.sql`, `0008_connector_instance.sql`, `0009_cross_workspace_link.sql`; db schema tests 48 ✓ |
| Read models rebuildable; the registry read-model is a rebuildable row | OK | `workspaceRegistry.ts:13-14` |

## §5 — Policy, Security & Egress

| Stated contract | Verdict | Evidence |
|---|---|---|
| Direct raw cross-workspace retrieval is a hard denial; default-CLOSED read gate | OK | `crossWorkspaceRead.ts:46` (absent link ⇒ `ok([])`); re-asserts status+directional+scope 51-54 |
| Explicit cross-workspace links are user-approved; the ONLY way raw content crosses; only on explicit approval (PENDING-until-approved) | OK | `crossWorkspaceLink.ts:114-125` mints `pending`; `approveCrossWorkspaceLink` 146-161 requires `status==='pending'`; revoked terminal 168-181 |
| Renderer↔worker session-token auth on every call | OK | all Phase-14 procedures use `authedResolver` |
| Sanitizer authorizes OUTPUT not raw bytes; read-back identity re-gate (`workspaceId===link.toWorkspaceId`) | OK | `crossWorkspaceRead.ts:63-73` (per-row re-gate + `GclProjectionSchema.safeParse`, fail-closed `sanitization_rejected`) |

## §6 — Knowledge: Markdown, Obsidian, GBrain & GCL

| Stated contract | Verdict | Evidence |
|---|---|---|
| One-writer: the project-creation path writes ONLY the operational row, never canonical Markdown (no KW/vault dep) | OK | `projectRegistry.ts:135-138, 199-204` (deps carry no writer — structural rule-1 boundary) |
| Project `workspaceId` (WS-2/WS-8 anchor) immutable through creation | OK | `projectRegistry.ts:177-185` (`project_workspace_immutable`) |
| GCL is the single cross-workspace read path; approved links the only raw-content crossing | OK | `crossWorkspaceRead.ts` gate is the reachable unit; deliberately NOT wired into the aggregate `queries.ts globalSurface` (documented §19.1 impl note) |
| Cross-doc: `CrossWorkspaceLink`/`ProjectRegistryEntry` shipped as db-owned DTOs, NOT frozen Appendix-A seam models | OK (consistent) | schema headers `cross-workspace-link.ts:6-8`, `project-registry.ts:4-8`; contracts Appendix-A table unchanged (28 models) — reconciled in §19.1 impl notes |

## §8 — Connector & Tool Gateways

| Stated contract | Verdict | Evidence |
|---|---|---|
| Connector-instance is a durable CONFIG record, NOT a live vendor call | OK | `connectorConfig.ts:64-116` (no transport/secret resolution) |
| `tokenRef` = opaque Keychain reference; a smuggled secret field is dropped by the whitelisting parser (rule 7 structural) | OK | `procedures/connectorConfig.ts:56-72` (field-pick whitelist) |
| `register` defaults `state=paused` (fail-safe; explicit-enable-only) | OK | `connectorConfig.ts:98-105` |
| Connector `workspaceId` binding immutable (`connector_instance_workspace_immutable`) | OK | `connectorConfig.ts:85-93` |
| Connector-ids match canonical adapter ids (Asana/Drive/Calendar/Granola/GitHub/Linear/Gmail; Todoist dropped) | OK | `composition/presetProfiles.ts:74-106` |

## §11 — Electron Desktop UI

| Stated contract | Verdict | Evidence |
|---|---|---|
| First-run onboarding offers Simple/Professional/Founder/Advanced presets | OK | `renderer/surfaces/onboarding/index.tsx`, `renderer/lib/preset-preview.ts`, `presetProfiles.preview` procedure |
| Presets "scaffold workspaces, repos, and brains" | PARTIAL (documented) | preset→profile MAPPING + `preview` shipped; profile-APPLICATION (actually scaffolding connectors/schedules) is a documented later step (§19.1 impl note "(later)"; schedules→Phase 25). Consistent with the 14.5 Done-when (mapping+divergence only). Not drift. |
| System Health surface; renderer renders UI-safe items | OK | `renderer/surfaces/system-health/index.tsx` (reuses hydrated `state.health`, desktop Lesson 11) |
| Cross-workspace-links owner-approval surface (UI-safe-only, deliberate per-link approve) | OK | `renderer/surfaces/cross-workspace-links/index.tsx` (desktop Lesson 12) |

## §13 — Deployment, Install, Rollback & Repair

| Stated contract | Verdict | Evidence |
|---|---|---|
| App supervises a loopback local Temporal dev-server (127.0.0.1:7233), mirroring `MANAGE_GBRAIN_SERVE`, env-gated default-OFF | OK | `temporal-supervisor.ts:70` (`SOW_MANAGE_TEMPORAL==="true"` strict); `worker-host/index.ts:118-127` byte-equivalent default-OFF |
| Loopback-only bind ENFORCED (start refuses non-loopback; `--ip`/`--ui-ip` forced to validated loopback) | OK | `temporal-supervisor.ts:64-66, 168-171` (`isLoopbackHost` + `parseTemporalHostPort`) |
| Leaves Temporal-DEGRADED mode when the managed server is healthy; clean stop on quit | OK | `worker-host/index.ts:115-127, 254-260` (`connectTemporal` targets the managed addr; `dispose()` on quit) |
| **Local Temporal dev server PERSISTENT storage (`--db-filename` SQLite under app data, NEVER in-memory)** | **DRIFT** | `temporal-supervisor.ts:64-66` `temporalServerArgs` omits `--db-filename`; `worker-host/index.ts:122` calls `createTemporalSpawner()` with no options/extraArgs ⇒ `temporal server start-dev` defaults to IN-MEMORY storage |

## §16 — Cross-cutting concerns

| Stated contract | Verdict | Evidence |
|---|---|---|
| `HealthItem` typed record: `failureClass`, `severity`, `auditRef`, `state`(open\|acknowledged\|resolved), distinct/persistent/audit-linked | OK | `contracts/src/models/health-item.ts:23-75` (matches Appendix-A row incl. task-11.8 C-enum classes) |
| Redaction strips secrets + raw content before the surface sink; `toUiSafeHealthItem` drops `message`/`auditRef`/`parityReportRef`/`factIdentity` | OK | `api/projections/uiSafe.ts:80-90` |
| Producer routing (`worker_down`/`keychain_locked`/`parity_defect`) into the durable surface; `coverage-degrade`+connector `auth_locked` unbuilt (Phase 16/23) | OK (documented) | `health/surface.ts`; §19.1 14.3 impl note — route-when-built, not a gap |

---

## Findings

### DRIFT (code ≠ spec, spec is right) → orchestrator escalates

**DRIFT-1 — §13/§9 · 14.4 managed Temporal runs IN-MEMORY (missing `--db-filename`).**
§13 requires the app-managed local Temporal dev server to use **persistent SQLite storage
(`--db-filename` under app data, "never in-memory")**. The shipped supervisor spawns
`temporal server start-dev --ip <loopback> --port <port> --ui-ip <loopback>`
(`temporal-supervisor.ts:64-66`) with **no `--db-filename`**, and the worker-host calls
`createTemporalSpawner()` with no options/extraArgs (`worker-host/index.ts:122`), so the CLI
default (**ephemeral in-memory DB**) applies. Impact: on the opt-in path (`SOW_MANAGE_TEMPORAL=true`)
all workflow history is lost on every app restart, defeating §9 **LIFE-3** ("in-flight workflows
resume after restart/sleep", REQ-NF-006) and the §13 persistence contract. No in-code `arch_gap`
notes the deferral — it is a silent gap, not a documented one.
*Severity context (not inflation):* dormant-by-default (managed Temporal is OFF unless the operator
opts in — the shipped default runs Temporal-DEGRADED, no server spawned), and this is a
durability/correctness gap, NOT a safety-rule / hard-line crossing. Right-size: pass
`--db-filename <appData>/temporal/temporal.db` (via a spawner option / `extraArgs`) so the managed
server persists.

## Architecture-doc / tracker notes (STALE-DOC: code is right, doc lags) → NOT findings

**STALE-1 — IMPLEMENTATION_PLAN 14.1/14.2/14.3/14.5 status headers say the desktop legs are
"PENDING," but they have shipped.** The desktop onboarding UI + preset picker (`ad624a16`),
connectors surface + System Health panel (`7d141528`) landed; the surfaces + tests exist
(`renderer/surfaces/{onboarding,connectors,system-health}`, desktop Lessons 8/9/10/11; 71 desktop
tests green). Yet the status blocks still read "DESKTOP UI PENDING (partial)" (14.1:2410),
"DESKTOP connectors surface PENDING" (14.2:2420), "RENDERER PANEL PENDING (desktop)" (14.3:2429),
"DESKTOP preset picker PENDING" (14.5:2447) — while 14.7's status WAS updated to reflect its desktop
leg (`31a0a0d3`). The code is ahead of the tracker. Suggested: update the four status headers +
tick the flow/Done-when checkboxes (orchestrator territory).

## Ambiguous (can't tell which side is right)

None.
