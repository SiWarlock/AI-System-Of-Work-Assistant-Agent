// Task 13.23 leg B/C — createEntityRefSignalsHealthSink: the LivingVaultAdapterDeps.recordEntityRefSignals
// sink boot.ts binds so the CA-2 entity-ref signal counts (truncated/rejected/withheldByReason) reach a
// HealthItem via the SAME HealthSurface.record chokepoint every other boot-time health signal in this
// file uses — recordEntityRefSignals had NOTHING constructing it in production (living-vault.ts's own
// doc comment: "nothing constructs this dep in production today").
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { WorkspaceIdSchema, sourceId, type WorkspaceId, type AuditId } from "@sow/contracts";
import type { ValidatedExtraction } from "@sow/workflows";
import {
  createLivingVaultPort,
  type SignalCountsHealth,
  type LivingVaultRewrite,
} from "../../src/composition/living-vault";
import type { SourceNoteIdentity } from "../../src/composition/sourceNotePath";
import type { HealthFailure } from "../../src/health/surface";
import { createEntityRefSignalsHealthSink } from "../../src/boot";

const WS: WorkspaceId = WorkspaceIdSchema.parse("ws-employer");
const HEALTH_DEPS = { now: () => "2026-08-25T00:00:00.000Z", newAuditId: () => "audit-erf-1" };

function signals(over: Partial<SignalCountsHealth> = {}): SignalCountsHealth {
  return {
    workspaceId: WS,
    truncated: 0,
    rejected: 0,
    withheldByReason: {},
    ...over,
  };
}

describe("createEntityRefSignalsHealthSink — the 13.23 leg B/C health sink", () => {
  it("mints a HealthFailure carrying the three counts + the arch_gap token + the workspace subjectRef", async () => {
    const failures: HealthFailure[] = [];
    const recordFailure = vi.fn((f: HealthFailure) => {
      failures.push(f);
      return Promise.resolve(undefined);
    });
    const sink = createEntityRefSignalsHealthSink({ ...HEALTH_DEPS, recordFailure });

    await sink(signals({ truncated: 3, rejected: 2, withheldByReason: { ambiguous: 1, lossy_match: 4 } }));

    expect(failures).toHaveLength(1);
    const f = failures[0]!;
    expect(f.subjectRef).toContain("ws-employer");
    expect(f.message).toContain("arch_gap:entity-ref-signals");
    expect(f.message).toContain("truncated=3");
    expect(f.message).toContain("rejected=2");
    expect(f.message).toContain("ambiguous=1");
    expect(f.message).toContain("lossy_match=4");
    expect(f.auditRef).toBe("audit-erf-1" as AuditId);
    expect(f.now).toBe("2026-08-25T00:00:00.000Z");
  });

  it("an empty withheldByReason renders no dangling withheld={} block", async () => {
    const failures: HealthFailure[] = [];
    const recordFailure = vi.fn((f: HealthFailure) => {
      failures.push(f);
      return Promise.resolve(undefined);
    });
    const sink = createEntityRefSignalsHealthSink({ ...HEALTH_DEPS, recordFailure });

    await sink(signals({ truncated: 1, rejected: 0, withheldByReason: {} }));

    expect(failures).toHaveLength(1);
    expect(failures[0]!.message).not.toContain("withheld={}");
    expect(failures[0]!.message).not.toContain("withheld={,");
  });

  it("never mints a HealthItem's raw free-form fields — the message carries ONLY counts + the closed WithheldReason keys (safety rule 7)", async () => {
    const failures: HealthFailure[] = [];
    const recordFailure = vi.fn((f: HealthFailure) => {
      failures.push(f);
      return Promise.resolve(undefined);
    });
    const sink = createEntityRefSignalsHealthSink({ ...HEALTH_DEPS, recordFailure });

    await sink(signals({ truncated: 0, rejected: 0, withheldByReason: { malformed_entity: 1 } }));

    expect(failures).toHaveLength(1);
    // Every token in the message is either fixed prose, the workspace id, a WithheldReason enum key, or
    // a digit — never a free-form string an entity name / path could ride in on.
    expect(JSON.stringify(failures[0])).not.toMatch(/entities\/|\.md/);
  });

  it("propagates a recordFailure rejection (the CALLER — living-vault.ts's emitEntityRefSignals — already best-effort-swallows; this sink does not double-swallow)", async () => {
    const recordFailure = vi.fn(() => Promise.reject(new Error("HealthSurface.record down")));
    const sink = createEntityRefSignalsHealthSink({ ...HEALTH_DEPS, recordFailure });

    await expect(sink(signals({ truncated: 1 }))).rejects.toThrow("HealthSurface.record down");
  });

  it("failureClass is an EXISTING frozen FailureClass member (no new member invented, Lesson 18)", async () => {
    const failures: HealthFailure[] = [];
    const recordFailure = vi.fn((f: HealthFailure) => {
      failures.push(f);
      return Promise.resolve(undefined);
    });
    const sink = createEntityRefSignalsHealthSink({ ...HEALTH_DEPS, recordFailure });

    await sink(signals({ rejected: 1 }));

    const { failureClassSchema } = await import("@sow/contracts");
    expect(failures).toHaveLength(1);
    expect(failureClassSchema.safeParse(failures[0]!.failureClass).success).toBe(true);
  });
});

describe("createEntityRefSignalsHealthSink plugged into the REAL createLivingVaultPort (task 13.23 leg B/C — the actual production composition boot.ts wires)", () => {
  const SRC: SourceNoteIdentity = { sourceId: sourceId("src-13-23"), contentHash: "sha256:13-23" };
  const VALIDATED = {} as unknown as ValidatedExtraction;

  it("a non-zero receipt's counts reach the injected HealthFailure sink through the REAL port, before any containment rejection", async () => {
    const failures: HealthFailure[] = [];
    const recordFailure = vi.fn((f: HealthFailure) => {
      failures.push(f);
      return Promise.resolve(undefined);
    });
    const sink = createEntityRefSignalsHealthSink({ ...HEALTH_DEPS, recordFailure });

    const fakeRewrite: LivingVaultRewrite = async () => ({
      plans: [],
      entityRefsTruncated: 5,
      entityRefsRejected: 1,
      entityRefsWithheldByReason: { ambiguous: 2 },
    });
    // An UNRESOLVABLE vaultRoot: `createLivingVaultPort`'s rewrite REJECTS on this (path_escape) — proving
    // the signal still reached the sink BEFORE that later rejection (the file's own documented ordering).
    const port = createLivingVaultPort({
      vaultRoot: "/nonexistent/vault/root/for/13-23/test",
      rewrite: fakeRewrite,
      recordEntityRefSignals: sink,
    });

    const result = await port.rewrite(VALIDATED, WS, SRC);

    expect(result.ok).toBe(false); // the unresolvable root rejects, as designed
    expect(failures).toHaveLength(1); // but the signal fired first, exactly as intended
    expect(failures[0]!.message).toContain("truncated=5");
    expect(failures[0]!.message).toContain("rejected=1");
    expect(failures[0]!.message).toContain("ambiguous=2");
  });

  it("a clean (all-zero) receipt fires the sink ZERO times — living-vault.ts's own gate, unchanged by this wiring", async () => {
    const failures: HealthFailure[] = [];
    const recordFailure = vi.fn((f: HealthFailure) => {
      failures.push(f);
      return Promise.resolve(undefined);
    });
    const sink = createEntityRefSignalsHealthSink({ ...HEALTH_DEPS, recordFailure });

    const cleanRewrite: LivingVaultRewrite = async () => ({ plans: [] });
    const port = createLivingVaultPort({
      vaultRoot: "/nonexistent/vault/root/for/13-23/test",
      rewrite: cleanRewrite,
      recordEntityRefSignals: sink,
    });

    await port.rewrite(VALIDATED, WS, SRC);

    expect(recordFailure).not.toHaveBeenCalled();
  });
});

describe("createEntityRefSignalsHealthSink — has a REAL production caller (task 13.23 leg B/C, was ZERO)", () => {
  it("boot.ts constructs the sink AND threads it into withLivingVaultRewrite's createLivingVaultPort call", () => {
    const src = readFileSync(fileURLToPath(new URL("../../src/boot.ts", import.meta.url)), "utf8");
    expect(src).toContain("createEntityRefSignalsHealthSink(");
    expect(src).toContain("recordEntityRefSignalsHealth,"); // threaded as withLivingVaultRewrite's 4th arg
    // The late-bound HealthSurface holder is filled in AFTER `surface` is constructed — proves the sink
    // reaches the SAME HealthSurface.record chokepoint every other boot-time health signal uses, not a
    // disconnected/never-filled stand-in.
    expect(src).toContain("entityRefSignalsHealthSurfaceHolder.surface = surface;");
  });
});
