// UI-safe projection contract test (task 8.2, §10 UI-safe projections / WS-8
// leakage gate). SECURITY-CRITICAL: the renderer receives ONLY these narrow
// shapes — never secrets, Keychain refs, raw Employer-Work content, provider
// prompts, or AgentResult.logs. This test freezes each projection's runtime
// field set against its UI_SAFE_ALLOWLIST entry (no field can be silently added
// later) and rejects any allowlisted field whose name is a known-sensitive one.
// PURE — no app/adapter imports, no @trpc import.
import { describe, expect, it } from "vitest";
import {
  UiSafeApprovalSchema,
  UiSafeHealthItemSchema,
  UiSafeWorkflowRunRefSchema,
  UiSafeDashboardCardSchema,
  UI_SAFE_ALLOWLIST,
} from "../../src/api/ui-safe";

// Known-sensitive name fragments: any allowlisted field whose lower-cased name
// contains one of these is a leakage defect (§10 UI-safe projections / WS-8).
const SENSITIVE_FRAGMENTS = [
  "secret",
  "token",
  "apikey",
  "prompt",
  "rawcontent",
  "logs",
  "keychain",
] as const;

// The projection schemas paired with their allowlist entry, keyed by allowlist
// name. The allowlist is THE source of truth; each schema's own `.shape` keys
// must EQUAL its entry (a snapshot-style equality freeze).
const PROJECTIONS = [
  ["approval", UiSafeApprovalSchema, UI_SAFE_ALLOWLIST.approval] as const,
  ["healthItem", UiSafeHealthItemSchema, UI_SAFE_ALLOWLIST.healthItem] as const,
  ["workflowRunRef", UiSafeWorkflowRunRefSchema, UI_SAFE_ALLOWLIST.workflowRunRef] as const,
  ["dashboardCard", UiSafeDashboardCardSchema, UI_SAFE_ALLOWLIST.dashboardCard] as const,
] as const;

describe("UI-safe projections — spec(§10 UI-safe projections / WS-8 leakage gate)", () => {
  // ── Field-set freeze: each projection's runtime keys EQUAL its allowlist ─────
  for (const [name, schema, allowlist] of PROJECTIONS) {
    it(`${name}: schema field set EQUALS its UI_SAFE_ALLOWLIST entry (freeze)`, () => {
      const schemaKeys = Object.keys(schema.shape).sort();
      // Allowlist is checked-in already sorted; compare against a sorted copy so
      // the equality is order-independent but the checked-in form stays sorted.
      expect(schemaKeys).toEqual([...allowlist].sort());
    });

    it(`${name}: allowlist is stored sorted (checked-in ordering is canonical)`, () => {
      expect([...allowlist]).toEqual([...allowlist].sort());
    });

    it(`${name}: no allowlisted field name is a known-sensitive name`, () => {
      for (const field of allowlist) {
        const lower = field.toLowerCase();
        for (const frag of SENSITIVE_FRAGMENTS) {
          expect(
            lower.includes(frag),
            `field "${field}" on ${name} matches sensitive fragment "${frag}"`,
          ).toBe(false);
        }
      }
    });
  }

  // ── Standalone-interface guard: sensitive source fields did NOT leak in ──────
  it("UiSafeApproval omits actor + payloadHash (identity + content-derived hash)", () => {
    expect(UI_SAFE_ALLOWLIST.approval).not.toContain("actor");
    expect(UI_SAFE_ALLOWLIST.approval).not.toContain("payloadHash");
  });

  it("UiSafeHealthItem omits message + internal refs (auditRef/parityReportRef/factIdentity)", () => {
    expect(UI_SAFE_ALLOWLIST.healthItem).not.toContain("message");
    expect(UI_SAFE_ALLOWLIST.healthItem).not.toContain("auditRef");
    expect(UI_SAFE_ALLOWLIST.healthItem).not.toContain("parityReportRef");
    expect(UI_SAFE_ALLOWLIST.healthItem).not.toContain("factIdentity");
  });

  it("UiSafeWorkflowRunRef omits auditRefs (internal audit trail)", () => {
    expect(UI_SAFE_ALLOWLIST.workflowRunRef).not.toContain("auditRefs");
  });

  // ── Behaviors: each schema accepts a valid sample + rejects unknown keys ─────
  it("UiSafeApprovalSchema accepts a valid sample + rejects an unknown key", () => {
    const sample = {
      id: "approval-1",
      actionRef: "action-1",
      status: "pending",
      channel: "mac",
    };
    expect(UiSafeApprovalSchema.safeParse(sample).success).toBe(true);
    expect(
      UiSafeApprovalSchema.safeParse({ ...sample, actor: "leaked" }).success,
    ).toBe(false);
  });

  it("UiSafeHealthItemSchema accepts a valid sample + rejects an unknown key", () => {
    const sample = {
      id: "health-1",
      failureClass: "worker_down",
      severity: "critical",
      state: "open",
      openedAt: "2026-06-30T00:00:00.000Z",
    };
    expect(UiSafeHealthItemSchema.safeParse(sample).success).toBe(true);
    expect(
      UiSafeHealthItemSchema.safeParse({ ...sample, message: "raw" }).success,
    ).toBe(false);
  });

  it("UiSafeWorkflowRunRefSchema accepts a valid sample + rejects an unknown key", () => {
    const sample = {
      workflowId: "wf-1",
      trigger: "schedule",
      state: "running",
      idempotencyKey: "wf-1:2026-06-30",
    };
    expect(UiSafeWorkflowRunRefSchema.safeParse(sample).success).toBe(true);
    expect(
      UiSafeWorkflowRunRefSchema.safeParse({ ...sample, auditRefs: [] }).success,
    ).toBe(false);
  });

  it("UiSafeDashboardCardSchema accepts a valid sample + rejects an unknown key", () => {
    const sample = {
      cardId: "card-1",
      kind: "approvals",
      title: "Pending approvals",
      status: "ok",
      count: 3,
      updatedAt: "2026-06-30T00:00:00.000Z",
    };
    expect(UiSafeDashboardCardSchema.safeParse(sample).success).toBe(true);
    expect(
      UiSafeDashboardCardSchema.safeParse({ ...sample, rawContent: "x" }).success,
    ).toBe(false);
  });

  // ── Constraint: enum-typed fields reject an out-of-set value ─────────────────
  it("UiSafeApprovalSchema rejects an out-of-set status", () => {
    expect(
      UiSafeApprovalSchema.safeParse({
        id: "approval-1",
        actionRef: "action-1",
        status: "not-a-status",
        channel: "mac",
      }).success,
    ).toBe(false);
  });

  it("UiSafeHealthItemSchema rejects an out-of-set failureClass", () => {
    expect(
      UiSafeHealthItemSchema.safeParse({
        id: "health-1",
        failureClass: "not-a-class",
        severity: "critical",
        state: "open",
        openedAt: "2026-06-30T00:00:00.000Z",
      }).success,
    ).toBe(false);
  });
});
