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
  UiSafeGclProjectionSchema,
  UiSafeRecentChangeSchema,
  UiSafeProjectProgressSchema,
  UiSafeManagedDocSchema,
  UiSafeProjectDashboardSchema,
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
  ["gclProjection", UiSafeGclProjectionSchema, UI_SAFE_ALLOWLIST.gclProjection] as const,
  ["recentChange", UiSafeRecentChangeSchema, UI_SAFE_ALLOWLIST.recentChange] as const,
  ["projectProgress", UiSafeProjectProgressSchema, UI_SAFE_ALLOWLIST.projectProgress] as const,
  ["managedDoc", UiSafeManagedDocSchema, UI_SAFE_ALLOWLIST.managedDoc] as const,
  ["projectDashboard", UiSafeProjectDashboardSchema, UI_SAFE_ALLOWLIST.projectDashboard] as const,
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

  // The Global-Today (§9.4) GCL surface is the highest workspace-isolation risk: it
  // is the ONLY cross-workspace read path. The UI-safe shape must carry NEITHER the
  // open `sanitizedPayload` record (arbitrary keys — even gate-sanitized, an open
  // passthrough defeats the explicit-allowlist boundary) NOR the internal
  // `sourceRefs` (they identify raw source objects; drill-down is worker-mediated).
  it("UiSafeGclProjection omits sanitizedPayload (open record) + sourceRefs (internal refs)", () => {
    expect(UI_SAFE_ALLOWLIST.gclProjection).not.toContain("sanitizedPayload");
    expect(UI_SAFE_ALLOWLIST.gclProjection).not.toContain("sourceRefs");
  });

  // Recent Changes (§9.5) surfaces workspace-scoped audit-linked mutations. It carries a
  // projector-built single-line `summary` (actor + event + detail folded in, bounded) — NOT
  // the raw AuditRecord fields. It must drop the content-derived `payloadHash`, the
  // principal `actor` (identity — dropped like UiSafeApproval), and the internal `auditRef`/
  // `refs` (internal refs — dropped like UiSafeHealthItem; a raw drill is worker-mediated by
  // `changeId`). It also carries NO `workspaceId` (mirrors UiSafeDashboardCard — a
  // pushed/cached item can never blend cross-scope).
  it("UiSafeRecentChange omits actor + payloadHash + internal refs (auditRef/refs) + workspaceId", () => {
    expect(UI_SAFE_ALLOWLIST.recentChange).not.toContain("actor");
    expect(UI_SAFE_ALLOWLIST.recentChange).not.toContain("payloadHash");
    expect(UI_SAFE_ALLOWLIST.recentChange).not.toContain("auditRef");
    expect(UI_SAFE_ALLOWLIST.recentChange).not.toContain("refs");
    expect(UI_SAFE_ALLOWLIST.recentChange).not.toContain("beforeSummary");
    expect(UI_SAFE_ALLOWLIST.recentChange).not.toContain("afterSummary");
    expect(UI_SAFE_ALLOWLIST.recentChange).not.toContain("workspaceId");
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

  it("UiSafeGclProjectionSchema accepts a valid sample + rejects a sanitizedPayload passthrough", () => {
    const sample = {
      workspaceId: "ws-employer",
      visibilityLevel: "sanitized",
      projectionType: "deadlines",
      summary: "2 deadlines this week",
      drillable: true,
    };
    expect(UiSafeGclProjectionSchema.safeParse(sample).success).toBe(true);
    // The open source record must NOT ride through as an unknown key (.strict()).
    expect(
      UiSafeGclProjectionSchema.safeParse({ ...sample, sanitizedPayload: { x: 1 } }).success,
    ).toBe(false);
    // Internal source refs must NOT ride through either.
    expect(
      UiSafeGclProjectionSchema.safeParse({ ...sample, sourceRefs: [{ sourceId: "s1" }] }).success,
    ).toBe(false);
  });

  it("UiSafeGclProjectionSchema rejects a multi-line summary (single-line defense-in-depth)", () => {
    const base = {
      workspaceId: "ws-employer",
      visibilityLevel: "sanitized",
      projectionType: "deadlines",
      drillable: false,
    };
    // A multi-line value is the shape of leaked raw content — reject it at the UI seam
    // too, not only at the GCL gate.
    expect(
      UiSafeGclProjectionSchema.safeParse({ ...base, summary: "line one\nline two" }).success,
    ).toBe(false);
    expect(UiSafeGclProjectionSchema.safeParse({ ...base, summary: "one line" }).success).toBe(true);
  });

  it("UiSafeGclProjectionSchema rejects an out-of-set visibilityLevel", () => {
    expect(
      UiSafeGclProjectionSchema.safeParse({
        workspaceId: "ws-employer",
        visibilityLevel: "not-a-level",
        projectionType: "deadlines",
        summary: "2 deadlines this week",
        drillable: true,
      }).success,
    ).toBe(false);
  });

  it("UiSafeRecentChangeSchema accepts a valid sample + rejects a payloadHash / actor passthrough", () => {
    const sample = {
      changeId: "chg-1",
      kind: "commit",
      summary: "KnowledgeWriter committed meeting-2026-06-30-arch-sync.md rev 0c4",
      occurredAt: "2026-07-04T00:00:00.000Z",
    };
    expect(UiSafeRecentChangeSchema.safeParse(sample).success).toBe(true);
    // Content-derived hash + principal identity must NOT ride through as unknown keys (.strict()).
    expect(UiSafeRecentChangeSchema.safeParse({ ...sample, payloadHash: "h:1" }).success).toBe(false);
    expect(UiSafeRecentChangeSchema.safeParse({ ...sample, actor: "alice@corp" }).success).toBe(false);
    expect(UiSafeRecentChangeSchema.safeParse({ ...sample, auditRef: "aud-9" }).success).toBe(false);
  });

  it("UiSafeRecentChangeSchema rejects a multi-line summary — incl. the full Unicode newline family (sole structural bound)", () => {
    const base = { changeId: "chg-1", kind: "commit", occurredAt: "2026-07-04T00:00:00.000Z" };
    expect(UiSafeRecentChangeSchema.safeParse({ ...base, summary: "line one\nline two" }).success).toBe(false);
    // U+2028 (line separator) + U+0085 (next line) render as breaks in some surfaces —
    // `uiSafeSummaryLine` is the ONLY structural bound here (no upstream sanitization gate).
    expect(UiSafeRecentChangeSchema.safeParse({ ...base, summary: "a\u2028b" }).success).toBe(false);
    expect(UiSafeRecentChangeSchema.safeParse({ ...base, summary: "a\u0085b" }).success).toBe(false);
    expect(UiSafeRecentChangeSchema.safeParse({ ...base, summary: "one line" }).success).toBe(true);
  });

  // Project dashboard (§9.5) surfaces DETERMINISTIC progress (REQ-F-011 — parsed counts,
  // never an inferred %). It drops `workspaceId` (renderer knows the scope; a card can't
  // self-misattribute — like UiSafeDashboardCard) and `progressSources` (per-source names
  // can be file paths). Prose fields (blockers/waiting/next) + evidenceRefs are single-line
  // bounded; evidenceRefs are opaque canonical ids, never paths/URLs.
  const validProject = {
    projectId: "prj-1",
    title: "Auth redesign",
    status: "on-track",
    progress: { completedCount: 2, totalCount: 5, percentComplete: 40 },
    blockers: ["waiting on vendor SSO cert"],
    waitingItems: ["review from Priya"],
    nextActions: ["wire the callback route"],
    evidenceRefs: ["src:plan-abc123"],
    docPack: [{ slot: "00_brief", title: "00 Brief", linkState: "unlinked", syncState: "unknown" }],
    updatedAt: "2026-07-04T00:00:00.000Z",
  };

  it("UiSafeProjectDashboard omits workspaceId + progressSources + raw refs (no cross-scope / path leak)", () => {
    expect(UI_SAFE_ALLOWLIST.projectDashboard).not.toContain("workspaceId");
    expect(UI_SAFE_ALLOWLIST.projectDashboard).not.toContain("progressSources");
    expect(UI_SAFE_ALLOWLIST.projectDashboard).not.toContain("sourceRefs");
    expect(UI_SAFE_ALLOWLIST.projectDashboard).not.toContain("payloadHash");
  });

  it("UiSafeProjectDashboardSchema accepts a valid sample + rejects workspaceId / multi-line prose", () => {
    expect(UiSafeProjectDashboardSchema.safeParse(validProject).success).toBe(true);
    // .strict() rejects a workspaceId passthrough (blend-prevention).
    expect(UiSafeProjectDashboardSchema.safeParse({ ...validProject, workspaceId: "employer-work" }).success).toBe(false);
    // A prose element must be single-line (no raw-content leak through blockers/waiting/next).
    expect(UiSafeProjectDashboardSchema.safeParse({ ...validProject, blockers: ["line one\nleaked raw"] }).success).toBe(false);
  });

  it("UiSafeProjectDashboard rejects a path/URL evidenceRef (opaque-id grammar) + caps array lengths", () => {
    // A projector must not smuggle a filesystem path or URL through an evidence ref (WS-8/#7).
    expect(UiSafeProjectDashboardSchema.safeParse({ ...validProject, evidenceRefs: ["/Users/x/secret-plan.md"] }).success).toBe(false);
    expect(UiSafeProjectDashboardSchema.safeParse({ ...validProject, evidenceRefs: ["https://internal.acme.corp/doc"] }).success).toBe(false);
    // Array LENGTHS are capped — a raw doc can't be chunk-smuggled as N single-line elements.
    expect(UiSafeProjectDashboardSchema.safeParse({ ...validProject, evidenceRefs: Array(51).fill("src:x") }).success).toBe(false);
    expect(UiSafeProjectDashboardSchema.safeParse({ ...validProject, blockers: Array(51).fill("b") }).success).toBe(false);
  });

  it("UiSafeProjectDashboard accepts empty prose/evidence arrays (a project may have none)", () => {
    expect(
      UiSafeProjectDashboardSchema.safeParse({
        ...validProject,
        blockers: [],
        waitingItems: [],
        nextActions: [],
        evidenceRefs: [],
      }).success,
    ).toBe(true);
  });

  it("UiSafeProjectProgressSchema pins the deterministic count fields (REQ-F-011: int counts, 0-100 percent)", () => {
    expect(UiSafeProjectProgressSchema.safeParse({ completedCount: 2, totalCount: 5, percentComplete: 40 }).success).toBe(true);
    expect(UiSafeProjectProgressSchema.safeParse({ completedCount: 2, totalCount: 5, percentComplete: 140 }).success).toBe(false);
    expect(UiSafeProjectProgressSchema.safeParse({ completedCount: 2.5, totalCount: 5, percentComplete: 40 }).success).toBe(false);
    expect(UiSafeProjectProgressSchema.safeParse({ completedCount: 2, totalCount: 5, percentComplete: 40, raw: "x" }).success).toBe(false);
  });

  // ── UiSafeManagedDoc + docPack (§4.5 managed NotebookLM doc pack 00–04) ─────────
  const validManagedDoc = { slot: "00_brief", title: "00 Brief", linkState: "unlinked", syncState: "unknown" };

  it("UiSafeManagedDocSchema accepts a valid managed doc; rejects unknown slot/linkState/syncState + extra field", () => {
    expect(UiSafeManagedDocSchema.safeParse(validManagedDoc).success).toBe(true);
    expect(UiSafeManagedDocSchema.safeParse({ ...validManagedDoc, slot: "99_bogus" }).success).toBe(false);
    expect(UiSafeManagedDocSchema.safeParse({ ...validManagedDoc, linkState: "maybe" }).success).toBe(false);
    expect(UiSafeManagedDocSchema.safeParse({ ...validManagedDoc, syncState: "kinda" }).success).toBe(false);
    // .strict() — no Drive doc id / folder id / url / path smuggled through the projection.
    expect(UiSafeManagedDocSchema.safeParse({ ...validManagedDoc, driveDocId: "abc" }).success).toBe(false);
    // A multi-line title is the shape of a raw-content leak.
    expect(UiSafeManagedDocSchema.safeParse({ ...validManagedDoc, title: "00 Brief\nleaked" }).success).toBe(false);
  });

  it("UiSafeManagedDoc allowlist omits Drive ids / folder ids / urls / paths (link+sync state only; WS-8/#7 precedent)", () => {
    expect(UI_SAFE_ALLOWLIST.managedDoc).not.toContain("driveDocId");
    expect(UI_SAFE_ALLOWLIST.managedDoc).not.toContain("driveFolderId");
    expect(UI_SAFE_ALLOWLIST.managedDoc).not.toContain("url");
    expect(UI_SAFE_ALLOWLIST.managedDoc).not.toContain("path");
  });

  it("UiSafeProjectDashboard carries a docPack (0..5 managed docs); caps at 5", () => {
    expect(UiSafeProjectDashboardSchema.safeParse({ ...validProject, docPack: [] }).success).toBe(true);
    expect(UiSafeProjectDashboardSchema.safeParse(validProject).success).toBe(true); // validProject now carries a docPack
    expect(UiSafeProjectDashboardSchema.safeParse({ ...validProject, docPack: Array(6).fill(validManagedDoc) }).success).toBe(false);
    // A bad managed doc inside the pack fails the whole dashboard (element validation).
    expect(UiSafeProjectDashboardSchema.safeParse({ ...validProject, docPack: [{ ...validManagedDoc, slot: "bogus" }] }).success).toBe(false);
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
