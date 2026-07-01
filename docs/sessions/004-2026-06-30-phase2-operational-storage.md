# Session 004 — Phase 2: Operational Storage (`@sow/db`)

- **Date:** 2026-06-30
- **Predecessor:** `003-2026-06-30-phase1-contract-freeze.md` (Phase 1 — contract + domain layer, CLEAR)
- **Operating model:** single-operator, Workflow-driven (Claude Code, ultracode). NOT an agent team.
- **Outcome:** **Phase 2 COMPLETE** — the dual-dialect operational store (SQLite + Postgres) is built, green, and certified at `/phase-exit 2`. The parallel tracks (Phase 3/4/5/6) may fork.

> **Cold-start note:** this doc is written to be self-contained. If you're resuming with fresh context, read this doc + `IMPLEMENTATION_PLAN.md` (Currently-in-progress + Carry-forward + Phase 3) + memory `system-of-work-prd`, then use the **Resume prompt** at the bottom.

---

## Headline

Phase 2 built `@sow/db` — the app-owned operational store — with **SQLite and Postgres adapters from day one**, both passing a single behavioral **repository contract suite** (REQ-D-003). The "real, non-mocked Postgres" requirement is satisfied by **PGLite** (Postgres 16 compiled to WASM — the same engine GBrain uses), running in-process; an optional `postgres:16` **Docker gate** (`SOW_PG_DOCKER=1`) is wired but skipped by default. Built via two Workflow fan-outs (implementation, then a parity repair). Final gate: **985 tests + 2 gated Docker todos, typecheck clean across 3 packages, `pnpm audit --prod` clean, `/phase-exit 2` CLEAR.**

## What was built (`@sow/db`)

Extends the schema + repo interfaces frozen in Phase-1 task 1.14.

- **Schema — both dialects (2.1):** the 10 tables (9 domain files; event-log holds `eventLog` + `workflowRunRefs`) exist as `drizzle-orm/sqlite-core` **and** parallel `drizzle-orm/pg-core` definitions with identical column-name sets + portable types (text/integer/boolean; nested → one `json` column; ISO-text timestamps). `operational-schema.test.ts` freezes a snapshot asserting sqlite ≡ pg column names ≡ the Appendix-A field sets. No plaintext-secret column in either dialect.
- **Adapters (2.3/2.4):** `createSqliteRepositories` (better-sqlite3) + `createPostgresRepositories` (pg-core; driver-agnostic — PGLite in tests, node-postgres in prod). Every method returns `Result<T, DbError>`; driver errors mapped to typed codes; never throws across the boundary.
- **Operational-truth invariants (2.5):** `src/invariants/operational-truth.ts` — append-only event log, immutable/tombstone audit, exactly-once approval **compare-and-set**, rebuildable read models. **Both adapters import + use `decideApprovalCas`** (single shared implementation).
- **Migration lifecycle (2.6):** dialect-aware runner (`src/migrate/runner.ts` + `sqlite-engine.ts` + `pg-engine.ts`) — backup-before-migrate → transactional apply → **restore-from-backup on failure** → typed repair message. Postgres schema-version marker in a `_sow_schema_version` table (no PG `PRAGMA user_version`).
- **Version-compat (2.7):** `assertSchemaCompatible(appVersion, schemaVersion)` — refuses an incompatible pairing (exact-match, fail-closed) with a typed repair message; no silent forward break. Genesis seeds: `CURRENT_SCHEMA_VERSION=1`, app `0.1.0`.
- **Degraded-mode (2.8):** DB-unavailable → typed DEGRADED mode + audit-linked System Health item + queue-where-possible; nothing silent.
- **Contract suite (2.9):** ONE parameterized suite asserting SQLite/Postgres(PGLite) behavioral equivalence across every repo interface + the operational-truth invariants + the typed-Result convention. Optional Docker-pg run gated on `SOW_PG_DOCKER=1`.
- **Backup/restore (2.10):** periodic backup + exercised restore for BOTH dialects (SQLite byte-stable; PGLite via `dumpDataDir`/`loadDataDir` — row-digest recovery invariant, byte-match not asserted for PG). `packages/db/docs/at-rest-posture.md`: FileVault = the §13 install-doctor prerequisite; SQLCipher explicitly V1.1-deferred.

## Decisions

- **PGLite as the "real Postgres" for the contract suite + optional Docker-pg gate** (owner choice this session). Production Postgres driver = `pg`; tests use PGLite (real PG16, in-process). Docker-pg behind `SOW_PG_DOCKER=1`.
- **ADR-009 (single-dialect source) is now COMPLETED** — Phase 1 shipped sqlite-core only; Phase 2 added the pg-core mirror + the both-dialect contract suite as ADR-009 planned.
- **Async storage ports:** the `MigrationEngine` / backup / restore ports + orchestrators went from sync `Result` to **async `Promise<Result>`** because PGLite is async end-to-end (the only callers were the two lifecycle/backup test files). `BackupSink` stayed sync (fs).

## Findings & carry-forward

- **NOTE (carried forward):** degraded-mode reuses the frozen OBS-2 `failureClass = 'worker_down'` for DB-unavailable because the enum has no `db_unavailable` member. Correctly abstracted behind a named constant (`DB_UNAVAILABLE_FAILURE_CLASS`) + flagged `arch_gap` in-code, so pinning a `db_unavailable` OBS-2 class upstream is a one-line swap. **To do:** add `db_unavailable` to the HealthItem `failureClass` enum (ARCHITECTURE.md Appendix A + §16 + `packages/contracts/src/models/health-item.ts` + its snapshot) in a future round.
- **Still open from Phase 1** (unchanged): the **candidate-data gate composition** Finding (ajv `validate()` is structural-only — compose ajv + Zod parse + §3 universal rules at §5/§7/§9); the 5 state-machine `arch_gap` recovery edges (pin at §9/Phase-7); ESLint/format tooling still a `tsc` placeholder.

## Process note

The Phase-2 implementation ran clean (no burst). The **parity repair** hit an agent stall (R1 died on all retries) but **R3 self-recovered** — it detected the missing pg engine and built `src/migrate/pg-engine.ts` + `src/backup/pg-ops.ts` itself. (See memory `workflow-fanout-burst-stall-repair`.)

## `/phase-exit 2` — verdict

- [x] All 2.1–2.10 task checkboxes + acceptance criteria (2) ticked.
- [x] `/preflight` — test (985 + 2 gated todos) + typecheck (3 pkgs) green; lint = tsc placeholder; `format:check` waived (no prettier).
- [x] Cross-doc invariants — no frozen model field change (the pg mirror uses the same field sets; the `db_unavailable` enum gap is a recorded carry-forward, not a silent change).
- [x] Spec coverage — `spec-lint tests 2` PASS (§4/§12/§13/§16/§3 tagged; §2.5 waived — worker-track structural).
- [x] Dependency audit — `pnpm audit --prod` clean.
- [x] Reachability — judgment-waived (still no production entry point consuming `@sow/db`; apps/worker land Phase 7+). Re-run once the worker exists.
- [x] Arch-drift + security auditors — **both CLEAR** (`docs/audits/phase2-{arch-drift,security}.md`). Arch-drift surfaced one §16 finding — HealthItems are operational truth but persisted **in-memory only** — **owner-approved as a deferment to Phase 10** (System Health/observability owns the `health_items` table + backup there). Security flagged 3 low + 2 info hardening items (carry-forward: bound audit reads, atomic `appendAuditRef`, digest table-name allow-list, §16-redact driver errors, drop the test docker-password literal).
- [x] Session doc (this) + commits pushed.

## Commit map (Phase 2)

| Commit | What |
|---|---|
| `48a7260` | Phase-2 DB drivers (better-sqlite3 · PGLite · pg · drizzle-kit) |
| `c0c7c36` | 2.1 — pg-core schema mirror + operational-schema snapshot |
| `8852d2a` | 2.3/2.4 — SQLite + Postgres repository adapters |
| `3b16486` | 2.5/2.6/2.7/2.8 — invariants · migrations · version-compat · degraded-mode |
| `af0ce1f` | 2.9/2.10 — both-dialect contract suite + backup/restore + barrel |
| `78c3267` | parity fix — pg migration/backup engine + dual-dialect lifecycle + CAS reconciliation |
| _(this doc + plan/DECISIONS/EVALUATION sync + phase-exit)_ | Phase-2 close-out |

---

## Resume prompt (cold start → Phase 3+)

> Resume the System of Work Assistant build (repo: SoW-build, `main`, pushed to origin). **Phases 0–2 are COMPLETE and certified** — Phase 1 (27 frozen contract models + the pure domain layer: validators, 6 state machines, key builders) and Phase 2 (`@sow/db` dual-dialect operational store: SQLite + Postgres(PGLite) adapters, both passing one repository contract suite, migrations w/ backup-restore, version-compat, degraded-mode). **985 tests green; typecheck clean; `pnpm audit --prod` clean.** Read `docs/sessions/004-…` (this handoff) + `003-…`, memory `system-of-work-prd` + `solo-session-full-closeout` + `workflow-fanout-burst-stall-repair`, and `IMPLEMENTATION_PLAN.md` (Currently-in-progress + Carry-forward + the target phase).
>
> **Phase 1 unblocked all parallel tracks — Phase 3/4/5/6 may now run concurrently.** Pick the next phase (recommend **Phase 3 — Policy, Security & Egress**, `packages/policy`, on the critical path 0→1→3→6→7→8→9: workspace policy resolution, the provider×capability matrix, the four hard denials incl. the Employer-Work egress veto + ING-7 admission gate, and the per-launch session-token worker-API auth — all fail-closed, audit-emitting, redaction-safe). Alternatively fork Phase 4 (Knowledge/GBrain write-through) or Phase 5 (Provider/Runtime Broker).
>
> **Carry these forward:** (1) the **candidate-data gate composition Finding** — the ajv `validate()` gate is structural-only, so §5/§7/§9 MUST compose ajv + the model's Zod parse + the §3 universal rules + the §5/§6/§7 predicates, never ajv alone (Phase-3 policy enforcement is the first real consumer). (2) Add a `db_unavailable` member to the OBS-2 `HealthItem.failureClass` enum (frozen-contract edit: ARCHITECTURE Appendix A + §16 + health-item.ts + snapshot). (3) The 5 state-machine `arch_gap` recovery edges pin at §9/Phase-7. (4) Stand up real ESLint + Prettier (`lint`/`format:check` are placeholders).
>
> **Method:** single-operator + Workflow fan-outs; honor TDD (deterministic code test-first); Zod-as-source for any new contract; commit per batch (explicit `git add`, Conventional Commits + `Co-Authored-By: Claude Opus 4.8 (1M context)`); push origin/main. **Run the FULL close-out discipline per memory `solo-session-full-closeout`** — session doc, hot-routing, `/orchestrate-end` (incl. Step-5.5 Carry-forward triage), and a formal `/phase-exit <n>` with the reviewer sub-agents (arch-drift + security) on phase completion. Effort: ultracode. Don't touch `.env`/`scaffold/`.
