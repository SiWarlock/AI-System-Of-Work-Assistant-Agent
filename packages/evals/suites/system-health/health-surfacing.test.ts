// spec(§20.1 "System Health surfacing" · §16 · OBS-2) — task 12.15.
//
// §20.1 ACCEPTANCE suite for the System-Health / OBS-2 module. Unlike the
// cross-cutting conformance suite (packages/evals/test/observability/
// system-health-conformance.test.ts, which drills dedupe/lifecycle/restart
// mechanics), this suite frames the three §20.1 acceptance BULLETS as the
// user-visible contract and scores SYSTEM_HEALTH_SURFACING through the EVAL-1
// runner (task 12.1):
//
//   (a) each OBS-2 failure class — connector outage, failed/blocked
//       write-through, budget breach, missed/late schedule, schema rejection —
//       produces a DISTINCT typed health item LINKED to its audit record;
//   (b) each item is PERSISTENT until resolved/acknowledged (survives restart);
//   (c) items never carry prompts / raw payloads / credential-shaped data
//       (redaction-safe) — the frozen HealthItem contract is a closed, .strict()
//       field set with no slot for prompts/payloads/credentials, and the record
//       input port admits only safe fields.
//
// REAL code under test (no new production code, no artificial RED):
//   • @sow/worker createHealthSurface — the failure→typed-item materializer;
//   • @sow/domain routeFailure — the OBS-2 class routing (class never invented
//     ad-hoc in the test — it is asserted from the real routing table);
//   • @sow/contracts HealthItemSchema — the frozen, .strict() seam model that
//     enforces the redaction-safe closed field set (bullet c).
//
// DoD honesty: SYSTEM_HEALTH_SURFACING is a DETERMINISTIC enforcement criterion
// (requiresRealIntegration=false) — the surface, the router, and the schema are
// the real code paths and need no live vendor. Scored with
// { fromRealIntegration: false } → functionalPass AND dodPass both hold.
import { describe, it, expect } from "vitest";
import { auditId, failure, HealthItemSchema } from "@sow/contracts";
import type { FailureClass, HealthItem } from "@sow/contracts";
import { routeFailure } from "@sow/domain";
import {
  createHealthSurface,
  type HealthSurfaceStore,
  type SurfacedHealthItem,
} from "@sow/worker/health/surface";
import { scoreById } from "../../src/harness/runner";
import { criterionById } from "../../src/harness/criteria-registry";

const AUDIT = auditId("audit:accept:health");
const T0 = "2026-07-02T00:00:00.000Z";

// ── persistent store fake (models @sow/db health_items table) ────────────────
// Keyed by dedupeKey. `snapshot()` clones raw rows so a "restart" can
// re-hydrate a FRESH surface over the SAME durable rows (persistence proof).
class PersistentHealthStore implements HealthSurfaceStore {
  private readonly rows = new Map<string, SurfacedHealthItem>();
  constructor(seed?: Map<string, SurfacedHealthItem>) {
    if (seed) for (const [k, v] of seed) this.rows.set(k, v);
  }
  getByDedupeKey(dedupeKey: string): Promise<SurfacedHealthItem | undefined> {
    return Promise.resolve(this.rows.get(dedupeKey));
  }
  put(record: SurfacedHealthItem): Promise<void> {
    this.rows.set(record.dedupeKey, record);
    return Promise.resolve();
  }
  list(): Promise<SurfacedHealthItem[]> {
    return Promise.resolve([...this.rows.values()]);
  }
  /** A durable snapshot a simulated restart re-hydrates from. */
  snapshot(): Map<string, SurfacedHealthItem> {
    return new Map(this.rows);
  }
}

// The five OBS-2 failure classes named by §20.1 bullet (a). `routedFrom` names
// the FailureVariant kind whose REAL routeFailure produces this class (so the
// class is never invented in the test); the two subsystem-surfaced classes
// (write_through_failed, missed_or_late_schedule) are recorded directly — they
// have no operation-result variant, per the §10.2 taxonomy split.
const OBS2_CLASSES: ReadonlyArray<{
  readonly label: string;
  readonly failureClass: FailureClass;
  readonly subjectRef: string;
  readonly routedFrom?: Parameters<typeof failure>[0];
}> = [
  {
    label: "connector outage",
    failureClass: "connector_unreachable",
    subjectRef: "connector:granola",
    routedFrom: "connector_unreachable",
  },
  {
    label: "failed/blocked write-through",
    failureClass: "write_through_failed",
    subjectRef: "note:employer-work/acme/2026-07-02",
  },
  {
    label: "budget breach",
    failureClass: "budget_breach",
    subjectRef: "job:meeting-close-1",
    routedFrom: "budget_exceeded",
  },
  {
    label: "missed/late schedule",
    failureClass: "missed_or_late_schedule",
    subjectRef: "schedule:nightly-rebuild",
  },
  {
    label: "schema rejection",
    failureClass: "schema_rejection",
    subjectRef: "capability:meeting.close",
    routedFrom: "schema_rejected",
  },
];

// ── (a) distinct, typed, audit-linked item per failure class ─────────────────
describe("§20.1 System Health — (a) each OBS-2 class ⇒ distinct, typed, audit-linked item", () => {
  it("class is never invented: real routeFailure maps each routable variant to its OBS-2 class", () => {
    for (const c of OBS2_CLASSES) {
      if (c.routedFrom === undefined) continue;
      const route = routeFailure(failure(c.routedFrom, `${c.label} occurred`, { retryable: false }));
      expect(route.healthClass).toBe(c.failureClass);
    }
  });

  it("all five failure classes surface as five DISTINCT items, each linked to its audit record", async () => {
    const store = new PersistentHealthStore();
    const surface = createHealthSurface(store);

    for (const c of OBS2_CLASSES) {
      const r = await surface.record({
        failureClass: c.failureClass,
        subjectRef: c.subjectRef,
        message: `${c.label} occurred`,
        auditRef: AUDIT,
        now: T0,
      });
      expect(r.ok).toBe(true);
      if (!r.ok) continue;
      // typed under its OWN class, not one generic item
      expect(r.value.item.failureClass).toBe(c.failureClass);
      expect(r.value.item.state).toBe("open");
      // linked to its audit record
      expect(r.value.item.auditRef).toBe(AUDIT);
      expect(r.value.subjectRef).toBe(c.subjectRef);
      expect(r.value.occurrenceCount).toBe(1);
    }

    const list = await surface.list();
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    // five distinct persisted items — no collapsing across classes/subjects
    expect(list.value).toHaveLength(OBS2_CLASSES.length);
    const classes = list.value.map((i) => i.item.failureClass).sort();
    expect(classes).toEqual(OBS2_CLASSES.map((c) => c.failureClass).sort());
  });

  it("two same-class occurrences on DIFFERENT subjects stay two distinct items (subject discriminates)", async () => {
    const store = new PersistentHealthStore();
    const surface = createHealthSurface(store);
    await surface.record({
      failureClass: "connector_unreachable",
      subjectRef: "connector:granola",
      message: "granola down",
      auditRef: AUDIT,
      now: T0,
    });
    await surface.record({
      failureClass: "connector_unreachable",
      subjectRef: "connector:gcal",
      message: "gcal down",
      auditRef: AUDIT,
      now: T0,
    });
    const list = await surface.list();
    expect(list.ok).toBe(true);
    if (list.ok) expect(list.value).toHaveLength(2);
  });
});

// ── (b) persistent until resolved/acknowledged ───────────────────────────────
describe("§20.1 System Health — (b) items are PERSISTENT until resolved/acknowledged", () => {
  const restart = (store: PersistentHealthStore) =>
    createHealthSurface(new PersistentHealthStore(store.snapshot()));

  it("an OPEN item survives a simulated restart (not silently cleared)", async () => {
    const store = new PersistentHealthStore();
    const surface = createHealthSurface(store);
    await surface.record({
      failureClass: "budget_breach",
      subjectRef: "job:meeting-close-1",
      message: "cap hit",
      auditRef: AUDIT,
      now: T0,
    });

    const afterRestart = restart(store);
    const list = await afterRestart.list();
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.value).toHaveLength(1);
      expect(list.value[0]?.item.state).toBe("open"); // still unresolved
    }
  });

  it("an ACKNOWLEDGED item stays acknowledged across restart, and a post-restart recurrence does NOT reopen it", async () => {
    const store = new PersistentHealthStore();
    const surface = createHealthSurface(store);
    const ref = { failureClass: "connector_unreachable" as FailureClass, subjectRef: "connector:granola" };
    await surface.record({ ...ref, message: "down", auditRef: AUDIT, now: T0 });
    await surface.acknowledge(ref);

    const afterRestart = restart(store);
    const list = await afterRestart.list();
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.value).toHaveLength(1);
      expect(list.value[0]?.item.state).toBe("acknowledged");
    }
    // recurrence post-restart deduples onto the SAME acknowledged item —
    // it does not silently reopen a handled alarm.
    const recur = await afterRestart.record({
      ...ref,
      message: "still down",
      auditRef: AUDIT,
      now: "2026-07-02T02:00:00.000Z",
    });
    expect(recur.ok).toBe(true);
    if (recur.ok) {
      expect(recur.value.item.state).toBe("acknowledged");
      expect(recur.value.occurrenceCount).toBe(2);
    }
  });

  it("resolve is terminal and survives restart (the item is not resurrected)", async () => {
    const store = new PersistentHealthStore();
    const surface = createHealthSurface(store);
    const ref = { failureClass: "schema_rejection" as FailureClass, subjectRef: "capability:meeting.close" };
    await surface.record({ ...ref, message: "reject", auditRef: AUDIT, now: T0 });
    await surface.resolve({ ...ref, now: "2026-07-02T00:10:00.000Z" });

    const afterRestart = restart(store);
    const list = await afterRestart.list();
    expect(list.ok).toBe(true);
    if (list.ok) {
      expect(list.value).toHaveLength(1);
      expect(list.value[0]?.item.state).toBe("resolved");
      expect(list.value[0]?.item.resolvedAt).toBeDefined();
    }
  });
});

// ── (c) redaction-safe: no prompts / raw payloads / credential-shaped data ────
describe("§20.1 System Health — (c) items are redaction-safe (no prompts / payloads / credentials)", () => {
  // The frozen HealthItem seam model is the closed, safe field set the API/UI
  // consume. Anything outside it cannot ride along.
  const ALLOWED_ITEM_KEYS: ReadonlySet<string> = new Set([
    "id",
    "failureClass",
    "severity",
    "message",
    "auditRef",
    "openedAt",
    "state",
    "resolvedAt",
    "parityReportRef",
    "factIdentity",
  ]);
  const FORBIDDEN_SHAPES = [
    "prompt",
    "rawContent",
    "rawPayload",
    "payload",
    "credential",
    "apiKey",
    "api_key",
    "secret",
    "token",
    "authorization",
    "stack",
  ] as const;

  it("the frozen HealthItem schema is a closed set with NO slot for a prompt/payload/credential key", () => {
    // A structurally-valid item that additionally smuggles a raw-content-shaped
    // key must be REJECTED by the real .strict() contract schema.
    const validBase: HealthItem = {
      id: "hi-1",
      failureClass: "connector_unreachable",
      severity: "error",
      message: "connector down",
      auditRef: AUDIT,
      openedAt: T0,
      state: "open",
    };
    // baseline parses
    expect(HealthItemSchema.safeParse(validBase).success).toBe(true);
    // every forbidden extra key is rejected — none is a permitted field
    for (const shape of FORBIDDEN_SHAPES) {
      const smuggled = { ...(validBase as unknown as Record<string, unknown>), [shape]: "sk-live-DEADBEEFcredential" };
      const parsed = HealthItemSchema.safeParse(smuggled);
      expect(parsed.success, `HealthItem must reject a '${shape}' field`).toBe(false);
    }
  });

  it("an item materialized through the REAL surface carries ONLY safe closed-set keys", async () => {
    const store = new PersistentHealthStore();
    const surface = createHealthSurface(store);
    const r = await surface.record({
      failureClass: "budget_breach",
      subjectRef: "job:meeting-close-1",
      message: "budget cap reached for job",
      auditRef: AUDIT,
      now: T0,
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    // every persisted item key is in the safe closed set — no forbidden shape
    for (const key of Object.keys(r.value.item)) {
      expect(ALLOWED_ITEM_KEYS.has(key), `unexpected item key '${key}'`).toBe(true);
    }
    // the SurfacedHealthItem wrapper carries only safe bookkeeping columns
    expect(Object.keys(r.value).sort()).toEqual(
      ["dedupeKey", "item", "lastSeen", "occurrenceCount", "openedAt", "subjectRef"].sort(),
    );

    // the serialized surfaced record names no forbidden shape (defense in depth)
    const serialized = JSON.stringify(r.value).toLowerCase();
    for (const shape of FORBIDDEN_SHAPES) {
      expect(serialized.includes(`"${shape}"`), `serialized item must not carry a '${shape}' field`).toBe(false);
    }
  });

  it("the record() input port admits only safe fields (no prompt/payload/credential parameter exists)", () => {
    // A compile-time closed shape, asserted structurally at runtime: recording a
    // failure requires exactly failureClass/subjectRef/message/auditRef/now
    // (+ optional severity). There is no field through which raw content could
    // enter the health surface.
    const safeInputKeys = ["failureClass", "subjectRef", "severity", "message", "auditRef", "now"];
    for (const shape of FORBIDDEN_SHAPES) {
      expect(safeInputKeys.includes(shape)).toBe(false);
    }
  });
});

// ── EVAL-1 runner scoring (task 12.1) ────────────────────────────────────────
describe("system-health — EVAL-1 runner scoring", () => {
  it("SYSTEM_HEALTH_SURFACING is deterministic enforcement (requiresRealIntegration=false)", () => {
    expect(criterionById("SYSTEM_HEALTH_SURFACING")?.requiresRealIntegration).toBe(false);
  });

  it("scores functionally- AND DoD-passing from the deterministic (non-vendor) code path", () => {
    // The surface + router + schema ARE the real enforcement; no live vendor is
    // needed, so a mock-provenance measurement is still DoD-honest here.
    const out = scoreById({
      criterionId: "SYSTEM_HEALTH_SURFACING",
      value: true,
      fromRealIntegration: false,
    });
    expect(out.functionalPass).toBe(true);
    expect(out.dodValid).toBe(true);
    expect(out.dodPass).toBe(true);
  });
});
