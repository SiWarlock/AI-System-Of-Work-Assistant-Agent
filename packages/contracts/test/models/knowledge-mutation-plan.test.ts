// KnowledgeMutationPlan contract test (task 1.7(WT-amended), §3/§6/§7). RED-first
// schema-snapshot freeze + behavior + REQ-F-006 reject-on-empty invariant
// coverage. Mirrors the canonical egress-policy.test.ts template. Embeds the REAL
// ProposedAction + SignedProvenanceStamp seam schemas (not stubs) so a drift in
// either nested contract trips this test. PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import {
  KnowledgeMutationPlanSchema,
  KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
} from "../../src/models/knowledge-mutation-plan";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

// A minimal plan honoring REQ-F-006 (workspaceId + non-empty sourceRefs); all
// mutation lists empty (the contract requires only sourceRefs to be non-empty).
const MINIMAL_VALID = {
  planId: "plan-1",
  workspaceId: "ws-employer",
  sourceRefs: [{ sourceId: "src-1" }],
  creates: [],
  patches: [],
  linkMutations: [],
  frontmatterUpdates: [],
  externalActionProposals: [],
  confidence: 0.9,
  requiresApproval: true,
  provenanceOrigin: "human",
} as const;

// A full plan exercising every optional field + the embedded ProposedAction and
// SignedProvenanceStamp seam schemas + every mutation primitive list.
const FULL_VALID = {
  planId: "plan-2",
  workspaceId: "ws-employer",
  sourceRefs: [{ sourceId: "src-1", span: "L1-L4" }],
  creates: [{ path: "notes/a.md", title: "A", body: "hello", frontmatter: { k: 1 } }],
  patches: [{ path: "notes/a.md", regionId: "region-1", newBody: "replaced" }],
  linkMutations: [{ op: "add", srcPath: "notes/a.md", dstSlug: "b", field: "relatesTo" }],
  frontmatterUpdates: [{ path: "notes/a.md", key: "status", value: "done" }],
  externalActionProposals: [
    {
      actionId: "act-1",
      targetSystem: "calendar",
      canonicalObjectKey: "calendar:event:abc",
      payload: { title: "Sync" },
      approvalPolicy: "manual",
      idempotencyKey: "idem-1",
    },
  ],
  confidence: 0.5,
  requiresApproval: true,
  provenanceOrigin: "gbrain_proposal",
  gbrainProposalRef: "prop-1",
  signedProvenanceStamp: {
    kwRevision: "rev-1",
    originPath: "notes/a.md",
    mdContentSha: "a".repeat(64),
    writerActor: "KnowledgeWriter",
    sourceEventRef: "evt-1",
    committedAt: "2026-06-30T12:00:00.000Z",
    sig: "deadbeef",
  },
  expectedProjectId: "acme-corp",
} as const;

describe("KnowledgeMutationPlan contract — spec(§3/§6/§7)", () => {
  // ── Frozen field-name set (the spec, hand-authored in __snapshots__) ────────
  it("freezes its top-level field-name set against the spec snapshot", () => {
    expect(
      fieldSet(emitJsonSchema(KnowledgeMutationPlanSchema, KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID)),
    ).toEqual(loadFieldSnapshot("knowledge-mutation-plan"));
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ─
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/knowledge-mutation-plan.schema.json", import.meta.url),
      emitJsonSchema(KnowledgeMutationPlanSchema, KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID),
    );
  });

  // ── Behaviors — valid ──────────────────────────────────────────────────────
  it("accepts a minimal valid plan (workspaceId + non-empty sourceRefs)", () => {
    const ok = KnowledgeMutationPlanSchema.safeParse(MINIMAL_VALID);
    expect(ok.success).toBe(true);
  });

  it("accepts a full valid plan (every optional + embedded ProposedAction/stamp)", () => {
    const ok = KnowledgeMutationPlanSchema.safeParse(FULL_VALID);
    expect(ok.success).toBe(true);
  });

  // ── Behaviors — invalid ────────────────────────────────────────────────────
  it("rejects a missing required field (workspaceId)", () => {
    const { workspaceId: _omit, ...bad } = MINIMAL_VALID;
    expect(KnowledgeMutationPlanSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects an unknown top-level key (.strict)", () => {
    const bad = { ...MINIMAL_VALID, surprise: "x" };
    expect(KnowledgeMutationPlanSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects confidence above 1 (out of [0,1])", () => {
    const bad = { ...MINIMAL_VALID, confidence: 1.5 };
    expect(KnowledgeMutationPlanSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects confidence below 0 (out of [0,1])", () => {
    const bad = { ...MINIMAL_VALID, confidence: -0.1 };
    expect(KnowledgeMutationPlanSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a provenanceOrigin outside the ProvenanceOrigin enum", () => {
    const bad = { ...MINIMAL_VALID, provenanceOrigin: "robot" };
    expect(KnowledgeMutationPlanSchema.safeParse(bad).success).toBe(false);
  });

  // §13.10a — the Copilot semantic-write bridge's origin is an accepted member.
  it("accepts provenanceOrigin: copilot_propose (§13.10a Copilot semantic-write bridge)", () => {
    const ok = KnowledgeMutationPlanSchema.safeParse({ ...MINIMAL_VALID, provenanceOrigin: "copilot_propose" });
    expect(ok.success).toBe(true);
  });

  // §13.10a gate 1 — the optional verification-only projectId (the executor matches it against the
  // target note's frontmatter on a patch). Optional (absent on non-propose plans); non-empty when present.
  it("accepts an optional expectedProjectId and rejects an empty one (.min(1))", () => {
    expect(KnowledgeMutationPlanSchema.safeParse({ ...MINIMAL_VALID, expectedProjectId: "acme-corp" }).success).toBe(true);
    expect(KnowledgeMutationPlanSchema.safeParse({ ...MINIMAL_VALID, expectedProjectId: "" }).success).toBe(false);
  });

  it("rejects an empty/whitespace sourceId in sourceRefs (branded non-empty)", () => {
    const bad = { ...MINIMAL_VALID, sourceRefs: [{ sourceId: "" }] };
    expect(KnowledgeMutationPlanSchema.safeParse(bad).success).toBe(false);
  });

  // Proves the REAL ProposedAction schema is embedded (universal external-write
  // rule §3: canonicalObjectKey is required) — not a permissive stub.
  it("rejects an embedded ProposedAction missing canonicalObjectKey", () => {
    const bad = {
      ...MINIMAL_VALID,
      externalActionProposals: [
        {
          actionId: "act-1",
          targetSystem: "calendar",
          payload: {},
          approvalPolicy: "manual",
          idempotencyKey: "idem-1",
        },
      ],
    };
    expect(KnowledgeMutationPlanSchema.safeParse(bad).success).toBe(false);
  });

  // Proves the REAL SignedProvenanceStamp schema is embedded (one-writer literal,
  // safety rule 1: writerActor MUST be "KnowledgeWriter").
  it("rejects an embedded SignedProvenanceStamp with a non-KnowledgeWriter writerActor", () => {
    const bad = {
      ...FULL_VALID,
      signedProvenanceStamp: { ...FULL_VALID.signedProvenanceStamp, writerActor: "Imposter" },
    };
    expect(KnowledgeMutationPlanSchema.safeParse(bad).success).toBe(false);
  });

  // ── REQ-F-006 reject-on-empty invariant: workspaceId + non-empty sourceRefs ─
  // Passing direction covered by the two "accepts valid plan" tests above. The
  // failing direction (empty sourceRefs) is the refine's negative case.
  it("rejects an empty sourceRefs list (REQ-F-006 reject-on-empty refine)", () => {
    const bad = { ...MINIMAL_VALID, sourceRefs: [] };
    expect(KnowledgeMutationPlanSchema.safeParse(bad).success).toBe(false);
  });
});
