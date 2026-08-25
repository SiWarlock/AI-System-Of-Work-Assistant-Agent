// Task 19.4 — createReconcileTrigger over the REAL scheduler → driver → pass chain (pieces E→D→A, all
// composed from the real production modules, never re-implemented). Three pins:
//   1. a canonical-vs-DB divergence mints a parity_defect HealthItem (through the FULL real chain);
//   2. a clean (faithfully mirrored) vault yields a clean report, zero health items;
//   3. a BURST of enqueues collapses to exactly ONE reconcile per flush.
// Plus a companion sanity pin for buildDegradableDbProjectionReader run against `makeDbAdapter: () =>
// undefined` (the exact boot.ts:2386 shipped-default shape) — degrade, complete=false, never a throw.
import { describe, it, expect, vi } from "vitest";
import {
  isOk,
  WorkspaceIdSchema,
  RevisionIdSchema,
  type WorkspaceId,
  type RevisionId,
  type HealthItem,
} from "@sow/contracts";
import {
  deriveCanonicalFacts,
  type CanonicalFactSet,
  type DerivedFact,
  type DbFact,
  type ReconcilerDbProjection,
  type ReconcilerDeps,
  type ReconcileTriggerOrigin,
} from "@sow/knowledge";
import { runReconcilePass, type ReconcileHealthSink } from "../../src/composition/parityReconcile";
import { runReconcileForWorkspace, type ReconcileDriverDeps } from "../../src/composition/reconcileDriver";
import { createReconcileScheduler, type LoggedReconcileOutcome } from "../../src/composition/reconcileScheduler";
import {
  createReconcileTrigger,
  buildDegradableDbProjectionReader,
} from "../../src/composition/reconcileTrigger";
import type { ParityReportRecorder } from "../../src/composition/parityReportStore";
import type { CanonicalSnapshotOutcome } from "../../src/composition/canonicalFactSet";

const WS: WorkspaceId = WorkspaceIdSchema.parse("ws-employer");
const REV: RevisionId = RevisionIdSchema.parse("rev:abc123");

function canonical(files: Record<string, string>): CanonicalFactSet {
  const r = deriveCanonicalFacts({ workspaceId: WS, revisionId: REV, files: new Map(Object.entries(files)) });
  if (!isOk(r)) throw new Error("derive failed in fixture");
  return r.value;
}

/** A DB projection that faithfully mirrors a canonical set (stamped, current, hash-equal) → clean. */
function mirrorDb(set: CanonicalFactSet): ReconcilerDbProjection {
  const facts: DbFact[] = set.facts.map((df: DerivedFact) => ({
    factIdentity: df.fact.factIdentity as string,
    factKind: df.fact.factKind,
    dbContentHash: df.fact.mdContentSha as string,
    stamped: true,
    revisionId: REV as string,
  }));
  return { workspaceId: WS as string, gbrainSchemaVersion: 3, facts, complete: true };
}

function makeReconcilerDeps(): ReconcilerDeps {
  let seq = 0;
  return {
    newReportId: () => `report-${(seq += 1)}`,
    newHealthItemId: () => `health-${(seq += 1)}`,
    newAuditId: () => `audit-${(seq += 1)}`,
    now: () => "2026-07-14T00:00:00.000Z",
  };
}

/** A no-op-but-real recorder (never rejects) — mirrors parityReconcile.test.ts's fakes; not the store's own
 *  concern here (the store adapter is a different piece — this pin is about the TRIGGER wiring). */
function fakeRecorder(): ParityReportRecorder {
  return {
    record: async (): Promise<void> => undefined,
  };
}

/** Build the FULL real driver deps (scheduler → driver → pass, all real modules) over the given canonical
 *  set + db projection, recording every routed HealthItem for assertions. */
function buildFullChain(canonicalSet: CanonicalFactSet, dbProjection: ReconcilerDbProjection) {
  const routed: HealthItem[] = [];
  const healthSink: ReconcileHealthSink = { record: async (item) => void routed.push(item) };
  const runPass = (req: Parameters<typeof runReconcilePass>[0]) =>
    runReconcilePass(req, { reconcilerDeps: makeReconcilerDeps(), recorder: fakeRecorder(), healthSink });

  const driverDeps: ReconcileDriverDeps = {
    getCanonicalFactSet: async (): Promise<CanonicalSnapshotOutcome> => ({ kind: "derived", set: canonicalSet }),
    getDbProjection: async (): Promise<ReconcilerDbProjection> => dbProjection,
    origin: "post_commit",
    runPass,
  };

  const logs: LoggedReconcileOutcome[] = [];
  let runReconcileCalls = 0;
  const scheduler = createReconcileScheduler({
    runReconcile: async (workspaceId: string, origin: ReconcileTriggerOrigin) => {
      runReconcileCalls += 1;
      return runReconcileForWorkspace(workspaceId, { ...driverDeps, origin });
    },
    log: (l) => routedLog(l),
  });
  function routedLog(l: LoggedReconcileOutcome): void {
    logs.push(l);
  }
  const trigger = createReconcileTrigger({ scheduler });
  return { trigger, routed, logs, callCount: (): number => runReconcileCalls };
}

describe("createReconcileTrigger — the trigger source over the real scheduler→driver→pass chain (19.4)", () => {
  it("a canonical-vs-DB divergence mints a parity_defect HealthItem (routed through the REAL health sink)", async () => {
    const set = canonical({ "p.md": "hi" });
    const db = mirrorDb(set);
    const ghost: DbFact = {
      factIdentity: "page:ghost",
      factKind: "page",
      dbContentHash: "ab".repeat(32),
      stamped: true,
      revisionId: REV as string,
    };
    const { trigger, routed } = buildFullChain(set, { ...db, facts: [...db.facts, ghost] });

    await trigger.notify(WS as string, "post_commit", REV as string);

    expect(routed).toHaveLength(1);
    expect(routed[0]?.failureClass).toBe("parity_defect");
  });

  it("a clean (faithfully mirrored) vault yields a clean report — zero health items routed", async () => {
    const set = canonical({ "p.md": "hi", "q.md": "[[p]]" });
    const { trigger, routed } = buildFullChain(set, mirrorDb(set));

    await trigger.notify(WS as string, "post_commit", REV as string);

    expect(routed).toHaveLength(0);
  });

  it("a BURST of enqueues (synchronous notify() calls) collapses to EXACTLY ONE reconcile per flush", async () => {
    const set = canonical({ "p.md": "hi" });
    const { trigger, callCount } = buildFullChain(set, mirrorDb(set));

    // Three notify() calls fired SYNCHRONOUSLY (no await between them) — the real-world shape of a burst of
    // fs-watcher events or rapid post-commit hooks arriving within the same microtask turn.
    const p1 = trigger.notify(WS as string, "fs_watch", "rev:1");
    const p2 = trigger.notify(WS as string, "fs_watch", "rev:2");
    const p3 = trigger.notify(WS as string, "fs_watch", "rev:3");
    // All three share the SAME coalesced flush promise (proves they rode one burst, not three separate ones).
    expect(p1).toBe(p2);
    expect(p2).toBe(p3);
    await p1;

    expect(callCount()).toBe(1); // ONE reconcile for the whole burst, not three
  });

  it("a SEQUENTIAL (awaited) series of notify() calls does NOT collapse — each is its own reconcile", async () => {
    // Contrast with the burst case: once a flush has genuinely COMPLETED, a later notify() starts a NEW one.
    const set = canonical({ "p.md": "hi" });
    const { trigger, callCount } = buildFullChain(set, mirrorDb(set));

    await trigger.notify(WS as string, "post_commit", "rev:1");
    await trigger.notify(WS as string, "post_commit", "rev:2");

    expect(callCount()).toBe(2);
  });
});

describe("buildDegradableDbProjectionReader — the shipped-default degrade shape (boot.ts:2386's makeDbAdapter)", () => {
  it("makeDbAdapter: () => undefined ⇒ degrade (complete=false, empty facts), never a throw", async () => {
    const reader = buildDegradableDbProjectionReader(() => undefined);
    const projection = await reader(WS as string);
    expect(projection).toEqual({ workspaceId: WS, gbrainSchemaVersion: 0, facts: [], complete: false });
  });

  it("a bound adapter delegates to the real buildReconcilerDbProjection (piece B) — never a hardcoded stub", async () => {
    const graph = vi.fn(async () => ({ ok: true as const, value: { facts: [], complete: true } }));
    const schemaRead = vi.fn(async () => ({ ok: true as const, value: { schemaVersion: 5 } }));
    const reader = buildDegradableDbProjectionReader(() => ({
      workspaceId: WS,
      brainId: "brain-1" as never,
      pinnedSha: "sha",
      allowedOps: ["graph", "schema_read"] as never,
      search: async () => ({ ok: true as const, value: {} }),
      graph,
      schemaRead,
      timeline: async () => ({ ok: true as const, value: {} }),
      health: async () => ({ ok: true as const, value: {} }),
      containedSynthesis: async () => ({ ok: true as const, value: {} }),
    }));
    const projection = await reader(WS as string);
    expect(graph).toHaveBeenCalledTimes(1);
    expect(projection.gbrainSchemaVersion).toBe(5);
    expect(projection.complete).toBe(true);
  });
});
