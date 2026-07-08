// Approval contract test (task 1.9, §3/§9/§10/§11). RED-first schema-snapshot
// freeze + behavior + conditional-invariant coverage. Mirrors the canonical
// EgressPolicy template. PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import { ApprovalSchema, APPROVAL_SCHEMA_ID } from "../../src/models/approval";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

// Reusable valid base (acknowledgment of all required fields). Each test spreads
// + overrides only the field under exercise. §13.10a: `subjectKind` discriminates
// the pending card's subject — `external_action` (an §8 ProposedAction, referenced
// by `actionRef`) vs `semantic_mutation` (a §6 KMP, referenced by `planRef`). This
// base is the external-action shape (the pre-§13.10a card): actionRef present, no
// planRef — the majority of stored approvals.
const validBase = {
  id: "appr-001",
  actionRef: "act-001",
  subjectKind: "external_action",
  workspaceId: "ws-personal-business",
  status: "approved",
  actor: "user:cody",
  channel: "mac",
  payloadHash: "9f2c8a1b3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff",
} as const;

// The semantic-mutation shape (§13.10a): NO actionRef, a `planRef` into the
// pending-KMP store, subjectKind === "semantic_mutation".
const validSemanticBase = {
  id: "appr-002",
  planRef: "plan-001",
  subjectKind: "semantic_mutation",
  workspaceId: "ws-personal-business",
  status: "pending",
  actor: "user:cody",
  channel: "mac",
  payloadHash: "0011223344556677889900aabbccddeeff00112233445566778899aabbccddee",
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

// ── §13.10a — the SUBJECT invariant: exactly one of actionRef/planRef, matching
// subjectKind. This is the frozen-round's security heart: the executor routes an
// approved card to the correct committer (Tool Gateway for external_action,
// KnowledgeWriter for semantic_mutation) off `subjectKind`, and the ref it reads
// MUST be the matching one — a card carrying the wrong ref (or both) is a
// mis-routed write, so the contract makes it unrepresentable.
describe("Approval subject invariant — spec(§13.10a)", () => {
  it("requires subjectKind (missing → reject)", () => {
    const { subjectKind: _omit, ...without } = validBase;
    const bad = ApprovalSchema.safeParse(without);
    expect(bad.success).toBe(false);
  });

  it("rejects a subjectKind outside the enum (external_action|semantic_mutation)", () => {
    const bad = ApprovalSchema.safeParse({ ...validBase, subjectKind: "cron_job" });
    expect(bad.success).toBe(false);
  });

  // external_action ⇒ actionRef present ∧ planRef absent
  it("accepts external_action with actionRef and no planRef", () => {
    const ok = ApprovalSchema.safeParse(validBase);
    expect(ok.success).toBe(true);
  });

  it("rejects external_action MISSING actionRef", () => {
    const { actionRef: _omit, ...without } = validBase;
    const bad = ApprovalSchema.safeParse(without);
    expect(bad.success).toBe(false);
  });

  it("rejects external_action carrying a planRef (both refs → mis-route risk)", () => {
    const bad = ApprovalSchema.safeParse({ ...validBase, planRef: "plan-001" });
    expect(bad.success).toBe(false);
  });

  // semantic_mutation ⇒ planRef present ∧ actionRef absent
  it("accepts semantic_mutation with planRef and no actionRef", () => {
    const ok = ApprovalSchema.safeParse(validSemanticBase);
    expect(ok.success).toBe(true);
  });

  it("rejects semantic_mutation MISSING planRef", () => {
    const { planRef: _omit, ...without } = validSemanticBase;
    const bad = ApprovalSchema.safeParse(without);
    expect(bad.success).toBe(false);
  });

  it("rejects semantic_mutation carrying an actionRef (both refs → mis-route risk)", () => {
    const bad = ApprovalSchema.safeParse({ ...validSemanticBase, actionRef: "act-001" });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty/whitespace planRef when present (branded non-empty)", () => {
    const bad = ApprovalSchema.safeParse({ ...validSemanticBase, planRef: "   " });
    expect(bad.success).toBe(false);
  });

  // Kind/ref MISMATCH (distinct from a MISSING ref): the subjectKind names one kind
  // but the card carries the OTHER kind's ref. external_action bearing a planRef-only
  // shape must reject (external_action ⇒ actionRef only) — the mis-route the refine exists
  // to make unrepresentable.
  it("rejects external_action bearing a planRef-only (semantic-shaped) subject", () => {
    const bad = ApprovalSchema.safeParse({ ...validSemanticBase, subjectKind: "external_action" });
    expect(bad.success).toBe(false);
  });

  // The mirror: semantic_mutation bearing an actionRef-only (external-shaped) subject.
  it("rejects semantic_mutation bearing an actionRef-only (external-shaped) subject", () => {
    const bad = ApprovalSchema.safeParse({ ...validBase, subjectKind: "semantic_mutation" });
    expect(bad.success).toBe(false);
  });
});
