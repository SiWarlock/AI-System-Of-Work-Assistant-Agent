// 1.11 — the 5 §3 universal validation rules as PURE composable predicates.
// Each rule has a passing + a failing test; rejections are typed + enumerable.
// PURE — no clock/network/random; the schema rule uses an INLINE fixture registry
// (the same pattern as the 1.2 schema-gate self-test).
import { describe, it, expect } from "vitest";
import { z } from "zod";
import { emitJsonSchema } from "@sow/contracts/schema/emit";
import { buildSchemaRegistry } from "@sow/contracts/schema/registry";
import { actionId, planId, sourceId, workspaceId } from "@sow/contracts";
import type {
  ExternalWriteEnvelope,
  ProposedAction,
  KnowledgeMutationPlan,
  GclProjection,
} from "@sow/contracts";
import {
  ruleSchemaValid,
  ruleExternalWriteKeys,
  ruleScopedMutation,
  ruleVisibilityDeclared,
} from "../../src/validation/universal-rules";

// ── rule (a) schema validity ────────────────────────────────────────────────
describe("ruleSchemaValid (rule a, REQ-S-006 / §3)", () => {
  const reg = buildSchemaRegistry([
    emitJsonSchema(z.object({ a: z.string() }).strict(), "sow:fixture"),
  ]);

  it("passes conforming output (ok(output))", () => {
    const r = ruleSchemaValid({ a: "x" }, "sow:fixture", reg);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value).toEqual({ a: "x" });
  });

  it("rejects non-conforming output as schema_violation", () => {
    const r = ruleSchemaValid({ a: 1 }, "sow:fixture", reg);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("schema_violation");
      expect(r.error.schemaId).toBe("sow:fixture");
      expect((r.error.errors ?? []).length).toBeGreaterThan(0);
    }
  });

  it("maps an unknown schema id to schema_violation", () => {
    const r = ruleSchemaValid({}, "sow:nope", reg);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("schema_violation");
  });
});

// ── rule (b) external-write keys ────────────────────────────────────────────
const validAction = (): ProposedAction => ({
  actionId: actionId("act-1"),
  targetSystem: "calendar",
  canonicalObjectKey: "calendar:evt-1",
  payload: {},
  approvalPolicy: "auto_allowed",
  idempotencyKey: "idem-1",
});

const validEnvelope = (): ExternalWriteEnvelope => ({
  actionId: actionId("act-1"),
  targetSystem: "calendar",
  canonicalObjectKey: "calendar:evt-1",
  idempotencyKey: "idem-1",
  preconditions: [],
  payloadHash: "hash-1",
});

describe("ruleExternalWriteKeys (rule b, §3/§8 / safety rule 3)", () => {
  it("passes a ProposedAction carrying both non-empty keys", () => {
    const r = ruleExternalWriteKeys(validAction());
    expect(r.ok).toBe(true);
  });

  it("passes an ExternalWriteEnvelope carrying both non-empty keys", () => {
    const r = ruleExternalWriteKeys(validEnvelope());
    expect(r.ok).toBe(true);
  });

  it("rejects an empty canonicalObjectKey as missing_key", () => {
    const r = ruleExternalWriteKeys({ ...validAction(), canonicalObjectKey: "" });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("missing_key");
      expect(r.error.fields).toContain("canonicalObjectKey");
    }
  });

  it("rejects a whitespace-only idempotencyKey as missing_key", () => {
    const r = ruleExternalWriteKeys({ ...validAction(), idempotencyKey: "   " });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("missing_key");
      expect(r.error.fields).toContain("idempotencyKey");
    }
  });
});

// ── rule (c) scoped mutation ────────────────────────────────────────────────
const validPlan = (): KnowledgeMutationPlan => ({
  planId: planId("plan-1"),
  workspaceId: workspaceId("ws-1"),
  sourceRefs: [{ sourceId: sourceId("src-1") }],
  creates: [],
  patches: [],
  linkMutations: [],
  frontmatterUpdates: [],
  externalActionProposals: [],
  confidence: 1,
  requiresApproval: false,
  provenanceOrigin: "meeting_close",
});

describe("ruleScopedMutation (rule c, REQ-F-006 / §3)", () => {
  it("passes a plan carrying a workspaceId AND a non-empty sourceRefs list", () => {
    const r = ruleScopedMutation(validPlan());
    expect(r.ok).toBe(true);
  });

  it("rejects a plan with an empty sourceRefs list as unscoped_mutation", () => {
    const r = ruleScopedMutation({ ...validPlan(), sourceRefs: [] });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("unscoped_mutation");
      expect(r.error.fields).toContain("sourceRefs");
    }
  });

  it("rejects a plan with an empty workspaceId as unscoped_mutation", () => {
    const r = ruleScopedMutation({
      ...validPlan(),
      workspaceId: "" as unknown as KnowledgeMutationPlan["workspaceId"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("unscoped_mutation");
      expect(r.error.fields).toContain("workspaceId");
    }
  });
});

// ── rule (d) visibility ─────────────────────────────────────────────────────
const validProjection = (): GclProjection => ({
  workspaceId: workspaceId("ws-1"),
  visibilityLevel: "coordination",
  projectionType: "busy_free",
  sanitizedPayload: {},
  sourceRefs: [{ sourceId: sourceId("src-1") }],
});

describe("ruleVisibilityDeclared (rule d, REQ-F-005 / §6 WS-8)", () => {
  it("passes a projection declaring visibilityLevel AND source workspaceId", () => {
    const r = ruleVisibilityDeclared(validProjection());
    expect(r.ok).toBe(true);
  });

  it("rejects a projection missing visibilityLevel as missing_visibility", () => {
    const r = ruleVisibilityDeclared({
      ...validProjection(),
      visibilityLevel: "" as unknown as GclProjection["visibilityLevel"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("missing_visibility");
      expect(r.error.fields).toContain("visibilityLevel");
    }
  });

  it("rejects a projection missing source workspaceId as missing_visibility", () => {
    const r = ruleVisibilityDeclared({
      ...validProjection(),
      workspaceId: "" as unknown as GclProjection["workspaceId"],
    });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("missing_visibility");
      expect(r.error.fields).toContain("workspaceId");
    }
  });
});
