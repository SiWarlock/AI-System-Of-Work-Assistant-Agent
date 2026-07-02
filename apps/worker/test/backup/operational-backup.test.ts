// 10.6 — operational backup (worker orchestrator over the §4/§16 non-rebuildable
// truth set). Ungated Vitest: no real DB, no real fs, no Temporal server. Every
// side effect is an injected port; the orchestrator is a deterministic function of
// its inputs (injected `now`). §16: never throws across the boundary.
//
// What these tests pin:
//   • the backup covers EXACTLY the §4/§16 non-rebuildable operational-truth
//     domains — event log / audit / approvals / outboxes / connector cursors PLUS
//     write_receipts + the Phase-10 durability tables (health_items /
//     schedule_bookkeeping / instance_leases) + Temporal persistence;
//   • rebuildable read models + GCL projections are NOT a separate backup target
//     (re-derived on restore — no redundant snapshot);
//   • a cadence skip when a fresh backup exists; a force override;
//   • a captured Temporal-persistence snapshot rides ALONGSIDE the op-DB snapshot;
//   • a failure in any port folds to a typed BackupServiceFailure (never a throw).

import { describe, it, expect } from "vitest";
import { isOk, isErr, ok, err } from "@sow/contracts";
import {
  NON_REBUILDABLE_BACKUP_DOMAINS,
  runOperationalBackup,
  createOperationalBackupService,
  type OpDbBackupPort,
  type TemporalPersistenceBackupPort,
  type OpDbBackupArtifact,
  type TemporalBackupArtifact,
} from "../../src/backup/operational-backup";
import {
  OPERATIONAL_TRUTH_DOMAINS,
  isRebuildable,
  isOperationalTruth,
  type OperationalDomain,
} from "@sow/db";

// ── fakes ─────────────────────────────────────────────────────────────────────

function fakeOpDbPort(overrides: Partial<OpDbBackupPort> = {}): OpDbBackupPort {
  return {
    latestBackupAt: () => Promise.resolve(ok(undefined)),
    backup: () =>
      Promise.resolve(
        ok<OpDbBackupArtifact>({
          backupId: "op-2026-07-02",
          createdAt: "2026-07-02T00:00:00.000Z",
          sizeBytes: 100,
          rowDigest: "digest-abc",
          location: "/backups/op-2026-07-02.bin",
          coveredDomains: [...NON_REBUILDABLE_BACKUP_DOMAINS],
        }),
      ),
    ...overrides,
  };
}

function fakeTemporalPort(
  overrides: Partial<TemporalPersistenceBackupPort> = {},
): TemporalPersistenceBackupPort {
  return {
    backup: () =>
      Promise.resolve(
        ok<TemporalBackupArtifact>({
          backupId: "temporal-2026-07-02",
          createdAt: "2026-07-02T00:00:00.000Z",
          sizeBytes: 50,
          location: "/backups/temporal-2026-07-02.bin",
        }),
      ),
    ...overrides,
  };
}

const NOW = new Date("2026-07-02T00:00:00.000Z");
const DAY_MS = 24 * 60 * 60 * 1000;

// ── the non-rebuildable domain manifest ────────────────────────────────────────

describe("NON_REBUILDABLE_BACKUP_DOMAINS — the §4/§16 backup contract", () => {
  it("includes every §4-named operational-truth domain", () => {
    for (const d of OPERATIONAL_TRUTH_DOMAINS) {
      expect(NON_REBUILDABLE_BACKUP_DOMAINS).toContain(d);
    }
  });

  it("includes write_receipts + the Phase-10 durability tables", () => {
    for (const d of [
      "write_receipts",
      "health_items",
      "schedule_bookkeeping",
      "instance_leases",
    ] as const) {
      expect(NON_REBUILDABLE_BACKUP_DOMAINS).toContain(d);
    }
  });

  it("EXCLUDES rebuildable read models + derived GCL projections (re-derived, not backed up)", () => {
    expect(NON_REBUILDABLE_BACKUP_DOMAINS).not.toContain("read_models");
    expect(NON_REBUILDABLE_BACKUP_DOMAINS).not.toContain("gcl_projections");
  });

  it("every listed domain is operational_truth (NOT rebuildable) per the @sow/db classification", () => {
    for (const d of NON_REBUILDABLE_BACKUP_DOMAINS) {
      expect(isOperationalTruth(d as OperationalDomain)).toBe(true);
      expect(isRebuildable(d as OperationalDomain)).toBe(false);
    }
  });
});

// ── the backup orchestrator ─────────────────────────────────────────────────────

describe("runOperationalBackup — cadence + full non-rebuildable coverage", () => {
  it("captures BOTH the op-DB and Temporal-persistence snapshots when due", async () => {
    const r = await runOperationalBackup(fakeOpDbPort(), fakeTemporalPort(), {
      intervalMs: DAY_MS,
      now: NOW,
    });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.performed).toBe(true);
      expect(r.value.opDb?.backupId).toBe("op-2026-07-02");
      expect(r.value.temporal?.backupId).toBe("temporal-2026-07-02");
      // The op-DB artifact covers exactly the non-rebuildable set.
      expect(r.value.opDb?.coveredDomains).toEqual([...NON_REBUILDABLE_BACKUP_DOMAINS]);
    }
  });

  it("SKIPS on cadence when a fresh backup already exists (not force)", async () => {
    const port = fakeOpDbPort({
      // Last backup was 1 minute ago — younger than the 1-day interval.
      latestBackupAt: () => Promise.resolve(ok("2026-07-01T23:59:00.000Z")),
    });
    const r = await runOperationalBackup(port, fakeTemporalPort(), {
      intervalMs: DAY_MS,
      now: NOW,
    });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.performed).toBe(false);
      expect(r.value.skippedReason).toBe("not_due");
      expect(r.value.opDb).toBeUndefined();
      expect(r.value.temporal).toBeUndefined();
    }
  });

  it("force overrides the cadence even when a fresh backup exists (pre-migration adjacency)", async () => {
    const port = fakeOpDbPort({
      latestBackupAt: () => Promise.resolve(ok("2026-07-01T23:59:00.000Z")),
    });
    const r = await runOperationalBackup(port, fakeTemporalPort(), {
      intervalMs: DAY_MS,
      now: NOW,
      force: true,
    });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.performed).toBe(true);
  });

  it("takes a backup when the interval has elapsed since the last one", async () => {
    const port = fakeOpDbPort({
      // Two days ago — older than the 1-day interval.
      latestBackupAt: () => Promise.resolve(ok("2026-06-30T00:00:00.000Z")),
    });
    const r = await runOperationalBackup(port, fakeTemporalPort(), {
      intervalMs: DAY_MS,
      now: NOW,
    });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.performed).toBe(true);
  });
});

describe("runOperationalBackup — typed failures (§16, never throws)", () => {
  it("a cadence-probe fault folds to list_failed (nothing captured)", async () => {
    const port = fakeOpDbPort({
      latestBackupAt: () =>
        Promise.resolve(err({ code: "unavailable", message: "db down" })),
    });
    const r = await runOperationalBackup(port, fakeTemporalPort(), {
      intervalMs: DAY_MS,
      now: NOW,
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.reason).toBe("list_failed");
  });

  it("an op-DB capture fault folds to op_db_backup_failed", async () => {
    const port = fakeOpDbPort({
      backup: () =>
        Promise.resolve(err({ code: "unavailable", message: "locked" })),
    });
    const r = await runOperationalBackup(port, fakeTemporalPort(), {
      intervalMs: DAY_MS,
      now: NOW,
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) {
      expect(r.error.reason).toBe("op_db_backup_failed");
      expect(typeof r.error.repair).toBe("string");
      expect(r.error.repair.length).toBeGreaterThan(0);
    }
  });

  it("a Temporal-persistence backup fault folds to temporal_backup_failed", async () => {
    const port = fakeTemporalPort({
      backup: () =>
        Promise.resolve(err({ code: "unavailable", message: "temporal dir gone" })),
    });
    const r = await runOperationalBackup(fakeOpDbPort(), port, {
      intervalMs: DAY_MS,
      now: NOW,
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.reason).toBe("temporal_backup_failed");
  });

  it("does not throw on a hostile port that rejects (folds to a typed err)", async () => {
    const port: OpDbBackupPort = {
      latestBackupAt: () => Promise.reject(new Error("boom")),
      backup: () => Promise.reject(new Error("boom")),
    };
    const r = await runOperationalBackup(port, fakeTemporalPort(), {
      intervalMs: DAY_MS,
      now: NOW,
    });
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.reason).toBe("list_failed");
  });
});

// ── the wiring factory ──────────────────────────────────────────────────────────

describe("createOperationalBackupService — the injectable factory (wiringFactory)", () => {
  it("exposes a run() that delegates to runOperationalBackup", async () => {
    const svc = createOperationalBackupService(fakeOpDbPort(), fakeTemporalPort());
    const r = await svc.run({ intervalMs: DAY_MS, now: NOW });
    expect(isOk(r)).toBe(true);
    if (isOk(r)) expect(r.value.performed).toBe(true);
  });
});
