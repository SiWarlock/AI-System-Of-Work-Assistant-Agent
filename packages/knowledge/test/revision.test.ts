// spec(§6) — revision id compute/compare + commit AuditRecord shape, task 4.1
import { describe, it, expect } from "vitest";
import { AuditRecordSchema } from "@sow/contracts";
import type { WorkflowRunRef } from "@sow/contracts";
import {
  buildCommitAuditRecord,
  compareRevision,
  computeRevisionId,
  hashPayload,
} from "../src/knowledge-writer/revision";

const wf: WorkflowRunRef = {
  workflowId: "wf-001" as WorkflowRunRef["workflowId"],
  trigger: "manual",
  state: "running",
  idempotencyKey: "idem-1",
  auditRefs: [],
};

describe("computeRevisionId", () => {
  it("is deterministic and insertion-order independent", () => {
    const a = new Map([
      ["notes/a.md", "AAA"],
      ["notes/b.md", "BBB"],
    ]);
    const b = new Map([
      ["notes/b.md", "BBB"],
      ["notes/a.md", "AAA"],
    ]);
    expect(computeRevisionId(a)).toBe(computeRevisionId(b));
    expect(computeRevisionId(a)).toMatch(/^rev:[0-9a-f]{64}$/u);
  });

  it("changes when any byte changes", () => {
    const base = new Map([["notes/a.md", "AAA"]]);
    const changed = new Map([["notes/a.md", "AAA "]]);
    expect(computeRevisionId(base)).not.toBe(computeRevisionId(changed));
  });

  it("gives a stable id for an empty vault", () => {
    expect(computeRevisionId(new Map())).toBe(computeRevisionId(new Map()));
  });
});

describe("compareRevision", () => {
  it("is strict equality", () => {
    expect(compareRevision("rev:x", "rev:x")).toBe(true);
    expect(compareRevision("rev:x", "rev:y")).toBe(false);
  });
});

describe("buildCommitAuditRecord", () => {
  it("produces a schema-valid AuditRecord carrying the commit provenance", () => {
    const rec = buildCommitAuditRecord({
      actor: "KnowledgeWriter",
      sourceEventRef: "evt-1",
      workflowRunRef: wf,
      idempotencyKey: "idem-1",
      planId: "plan-1",
      baseRevisionId: "rev:base",
      newRevisionId: "rev:new",
      beforeSummary: "revision rev:base",
      afterSummary: "1 file changed",
      payloadHash: hashPayload({ a: 1 }),
      occurredAt: "2026-07-01T00:00:00.000Z",
    });
    // schema-valid (redaction-friendly: summaries + hash only, no raw content)
    expect(() => AuditRecordSchema.parse(rec)).not.toThrow();
    expect(rec.refs).toContain("rev:new");
    expect(rec.refs).toContain("idem-1");
    expect(rec.refs).toContain("evt-1");
    expect(rec.actor).toBe("KnowledgeWriter");
  });

  it("folds the plan's workspaceId onto the audit record (WS-8 scope for the §9.5 recent-changes feed)", () => {
    const rec = buildCommitAuditRecord({
      actor: "KnowledgeWriter",
      sourceEventRef: "evt-1",
      workflowRunRef: wf,
      idempotencyKey: "idem-1",
      planId: "plan-1",
      baseRevisionId: "rev:base",
      newRevisionId: "rev:new",
      beforeSummary: "revision rev:base",
      afterSummary: "1 file changed",
      payloadHash: hashPayload({ a: 1 }),
      occurredAt: "2026-07-01T00:00:00.000Z",
      workspaceId: "employer-work",
    });
    expect(rec.workspaceId).toBe("employer-work");
    expect(() => AuditRecordSchema.parse(rec)).not.toThrow();
  });
});

describe("hashPayload", () => {
  it("is deterministic", () => {
    expect(hashPayload({ a: 1, b: 2 })).toBe(hashPayload({ a: 1, b: 2 }));
  });
});
