// GBrainProposedFact contract test (task WT, §6/§7). RED-first schema-snapshot
// freeze + behavior + invariant coverage. Mirrors the canonical egress-policy
// template. PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import {
  GBrainProposedFactSchema,
  GBRAIN_PROPOSED_FACT_SCHEMA_ID,
} from "../../src/models/gbrain-proposed-fact";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

// A valid proposal with `requiresApproval` OMITTED — so the default-true behavior
// is exercised by the base "accepts" test. Other fixtures spread + override this.
const valid = (): Record<string, unknown> => ({
  proposalId: "prop-001",
  workspaceId: "ws-employer",
  factKind: "page",
  proposedContent: { slug: "acme-api/auth-redesign", title: "Auth redesign" },
  evidenceRefs: [{ kind: "markdown", ref: "acme-api/auth-redesign.md", span: "L1-L20" }],
  confidence: 0.82,
  generatedBy: "synthesis",
});

describe("GBrainProposedFact contract — spec(§6/§7)", () => {
  // ── Frozen field-name set (the spec, hand-authored in __snapshots__) ──────
  it("freezes its top-level field-name set to the spec snapshot", () => {
    expect(
      fieldSet(emitJsonSchema(GBrainProposedFactSchema, GBRAIN_PROPOSED_FACT_SCHEMA_ID)),
    ).toEqual(loadFieldSnapshot("gbrain-proposed-fact"));
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ─
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/gbrain-proposed-fact.schema.json", import.meta.url),
      emitJsonSchema(GBrainProposedFactSchema, GBRAIN_PROPOSED_FACT_SCHEMA_ID),
    );
  });

  // ── Behaviors ────────────────────────────────────────────────────────────
  it("accepts a valid proposal and defaults requiresApproval to true when omitted", () => {
    const parsed = GBrainProposedFactSchema.safeParse(valid());
    expect(parsed.success).toBe(true);
    if (parsed.success) expect(parsed.data.requiresApproval).toBe(true);
  });

  it("accepts requiresApproval explicitly set to false (override)", () => {
    expect(
      GBrainProposedFactSchema.safeParse({ ...valid(), requiresApproval: false }).success,
    ).toBe(true);
  });

  it("accepts a source_envelope evidence ref with a span", () => {
    expect(
      GBrainProposedFactSchema.safeParse({
        ...valid(),
        evidenceRefs: [{ kind: "source_envelope", ref: "env-123", span: "0:512" }],
      }).success,
    ).toBe(true);
  });

  it("accepts an evidence ref carrying an optional numbered `block` back-ref (task 13.7a, additive)", () => {
    expect(
      GBrainProposedFactSchema.safeParse({
        ...valid(),
        evidenceRefs: [{ kind: "markdown", ref: "acme/note.md", span: "L1-L20", block: "B3" }],
      }).success,
    ).toBe(true);
  });

  it("accepts every generatedBy literal (synthesis|dream|patterns|minion)", () => {
    for (const generatedBy of ["synthesis", "dream", "patterns", "minion"]) {
      expect(GBrainProposedFactSchema.safeParse({ ...valid(), generatedBy }).success).toBe(true);
    }
  });

  it("rejects an unknown top-level key (.strict)", () => {
    expect(GBrainProposedFactSchema.safeParse({ ...valid(), extra: "nope" }).success).toBe(false);
  });

  it("rejects an empty/whitespace proposalId (branded non-empty)", () => {
    expect(GBrainProposedFactSchema.safeParse({ ...valid(), proposalId: "   " }).success).toBe(
      false,
    );
  });

  it("rejects an empty/whitespace workspaceId (branded non-empty)", () => {
    expect(GBrainProposedFactSchema.safeParse({ ...valid(), workspaceId: "" }).success).toBe(false);
  });

  it("rejects an out-of-set factKind", () => {
    expect(GBrainProposedFactSchema.safeParse({ ...valid(), factKind: "comment" }).success).toBe(
      false,
    );
  });

  it("rejects an out-of-set generatedBy (e.g. 'human')", () => {
    expect(GBrainProposedFactSchema.safeParse({ ...valid(), generatedBy: "human" }).success).toBe(
      false,
    );
  });

  // ── confidence ∈ [0,1] ─────────────────────────────────────────────────────
  it("accepts confidence at the boundaries 0 and 1", () => {
    expect(GBrainProposedFactSchema.safeParse({ ...valid(), confidence: 0 }).success).toBe(true);
    expect(GBrainProposedFactSchema.safeParse({ ...valid(), confidence: 1 }).success).toBe(true);
  });

  it("rejects confidence > 1", () => {
    expect(GBrainProposedFactSchema.safeParse({ ...valid(), confidence: 1.5 }).success).toBe(false);
  });

  it("rejects confidence < 0", () => {
    expect(GBrainProposedFactSchema.safeParse({ ...valid(), confidence: -0.01 }).success).toBe(
      false,
    );
  });

  it("rejects a non-numeric confidence", () => {
    expect(GBrainProposedFactSchema.safeParse({ ...valid(), confidence: "high" }).success).toBe(
      false,
    );
  });

  // ── evidenceRefs: CanonicalSourceRef[] — scratch origin inadmissible, non-empty ─
  it("rejects an evidence ref with an inadmissible (scratch) kind", () => {
    expect(
      GBrainProposedFactSchema.safeParse({
        ...valid(),
        evidenceRefs: [{ kind: "scratch", ref: "tmp/notes" }],
      }).success,
    ).toBe(false);
  });

  it("rejects an empty evidenceRefs list (a generative proposal must cite evidence, §6 propose-only)", () => {
    expect(GBrainProposedFactSchema.safeParse({ ...valid(), evidenceRefs: [] }).success).toBe(
      false,
    );
  });

  it("rejects an evidence ref with an empty ref string", () => {
    expect(
      GBrainProposedFactSchema.safeParse({
        ...valid(),
        evidenceRefs: [{ kind: "markdown", ref: "" }],
      }).success,
    ).toBe(false);
  });

  it("rejects an evidence ref carrying an unknown key (.strict, nested)", () => {
    expect(
      GBrainProposedFactSchema.safeParse({
        ...valid(),
        evidenceRefs: [{ kind: "markdown", ref: "a.md", origin: "scratch" }],
      }).success,
    ).toBe(false);
  });

  // ── reject-on-missing (§3 universal rule) ──────────────────────────────────
  it("rejects a missing required field (factKind)", () => {
    const bad = { ...valid() };
    delete (bad as Record<string, unknown>)["factKind"];
    expect(GBrainProposedFactSchema.safeParse(bad).success).toBe(false);
  });

  it("rejects a missing required field (proposedContent)", () => {
    const bad = { ...valid() };
    delete (bad as Record<string, unknown>)["proposedContent"];
    expect(GBrainProposedFactSchema.safeParse(bad).success).toBe(false);
  });
});
