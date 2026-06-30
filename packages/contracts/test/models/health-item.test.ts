// HealthItem contract test (task WT-amended, §16/§10/§11). RED-first schema-
// snapshot freeze + behavior + conditional-invariant coverage. Modeled on the
// canonical EgressPolicy template. PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import { HealthItemSchema, HEALTH_ITEM_SCHEMA_ID } from "../../src/models/health-item";
import { FailureClass } from "../../src/models/shared-enums";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

// A minimal valid open item (no resolvedAt, no optional refs).
const openItem = {
  id: "hi-001",
  failureClass: "connector_unreachable",
  severity: "warning",
  message: "Drive connector unreachable",
  auditRef: "audit-001",
  openedAt: "2026-06-30T12:00:00.000Z",
  state: "open",
} as const;

describe("HealthItem contract — spec(§16/§10/§11)", () => {
  // ── Frozen field-name set (the spec, hand-authored in __snapshots__) ──────
  it("freezes its top-level field-name set to the spec snapshot", () => {
    expect(fieldSet(emitJsonSchema(HealthItemSchema, HEALTH_ITEM_SCHEMA_ID))).toEqual(
      loadFieldSnapshot("health-item"),
    );
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ─
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/health-item.schema.json", import.meta.url),
      emitJsonSchema(HealthItemSchema, HEALTH_ITEM_SCHEMA_ID),
    );
  });

  // ── Behaviors ────────────────────────────────────────────────────────────
  it("accepts a valid open item (no resolvedAt)", () => {
    expect(HealthItemSchema.safeParse(openItem).success).toBe(true);
  });

  it("accepts a valid acknowledged item (no resolvedAt)", () => {
    const ok = HealthItemSchema.safeParse({ ...openItem, state: "acknowledged" });
    expect(ok.success).toBe(true);
  });

  it("accepts a valid resolved item with resolvedAt + optional parityReportRef + factIdentity", () => {
    const ok = HealthItemSchema.safeParse({
      ...openItem,
      failureClass: "parity_defect",
      state: "resolved",
      resolvedAt: "2026-06-30T13:00:00.000Z",
      parityReportRef: "report-77",
      factIdentity: "page:employer-work/acme/auth-redesign",
    });
    expect(ok.success).toBe(true);
  });

  // OBS-2 discriminant set: every one of the 10 failure classes (incl. the two
  // write-through amendment additions) must parse — cross-track consumers can't
  // drift the taxonomy.
  it("accepts every OBS-2 failureClass in the frozen 10-value taxonomy", () => {
    for (const fc of FailureClass) {
      const ok = HealthItemSchema.safeParse({ ...openItem, failureClass: fc });
      expect(ok.success, `failureClass ${fc} should parse`).toBe(true);
    }
    expect(FailureClass).toContain("sync_lagging");
    expect(FailureClass).toContain("rebuild_divergence");
  });

  it("rejects an unknown top-level key (.strict)", () => {
    const bad = HealthItemSchema.safeParse({ ...openItem, extra: "nope" });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty id (min(1); arch_gap: no HealthItemId brand upstream)", () => {
    expect(HealthItemSchema.safeParse({ ...openItem, id: "" }).success).toBe(false);
  });

  it("rejects an empty/whitespace severity (non-empty open string)", () => {
    expect(HealthItemSchema.safeParse({ ...openItem, severity: "" }).success).toBe(false);
  });

  it("rejects an empty/whitespace message (non-empty)", () => {
    expect(HealthItemSchema.safeParse({ ...openItem, message: "" }).success).toBe(false);
  });

  it("rejects an empty/whitespace auditRef (branded non-empty)", () => {
    expect(HealthItemSchema.safeParse({ ...openItem, auditRef: "  " }).success).toBe(false);
  });

  it("rejects a failureClass outside the OBS-2 taxonomy", () => {
    expect(
      HealthItemSchema.safeParse({ ...openItem, failureClass: "meltdown" }).success,
    ).toBe(false);
  });

  it("rejects a state outside open|acknowledged|resolved", () => {
    expect(
      HealthItemSchema.safeParse({ ...openItem, state: "closed" }).success,
    ).toBe(false);
  });

  it("rejects a non-datetime openedAt", () => {
    expect(HealthItemSchema.safeParse({ ...openItem, openedAt: "yesterday" }).success).toBe(
      false,
    );
  });

  it("rejects a non-datetime resolvedAt", () => {
    const bad = HealthItemSchema.safeParse({
      ...openItem,
      state: "resolved",
      resolvedAt: "soon",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a malformed factIdentity (regex-gated identity form)", () => {
    expect(
      HealthItemSchema.safeParse({ ...openItem, factIdentity: "not-an-identity" }).success,
    ).toBe(false);
  });

  it("rejects a missing required field (failureClass)", () => {
    const { failureClass: _omit, ...noClass } = openItem;
    expect(HealthItemSchema.safeParse(noClass).success).toBe(false);
  });

  // ── Conditional invariant: resolvedAt present IFF state === 'resolved' ──────
  // Passing each way is covered above (open/acknowledged → no resolvedAt;
  // resolved → resolvedAt). The two failing directions:
  it("rejects state === 'resolved' WITHOUT resolvedAt (IFF, forward)", () => {
    const bad = HealthItemSchema.safeParse({ ...openItem, state: "resolved" });
    expect(bad.success).toBe(false);
  });

  it("rejects resolvedAt present WHILE state !== 'resolved' (IFF, reverse)", () => {
    const bad = HealthItemSchema.safeParse({
      ...openItem,
      state: "open",
      resolvedAt: "2026-06-30T13:00:00.000Z",
    });
    expect(bad.success).toBe(false);
  });
});
