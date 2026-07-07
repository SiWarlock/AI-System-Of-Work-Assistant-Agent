// AuditRecord contract test (task 1.9, §3/§4/§16). RED-first schema-snapshot
// freeze + behavior + REDACTION-FRIENDLY no-raw-content coverage (§16). Mirrors
// the canonical EgressPolicy template. PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import { AuditRecordSchema, AUDIT_RECORD_SCHEMA_ID } from "../../src/models/audit-record";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

// A fully-populated valid record reused as the base for negative fixtures.
const validFull = {
  actor: "KnowledgeWriter",
  event: "knowledge.write.committed",
  refs: ["plan:abc", "workflow-run:xyz"],
  payloadHash: "sha256:deadbeefcafe",
  beforeSummary: "section had 2 tasks",
  afterSummary: "section has 3 tasks",
  timestamps: {
    occurredAt: "2026-06-30T12:00:00.000Z",
    recordedAt: "2026-06-30T12:00:01.000Z",
  },
};

describe("AuditRecord contract — spec(§3/§4/§16)", () => {
  // ── Frozen field-name set (the spec, hand-authored in __snapshots__) ──────
  it("freezes its top-level field-name set to the spec snapshot", () => {
    expect(fieldSet(emitJsonSchema(AuditRecordSchema, AUDIT_RECORD_SCHEMA_ID))).toEqual(
      loadFieldSnapshot("audit-record"),
    );
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ─
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/audit-record.schema.json", import.meta.url),
      emitJsonSchema(AuditRecordSchema, AUDIT_RECORD_SCHEMA_ID),
    );
  });

  // ── Behaviors ────────────────────────────────────────────────────────────
  it("accepts a fully-populated valid record", () => {
    expect(AuditRecordSchema.safeParse(validFull).success).toBe(true);
  });

  // ── workspaceId (optional; WS-8 scope attribution for the recent-changes projector) ──────────
  // OPTIONAL, not required — precedent: EventLogRecord/LogRecord carry a nullable/optional workspaceId
  // for GLOBAL control-plane events (the Tool-Gateway external-write audit has no workspaceId in scope).
  it("accepts a record WITH a workspaceId (WS-8 scope attribution for the recent-changes feed)", () => {
    expect(AuditRecordSchema.safeParse({ ...validFull, workspaceId: "employer-work" }).success).toBe(true);
  });

  it("accepts a record with workspaceId OMITTED (global control-plane audit events are unscoped)", () => {
    // validFull carries no workspaceId — it must still validate (optional field).
    expect(AuditRecordSchema.safeParse(validFull).success).toBe(true);
  });

  it("rejects an empty workspaceId when present (min length 1)", () => {
    expect(AuditRecordSchema.safeParse({ ...validFull, workspaceId: "" }).success).toBe(false);
  });

  it("accepts a record with recordedAt omitted (only that timestamp is optional)", () => {
    const ok = AuditRecordSchema.safeParse({
      actor: "human:cody",
      event: "approval.granted",
      refs: [],
      payloadHash: "abc123",
      beforeSummary: "status: pending",
      afterSummary: "status: approved",
      timestamps: { occurredAt: "2026-06-30T12:00:00.000Z" },
    });
    expect(ok.success).toBe(true);
  });

  it("rejects an unknown top-level key (.strict)", () => {
    expect(AuditRecordSchema.safeParse({ ...validFull, extra: "nope" }).success).toBe(false);
  });

  // ── NO id field (per Appendix A field list) ───────────────────────────────
  it("rejects an `id` field — AuditRecord carries no id per Appendix A (.strict)", () => {
    expect(AuditRecordSchema.safeParse({ ...validFull, id: "audit-1" }).success).toBe(false);
  });

  // ── Redaction-friendly: NO raw-content field; before/after are SUMMARIES (§16) ─
  it("rejects every raw-content field — before/after are SUMMARIES only (§16)", () => {
    const forbidden = [
      "rawContent",
      "content",
      "body",
      "before",
      "after",
      "beforeRaw",
      "afterRaw",
      "payload",
    ];
    for (const rawKey of forbidden) {
      const bad = AuditRecordSchema.safeParse({ ...validFull, [rawKey]: "secret raw content" });
      expect(bad.success, `expected key '${rawKey}' to be rejected`).toBe(false);
    }
  });

  // ── Required-field coverage ───────────────────────────────────────────────
  it("rejects a missing required field (event)", () => {
    const bad = AuditRecordSchema.safeParse({
      actor: "KnowledgeWriter",
      refs: [],
      payloadHash: "abc123",
      beforeSummary: "x",
      afterSummary: "y",
      timestamps: { occurredAt: "2026-06-30T12:00:00.000Z" },
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a missing timestamps", () => {
    const bad = AuditRecordSchema.safeParse({
      actor: "KnowledgeWriter",
      event: "e",
      refs: [],
      payloadHash: "abc123",
      beforeSummary: "x",
      afterSummary: "y",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a missing beforeSummary (required per Appendix A)", () => {
    const bad = AuditRecordSchema.safeParse({
      actor: "KnowledgeWriter",
      event: "e",
      refs: [],
      payloadHash: "abc123",
      afterSummary: "y",
      timestamps: { occurredAt: "2026-06-30T12:00:00.000Z" },
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty actor (min length 1)", () => {
    expect(AuditRecordSchema.safeParse({ ...validFull, actor: "" }).success).toBe(false);
  });

  it("rejects an empty event (min length 1)", () => {
    expect(AuditRecordSchema.safeParse({ ...validFull, event: "" }).success).toBe(false);
  });

  it("rejects an empty payloadHash (min length 1)", () => {
    expect(AuditRecordSchema.safeParse({ ...validFull, payloadHash: "" }).success).toBe(false);
  });

  it("rejects an empty ref string in refs[] (inner min length 1)", () => {
    expect(AuditRecordSchema.safeParse({ ...validFull, refs: ["ok", ""] }).success).toBe(false);
  });

  it("rejects a non-string beforeSummary (summaries are strings)", () => {
    expect(AuditRecordSchema.safeParse({ ...validFull, beforeSummary: 42 }).success).toBe(false);
  });

  it("rejects a non-datetime timestamps.occurredAt", () => {
    const bad = AuditRecordSchema.safeParse({
      ...validFull,
      timestamps: { occurredAt: "yesterday" },
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an unknown nested key in timestamps (.strict)", () => {
    const bad = AuditRecordSchema.safeParse({
      ...validFull,
      timestamps: { occurredAt: "2026-06-30T12:00:00.000Z", extra: 1 },
    });
    expect(bad.success).toBe(false);
  });
});
