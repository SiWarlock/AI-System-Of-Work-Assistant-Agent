# Backup & Recovery — Operational Runbook

> Task 10.6 · ARCHITECTURE §16 (Backup & recovery) + §4 (Operational Storage boundaries).
>
> **Scope of this doc.** The operational procedures for backing up and restoring the
> *non-rebuildable operational truth*, the vault git-remote precondition doctor, and
> Keychain export/restore guidance. The code lives in `apps/worker/src/backup/`
> (`operational-backup.ts` · `restore.ts` · `doctor.ts`), built over the dialect-agnostic
> `@sow/db` backup/restore primitives (`packages/db/src/backup/`).

---

## 1. What is backed up (and what is deliberately not)

The operational DB **and Temporal persistence** are *operational truth* and are **not
Git-backed** (§16). They are captured by a periodic **local** backup. The canonical
non-rebuildable manifest is `NON_REBUILDABLE_BACKUP_DOMAINS` in
`apps/worker/src/backup/operational-backup.ts`, kept in lock-step with the `@sow/db`
`DOMAIN_DURABILITY` classification (every member is `operational_truth`):

| Backed up (non-rebuildable operational truth) | Why it cannot be re-derived |
|---|---|
| `event_log`, `audit`, `approvals`, `outboxes`, `connector_cursors` | The §4-named five — authoritative operational truth. |
| `workflow_runs`, `provider_state`, `workspace_config` | Operational state; not a read model. |
| `write_receipts` | The WW-1 exactly-once external-write proofs (safety rule 3) — losing them lets a rebuilt worker re-issue an already-committed external write. |
| `health_items`, `schedule_bookkeeping`, `instance_leases` | Phase-10 durability tables (OBS-2 / LIFE-5 / LIFE-1) — a lost row drops audit history, re-fires/starves a schedule, or breaks the single-active-instance lease. |
| **Temporal persistence** | Workflow history is Temporal's source of truth — not held in the operational DB. |

**Not backed up — re-derived on restore** (they are *rebuildable* / *derived*, so a redundant
snapshot would only risk drift):

| Re-derived after restore | Source it is re-derived from |
|---|---|
| `read_models` (incl. dashboard projections) | Operational truth + Markdown. |
| `gcl_projections` | Derived from a master (re-derivable). |

> The parity **allow-set** is likewise rebuildable from Markdown by the
> `CanonicalFactDeriver` on crash recovery (§16 / §12); the `QuarantineLedger` +
> `ParityReport`s are operational truth covered by this backup (owned by the knowledge
> track — referenced here, not duplicated).

---

## 2. Periodic backup

### Cadence (documented default)

- **Default cadence: once per day (24 h).** The interval is an **injected** option
  (`OperationalBackupOptions.intervalMs`) — the policy is the caller's, not baked into
  the module. The driving scheduler (a worker-supervisor tick or a Temporal cron) is
  wired at the composition root.
- Retention of the local op-DB artifacts is owned by the `@sow/db`
  `runPeriodicBackup` orchestrator (default: keep the **7** most-recent, per
  `DEFAULT_BACKUP_RETENTION`).
- **Remote operational-DB backup is an owner option** (§16), not a default. The local
  backup is mandatory; a remote copy is opt-in.

### Cadence semantics

`runOperationalBackup(opDb, temporal, { intervalMs, now, force? })`:

1. **Cadence** — reads the most-recent op-DB backup time; **skips** (`performed: false`,
   `skippedReason: "not_due"`) if it is younger than `intervalMs`, unless `force` is set.
2. **Op-DB** — captures + persists the op-DB snapshot (the non-rebuildable truth set).
3. **Temporal** — captures + persists the Temporal-persistence snapshot alongside it.

Every fault folds to a typed `BackupServiceFailure` (`list_failed` · `op_db_backup_failed`
· `temporal_backup_failed`) — **it never throws across the boundary** (§16). A partial
capture never claims success: if the Temporal backup fails after the op-DB backup landed,
the op-DB backup is safe but the run returns `temporal_backup_failed` so the operator
re-runs.

### At-rest posture

Bytes-at-rest are protected by **macOS FileVault full-disk encryption** (a §13
install-doctor prerequisite). App-level encryption (SQLCipher) is a V1.1 hardening item
(§15). See `packages/db/docs/at-rest-posture.md`.

---

## 3. Restore

`restoreOperational(opDb, temporal, rebuilder, opts?)` — the documented recovery path:

1. **Recover the op-DB truth set.** The `@sow/db` integrity gate re-derives the
   operational-truth row digest and compares it to the backup's recorded digest; a
   mismatch **fails closed** (`integrity_unverified`) — a corrupt store is never returned.
2. **Recover Temporal persistence.**
3. **Re-derive the rebuildable read models** (`read_models` + `gcl_projections`) from the
   recovered truth + Markdown. This runs **only after** truth recovery succeeds — never
   against a broken truth store.
4. **Consistency check.** Verifies the re-derived set is **exactly** the rebuildable
   domains and is **disjoint** from the recovered-as-truth set — **no orphaned or
   duplicated state**. A non-clean recovery returns `inconsistent_after_restore`.

Failure reasons (all typed, never thrown): `op_db_restore_failed` · `integrity_unverified`
· `temporal_restore_failed` · `rederivation_failed` · `inconsistent_after_restore`. Each
carries an actionable `repair` string.

### Restore procedure (operator steps)

1. **Stop the worker.** Restore must not race a live writer.
2. **Choose the backup.** Default = the latest; pass `{ backupId }` to pick a specific
   artifact.
3. **Run the restore.** On `integrity_unverified` or `inconsistent_after_restore`: **do
   not use the result** — pick an earlier backup and re-verify (follow the `repair`).
4. **Restart the worker.** On respawn it re-acquires the single-instance lease (LIFE-1)
   and recovers in-flight side effects via Temporal resume + the §8 envelope.

---

## 4. Pre-migration backup & rollback

The **pre-migration backup is owned by the §4 / P2 migration path** (the `@sow/db`
migrate runner: it takes a mandatory backup *before* applying any migration — worker
forbidden-pattern #4). **This runbook does not duplicate that mechanism** — it references
it.

On a **partial or failed migration**, the documented rollback is
`rollbackFromPreMigrationBackup(opDb, temporal, rebuilder, { preMigrationBackupId })` —
a thin wrapper over `restoreOperational` that targets the pre-migration backup by id and
re-derives the read models. Steps:

1. Note the `preMigrationBackupId` the migrate runner recorded before the failed migration.
2. Stop the worker.
3. Run `rollbackFromPreMigration({ preMigrationBackupId })`.
4. Confirm the restore is clean (`consistency.clean === true`); restart the worker.

A migration is never left half-applied silently: the migrate path refuses to start on an
incompatible app-version ↔ schema-version pairing and points here for the rollback.

---

## 5. Vault git-remote doctor

Each **workspace Markdown repo** *and* the **Global/Coordination repo** must be backed —
by the owner's Obsidian Sync / iCloud and/or a configured **git remote** (§16). The
install doctor enforces, per repo, **a git remote is configured OR an explicit local-only
acceptance is recorded** — otherwise a finding (fail closed: *no silent unbacked vault*).

`runVaultRemoteDoctor(targets, git, acceptance)` classifies each repo:

| Status | Meaning |
|---|---|
| `remote_configured` | A git remote is configured → backed. |
| `local_only_accepted` | No remote, but an explicit local-only acceptance is recorded. |
| `unbacked` | No remote and no acceptance → a **finding** (report is not `ok`). |

The report's `findings` lists the `repoId`s that are `unbacked`. A git-probe fault folds
to `probe_failed` — the doctor **cannot silently pass on an unreadable git repo**.

**To clear a finding**, either:

```bash
# Option A — configure a git remote for the vault repo
git -C <vault-path> remote add origin <remote-url>
git -C <vault-path> push -u origin main

# Option B — record an explicit local-only acceptance (owner acknowledges no remote)
#   → set the local-only acceptance for the repoId via the acceptance store / config.
```

---

## 6. Keychain reachability + export/restore guidance

### Reachability check (degraded-mode precondition — LIFE-6)

Secrets are resolved **only** through the `SecretsPort` (`KeychainSecretsAdapter`);
callers receive references, never raw secret material (§3 / §16 / safety rule 7).
`checkKeychainReachable(probe)` is the degraded-mode precondition consumed by worker
supervision (task 10.5):

- `reachable` → `ok`.
- `locked` / `denied` → a typed `keychain_unavailable` refusal carrying the state.
  Dependent providers/connectors are marked degraded and **re-attempt on unlock**
  (LIFE-6 wake/power hooks) — the job holds retryable, it does **not** fall back.
- A probe fault → `probe_failed`.

It **never throws**; the caller/supervisor maps the refusal onto the existing degraded
surfaces. (The frozen OBS-2 `FailureClass` set has no dedicated `keychain_locked` member;
the providers layer models Keychain-locked/denied as its own broker health states.)

### Keychain export / restore

The **HMAC provenance-stamp-signing key** and provider/connector credentials live in the
macOS login Keychain — they are **not** in the operational DB backup and **not** in the
vault. Recovering the machine therefore requires restoring the Keychain items separately.

**Export (before a migration / machine move):**

1. Open **Keychain Access** → **login** keychain.
2. Export the SoW items (provider keys, connector OAuth tokens, the HMAC stamp key) to a
   `.p12` bundle: select the items → **File ▸ Export Items…** → set a strong passphrase.
3. Store the `.p12` + its passphrase in the owner's password manager — **never** in the
   vault, the operational DB, logs, or config (secrets are Keychain-only, REQ-S-003).

CLI alternative for a single generic-password item:

```bash
# Read a secret's reference/value into the clipboard for manual re-entry (never logged):
security find-generic-password -s "<service>" -a "<account>" -w
```

**Restore (on a new machine or after a Keychain reset):**

1. Open **Keychain Access** → **File ▸ Import Items…** → select the `.p12` → enter the
   passphrase.
2. Verify each item is present under the **login** keychain and unlocked.
3. Run the Keychain-reachable check (`checkKeychainReachable`) → expect `reachable`.
4. Restart the worker; it re-attempts secret resolution on unlock (LIFE-6).

CLI alternative for a single generic-password item:

```bash
security add-generic-password -s "<service>" -a "<account>" -w "<secret>" -U
```

> **HMAC key rotation invalidates historical provenance stamps** (§16). If the stamp key
> is rotated rather than restored, run the re-stamp-on-rotation migration (or use a
> multi-key verify window) so previously-committed stamps still verify. Rotate/restore
> the *same* key to avoid this.
