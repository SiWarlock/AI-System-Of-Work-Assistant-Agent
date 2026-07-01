# Phase-2 Security Audit — Operational Storage (`@sow/db`)

**Reviewer:** security-reviewer (phase-boundary dispatch, `/phase-exit 2`)
**Date:** 2026-06-30
**Verdict:** **CLEAR**
**Review surface:** accumulated Phase-2 diff, `packages/db/src/**` + `packages/db/test/**`
(commits `48a7260`→`78c3267`, plus 2 uncommitted comment-only test edits). No feature
branch exists (single-track on `main`), so the surface is the accumulated track diff —
acceptable per the phase-boundary over-approximation rule.

This dispatch IS the whole-system security pass for Phase 2; the phase-exit checklist
security row records this verdict.

---

## Invariant pass (safety rules touched by the operational store)

| # | Invariant | Verdict | Evidence |
|---|---|---|---|
| 7 | **Secrets** — no plaintext-secret column, either dialect | **PASS** | Snapshot + `provider-state.ts`/`pg/provider-state.ts` sources carry only `{provider,endpoint,model,capabilities,egressClass,costCaps,conformanceStatus}`. `operational-schema.test.ts` §"Unit 2.1 no plaintext-secret" and `column-parity.test.ts` iterate the **real Drizzle column objects** for BOTH `sqliteTables` and `pgTables` against a forbidden set (`apikey/secret/token/password/credentials/privatekey/rawcontent/rawbefore/rawafter`). Every schema header restates REQ-S-003 ("Keychain references only"). No secret-shaped literal persists in any fixture. |
| §4 D-001/004/005 | **No semantic-truth / workflow-history / GBrain-index smuggling** | **PASS** | No `markdown/frontmatter/body/rawContent/embedding/vector` column anywhere. `markdownRepoPath` (workspace_config) is a filesystem **config path**, not content. Event log stores the run **reference** (Temporal owns full history — `event-log.ts:18`). Audit before/after are `beforeSummary`/`afterSummary` + `payloadHash` (no raw content, §16). GCL projections carry `sanitizedPayload` only. |
| §4 truth-integrity | **Append-only / immutable / exactly-once** | **PASS** | Append-only (event log) + immutable/tombstone (audit) are **structural** — neither repo exposes an update/delete method; only the rebuildable read-model store exposes destructive `put`/`clear`. Exactly-once approval CAS shares ONE pure decider (`decideApprovalCas`) across both adapters. |

## CAS exactly-once — focused analysis (BLOCKED trigger #2)

`applyTransition` (both adapters, sqlite `:342`, pg `:375`):
1. SELECT current — used ONLY to distinguish `not_found` and to produce the record
   returned on an idempotent replay. It is **not** the authority.
2. `decideApprovalCas(current, expectedFrom, next)` — pure: `current===next`→
   idempotent_noop (no write); `isTerminal(current)`→stale_conflict (no
   tombstone resurrection); `current===expectedFrom`→apply; else stale_conflict.
3. Winner performs the **atomic conditional write** `UPDATE … WHERE id=? AND
   status=expectedFrom RETURNING`. Under concurrency the loser matches **0 rows**
   → `stale_conflict` (SQLite serialized writer; Postgres row-lock re-evaluates the
   `WHERE` against the committed row). **No double-apply, no wrong-apply, no TOCTOU
   escape** — the SELECT being stale only ever downgrades to a safe `stale_conflict`.
4. Replay (`expected==current && next==current`) returns `ok(current)` with **no
   write** — cannot be abused to skip a legitimate transition (a same-status no-op
   leaves the record unchanged; a subsequent legitimate CAS still wins).

Covered by `operational-truth.test.ts` (winner / concurrent-same-target noop /
replay / stale-different-target / non-terminal mismatch / cannot-exit-terminal /
terminal-replay) **and** the dual-dialect contract suite + per-adapter tests
(`repository-contract.test.ts:467/709`, `postgres.test.ts:258`, `sqlite.test.ts`).

## Migration / backup safety (BLOCKED trigger #3 — injection; half-applied store)

- **Backup-before-migrate mandatory**: `applyMigrations` fails closed on backup
  failure (`backup_failed`, DB untouched). Apply failure → restore; restore failure →
  `apply_failed_unrestorable` (CRITICAL, do-NOT-start). `record_failed` correctly does
  NOT roll back valid applied data. `version-compat` gate fails closed on
  `unknown_app_version` / corrupt marker / `schema_ahead_of_app` / `schema_below_minimum`.
- **Restore-on-failure exercised both dialects**: `lifecycle.test.ts:303/395/420`
  (restored / unrestorable / record-failed) + `backup-restore.test.ts:338/476` restore +
  integrity gate that **fails closed** on row-digest divergence (`integrity_check_failed`).
- **No SQL injection in DDL/migration paths**: every adapter `WHERE`/`SET` uses
  Drizzle parameterized builders. The only string-built SQL is `recordApply`
  (`sqlite-engine PRAGMA user_version = ${Math.trunc(v)}`, `pg-engine INSERT … VALUES
  (${Math.trunc(v)})`) — the interpolated value is a `number` (provably not a string
  injection vector; NaN→syntax error→typed err) and the table name is a compile-time
  constant. `migrationsFolder` is operator config (a filesystem path), not user input,
  not SQL. No unparameterized **user-controlled** identifier anywhere.

## Error handling / degraded mode (BLOCKED trigger #5-adjacent)

- **Typed Result everywhere, no throw across a boundary**: every adapter method wraps
  in `run(...)` → `toDbError`; `DbErrorCode` is a closed 6-member set; `not_found` is a
  typed result, not an exception.
- **No `any` on any repo surface** (grep clean); DTO mapping uses type assertions, not `any`.
- **Degraded mode fails closed**: `onDbConnectionFailure` returns a typed Result, emits a
  deduped audit-linked HealthItem (validated through `HealthItemSchema.safeParse`), and
  **queues writes where possible but never fakes reads** (`not_queueable`), `recover()`
  errs (not throws) if called while available. Confirmed by `degraded.test.ts:36/78`.

---

## Non-blocking observations (low / informational — route per Step-9 matrix)

1. **[low] `audit.query` unbounded in-memory read** (`adapters/sqlite/index.ts:314`,
   `adapters/postgres/index.ts:347`). Both `.all()` the entire audit table (the
   fastest-growing operational-truth table) then apply `limit` via JS `.slice(0,limit)`;
   the `ref` filter is also applied in JS. Not a safety-invariant violation and bounded
   in practice by a single-operator local store, but a resource-exhaustion-adjacent
   growth path. Recommend a SQL-level `LIMIT` once the dialect-agnostic forward order is
   pinned (the existing task-2.9 `arch_gap` on audit ordering). action: defer.

2. **[low] Digest table-name interpolation without an allow-list assertion**
   (`periodic-backup.ts:347 sqliteRowDigest`, `pg-ops.ts:74 pgRowDigest`): `"${t}"` is
   interpolated into `SELECT`. All current call sites pass the frozen
   `OPERATIONAL_TRUTH_TABLES` constant, so **not exploitable today**, but the `tables`
   param is injectable. Defense-in-depth: assert each `t` ∈ a known-table allow-list
   before interpolation. action: defer.

3. **[low] `appendAuditRef` non-atomic read-modify-write** (`workflowRunRefs`, sqlite
   `:282` / pg `:310`): SELECT-then-UPDATE of the `auditRefs` array with no conditional
   or transaction — concurrent appends could lose an entry (last-write-wins). Not an
   exactly-once/tombstone invariant; workflow refs are effectively single-writer per
   workflow (Temporal). action: defer.

4. **[info] Opaque driver cause/message retained** (`errors.ts` both dialects):
   `toDbError` keeps the raw driver `message` + opaque `cause`, which can echo column
   *values* (e.g. `idempotencyKey`, `payloadHash`) — but **never secrets or raw content**
   (no such columns exist). The §16 redaction-before-log-sink obligation lives at the
   worker's log sink, not this layer. Cross-layer note: confirm the worker redacts
   `cause`/`message` before any log sink. No finding in this diff.

5. **[info] Test-only credential literal** `POSTGRES_PASSWORD=sow`
   (`repository-contract.test.ts:189`) — a throwaway env var for an optional Docker-pg
   gate, not a schema column or a persisted fixture secret. Acceptable.

## Recorded carry-forward (explicitly NOT a blocker, per dispatch)

`degraded-mode.ts:32` maps the DB-unavailable degraded mode onto OBS-2
`failureClass = "worker_down"` because §16's enum has no dedicated `db_unavailable`
member (kept distinct by `subjectRef`+message). Flagged upstream as an arch_gap; a
precise `db_unavailable` class is the clean fit. Not a security blocker.

---

## Verdict rationale

No real secret column, no semantic-data column, no CAS double-apply, no
tombstone-resurrection path, no user-controlled injection surface, fail-closed
migration/backup with restore exercised on both dialects, and typed-Result /
no-throw / no-`any` discipline throughout. All BLOCKED triggers are absent; the only
observations are defer-class hardening. **CLEAR.**
