// 10.6 — operational restore (worker orchestrator). Ungated Vitest: injected
// ports, no real DB / fs / Temporal. §16: never throws across the boundary.
//
// What these tests pin:
//   • restore recovers ALL non-rebuildable operational truth (op-DB truth set +
//     Temporal persistence) from a backup;
//   • rebuildable read models (incl. dashboard projections) are RE-DERIVED after
//     restore, not restored from a redundant snapshot;
//   • the post-restore consistency check leaves NO orphaned or duplicated state —
//     every rebuildable domain is re-derived exactly once and no operational-truth
//     domain is re-derived (that would clobber recovered truth);
//   • the pre-migration rollback path is a thin REFERENCE to the same restore (the
//     pre-migration backup itself is §4/P2-owned — not duplicated here);
//   • a store/derive fault folds to a typed RestoreServiceFailure (never a throw).

import { describe, it, expect } from "vitest";
import { isOk, isErr, ok, err } from "@sow/contracts";
import {
  restoreOperational,
  rollbackFromPreMigrationBackup,
  createOperationalRestoreService,
  type OpDbRestorePort,
  type TemporalPersistenceRestorePort,
  type ReadModelRebuilder,
  type RestoredReadModels,
} from "../../src/backup/restore";
import { isRebuildable, type OperationalDomain } from "@sow/db";
import { NON_REBUILDABLE_BACKUP_DOMAINS } from "../../src/backup/operational-backup";

// ── fakes ─────────────────────────────────────────────────────────────────────

function fakeOpDbRestore(overrides: Partial<OpDbRestorePort> = {}): OpDbRestorePort {
  return {
    restore: () =>
      Promise.resolve(
        ok({
          backupId: "op-2026-07-02",
          recoveredDomains: [...NON_REBUILDABLE_BACKUP_DOMAINS],
          integrityVerified: true,
        }),
      ),
    ...overrides,
  };
}

function fakeTemporalRestore(
  overrides: Partial<TemporalPersistenceRestorePort> = {},
): TemporalPersistenceRestorePort {
  return {
    restore: () => Promise.resolve(ok({ backupId: "temporal-2026-07-02" })),
    ...overrides,
  };
}

// A rebuilder that records which domains it was asked to re-derive.
function recordingRebuilder(): ReadModelRebuilder & { derived: OperationalDomain[] } {
  const derived: OperationalDomain[] = [];
  return {
    derived,
    rebuild(domains) {
      derived.push(...domains);
      const rebuilt: RestoredReadModels = { rederivedDomains: [...domains] };
      return Promise.resolve(ok(rebuilt));
    },
  };
}

// ── the restore orchestrator ─────────────────────────────────────────────────────

describe("restoreOperational — recovers non-rebuildable truth + re-derives read models", () => {
  it("recovers the full non-rebuildable operational-truth set (op-DB + Temporal)", async () => {
    const r = await restoreOperational(
      fakeOpDbRestore(),
      fakeTemporalRestore(),
      recordingRebuilder(),
    );
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(r.value.opDb.recoveredDomains).toEqual([...NON_REBUILDABLE_BACKUP_DOMAINS]);
      expect(r.value.temporal.backupId).toBe("temporal-2026-07-02");
      expect(r.value.opDb.integrityVerified).toBe(true);
    }
  });

  it("re-derives ONLY the rebuildable read models after restore (read_models + gcl_projections)", async () => {
    const rebuilder = recordingRebuilder();
    const r = await restoreOperational(fakeOpDbRestore(), fakeTemporalRestore(), rebuilder);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      expect(new Set(r.value.readModels.rederivedDomains)).toEqual(
        new Set(["read_models", "gcl_projections"]),
      );
    }
    // Every re-derived domain is genuinely rebuildable — no truth was re-derived.
    for (const d of rebuilder.derived) expect(isRebuildable(d)).toBe(true);
  });

  it("leaves NO orphan/duplicate: no domain is both recovered-as-truth AND re-derived", async () => {
    const rebuilder = recordingRebuilder();
    const r = await restoreOperational(fakeOpDbRestore(), fakeTemporalRestore(), rebuilder);
    expect(isOk(r)).toBe(true);
    if (isOk(r)) {
      const recovered = new Set(r.value.opDb.recoveredDomains);
      for (const d of rebuilder.derived) {
        expect(recovered.has(d)).toBe(false); // no overlap → no clobber, no duplicate
      }
      // Each rebuildable domain re-derived EXACTLY once (no duplicate rebuild).
      const seen = new Set<OperationalDomain>();
      for (const d of rebuilder.derived) {
        expect(seen.has(d)).toBe(false);
        seen.add(d);
      }
      // The consistency verdict is reported.
      expect(r.value.consistency.orphanedDomains).toEqual([]);
      expect(r.value.consistency.duplicatedDomains).toEqual([]);
      expect(r.value.consistency.clean).toBe(true);
    }
  });
});

describe("restoreOperational — fail closed on a broken restore (§16)", () => {
  it("an op-DB restore fault folds to op_db_restore_failed (read models NOT re-derived)", async () => {
    const rebuilder = recordingRebuilder();
    const port = fakeOpDbRestore({
      restore: () =>
        Promise.resolve(err({ code: "unavailable", message: "no backup" })),
    });
    const r = await restoreOperational(port, fakeTemporalRestore(), rebuilder);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.reason).toBe("op_db_restore_failed");
    // Fail closed BEFORE re-derivation: never re-derive against a broken truth store.
    expect(rebuilder.derived).toEqual([]);
  });

  it("an integrity-check failure on the recovered store is a typed refusal", async () => {
    const port = fakeOpDbRestore({
      restore: () =>
        Promise.resolve(
          ok({
            backupId: "op-x",
            recoveredDomains: [...NON_REBUILDABLE_BACKUP_DOMAINS],
            integrityVerified: false,
          }),
        ),
    });
    const rebuilder = recordingRebuilder();
    const r = await restoreOperational(port, fakeTemporalRestore(), rebuilder);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.reason).toBe("integrity_unverified");
    expect(rebuilder.derived).toEqual([]);
  });

  it("a Temporal restore fault folds to temporal_restore_failed", async () => {
    const port = fakeTemporalRestore({
      restore: () =>
        Promise.resolve(err({ code: "unavailable", message: "temporal gone" })),
    });
    const r = await restoreOperational(fakeOpDbRestore(), port, recordingRebuilder());
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.reason).toBe("temporal_restore_failed");
  });

  it("a read-model rebuild fault folds to rederivation_failed (truth already recovered)", async () => {
    const rebuilder: ReadModelRebuilder = {
      rebuild: () =>
        Promise.resolve(err({ code: "unknown", message: "derive crashed" })),
    };
    const r = await restoreOperational(fakeOpDbRestore(), fakeTemporalRestore(), rebuilder);
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.reason).toBe("rederivation_failed");
  });

  it("does not throw on a hostile port that rejects", async () => {
    const port: OpDbRestorePort = { restore: () => Promise.reject(new Error("boom")) };
    const r = await restoreOperational(port, fakeTemporalRestore(), recordingRebuilder());
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.reason).toBe("op_db_restore_failed");
  });
});

// ── the pre-migration rollback REFERENCE (backup itself is §4/P2-owned) ──────────

describe("rollbackFromPreMigrationBackup — the documented rollback references restore", () => {
  it("restores from the pre-migration backup id and re-derives read models", async () => {
    const rebuilder = recordingRebuilder();
    const captured: string[] = [];
    const port: OpDbRestorePort = {
      restore: (opts) => {
        captured.push(opts?.backupId ?? "<latest>");
        return Promise.resolve(
          ok({
            backupId: opts?.backupId ?? "pre-mig",
            recoveredDomains: [...NON_REBUILDABLE_BACKUP_DOMAINS],
            integrityVerified: true,
          }),
        );
      },
    };
    const r = await rollbackFromPreMigrationBackup(
      port,
      fakeTemporalRestore(),
      rebuilder,
      { preMigrationBackupId: "pre-mig-001" },
    );
    expect(isOk(r)).toBe(true);
    // It targets the SPECIFIC pre-migration backup id (§4/P2 owns creating it).
    expect(captured).toEqual(["pre-mig-001"]);
    if (isOk(r)) expect(r.value.opDb.backupId).toBe("pre-mig-001");
  });
});

// ── the wiring factory ──────────────────────────────────────────────────────────

describe("createOperationalRestoreService — the injectable factory (wiringFactory)", () => {
  it("exposes restore() + rollback() that delegate to the orchestrators", async () => {
    const svc = createOperationalRestoreService(
      fakeOpDbRestore(),
      fakeTemporalRestore(),
      recordingRebuilder(),
    );
    const r = await svc.restore();
    expect(isOk(r)).toBe(true);
    const rb = await svc.rollbackFromPreMigration({ preMigrationBackupId: "pre-mig-001" });
    expect(isOk(rb)).toBe(true);
  });
});
