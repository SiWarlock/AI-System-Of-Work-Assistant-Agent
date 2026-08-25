// DOD-worker-boot task 2 — 11.1's single-owner lock is UNBOUND. `singleOwnerLock.ts`'s real OS-atomic
// `acquireSingleOwnerLock` primitive (task 11.1/24.1, REQ-D-005) landed with zero production callers —
// `bootWorker` never called it, so the shipped posture was report-only (a doctor CAN diagnose the
// posture, but nothing ever ACQUIRES it). This binds it: `bootWorker` now attempts the lock BEFORE the
// operational store opens, holds it for the life of the process, releases it idempotently at `close()`,
// and — on refusal or an unexpected fault — mints a `worker_down` HealthItem + logs loudly (code-only,
// rule 7) rather than throwing (§16).
//
// `deriveSingleOwnerLockPath` is pure and unit-tested UNGATED (no socket, no real boot — fast, every
// run). The real end-to-end acquire/refuse/release proof drives the REAL `bootWorker()` composition
// root and is SOW_API-gated (`apps/worker/test/support/apiGate.ts`'s own header: "the DEFAULT suite
// must NEVER open a socket" — `bootWorker` binds a real loopback port), mirroring the existing
// `test/integration/boot-provision.test.ts` convention.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mintSessionToken } from "@sow/policy";
import { SOW_API } from "../support/apiGate";
import { bootWorker, deriveSingleOwnerLockPath, type BootedWorker, type BootConfig } from "../../src/boot";
import type { WorkerOriginAllowlist } from "../../src/api/auth/originAllowlist";
import type { TriageDispatchFn } from "../../src/api/adapters/commands";
import type { DispatchApprovalFn } from "../../src/api/procedures/commands";

describe("deriveSingleOwnerLockPath — pure path derivation (task 11.1/24.1)", () => {
  it("a durable dbPath yields a STABLE path — two derivations of the SAME dbPath agree", () => {
    const a = deriveSingleOwnerLockPath({ dbPath: "/tmp/sow-example/operational.sqlite" });
    const b = deriveSingleOwnerLockPath({ dbPath: "/tmp/sow-example/operational.sqlite" });
    expect(a).toBe(b);
    expect(a).toContain("operational.sqlite");
  });

  it("two DIFFERENT durable dbPaths derive to two DIFFERENT lock paths (no cross-deployment collision)", () => {
    const a = deriveSingleOwnerLockPath({ dbPath: "/tmp/sow-a/operational.sqlite" });
    const b = deriveSingleOwnerLockPath({ dbPath: "/tmp/sow-b/operational.sqlite" });
    expect(a).not.toBe(b);
  });

  it("an UNSET dbPath (the ephemeral test/dev default) yields a FRESH path on EVERY call — no shared default collision", () => {
    const a = deriveSingleOwnerLockPath({});
    const b = deriveSingleOwnerLockPath({});
    expect(a).not.toBe(b);
  });

  it("an explicit ':memory:' dbPath is treated the SAME as unset (matches assembleBackends' own fallback) — also fresh per call", () => {
    const a = deriveSingleOwnerLockPath({ dbPath: ":memory:" });
    const b = deriveSingleOwnerLockPath({ dbPath: ":memory:" });
    expect(a).not.toBe(b);
  });
});

// ── real bootWorker() end-to-end proof — SOW_API-gated (opens a real loopback socket) ─────────────

function fixedRng(seed: number): (n: number) => Buffer {
  return (n: number): Buffer => Buffer.alloc(n, seed & 0xff);
}
const TOKEN = mintSessionToken(fixedRng(0x5a));
const ALLOWLIST: WorkerOriginAllowlist = { origins: ["app://sow"], hosts: ["127.0.0.1:47100"] };
const noopTriage: TriageDispatchFn = (input) =>
  Promise.resolve({ ok: true, value: { idempotencyKey: input.idempotencyKey } });
const noopApprovalDispatch: DispatchApprovalFn = () => Promise.resolve({ ok: true, value: undefined });

function baseConfig(over: Partial<BootConfig> = {}): BootConfig {
  return {
    sessionToken: TOKEN,
    allowlist: ALLOWLIST,
    triageDispatch: noopTriage,
    dispatchApproval: noopApprovalDispatch,
    apiPort: 0,
    ...over,
  };
}

const booted: BootedWorker[] = [];
const dirs: string[] = [];
afterEach(async () => {
  for (const b of booted.splice(0)) {
    await b.close();
  }
  for (const d of dirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe.skipIf(!SOW_API)("bootWorker — the single-owner lock is ACQUIRED at boot, refused across a real conflict, released at close (task 11.1/24.1)", () => {
  it("a durable dbPath boot ACQUIRES the real lockfile on disk", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sow-lock-e2e-"));
    dirs.push(dir);
    const dbPath = join(dir, "operational.sqlite");
    const lockPath = deriveSingleOwnerLockPath({ dbPath });

    expect(existsSync(lockPath)).toBe(false); // non-vacuity: confirm absent BEFORE boot
    const b = await bootWorker(baseConfig({ dbPath }));
    booted.push(b);
    expect(existsSync(lockPath)).toBe(true);
  });

  it("a SECOND boot against the SAME dbPath is REFUSED (not thrown) and mints a worker_down HealthItem", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sow-lock-e2e-"));
    dirs.push(dir);
    const dbPath = join(dir, "operational.sqlite");

    const first = await bootWorker(baseConfig({ dbPath }));
    booted.push(first);

    // MUST NOT THROW (§16) — the assignment itself is the pin: an unhandled rejection fails the test.
    const second = await bootWorker(baseConfig({ dbPath }));
    booted.push(second);

    const items = await second.backends.healthItems.list();
    const lockItem = items.find((i) => i.id.startsWith("single-owner-lock:"));
    expect(lockItem).toBeDefined();
    expect(lockItem?.failureClass).toBe("worker_down");
    // rule 7 — a STATIC message, no interpolated holder pid: any per-instance data (the other
    // holder's process id) would vary between two runs of this exact scenario, so pinning EQUALITY
    // to a fixed string (not merely a shape check) proves nothing per-conflict was interpolated in.
    expect(lockItem?.message).toBe(
      "Another process holds the canonical brain/vault lock, or this worker could not acquire it — " +
        "a second write-capable instance may be racing the operational store (REQ-D-005).",
    );
  });

  it("close() releases the lock — a THIRD boot after the first closes succeeds cleanly (no refusal item)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "sow-lock-e2e-"));
    dirs.push(dir);
    const dbPath = join(dir, "operational.sqlite");

    const first = await bootWorker(baseConfig({ dbPath }));
    await first.close(); // release, before pushing to `booted` — already closed, closing again in afterEach is a no-op

    const second = await bootWorker(baseConfig({ dbPath }));
    booted.push(second);

    const items = await second.backends.healthItems.list();
    const lockItem = items.find((i) => i.id.startsWith("single-owner-lock:"));
    expect(lockItem).toBeUndefined(); // the lock was free — no refusal, byte-equivalent
  });

  it("the default (ephemeral, no dbPath) config still boots cleanly — byte-equivalent, no refusal item", async () => {
    const b = await bootWorker(baseConfig());
    booted.push(b);
    const items = await b.backends.healthItems.list();
    const lockItem = items.find((i) => i.id.startsWith("single-owner-lock:"));
    expect(lockItem).toBeUndefined();
  });
});
