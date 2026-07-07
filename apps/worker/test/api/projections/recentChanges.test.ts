// R4 — the pure audit→recent_changes projector: AuditRecord[] → { changes: UiSafeRecentChange[] }, scoped to
// ONE workspace. This is the deferred "real audit-driven projector" (session 023) that replaces the dev-only
// interim. Two load-bearing safety properties beyond "maps the rows":
//  (1) WS-8 fail-closed: a record whose workspaceId != the asked workspace — INCLUDING a NULL/undefined
//      (global) workspaceId — is DROPPED. A scoped feed never surfaces a foreign or unscoped change.
//  (2) Lesson §5 redact-by-type: the summary is built from SAFE tokens only (the controlled `event`
//      vocabulary), never from the free-text before/after summaries — even though those are "summaries"
//      per the AuditRecord contract, they can still carry a codename/token, so they are never folded raw.
import { describe, it, expect } from "vitest";
import { UiSafeRecentChangeSchema } from "@sow/contracts";
import type { AuditRecord } from "@sow/contracts";
import { projectRecentChanges } from "../../../src/api/projections/recentChanges";

const base: AuditRecord = {
  actor: "KnowledgeWriter",
  event: "knowledge_writer.commit", // the EXACT event the KnowledgeWriter commit path emits (revision.ts)
  refs: ["rev:abc", "idem-1"],
  payloadHash: "sha256:aaa",
  beforeSummary: "no prior note",
  afterSummary: "note created at personal-business/auth.md",
  timestamps: { occurredAt: "2026-07-01T00:00:00.000Z" },
  workspaceId: "personal-business",
};

describe("projectRecentChanges — maps + scopes audit rows to a workspace feed", () => {
  it("projects a matching-workspace record to a schema-valid UiSafeRecentChange", () => {
    const { changes } = projectRecentChanges([base], "personal-business");
    expect(changes).toHaveLength(1);
    const c = changes[0]!;
    expect(() => UiSafeRecentChangeSchema.parse(c)).not.toThrow();
    expect(c.kind).toBe("commit"); // derived from the event vocabulary
    expect(c.occurredAt).toBe("2026-07-01T00:00:00.000Z"); // from timestamps.occurredAt (NOT recordedAt)
    expect(c.changeId.length).toBeGreaterThan(0);
    expect(c.summary.length).toBeGreaterThan(0);
  });

  it("WS-8: DROPS a record from a DIFFERENT workspace (never leaks a foreign change into a scoped feed)", () => {
    const foreign: AuditRecord = { ...base, workspaceId: "employer-work", afterSummary: "EW note" };
    const { changes } = projectRecentChanges([base, foreign], "personal-business");
    expect(changes).toHaveLength(1);
    expect(changes[0]!.changeId).toBe(projectRecentChanges([base], "personal-business").changes[0]!.changeId);
  });

  it("WS-8: DROPS a record with NO workspaceId (a global/unscoped audit event) from a scoped feed", () => {
    const globalRec: AuditRecord = { ...base };
    delete (globalRec as { workspaceId?: string }).workspaceId;
    const { changes } = projectRecentChanges([globalRec], "personal-business");
    expect(changes).toHaveLength(0);
  });

  it("Lesson §5: the summary NEVER contains the raw before/after summary text (redact-by-type)", () => {
    const leaky: AuditRecord = {
      ...base,
      beforeSummary: "BEFORE-CODENAME-9f3",
      afterSummary: "AFTER-SECRET-TOKEN-xyz",
    };
    const { changes } = projectRecentChanges([leaky], "personal-business");
    expect(changes).toHaveLength(1);
    const s = changes[0]!.summary;
    expect(s).not.toContain("CODENAME");
    expect(s).not.toContain("SECRET");
    expect(s).not.toContain("xyz");
    // and the payloadHash is not folded into the visible summary either
    expect(s).not.toContain("sha256");
  });

  it("changeId is STABLE for the same record + DISTINCT across different records", () => {
    const a = projectRecentChanges([base], "personal-business").changes[0]!.changeId;
    const aAgain = projectRecentChanges([base], "personal-business").changes[0]!.changeId;
    expect(a).toBe(aAgain); // deterministic
    const other: AuditRecord = { ...base, payloadHash: "sha256:bbb", timestamps: { occurredAt: "2026-07-02T00:00:00.000Z" } };
    const b = projectRecentChanges([other], "personal-business").changes[0]!.changeId;
    expect(b).not.toBe(a); // distinct change ⇒ distinct id
  });

  it("maps the tombstone event to its display kind", () => {
    const tomb: AuditRecord = { ...base, event: "knowledge_writer.tombstone" };
    expect(projectRecentChanges([tomb], "personal-business").changes[0]!.kind).toBe("tombstone");
  });

  it("emits changes sorted DESCENDING by occurredAt (newest first)", () => {
    const older: AuditRecord = { ...base, payloadHash: "sha256:old", timestamps: { occurredAt: "2026-06-01T00:00:00.000Z" } };
    const newer: AuditRecord = { ...base, payloadHash: "sha256:new", timestamps: { occurredAt: "2026-08-01T00:00:00.000Z" } };
    const { changes } = projectRecentChanges([older, newer], "personal-business");
    expect(changes.map((c) => c.occurredAt)).toEqual(["2026-08-01T00:00:00.000Z", "2026-06-01T00:00:00.000Z"]);
  });

  it("fail-closed: a record with a malformed occurredAt is DROPPED, not thrown (batch survives)", () => {
    const bad: AuditRecord = { ...base, payloadHash: "sha256:bad", timestamps: { occurredAt: "not-a-date" } };
    const { changes } = projectRecentChanges([bad, base], "personal-business");
    // the good one survives; the bad one is dropped by the schema safeParse
    expect(changes).toHaveLength(1);
    expect(changes[0]!.occurredAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("empty input → empty feed", () => {
    expect(projectRecentChanges([], "personal-business")).toEqual({ changes: [] });
  });

  it("WS-8 fail-closed: an empty served workspaceId yields an EMPTY feed (never an unscoped dump)", () => {
    // a global/undefined-workspace record must NOT satisfy `undefined !== ""`/`undefined !== undefined`.
    const globalRec: AuditRecord = { ...base };
    delete (globalRec as { workspaceId?: string }).workspaceId;
    expect(projectRecentChanges([base, globalRec], "")).toEqual({ changes: [] });
  });

  it("fallback: an unmapped but token-safe event → last-dot-segment kind + a generic summary", () => {
    // a real emitted-but-unmapped-in-a-hypothetical event; token-safe ⇒ kind = last segment, summary generic.
    const ev: AuditRecord = { ...base, event: "widget.frobnicated" };
    const c = projectRecentChanges([ev], "personal-business").changes[0]!;
    expect(c.kind).toBe("frobnicated");
    expect(c.summary).toBe("Change recorded (frobnicated)");
    expect(() => UiSafeRecentChangeSchema.parse(c)).not.toThrow();
  });

  it("redact-by-type: an UNSAFE event string (whitespace/newline/over-long) fails safe to 'change'", () => {
    for (const badEvent of ["evil event with spaces", "line\nbreak", "x".repeat(200)]) {
      const ev: AuditRecord = { ...base, event: badEvent };
      const c = projectRecentChanges([ev], "personal-business").changes[0]!;
      expect(c.kind).toBe("change"); // never emits the raw free-text event as a kind
      expect(c.summary).toBe("Change recorded");
      expect(() => UiSafeRecentChangeSchema.parse(c)).not.toThrow(); // still servable (single-line, bounded)
    }
  });

  it("maps the other real audit events (disposition, external-write) to display kinds", () => {
    const disp: AuditRecord = { ...base, event: "ingestion.triage.disposition.recorded" };
    const ext: AuditRecord = { ...base, event: "external_write.created" };
    expect(projectRecentChanges([disp], "personal-business").changes[0]!.kind).toBe("disposition");
    expect(projectRecentChanges([ext], "personal-business").changes[0]!.kind).toBe("external-write");
  });
});
