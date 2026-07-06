// Approval contract test (task 1.9, §3/§9/§10/§11). RED-first schema-snapshot
// freeze + behavior + conditional-invariant coverage. Mirrors the canonical
// EgressPolicy template. PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import { ApprovalSchema, APPROVAL_SCHEMA_ID } from "../../src/models/approval";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

// Reusable valid base (acknowledgment of all required fields). Each test spreads
// + overrides only the field under exercise.
const validBase = {
  id: "appr-001",
  actionRef: "act-001",
  workspaceId: "ws-personal-business",
  status: "approved",
  actor: "user:cody",
  channel: "mac",
  payloadHash: "9f2c8a1b3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff",
} as const;

describe("Approval contract — spec(§3/§9/§10/§11)", () => {
  // ── Frozen field-name set (the spec, hand-authored in __snapshots__) ──────
  it("freezes its top-level field-name set to the spec snapshot", () => {
    expect(fieldSet(emitJsonSchema(ApprovalSchema, APPROVAL_SCHEMA_ID))).toEqual(
      loadFieldSnapshot("approval"),
    );
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ─
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/approval.schema.json", import.meta.url),
      emitJsonSchema(ApprovalSchema, APPROVAL_SCHEMA_ID),
    );
  });

  // ── Behaviors ────────────────────────────────────────────────────────────
  it("accepts a valid non-deferred approval with no snoozeUntil/expiresAt", () => {
    const ok = ApprovalSchema.safeParse(validBase);
    expect(ok.success).toBe(true);
  });

  it("accepts a valid approval over the Telegram channel with an expiresAt", () => {
    const ok = ApprovalSchema.safeParse({
      ...validBase,
      status: "pending",
      channel: "telegram",
      expiresAt: "2026-07-07T12:00:00.000Z",
    });
    expect(ok.success).toBe(true);
  });

  it("rejects an unknown top-level key (.strict)", () => {
    const bad = ApprovalSchema.safeParse({ ...validBase, extra: "nope" });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty/whitespace id (branded non-empty)", () => {
    const bad = ApprovalSchema.safeParse({ ...validBase, id: "   " });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty/whitespace actionRef (branded non-empty)", () => {
    const bad = ApprovalSchema.safeParse({ ...validBase, actionRef: "" });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty/whitespace workspaceId (branded non-empty — WS-4 scope attribution)", () => {
    const bad = ApprovalSchema.safeParse({ ...validBase, workspaceId: "   " });
    expect(bad.success).toBe(false);
  });

  it("rejects a MISSING workspaceId (required — an unscoped Approval is unrepresentable)", () => {
    const { workspaceId: _omit, ...without } = validBase;
    const bad = ApprovalSchema.safeParse(without);
    expect(bad.success).toBe(false);
  });

  it("rejects an empty actor (non-empty string)", () => {
    const bad = ApprovalSchema.safeParse({ ...validBase, actor: "" });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty payloadHash (non-empty string)", () => {
    const bad = ApprovalSchema.safeParse({ ...validBase, payloadHash: "" });
    expect(bad.success).toBe(false);
  });

  it("rejects a status outside the enum (pending|approved|edited|rejected|deferred|expired)", () => {
    const bad = ApprovalSchema.safeParse({ ...validBase, status: "snoozed" });
    expect(bad.success).toBe(false);
  });

  it("rejects a channel outside the enum (mac|telegram)", () => {
    const bad = ApprovalSchema.safeParse({ ...validBase, channel: "slack" });
    expect(bad.success).toBe(false);
  });

  it("rejects a non-datetime snoozeUntil", () => {
    const bad = ApprovalSchema.safeParse({
      ...validBase,
      status: "deferred",
      snoozeUntil: "tomorrow",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a non-datetime expiresAt", () => {
    const bad = ApprovalSchema.safeParse({ ...validBase, expiresAt: "next week" });
    expect(bad.success).toBe(false);
  });

  it("rejects a missing required field (payloadHash)", () => {
    const { payloadHash: _omit, ...withoutHash } = validBase;
    const bad = ApprovalSchema.safeParse(withoutHash);
    expect(bad.success).toBe(false);
  });

  // ── Conditional invariant: snoozeUntil present ONLY when status==="deferred" ─
  // (one-directional, NOT iff — a deferred approval MAY omit snoozeUntil.)
  it("accepts status === 'deferred' WITH a snoozeUntil (invariant passing)", () => {
    const ok = ApprovalSchema.safeParse({
      ...validBase,
      status: "deferred",
      snoozeUntil: "2026-07-01T12:00:00.000Z",
    });
    expect(ok.success).toBe(true);
  });

  it("accepts status === 'deferred' WITHOUT a snoozeUntil (one-directional, default window)", () => {
    const ok = ApprovalSchema.safeParse({ ...validBase, status: "deferred" });
    expect(ok.success).toBe(true);
  });

  it("rejects snoozeUntil present WHILE status !== 'deferred' (invariant failing)", () => {
    const bad = ApprovalSchema.safeParse({
      ...validBase,
      status: "approved",
      snoozeUntil: "2026-07-01T12:00:00.000Z",
    });
    expect(bad.success).toBe(false);
  });
});
