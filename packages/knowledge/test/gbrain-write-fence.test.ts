// spec(§6) — GbrainWriteFence + OS-level one-writer lockdown (REQ-S-NEW-008):
// the SoW worker is the sole OS vault-writer + sole PGLite advisory-lock holder,
// every gbrain process runs read-only-mounted, and a continuous probe ALARMS on
// any stray write-capable gbrain process bound to a canonical brain. The fence
// fails CLOSED (typed breach + a §16 HealthItem alarm), never throws (§16).
import { describe, it, expect } from "vitest";
import type { AuditId, BrainId } from "@sow/contracts";
import { HealthItemSchema } from "@sow/contracts";
import {
  classifyGbrainCommand,
  scanForStrayWriters,
  evaluateWriteFence,
  READ_ONLY_GBRAIN_COMMANDS,
  type ObservedGbrainProcess,
  type WriteFenceContext,
  type WriteFenceInput,
} from "../src/gbrain/write-fence";

const BRAIN = "brain-employer-work" as BrainId;
const OTHER_BRAIN = "brain-personal-life" as BrainId;

const ctx: WriteFenceContext = {
  now: () => "2026-07-01T00:00:00.000Z",
  auditRef: "audit-wf-1" as AuditId,
};

function proc(overrides: Partial<ObservedGbrainProcess> = {}): ObservedGbrainProcess {
  return {
    pid: 4242,
    command: "gbrain import --source fs",
    boundBrainId: BRAIN,
    mount: "read_only",
    holdsPgliteLock: false,
    ...overrides,
  };
}

function baseInput(overrides: Partial<WriteFenceInput> = {}): WriteFenceInput {
  return {
    canonicalBrainId: BRAIN,
    workerIsSoleVaultWriter: true,
    pgliteLockHolder: "worker",
    observedProcesses: [],
    ...overrides,
  };
}

describe("classifyGbrainCommand — read-only allow-set vs write-capable default-deny", () => {
  it("classifies the read-only gbrain command allow-set as read_only", () => {
    for (const cmd of READ_ONLY_GBRAIN_COMMANDS) {
      expect(classifyGbrainCommand(`gbrain ${cmd} --source fs`)).toBe("read_only");
    }
  });

  it("classifies the hard-disabled DB/vault-writing commands as write_capable", () => {
    expect(classifyGbrainCommand("gbrain serve --stdio")).toBe("write_capable");
    expect(classifyGbrainCommand("gbrain sync --install-cron")).toBe("write_capable");
    expect(classifyGbrainCommand("gbrain autopilot")).toBe("write_capable");
    expect(classifyGbrainCommand("gbrain jobs work")).toBe("write_capable");
    expect(classifyGbrainCommand("gbrain dream")).toBe("write_capable");
    expect(classifyGbrainCommand("gbrain synthesize")).toBe("write_capable");
    expect(classifyGbrainCommand("gbrain frontmatter --fix")).toBe("write_capable");
    expect(classifyGbrainCommand("gbrain put_page")).toBe("write_capable");
  });

  it("a write-marker on an otherwise read-only subcommand still classifies write_capable", () => {
    // `sync` is read-only, but `--install-cron` makes it a DB-writing scheduler.
    expect(classifyGbrainCommand("gbrain sync --install-cron")).toBe("write_capable");
  });

  it("fails closed: an UNKNOWN command is treated as write_capable (default-deny)", () => {
    expect(classifyGbrainCommand("gbrain wibble --frobnicate")).toBe("write_capable");
    expect(classifyGbrainCommand("")).toBe("write_capable");
  });
});

describe("scanForStrayWriters — the continuous probe", () => {
  it("returns no alarms when every bound process is read-only-mounted, read-only-command, lock-free", () => {
    const alarms = scanForStrayWriters(
      BRAIN,
      [proc(), proc({ pid: 2, command: "gbrain doctor --json" })],
      ctx,
    );
    expect(alarms).toHaveLength(0);
  });

  it("alarms on a stray write-capable process bound to the canonical brain", () => {
    const alarms = scanForStrayWriters(
      BRAIN,
      [proc({ pid: 9, command: "gbrain serve --stdio" })],
      ctx,
    );
    expect(alarms).toHaveLength(1);
    expect(alarms[0]!.reason).toBe("stray_write_capable_process");
    expect(alarms[0]!.offendingPid).toBe(9);
    expect(alarms[0]!.healthItem.failureClass).toBe("conflict_review");
    expect(alarms[0]!.healthItem.state).toBe("open");
  });

  it("alarms on a read-WRITE-mounted gbrain process (mount posture breach)", () => {
    const alarms = scanForStrayWriters(BRAIN, [proc({ mount: "read_write" })], ctx);
    expect(alarms.map((a) => a.reason)).toContain("gbrain_process_read_write_mounted");
  });

  it("alarms on a gbrain process that holds the PGLite advisory lock", () => {
    const alarms = scanForStrayWriters(BRAIN, [proc({ holdsPgliteLock: true })], ctx);
    expect(alarms.map((a) => a.reason)).toContain("pglite_lock_held_by_gbrain");
  });

  it("emits one distinct alarm per breach when a process trips several at once", () => {
    const alarms = scanForStrayWriters(
      BRAIN,
      [proc({ command: "gbrain dream", mount: "read_write", holdsPgliteLock: true })],
      ctx,
    );
    expect(alarms.map((a) => a.reason).sort()).toEqual(
      [
        "gbrain_process_read_write_mounted",
        "pglite_lock_held_by_gbrain",
        "stray_write_capable_process",
      ].sort(),
    );
  });

  it("IGNORES a write-capable process bound to a DIFFERENT brain (per-brain fence)", () => {
    const alarms = scanForStrayWriters(
      BRAIN,
      [proc({ boundBrainId: OTHER_BRAIN, command: "gbrain serve --stdio", mount: "read_write" })],
      ctx,
    );
    expect(alarms).toHaveLength(0);
  });

  it("every emitted alarm carries a HealthItem that PASSES the frozen contract schema", () => {
    const alarms = scanForStrayWriters(
      BRAIN,
      [proc({ command: "gbrain autopilot", mount: "read_write", holdsPgliteLock: true })],
      ctx,
    );
    expect(alarms.length).toBeGreaterThan(0);
    for (const a of alarms) {
      expect(() => HealthItemSchema.parse(a.healthItem)).not.toThrow();
    }
  });
});

describe("evaluateWriteFence — intact vs fail-closed breach", () => {
  it("INTACT: worker sole vault-writer + sole lock-holder + only read-only processes ⇒ ok", () => {
    const r = evaluateWriteFence(
      baseInput({ observedProcesses: [proc(), proc({ pid: 2, command: "gbrain lint" })] }),
      ctx,
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.status).toBe("intact");
    expect(r.value.canonicalBrainId).toBe(BRAIN);
    expect(r.value.scannedProcessCount).toBe(2);
  });

  it("BREACH: worker is not the sole vault writer ⇒ write_through_failed alarm", () => {
    const r = evaluateWriteFence(baseInput({ workerIsSoleVaultWriter: false }), ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.status).toBe("breached");
    expect(r.error.reasons).toContain("vault_acl_not_worker_exclusive");
    const acl = r.error.alarms.find((a) => a.reason === "vault_acl_not_worker_exclusive");
    expect(acl!.healthItem.failureClass).toBe("write_through_failed");
  });

  it("BREACH: the PGLite advisory lock is not held by the worker ⇒ write_through_failed", () => {
    const r = evaluateWriteFence(baseInput({ pgliteLockHolder: "none" }), ctx);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reasons).toContain("pglite_lock_not_worker_held");
  });

  it("fails closed on an UNKNOWN lock holder (default-deny — must be exactly 'worker')", () => {
    const r = evaluateWriteFence(baseInput({ pgliteLockHolder: "unknown" }), ctx);
    expect(r.ok).toBe(false);
  });

  it("BREACH: a stray write-capable process surfaces through the top-level fence", () => {
    const r = evaluateWriteFence(
      baseInput({ observedProcesses: [proc({ command: "gbrain sync --install-cron" })] }),
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reasons).toContain("stray_write_capable_process");
  });

  it("aggregates EVERY breach (posture + process) into one typed err with all alarms", () => {
    const r = evaluateWriteFence(
      baseInput({
        workerIsSoleVaultWriter: false,
        pgliteLockHolder: "gbrain",
        observedProcesses: [proc({ command: "gbrain serve --stdio", mount: "read_write" })],
      }),
      ctx,
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.reasons).toContain("vault_acl_not_worker_exclusive");
    expect(r.error.reasons).toContain("pglite_lock_not_worker_held");
    expect(r.error.reasons).toContain("stray_write_capable_process");
    expect(r.error.reasons).toContain("gbrain_process_read_write_mounted");
    expect(r.error.alarms.length).toBe(r.error.reasons.length);
    for (const a of r.error.alarms) {
      expect(() => HealthItemSchema.parse(a.healthItem)).not.toThrow();
    }
  });

  it("respects a ctx-supplied severity + healthItem id prefix override", () => {
    const r = evaluateWriteFence(baseInput({ workerIsSoleVaultWriter: false }), {
      ...ctx,
      severity: "warning",
      healthItemIdPrefix: "custom-fence",
    });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.alarms[0]!.healthItem.severity).toBe("warning");
    expect(r.error.alarms[0]!.healthItem.id.startsWith("custom-fence:")).toBe(true);
  });
});
