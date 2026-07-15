// Task 14.3 (worker leg) — verify-and-pin the System-Health mint→durable-surface→
// redaction-safe-read round-trip. Most of this is built (Phase 10): the persistent
// HealthSurface is boot-bound, the temporal-unavailable producer records worker_down,
// and systemHealth reads it. The NEW pin here is REDACTION (safety rule 7): a minted
// HealthItem whose `message` carries a marker-secret must surface REF-ONLY through the
// read projection — `toUiSafeHealthItem` DROPS message/auditRef/parityReportRef/factIdentity.
import { describe, it, expect, afterEach } from "vitest";
import { auditId, isOk, type AuditId, type FailureVariant, type HealthItem, type Result, type UiSafeHealthItem } from "@sow/contracts";
import { openDatabase, type OpenDatabase } from "../../src/composition/backends";
import {
  createHealthItemStoreAdapter,
  createPersistentHealthSurfaceStore,
} from "../../src/composition/store-adapters";
import { createHealthSurface } from "../../src/health/surface";
import { toUiSafeHealthItem } from "../../src/api/projections/uiSafe";
import { createCallerFactory, router, type ApiContext } from "../../src/api/trpc";
import { buildSystemHealthRouter, type SystemHealthQueryPort } from "../../src/api/procedures/systemHealth";

const NOW = "2026-07-15T00:00:00.000Z";
const AUDIT: AuditId = auditId("worker-boot:temporal-degraded");
const AUTHED_CTX: ApiContext = { auth: { ok: true, value: { authenticated: true } } };

const opened: OpenDatabase[] = [];
afterEach(() => {
  for (const o of opened.splice(0)) o.conn.close();
});
async function freshHealth() {
  const o = await openDatabase({ dbPath: ":memory:" });
  opened.push(o);
  const healthItems = createHealthItemStoreAdapter(o.repos.healthItems, () => NOW);
  const surface = createHealthSurface(createPersistentHealthSurfaceStore(healthItems));
  return { healthItems, surface };
}

describe("System-Health read path (14.3 — mint → durable retain → redaction-safe read)", () => {
  it("health_item_retained_and_read_round_trips: a worker_down failure recorded through the surface is RETAINED durably + round-trips as a UiSafeHealthItem [spec(§16)]", async () => {
    const { healthItems, surface } = await freshHealth();
    const rec = await surface.record({
      failureClass: "worker_down",
      subjectRef: "temporal:default",
      message: "Temporal server unreachable — dispatch held.",
      auditRef: AUDIT,
      now: NOW,
    });
    expect(rec.ok).toBe(true);
    // The systemHealth read path: healthItems.list() → toUiSafeHealthItem.
    const uiSafe = (await healthItems.list()).map(toUiSafeHealthItem);
    expect(uiSafe).toHaveLength(1);
    expect(uiSafe[0]?.failureClass).toBe("worker_down"); // ref-only, but round-trips
    expect(uiSafe[0]?.id).toBe("worker_down|temporal:default");
    expect(uiSafe[0]?.state).toBe("open");
  });

  it("health_read_redacts_secret_message: a durable-retained HealthItem whose message carries a marker-secret surfaces REF-ONLY (no leak) [safety rule 7]", async () => {
    const { healthItems, surface } = await freshHealth();
    await surface.record({
      failureClass: "worker_down",
      subjectRef: "temporal:default",
      message: "Temporal down — SECRET-MARKER-abc123 leaked into the message field",
      auditRef: AUDIT,
      now: NOW,
    });
    const retained = await healthItems.list();
    // NON-VACUOUS setup: the durable store RETAINS the raw message at rest (so the redaction is
    // attributable to the READ projection, not to the store silently dropping it).
    expect(retained[0]?.message).toContain("SECRET-MARKER-abc123");
    const uiSafe = retained.map(toUiSafeHealthItem);
    expect(uiSafe).toHaveLength(1);
    // The read projection DROPS it: assert the marker + the raw message are ABSENT.
    const serialized = JSON.stringify(uiSafe);
    expect(serialized).not.toContain("SECRET-MARKER-abc123");
    expect(serialized).not.toContain("Temporal down");
    // The UiSafeHealthItem shape has no message/auditRef/parityReportRef/factIdentity key.
    const keys = Object.keys(uiSafe[0] ?? {});
    expect(keys).not.toContain("message");
    expect(keys).not.toContain("auditRef");
    expect(keys).not.toContain("parityReportRef");
    expect(keys).not.toContain("factIdentity");
  });

  it("health_read_procedure_redacts: the systemHealth `items` query projects HealthItems to UiSafeHealthItem — a secret message never crosses the tRPC boundary [safety rule 7]", async () => {
    // A fake port returns a raw HealthItem carrying a secret in `message`; the PROCEDURE's
    // projection must drop it before it crosses to the renderer.
    const secretItem: HealthItem = {
      id: "worker_down|temporal:default",
      failureClass: "worker_down",
      severity: "critical",
      message: "raw SECRET-MARKER-xyz789 in the health message",
      auditRef: AUDIT,
      openedAt: NOW,
      state: "open",
    };
    const port: SystemHealthQueryPort = {
      healthItems: (): Result<readonly HealthItem[], FailureVariant> => ({ ok: true, value: [secretItem] }),
      egressStatus: (workspaceId): Result<{ workspaceId: string; employerRawEgressAcknowledged: boolean; zeroEgressOnly: boolean }, FailureVariant> =>
        ({ ok: true, value: { workspaceId, employerRawEgressAcknowledged: false, zeroEgressOnly: true } }),
    };
    const appRouter = router({ systemHealth: buildSystemHealthRouter({ systemHealth: port }) });
    const caller = createCallerFactory(appRouter)(AUTHED_CTX);
    const res = (await caller.systemHealth.items()) as Result<readonly UiSafeHealthItem[], FailureVariant>;
    expect(isOk(res)).toBe(true);
    if (isOk(res)) {
      expect(res.value).toHaveLength(1);
      expect(res.value[0]?.failureClass).toBe("worker_down");
      expect(JSON.stringify(res.value)).not.toContain("SECRET-MARKER-xyz789");
    }
  });
});
