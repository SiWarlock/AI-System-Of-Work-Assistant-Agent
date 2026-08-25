// Tasks 11.1 + 24.1 (REQ-D-005, safety rule 1) — the REAL advisory single-owner lock. Pins that a second
// LIVE process is PHYSICALLY refused acquisition (the OS's own O_CREAT|O_EXCL atomicity, not merely a
// reported finding), that a clean release lets a subsequent acquire succeed, and that a lock left by a
// now-dead pid is reclaimed. The "physical, second-process" proof spawns a REAL separate OS process (via
// `node --experimental-strip-types`, Node 22) running the fixture at ./fixtures/acquire-lock-child.ts,
// which imports the SAME production module under test — never a reimplementation.
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { describe, it, expect, afterEach } from "vitest";
import { isOk, isErr } from "@sow/contracts";
import type { BrainId } from "@sow/contracts";
import { evaluateWriteFence } from "@sow/knowledge";
import {
  acquireSingleOwnerLock,
  resolvePgliteLockHolder,
} from "../../src/install/lock/singleOwnerLock";

const HERE = dirname(fileURLToPath(import.meta.url));
const CHILD_FIXTURE = resolve(HERE, "fixtures/acquire-lock-child.ts");
const CASE_TIMEOUT_MS = 15_000;

/** Spawn the child fixture against `lockPath`, capture its ONE JSON stdout line, return both the parsed
 *  result and the live ChildProcess handle (caller kills it when it acquired, to release cleanly). */
function spawnChildAcquire(lockPath: string): Promise<{
  readonly parsed: { readonly ok: boolean; readonly holderPid?: number };
  readonly child: ReturnType<typeof spawn>;
}> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, ["--experimental-strip-types", CHILD_FIXTURE, lockPath], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d: Buffer) => {
      out += d.toString("utf8");
      const line = out.split("\n").find((l) => l.trim().length > 0);
      if (line !== undefined) {
        try {
          resolvePromise({ parsed: JSON.parse(line) as { ok: boolean; holderPid?: number }, child });
        } catch (e) {
          reject(e as Error);
        }
      }
    });
    child.on("error", reject);
  });
}

let dir: string;
const spawned: ReturnType<typeof spawn>[] = [];
afterEach(() => {
  for (const c of spawned.splice(0)) {
    if (!c.killed) c.kill("SIGTERM");
  }
  if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
});

describe("acquireSingleOwnerLock — REQ-D-005 advisory single-owner lock (11.1/24.1)", () => {
  it(
    "a SECOND live OS process racing the SAME lock path is PHYSICALLY refused (not merely a reported finding)",
    async () => {
      dir = mkdtempSync(join(tmpdir(), "sow-single-owner-lock-"));
      const lockPath = join(dir, "brain.lock");

      // Process A (a genuine separate OS process) acquires first and HOLDS the lock live.
      const a = await spawnChildAcquire(lockPath);
      spawned.push(a.child);
      expect(a.parsed.ok).toBe(true);
      expect(existsSync(lockPath)).toBe(true);

      // Process B (this test process itself) races the SAME lock path while A is still alive.
      const b = acquireSingleOwnerLock(lockPath);
      expect(b.ok).toBe(false);
      if (!b.ok) {
        expect(b.reason).toBe("held");
        expect(b.holderPid).toBe(a.child.pid);
      }

      // A THIRD attempt — another genuinely separate OS process — is ALSO physically refused while A holds.
      const c = await spawnChildAcquire(lockPath);
      expect(c.parsed.ok).toBe(false);
      expect(c.parsed.holderPid).toBe(a.child.pid);
    },
    CASE_TIMEOUT_MS,
  );

  it(
    "release() is a CLEAN exit — a subsequent acquire against the SAME path succeeds afterward",
    async () => {
      dir = mkdtempSync(join(tmpdir(), "sow-single-owner-lock-"));
      const lockPath = join(dir, "brain.lock");

      const first = acquireSingleOwnerLock(lockPath);
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      // While STILL held, a second attempt is refused (baseline, in-process).
      const blocked = acquireSingleOwnerLock(lockPath);
      expect(blocked.ok).toBe(false);

      first.release();
      expect(existsSync(lockPath)).toBe(false); // the lockfile is gone — a clean, verifiable release

      // NOW a fresh acquire (including from a genuinely separate OS process) succeeds.
      const after = await spawnChildAcquire(lockPath);
      spawned.push(after.child);
      expect(after.parsed.ok).toBe(true);
    },
    CASE_TIMEOUT_MS,
  );

  it("release() is idempotent — calling it twice does not throw and does not touch a lock reclaimed since", () => {
    dir = mkdtempSync(join(tmpdir(), "sow-single-owner-lock-"));
    const lockPath = join(dir, "brain.lock");
    const held = acquireSingleOwnerLock(lockPath);
    expect(held.ok).toBe(true);
    if (!held.ok) return;
    held.release();
    expect(() => held.release()).not.toThrow();

    // A NEW holder (spawnSync — a real distinct pid) reclaims the now-free path.
    const reacquired = acquireSingleOwnerLock(lockPath);
    expect(reacquired.ok).toBe(true);
    // Calling the FIRST holder's release() again must NOT delete the new legitimate holder's lock.
    held.release();
    expect(existsSync(lockPath)).toBe(true);
    if (reacquired.ok) reacquired.release();
  });

  it("a STALE lock from a now-dead pid is reclaimable (the recorded holder no longer exists)", async () => {
    dir = mkdtempSync(join(tmpdir(), "sow-single-owner-lock-"));
    const lockPath = join(dir, "brain.lock");

    // Spawn a trivial child that exits IMMEDIATELY (spawnSync blocks until it has truly exited), so its
    // pid is guaranteed to belong to a now-dead process — a real crashed-holder scenario, not a guessed pid.
    const dead = spawnSync(process.execPath, ["-e", "process.exit(0)"]);
    const deadPid = dead.pid;
    expect(typeof deadPid).toBe("number");
    // Simulate the crash: a lockfile naming the now-dead pid was left behind (the crashed holder never
    // reached its release()).
    writeFileSync(lockPath, String(deadPid));

    const result = acquireSingleOwnerLock(lockPath);
    expect(result.ok).toBe(true); // reclaimed — a dead holder does not block forever
    if (result.ok) result.release();
  });

  it("a lockfile naming a LIVE pid (this very test process) is NOT reclaimed — refused, never displaced", () => {
    dir = mkdtempSync(join(tmpdir(), "sow-single-owner-lock-"));
    const lockPath = join(dir, "brain.lock");
    // This test process's OWN pid is unquestionably alive right now.
    writeFileSync(lockPath, String(process.pid));
    const result = acquireSingleOwnerLock(lockPath);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("held");
      expect(result.holderPid).toBe(process.pid);
    }
  });
});

describe("resolvePgliteLockHolder — the write-fence PgliteLockHolder producer", () => {
  it("a held lock resolves to 'worker' (the only safe value evaluateWriteFence accepts)", () => {
    const dirLocal = mkdtempSync(join(tmpdir(), "sow-single-owner-lock-holder-"));
    try {
      const lockPath = join(dirLocal, "brain.lock");
      const result = acquireSingleOwnerLock(lockPath);
      expect(resolvePgliteLockHolder(result)).toBe("worker");
      if (result.ok) result.release();
    } finally {
      rmSync(dirLocal, { recursive: true, force: true });
    }
  });

  it("a refused acquisition resolves to 'unknown' — default-deny, never guesses 'gbrain'", () => {
    const dirLocal = mkdtempSync(join(tmpdir(), "sow-single-owner-lock-holder-"));
    try {
      const lockPath = join(dirLocal, "brain.lock");
      writeFileSync(lockPath, String(process.pid)); // a live "foreign" holder (this process, for the test)
      const result = acquireSingleOwnerLock(lockPath);
      expect(result.ok).toBe(false);
      expect(resolvePgliteLockHolder(result)).toBe("unknown");
    } finally {
      rmSync(dirLocal, { recursive: true, force: true });
    }
  });
});

describe("resolvePgliteLockHolder feeding evaluateWriteFence — the write-fence integration (11.1/24.1)", () => {
  const BRAIN = "brain-canonical" as BrainId;
  const CTX = { now: () => "2026-08-24T00:00:00.000Z", auditRef: "audit-lock-check" };

  it("this worker HOLDING the real OS lock ⇒ evaluateWriteFence's pglite-lock leg is INTACT (holding it alone still needs the ACL leg true too)", () => {
    const dirLocal = mkdtempSync(join(tmpdir(), "sow-single-owner-lock-fence-"));
    try {
      const lockPath = join(dirLocal, "brain.lock");
      const held = acquireSingleOwnerLock(lockPath);
      expect(held.ok).toBe(true);
      const holder = resolvePgliteLockHolder(held);
      expect(holder).toBe("worker");

      // The lock leg ALONE is not the whole fence (workerIsSoleVaultWriter is a SEPARATE leg) — feed a
      // TRUE ACL leg alongside it to prove the lock-holder value itself is what the fence accepts as safe.
      const verdict = evaluateWriteFence(
        { canonicalBrainId: BRAIN, workerIsSoleVaultWriter: true, pgliteLockHolder: holder, observedProcesses: [] },
        CTX,
      );
      expect(isOk(verdict)).toBe(true);
      if (held.ok) held.release();
    } finally {
      rmSync(dirLocal, { recursive: true, force: true });
    }
  });

  it("a REFUSED acquisition ⇒ 'unknown' ⇒ evaluateWriteFence BREACHES on pglite_lock_not_worker_held (fail-closed even with a true ACL leg)", () => {
    const dirLocal = mkdtempSync(join(tmpdir(), "sow-single-owner-lock-fence-"));
    try {
      const lockPath = join(dirLocal, "brain.lock");
      writeFileSync(lockPath, String(process.pid)); // a live "foreign" holder
      const refused = acquireSingleOwnerLock(lockPath);
      expect(refused.ok).toBe(false);
      const holder = resolvePgliteLockHolder(refused);
      expect(holder).toBe("unknown");

      const verdict = evaluateWriteFence(
        { canonicalBrainId: BRAIN, workerIsSoleVaultWriter: true, pgliteLockHolder: holder, observedProcesses: [] },
        CTX,
      );
      expect(isErr(verdict)).toBe(true);
      if (isErr(verdict)) {
        expect(verdict.error.reasons).toContain("pglite_lock_not_worker_held");
      }
    } finally {
      rmSync(dirLocal, { recursive: true, force: true });
    }
  });
});
