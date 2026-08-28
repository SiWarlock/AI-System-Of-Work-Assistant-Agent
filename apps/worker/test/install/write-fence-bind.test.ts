// apps/worker — task 24.1 / REQ-S-NEW-008: the OS one-writer lock is now a
// PREVENTIVE write fence, not a detective one.
//
// ⛔ THE GAP THESE PIN, in 24.1's own words. `acquireSingleOwnerLock` was wired at
// boot so a second worker on the same durable `dbPath` is physically refused — but
// boot.ts recorded the rest itself: it "does NOT bind `resolvePgliteLockHolder` →
// `packages/knowledge`'s `evaluateWriteFence` … so the OS lock is a real ACQUISITION
// but not yet the thing that would make a refused write PHYSICALLY blocked at the
// gbrain/vault write layer." A worker that LOST the lock still wrote canonical
// Markdown. The Done-when is "denied at the OS layer … physically blocked, not just
// reported".
//
// The block lives at `atomicCommit`, evaluated PER COMMIT — not once at boot, because
// the lock can be lost while the process runs and a startup decision would authorize
// every later write on a fact that has since expired.
import { describe, it, expect } from "vitest";
import { isErr, isOk } from "@sow/contracts";
import { atomicCommit } from "@sow/knowledge";
import type { VaultFs } from "@sow/knowledge";
import { createWriteFenceProbe } from "../../src/install/lock/writeFenceProbe";
import type { LockAcquireResult } from "../../src/install/lock/singleOwnerLock";

const NOW = (): string => "2026-07-01T00:00:00.000Z";
const HELD: LockAcquireResult = { ok: false, reason: "held", holderPid: 4242 };
const WON: LockAcquireResult = { ok: true, release: () => undefined };

function probeFor(
  lockResult: LockAcquireResult | undefined,
  workerIsSoleVaultWriter = true,
): () => readonly string[] | undefined {
  return createWriteFenceProbe({
    lockResult,
    canonicalBrainId: "sow-canonical" as never,
    workerIsSoleVaultWriter,
    now: NOW,
    auditRef: "audit:test",
  });
}

/** A vault that RECORDS every filesystem touch, so "nothing was written" is provable
 *  rather than inferred from a return value. */
function recordingVault(): { fs: VaultFs; touches: string[] } {
  const touches: string[] = [];
  const files = new Map<string, string>();
  return {
    touches,
    fs: {
      read: async (p) => files.get(p),
      list: async () => [...files.keys()],
      write: async (p, c) => {
        touches.push(`write:${p}`);
        files.set(p, c);
      },
      rename: async (from, to) => {
        touches.push(`rename:${from}->${to}`);
        const v = files.get(from);
        if (v !== undefined) {
          files.set(to, v);
          files.delete(from);
        }
      },
      remove: async (p) => {
        touches.push(`remove:${p}`);
        files.delete(p);
      },
    },
  };
}

describe("write fence probe — maps the real lock outcome onto the fence verdict", () => {
  it("a WON lock with sole-writer posture ⇒ fence INTACT (undefined)", () => {
    expect(probeFor(WON)()).toBeUndefined();
  });

  it("a lock HELD BY ANOTHER PROCESS ⇒ breached, naming the lock reason", () => {
    const reasons = probeFor(HELD)();
    expect(reasons).toBeDefined();
    expect(reasons).toContain("pglite_lock_not_worker_held");
  });

  it("an ABSENT acquire result fails CLOSED — an unknown holder is not us", () => {
    // Models the exotic fs fault boot swallows: we never learned who holds the lock.
    // Default-deny is the whole posture; guessing `worker` here would be the bug.
    const reasons = probeFor(undefined)();
    expect(reasons).toContain("pglite_lock_not_worker_held");
  });

  it("a non-sole vault writer breaches even when the lock was WON (both facts count)", () => {
    const reasons = probeFor(WON, false)();
    expect(reasons).toContain("vault_acl_not_worker_exclusive");
    // Non-vacuity: the lock reason is NOT present — the two facts are independent.
    expect(reasons).not.toContain("pglite_lock_not_worker_held");
  });
});

describe("atomicCommit — a breached fence PHYSICALLY blocks the write (24.1 Done-when)", () => {
  const CHANGES = [{ path: "notes/a.md", content: "hello" }];

  it("refuses BEFORE staging: zero filesystem touches, typed refusal", async () => {
    const { fs, touches } = recordingVault();
    const res = await atomicCommit(fs, CHANGES, "tok", probeFor(HELD));

    expect(isErr(res)).toBe(true);
    if (!isErr(res)) return;
    expect(res.error.code).toBe("write_fence_breached");
    // THE POINT OF THE WHOLE TASK: not "reported", not "rolled back" — never started.
    expect(touches).toEqual([]);
  });

  it("the refusal carries the CLOSED reason set and no pid (rule 7)", async () => {
    const { fs } = recordingVault();
    const res = await atomicCommit(fs, CHANGES, "tok", probeFor(HELD));
    if (!isErr(res) || res.error.code !== "write_fence_breached") throw new Error("expected a fence refusal");
    expect(res.error.reasons).toContain("pglite_lock_not_worker_held");
    // The other holder's pid is observable to the lock module but must never ride out.
    expect(JSON.stringify(res.error)).not.toContain("4242");
  });

  it("an INTACT fence writes normally — the gate is not a blanket refusal", async () => {
    const { fs, touches } = recordingVault();
    const res = await atomicCommit(fs, CHANGES, "tok", probeFor(WON));
    expect(isOk(res)).toBe(true);
    expect(touches.some((t) => t.startsWith("rename:"))).toBe(true);
    expect(await fs.read("notes/a.md")).toBe("hello");
  });

  it("DORMANCY: no fence supplied ⇒ byte-identical to before the parameter existed", async () => {
    const { fs } = recordingVault();
    expect(isOk(await atomicCommit(fs, CHANGES, "tok"))).toBe(true);
    expect(await fs.read("notes/a.md")).toBe("hello");
  });

  it("the fence is consulted PER COMMIT, not once — a lock lost mid-run blocks the NEXT write", async () => {
    // The reason this is a probe and not a boolean. A fence evaluated once at boot
    // would authorize every later write on a fact that has since expired.
    const { fs } = recordingVault();
    let held = false;
    const probe = (): readonly string[] | undefined => (held ? ["pglite_lock_not_worker_held"] : undefined);

    expect(isOk(await atomicCommit(fs, [{ path: "a.md", content: "1" }], "t1", probe))).toBe(true);
    held = true; // the lock is lost while the process keeps running
    const after = await atomicCommit(fs, [{ path: "b.md", content: "2" }], "t2", probe);
    expect(isErr(after)).toBe(true);
    expect(await fs.read("b.md")).toBeUndefined();
  });
});
