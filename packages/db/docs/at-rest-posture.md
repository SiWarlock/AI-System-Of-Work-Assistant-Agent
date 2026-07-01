# Operational store — at-rest posture & backup/recovery (Phase 2, task 2.10)

> Spec anchors: ARCHITECTURE.md **§4** (Operational Storage — at-rest encryption,
> failure modes), **§13** (install doctor / FileVault prerequisite), **§15**
> (deferred work), **§16** (Backup & recovery). REQs: REQ-D-001/004/005,
> REQ-NF-001, REQ-S-003.

This document records the **at-rest control** for the operational DB and the
**backup/restore recovery path** for the not-rebuildable operational-truth set. It
is documentation of an install-time prerequisite plus a code seam — it does **not**
re-implement disk encryption.

## 1. At-rest encryption — macOS FileVault (V1)

**V1 relies on macOS FileVault full-disk encryption** as the at-rest control for
the operational store (SQLite by default, `§13`) **and** Temporal persistence. The
operational store therefore writes **no app-level-encrypted columns** — encryption
at rest is provided by the volume, not the app.

- **FileVault-enabled is a documented install prerequisite** surfaced by the
  install doctor (`§13`: "checks prerequisites … FileVault on …"). The doctor
  returns a typed repair step when FileVault is off; this module assumes it is on.
- This is a **prerequisite, not something re-implemented here.** The DB layer owns
  no disk-encryption code; it only documents the dependency and keeps the data
  model free of plaintext secrets (REQ-S-003 — secrets are Keychain *references*
  only, never a column).
- **Local backup artifacts inherit the same control.** The periodic backup writes
  artifacts to the **same FileVault-encrypted local disk**, so a backup is no less
  protected at rest than the live DB. A **remote** operational-DB backup is an
  owner option (`§16`) and, if enabled, must carry its own at-rest control — out of
  scope for V1.

## 2. App-level encryption (SQLCipher) — EXPLICITLY V1.1-deferred

**App-level encryption is explicitly deferred to V1.1** (`§4`, `§15`):

- **SQLCipher** for the operational store, and
- **encrypted Temporal persistence**.

This is **not** implemented in V1 and is **not** a gap — it is a recorded scope
boundary (`§15` "app-level at-rest encryption (SQLCipher / encrypted Temporal
persistence)"). FileVault is the V1 control; SQLCipher is the V1.1 hardening on top.

### The seam left for V1.1

The backup capture/restore path goes through dialect ports
(`OpStoreBackupEngine` / `RestoreEngine` in `src/backup/`) that treat the DB image
as **opaque bytes**. A V1.1 SQLCipher-backed engine is a drop-in: it encrypts on
`capture()` / decrypts on `rebuild()` (keyed via `SecretsPort`/Keychain) **without
changing the pure orchestrators** (`runPeriodicBackup` / `restoreFromBackup`) or
their callers. No V1 schema, repository interface, or orchestrator anticipates a
plaintext layout that SQLCipher would have to break — the seam is the engine port,
nothing more.

## 3. Backup & recovery — the operational-truth recovery path (§4/§16)

The operational DB and Temporal persistence are **operational truth and not
Git-backed** (`§16`). Recovery is by a **periodic local backup with a documented,
exercised restore**.

### What is / isn't recoverable

| Set | Tables | Recovery |
|---|---|---|
| **Operational truth — NOT rebuildable** | event log, audit, approvals, outboxes, connector cursors (+ workspace config, workflow-run registry, provider state) | **Backup/restore is the only recovery path** — exercised here (`§4`/`§16`). |
| **Rebuildable** | read models | Reconstructed from operational truth + Markdown (rebuild routine, task 2.5); captured by the whole-DB snapshot but not part of the recovery *contract*. |
| **Derived** | GCL projections | Rebuildable from the GCL master + source facts. |

The integrity digest the restore verifies (`OPERATIONAL_TRUTH_TABLES`) is scoped to
the **not-rebuildable** set — the truth that genuinely cannot be reconstructed.

### Cadence, retention, and the related backups

- **Periodic local backup** — `runPeriodicBackup(engine, sink, { intervalMs, now,
  keep, force })`. Cadence uses **persisted last-run bookkeeping** (the newest
  artifact's timestamp), not a naive wall-clock heuristic (`§16` Configuration &
  time). Retention keeps the `keep` newest artifacts (default
  `DEFAULT_BACKUP_RETENTION`).
- **Pre-migration backup** is **mandatory and separate** (`§4`, task 2.6,
  `src/migrate/`): every migration backs up first and restores on failed apply.
  The periodic backup is the steady-state recovery point between migrations; it
  does not replace the pre-migration backup.

### Restore — consistent or nothing (fail closed)

`restoreFromBackup(sink, engine, { backupId? })` rebuilds the store from a backup's
bytes and runs an **integrity gate**:

- **Row-consistency** — the rebuilt operational-truth digest MUST equal the
  backup's recorded digest. On mismatch the restore **fails closed** with a typed
  `integrity_check_failed` (`§16`: nothing recovers silently into a corrupt state);
  the half-built handle is disposed.
- **Byte-consistency** — the rebuilt store re-serializes to the exact backed-up
  image (`bytesMatched`), reported alongside.

The restore is **exercised** end-to-end on SQLite in
`test/backup/backup-restore.test.ts`: a seeded operational store is backed up to a
local artifact and restored, yielding a **byte- and row-consistent** store across
every not-rebuildable domain.

### Dialect portability & the Docker-pg gate

The orchestrators are pure and dialect-agnostic; the SQLite engine is the V1 local
default (`§13`). A Postgres engine implements the same ports (dump → reload) and is
covered by the dual-dialect contract suite (task 2.9). The optional real-Postgres
(node-postgres against `postgres:16`) run is gated behind `SOW_PG_DOCKER=1` and is
**skipped by default** — no daemon is required for this task's tests.

## 4. Keychain export/restore (cross-reference)

Secrets never live in the operational store (REQ-S-003) — they are resolved through
`SecretsPort`/Keychain. **Keychain export/restore guidance** is the secrets-side of
recovery and is documented with the secrets layer (`§16`: "Keychain export/restore
guidance is documented"); a restored operational DB references the same Keychain
items by reference, so secret material is recovered independently of this backup.
