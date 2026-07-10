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
  UiSafeCitationSchema,
  UiSafeCopilotAnswerSchema,
  UiSafeIngestionItemSchema,
  collapseToSummaryLine,
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
  ["citation", UiSafeCitationSchema, UI_SAFE_ALLOWLIST.citation] as const,
  ["copilotAnswer", UiSafeCopilotAnswerSchema, UI_SAFE_ALLOWLIST.copilotAnswer] as const,
  ["ingestion", UiSafeIngestionItemSchema, UI_SAFE_ALLOWLIST.ingestion] as const,
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

  // §13.10a Slice H — the card discriminator (external_action vs semantic_mutation) IS UI-safe (a
  // frozen 2-value enum, no content), so the renderer can branch card shapes. The subject REF is NOT
  // surfaced: planRef is an opaque idempotency key, and actionRef is already dropped for a semantic card.
  it("UiSafeApproval surfaces subjectKind (the card discriminator) but NOT the subject ref planRef", () => {
    expect(UI_SAFE_ALLOWLIST.approval).toContain("subjectKind");
    expect(UI_SAFE_ALLOWLIST.approval).not.toContain("planRef");
    // subjectKind is optional on the UI-safe shape (mirrors actionRef); when present it is the frozen enum.
    expect(UiSafeApprovalSchema.safeParse({ id: "a", status: "pending", channel: "mac", subjectKind: "semantic_mutation" }).success).toBe(true);
    expect(UiSafeApprovalSchema.safeParse({ id: "a", status: "pending", channel: "mac", subjectKind: "nope" }).success).toBe(false);
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

  it("collapseToSummaryLine ALWAYS yields a value the summary gate accepts (full newline family incl. U+0085 + 1024 cap)", () => {
    const okRow = (summary: string): boolean =>
      UiSafeRecentChangeSchema.safeParse({ changeId: "c", kind: "k", summary, occurredAt: "2026-07-04T00:00:00.000Z" }).success;
    // Every terminator the read-side gate rejects — INCLUDING U+0085 (NEL), which JS `\s` does NOT match.
    for (const term of [0x0d, 0x0a, 0x0b, 0x0c, 0x85, 0x2028, 0x2029].map((c) => String.fromCodePoint(c))) {
      const collapsed = collapseToSummaryLine(`a${term}b`);
      expect(collapsed).not.toMatch(/[\r\n\u000B\u000C\u0085\u2028\u2029]/);
      expect(okRow(collapsed)).toBe(true);
    }
    // An over-long input is clamped under the 1024 cap (so it can't fail the whole recent-changes list).
    const long = collapseToSummaryLine("x".repeat(5000));
    expect(long.length).toBeLessThanOrEqual(1024);
    expect(okRow(long)).toBe(true);
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

  // ── UiSafeCitation + UiSafeCopilotAnswer (§4.6 Copilot Q&A — cited, NO raw content) ──────
  // Copilot returns a synthesized answer WITH citations and NO side effects. At this UI-safe seam
  // the answer is prose split into single-line-bounded display blocks (both dimensions capped, like
  // the dashboard prose arrays — a raw document can't be chunk-smuggled), and each citation is an
  // OPAQUE canonical ref + a display title ONLY — never the cited note's raw content, path, or URL.
  const validCitation = { citationId: "src:note-abc123", title: "Vendor review — decisions" };
  const validAnswer = {
    answer: ["Two decisions were logged:", "adopt the new SLA, and defer the pricing change."],
    citations: [validCitation],
  };

  it("UiSafeCitation carries ONLY an opaque id + display title (no content/snippet/path/url/workspaceId)", () => {
    expect(UI_SAFE_ALLOWLIST.citation).not.toContain("content");
    expect(UI_SAFE_ALLOWLIST.citation).not.toContain("snippet");
    expect(UI_SAFE_ALLOWLIST.citation).not.toContain("path");
    expect(UI_SAFE_ALLOWLIST.citation).not.toContain("url");
    expect(UI_SAFE_ALLOWLIST.citation).not.toContain("workspaceId");
  });

  it("UiSafeCitationSchema accepts a valid citation; rejects a path/URL id, a raw-content passthrough, a multi-line title", () => {
    expect(UiSafeCitationSchema.safeParse(validCitation).success).toBe(true);
    // The citation id is an OPAQUE canonical ref — never a filesystem path or URL (WS-8/#7).
    expect(UiSafeCitationSchema.safeParse({ ...validCitation, citationId: "/Users/x/secret.md" }).success).toBe(false);
    expect(UiSafeCitationSchema.safeParse({ ...validCitation, citationId: "https://internal.acme/doc" }).success).toBe(false);
    // .strict() — the cited note's raw content / a source snippet must NOT ride through as an unknown key.
    expect(UiSafeCitationSchema.safeParse({ ...validCitation, content: "raw note body" }).success).toBe(false);
    // A multi-line title is the shape of a raw-content leak.
    expect(UiSafeCitationSchema.safeParse({ ...validCitation, title: "Vendor review\nleaked body" }).success).toBe(false);
  });

  it("UiSafeCopilotAnswer omits raw context / prompt / workspaceId (a cited answer, not a content dump)", () => {
    expect(UI_SAFE_ALLOWLIST.copilotAnswer).not.toContain("context");
    expect(UI_SAFE_ALLOWLIST.copilotAnswer).not.toContain("retrievedContent");
    expect(UI_SAFE_ALLOWLIST.copilotAnswer).not.toContain("prompt");
    expect(UI_SAFE_ALLOWLIST.copilotAnswer).not.toContain("workspaceId");
  });

  it("UiSafeCopilotAnswerSchema accepts a valid cited answer (incl. zero citations); rejects unknown keys + multi-line blocks", () => {
    expect(UiSafeCopilotAnswerSchema.safeParse(validAnswer).success).toBe(true);
    // An answer may cite nothing (found nothing in the workspace) — still valid.
    expect(UiSafeCopilotAnswerSchema.safeParse({ ...validAnswer, citations: [] }).success).toBe(true);
    // .strict() — the raw retrieval context / model prompt must NOT ride through the answer.
    expect(UiSafeCopilotAnswerSchema.safeParse({ ...validAnswer, context: "raw workspace notes" }).success).toBe(false);
    // Each answer block is single-line bounded (a multi-line block is the shape of a raw-content dump).
    expect(UiSafeCopilotAnswerSchema.safeParse({ ...validAnswer, answer: ["line one\nleaked raw"] }).success).toBe(false);
  });

  it("UiSafeCopilotAnswer requires a non-empty answer + caps BOTH dimensions at the exact boundary (no chunk-smuggling)", () => {
    // An answer must have at least one block.
    expect(UiSafeCopilotAnswerSchema.safeParse({ ...validAnswer, answer: [] }).success).toBe(false);
    // Boundary: exactly 40 blocks / 20 citations ACCEPT; one over REJECTS (pins the inclusive .max).
    expect(UiSafeCopilotAnswerSchema.safeParse({ ...validAnswer, answer: Array(40).fill("a line") }).success).toBe(true);
    expect(UiSafeCopilotAnswerSchema.safeParse({ ...validAnswer, answer: Array(41).fill("a line") }).success).toBe(false);
    expect(UiSafeCopilotAnswerSchema.safeParse({ ...validAnswer, citations: Array(20).fill(validCitation) }).success).toBe(true);
    expect(UiSafeCopilotAnswerSchema.safeParse({ ...validAnswer, citations: Array(21).fill(validCitation) }).success).toBe(false);
  });

  it("UiSafeCopilotAnswer.egressProcessor is an OPTIONAL single-line notice label (safety rule 5 / §9.6 follow-up)", () => {
    // Absent by default (a local/zero-egress answer, or non-Employer-Work cloud egress — no notice).
    expect(validAnswer).not.toHaveProperty("egressProcessor");
    expect(UiSafeCopilotAnswerSchema.safeParse(validAnswer).success).toBe(true);
    // Present → the Employer-Work cloud-egress NOTICE; the value is the processor label.
    expect(UiSafeCopilotAnswerSchema.safeParse({ ...validAnswer, egressProcessor: "anthropic" }).success).toBe(true);
    // Redact-by-type: a multi-line / leak-shaped processor label is rejected (never a content carrier).
    expect(UiSafeCopilotAnswerSchema.safeParse({ ...validAnswer, egressProcessor: "anthropic\nleaked raw note" }).success).toBe(false);
    // It IS on the allowlist (the freeze test pins the full key set); it is NOT a raw-content field.
    expect(UI_SAFE_ALLOWLIST.copilotAnswer).toContain("egressProcessor");
  });

  // ── UiSafeIngestionItem (§9.7 / §10/§11 — the ingestion inbox row) ────────────
  // A parked imported-source row (Flow 5 triage) the renderer lists so the owner can act on it.
  // Projected FROM the frozen SourceEnvelope, it must DROP every raw ref: `origin` (a source URI /
  // filesystem path — the GCL/#7 raw-ref precedent), `contentHash` (content-derived — dropped like
  // UiSafeApproval's payloadHash), `routingHints` (an open record — dropped like GclProjection's
  // sanitizedPayload), and `workspaceId` (the renderer knows its scope — mirrors
  // UiSafeDashboardCard/UiSafeRecentChange, so a pushed/cached row can never blend cross-scope).
  it("UiSafeIngestionItem omits origin + contentHash + routingHints + workspaceId (raw refs / cross-scope)", () => {
    expect(UI_SAFE_ALLOWLIST.ingestion).not.toContain("origin");
    expect(UI_SAFE_ALLOWLIST.ingestion).not.toContain("contentHash");
    expect(UI_SAFE_ALLOWLIST.ingestion).not.toContain("routingHints");
    expect(UI_SAFE_ALLOWLIST.ingestion).not.toContain("workspaceId");
  });

  it("UiSafeIngestionItemSchema accepts a valid sample; rejects an origin / contentHash / routingHints / workspaceId passthrough (.strict)", () => {
    const sample = { sourceId: "src-1", type: "youtube_video", sensitivity: "personal", summary: "youtube_video" };
    expect(UiSafeIngestionItemSchema.safeParse(sample).success).toBe(true);
    // No raw source ref rides through as an unknown key.
    expect(UiSafeIngestionItemSchema.safeParse({ ...sample, origin: "https://youtu.be/abc123" }).success).toBe(false);
    expect(UiSafeIngestionItemSchema.safeParse({ ...sample, contentHash: "sha256:deadbeef" }).success).toBe(false);
    expect(UiSafeIngestionItemSchema.safeParse({ ...sample, routingHints: { project: "p" } }).success).toBe(false);
    expect(UiSafeIngestionItemSchema.safeParse({ ...sample, workspaceId: "employer-work" }).success).toBe(false);
  });

  it("UiSafeIngestionItemSchema rejects a multi-line / over-length summary (single-line leak gate)", () => {
    const base = { sourceId: "src-1", type: "youtube_video", sensitivity: "personal" };
    expect(UiSafeIngestionItemSchema.safeParse({ ...base, summary: "line one\nleaked raw transcript" }).success).toBe(false);
    // Full Unicode newline family (U+2028 line separator; U+0085 NEL that JS `\s` misses).
    expect(UiSafeIngestionItemSchema.safeParse({ ...base, summary: "a\u2028b" }).success).toBe(false);
    expect(UiSafeIngestionItemSchema.safeParse({ ...base, summary: "a\u0085b" }).success).toBe(false);
    expect(UiSafeIngestionItemSchema.safeParse({ ...base, summary: "x".repeat(1025) }).success).toBe(false);
    expect(UiSafeIngestionItemSchema.safeParse({ ...base, summary: "one line" }).success).toBe(true);
  });
});
