// apps/worker — task 10.6: the operational store is actually BACKED UP now.
//
// ⛔ THE DEFECT. `@sow/db` had the engine, the fs sink and `runPeriodicBackup`; the
// worker had `createOperationalBackupService`. What did not exist was the adapter
// between them, so `bootWorker` built the service only when a caller passed
// `backupPorts` — and no caller ever did. `boot.ts` recorded this as "service wired,
// CRON deferred", which is an accurate description of a system that never backed up
// the non-rebuildable audit / approvals / outbox truth §16 names.
//
// These drive the REAL engine over a REAL temp SQLite file — no fs fakes — because
// the question ("does a backup artifact actually land on disk?") cannot be answered
// by a mock that says it did.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOk, isErr } from "@sow/contracts";
import { openDatabase } from "../../src/composition/backends";
import {
  createOperationalBackupPorts,
  createUnavailableTemporalBackupPort,
  deriveBackupDir,
} from "../../src/backup/backup-ports";
import { createOperationalBackupService } from "../../src/backup/operational-backup";

const dirs: string[] = [];
function tempDbPath(): string {
  const d = mkdtempSync(join(tmpdir(), "sow-backup-"));
  dirs.push(d);
  return join(d, "ops.sqlite");
}
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop();
    if (d !== undefined) rmSync(d, { recursive: true, force: true });
  }
});

describe("deriveBackupDir — where artifacts live", () => {
  it("puts backups beside the store, so they travel with the data they protect", () => {
    expect(deriveBackupDir("/var/sow/ops.sqlite")).toBe("/var/sow/backups");
  });

  it("an in-memory store is NOT backable — undefined, never an invented location", () => {
    // The alternative (defaulting to cwd or tmp) would write real artifacts during
    // every default test boot and pretend an ephemeral DB was protected.
    expect(deriveBackupDir(":memory:")).toBeUndefined();
    expect(deriveBackupDir(undefined)).toBeUndefined();
    expect(deriveBackupDir("   ")).toBeUndefined();
  });
});

describe("operational backup — end to end over a REAL sqlite file", () => {
  it("writes a real artifact to disk and reports it", async () => {
    const dbPath = tempDbPath();
    const opened = await openDatabase({ dbPath });
    try {
      const ports = createOperationalBackupPorts(opened.conn, dbPath);
      expect(ports).toBeDefined();
      if (ports === undefined) return;

      // Nothing backed up yet — the cadence marker is genuinely absent, not an error.
      const before = await ports.opDb.latestBackupAt();
      expect(isOk(before)).toBe(true);
      if (isOk(before)) expect(before.value).toBeUndefined();

      const made = await ports.opDb.backup();
      expect(isOk(made)).toBe(true);
      if (!isOk(made)) return;
      expect(made.value.sizeBytes).toBeGreaterThan(0);
      // THE POINT: a file exists on disk, not a mock that said so.
      expect(existsSync(made.value.location)).toBe(true);
      expect(readdirSync(deriveBackupDir(dbPath)!).length).toBeGreaterThan(0);

      // …and it becomes the persisted cadence marker, which is what makes the
      // schedule survive a restart with no CRON state of its own.
      const after = await ports.opDb.latestBackupAt();
      expect(isOk(after)).toBe(true);
      if (isOk(after)) expect(after.value).toBe(made.value.createdAt);
    } finally {
      opened.conn.close();
    }
  });

  it("the SERVICE honours the cadence: due runs, not-due skips", async () => {
    const dbPath = tempDbPath();
    const opened = await openDatabase({ dbPath });
    try {
      const ports = createOperationalBackupPorts(opened.conn, dbPath)!;
      const service = createOperationalBackupService(ports.opDb, ports.temporal);

      // First run: nothing on disk ⇒ due.
      const first = await service.run({ intervalMs: 24 * 60 * 60 * 1000, now: new Date() });
      const countAfterFirst = readdirSync(deriveBackupDir(dbPath)!).length;
      expect(countAfterFirst).toBeGreaterThan(0);
      void first;

      // Immediately again with a 24h cadence ⇒ NOT due ⇒ no new artifact. This is why
      // boot can simply ask on every launch and on an interval: a not-due run is a
      // cheap no-op, and the artifacts on disk ARE the schedule.
      await service.run({ intervalMs: 24 * 60 * 60 * 1000, now: new Date() });
      expect(readdirSync(deriveBackupDir(dbPath)!).length).toBe(countAfterFirst);
    } finally {
      opened.conn.close();
    }
  });

  it("an in-memory store yields NO ports — backups are not applicable, not broken", async () => {
    const opened = await openDatabase({});
    try {
      expect(createOperationalBackupPorts(opened.conn, undefined)).toBeUndefined();
    } finally {
      opened.conn.close();
    }
  });
});

describe("the Temporal port fails CLOSED rather than faking a success", () => {
  it("returns a typed err — a no-op ok would hide a half-captured backup until restore", async () => {
    const res = await createUnavailableTemporalBackupPort().backup();
    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("unavailable");
  });
});

describe("the PORT always captures — the cadence lives one layer up", () => {
  it("a SECOND immediate port.backup() still SUCCEEDS — it does not silently skip", async () => {
    // If the port also applied a cadence, the layers would DOUBLE-GATE: the service
    // decides a backup is due, the port quietly skips it, and the operator sees a
    // schedule that silently never advances. Asserting the behaviour (not the flags)
    // is deliberate — `intervalMs: 0` and `force: true` are redundant on purpose, so
    // neither is individually detectable; this catches losing BOTH, because a gated
    // port reports `performed: false` and the adapter turns that into a typed err.
    //
    // ⚠ It asserts SUCCESS, not two distinct artifacts. `backupId` is
    // `op-<ISO-with-ms>-<content-digest>`, so two backups of IDENTICAL content inside
    // the same millisecond legitimately collide and overwrite — an engine property,
    // unreachable under the real daily cadence, and not something this port should
    // demand. An earlier draft asserted distinct ids and was flaky by construction.
    const dbPath = tempDbPath();
    const opened = await openDatabase({ dbPath });
    try {
      const ports = createOperationalBackupPorts(opened.conn, dbPath)!;
      expect(isOk(await ports.opDb.backup())).toBe(true);
      expect(isOk(await ports.opDb.backup())).toBe(true);
      expect(readdirSync(deriveBackupDir(dbPath)!).length).toBeGreaterThan(0);
    } finally {
      opened.conn.close();
    }
  });
});

// ── the periodic tick's IN-FLIGHT GUARD — a defect found reviewing this session's own change ────
import { createPeriodicBackupTick } from "../../src/backup/backup-ports";

describe("createPeriodicBackupTick — a slow backup must not start a second one", () => {
  it("SKIPS a tick that lands while a run is still in flight", async () => {
    // ⛔ THE DEFECT. `bootWorker` schedules this on a 1-hour interval, fire-and-forget. The service
    // decides "due" from the NEWEST ARTIFACT'S timestamp — so a backup that outlives the interval
    // has not written its artifact yet, the next tick still reads the OLD timestamp, still sees
    // "due", and starts a SECOND concurrent backup against the same sink. They then race on
    // retention pruning and on `backupId` (`op-<ISO-with-ms>-<digest>`).
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const outcomes: string[] = [];
    const tick = createPeriodicBackupTick({
      service: { run: async () => { calls += 1; await gate; return undefined; } },
      cadenceMs: 1000,
      now: () => new Date("2026-08-28T00:00:00.000Z"),
      onTick: (o) => outcomes.push(o),
    });

    tick();               // starts, blocks on `gate`
    tick(); tick();       // land while in flight
    expect(calls).toBe(1);
    expect(outcomes).toEqual(["ran", "skipped", "skipped"]);

    release();
    await gate;
    await Promise.resolve(); await Promise.resolve(); // let `.finally` clear the flag

    tick();               // the gate is clear ⇒ a new run is allowed
    expect(calls).toBe(2);
  });

  it("a REJECTED run clears the guard — a failure must not wedge the tick permanently", async () => {
    // ⭐ The `finally` is load-bearing: without it one rejected backup would silently disable every
    // future backup for the life of the process, which is strictly worse than the overlap the
    // guard exists to prevent.
    let calls = 0;
    const tick = createPeriodicBackupTick({
      service: { run: async () => { calls += 1; throw new Error("sink exploded"); } },
      cadenceMs: 1000,
      now: () => new Date("2026-08-28T00:00:00.000Z"),
    });
    tick();
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    tick();
    expect(calls).toBe(2);
  });

  it("no service ⇒ inert, and it never throws", () => {
    const outcomes: string[] = [];
    const tick = createPeriodicBackupTick({
      service: undefined, cadenceMs: 1000, now: () => new Date(), onTick: (o) => outcomes.push(o),
    });
    expect(() => tick()).not.toThrow();
    expect(outcomes).toEqual(["no_service"]);
  });
});
