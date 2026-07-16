# Session 081 — Phase 14 worker foundation (worker-impl)

**Date:** 2026-07-15 · **Role:** worker-impl (implementer, worker/db track) · **Team:** `session-734f946b` (orchestrator `orch22`, lead) · **Branch:** `main`

**Scope:** the five foundational **Phase 14** (Onboarding, Config Surfaces & Runtime Substrate — ARCH §19.1) worker/db legs the desktop UI depends on. All PURE-BUILD / dormant-safe — **no arming hard line crossed** (loopback-only; no external network / spend / credential / real-transport bind).

## Slices shipped

| Task | Slice | Commits |
|---|---|---|
| 14.1 | Workspace onboarding & provisioning (`provisionWorkspace` + `onboarding` procedure; supersedes dev-only `provisionDev`) | `e1e4cfd` |
| 14.6 | Durable typed-Project registry + production `ResolveRegistryPort` + creation path | `b9dc03b` (db store) · `21ee906` (port + creation) |
| 14.2 | Per-workspace connector-instance config registry + `connectorConfig` procedure | `bda2c91` (db store) · `6f639a6` (config path) |
| 14.5 + 14.3 | Preset provisioning profiles + `presetProfiles.preview` query (14.5); System-Health read-path verify + redaction pins (14.3) | `a81040e` (bundle) |

Round close (lead): `9ce831eb` (pushed).

## What landed (by area)

- **`@sow/db` operational-store pattern (×3 new dual-dialect repos):** `WorkspaceConfigRepository` reuse (14.1) + NEW `ProjectRegistryRepository` (14.6) + `ConnectorInstanceRepository` (14.2). Each: a db-owned `*Row` DTO (contracts primitives — `@sow/db` never imports `@sow/workflows`), a SQLite + Postgres table + additive migration (0007, 0008), the ONE repo-contract suite green on BOTH dialects, mapped to a workflow-port type at the worker boundary where needed.
- **WS-8 (safety rule 4) throughout:** the fail-closed `{workspaceIds}` registry is the SOLE scoped-read visibility authority (14.1); resolution/creation gate on `resolveKnownWorkspace` (exported from `readModel.ts` for reuse); the resolved workspaceId always comes from the STORED row, never a caller field (anti-smuggle).
- **The immutable-workspace-binding-anchor (recurs 3×):** 14.1 workspace `type`→dataOwner, 14.6 project `workspaceId`, 14.2 connector-instance `workspaceId` — every re-registration that changes the binding is rejected (`*_immutable`); get-before-upsert; get-fault fails closed. → **banked as a lesson** (orchestrator, round close).
- **`ResolveRegistryPort` (14.6):** production port over the durable store, superseding `FakeResolveRegistryPort`; global `resolveRef` (projectId-PK precedence over alias; ambiguous-alias fail-closed); frozen closed error set `{project_unknown, provider_unmapped}` never expanded; total (never throws).
- **tokenRef reference-only (14.2, rule 7):** the connector record persists an opaque Keychain REFERENCE only — never credential bytes; the procedure's whitelisting parser structurally drops any smuggled secret/state field; no live vendor call; register defaults `paused` (fail-safe).
- **Preset profiles (14.5):** 4 distinct tiers; the no-arming guarantee is STRUCTURAL — `policyDefaults` typed literal-`false`/`"isolated"` + `Object.freeze`d (runtime-enforced); egress CLOSED; connector ids match the canonical adapter ids. Reachable via the auth-gated read-only `presetProfiles.preview` query (the desktop picker's data source).
- **System-Health read path (14.3):** a VERIFY (no source change) — the mint→durable-`HealthSurface`→redaction-safe-read chain is built (Phase 10). Pinned non-vacuously: a marker-secret in `HealthItem.message` is retained at rest but dropped by `toUiSafeHealthItem` (message/auditRef/parityReportRef/factIdentity), asserted absent through both the durable read and the `systemHealth` procedure.

## Reviews

Every slice dual-reviewed (security=invariant on the WS-8 / rule-7 / rule-1 / no-arming surfaces; code-quality every-slice). **All security reviews CLEAN — 0 critical/high; no arming hard line.** Findings resolved in-slice: the 14.6 `resolveRef` PK-precedence bug + the WS-2-anchor immutability guard (orch-ruled fix-in-slice); the 14.2 WS-8 registry-read-fault test gap + smuggled-state pin; the 14.5 `Object.freeze` + connector-id alignment (orch-ruled). Reviewer-subagents were `general-purpose`-class `security-reviewer` / `code-quality-reviewer`.

## Reachability / dormancy (Lesson 11)

- Reachable production entries this round: `onboarding.createWorkspace`, `projectRegistry.createProject`, `connectorConfig.{register,setState,setCadence}`, `presetProfiles.preview` — all boot-wired.
- **Deliberately deferred (dormant consumers — no dormant-on-dormant wiring):** binding the production `ResolveRegistryPort` into the dormant `runProjectSync` (→ the spine); the Phase-16 connector composition + Phase-23 arming that consume the connector-instance record; the desktop onboarding/connectors/System-Health surfaces.

## Cross-track

The `ApiServerDeps` gained `onboarding`/`projectRegistry`/`connectorConfig` as REQUIRED fields (an optional port would risk an unmounted router) → constant-only test stubs added to the eval-security `auth-suite.ts serverDeps` (authorized per the round-2 precedent; orchestrator writes the Carry-forward eval-review note covering all 3 stubs). `presetProfiles.preview` has no dep → no ripple.

## Follow-ups flagged (orchestrator-owned at round close)

- **arch_gaps (in-code):** store-fault→`project_unknown` folding (14.6 — a distinct degraded signal is a spine-arming decision); non-atomic get-then-upsert TOCTOU on the registry unions / connector register (14.1/14.6/14.2 — single-writer/CAS follow-up).
- **Future-TODO:** document the adapter-declared connectorIds as canonical + consider whether the 14.2 registry should VALIDATE `connectorId` against the known adapter set.
- **Cross-doc (orchestrator writes):** NEW `ProjectRegistryEntry`/`ProjectIdentity` (durable), `ConnectorInstance`, `PresetProfile` operational-record notes; §4/§8 added to the Phase-14 header; the immutable-anchor lesson.

## Gates (final)

Full worker suite green (1415 tests at 14.2 close), `@sow/db` 397, `@sow/workflows` 549; repo-wide turbo typecheck 20/20 + lint 11/11 at every slice close. Migrations additive (0007, 0008), both dialects; lifecycle `applied` 6→9.

**Handoff:** successor `worker-impl2` picks up **14.7** (cross-workspace links — the sanctioned WS-8 cross-read path; a separate safety slice). This session cycled at round close. **Successor session:** [082-2026-07-15-worker-impl2-phase14-15-spine.md](082-2026-07-15-worker-impl2-phase14-15-spine.md).
