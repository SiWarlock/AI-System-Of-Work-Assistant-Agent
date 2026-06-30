// SemanticFact contract test (task WT, §6/§12). RED-first schema-snapshot freeze
// + behavior + conditional-invariant coverage. Mirrors the canonical EgressPolicy
// template. SemanticFact is the normalized unit both the SoW `CanonicalFactDeriver`
// and the read-only `DbProjector` emit; its identity is content-INDEPENDENT.
// PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import { SemanticFactSchema, SEMANTIC_FACT_SCHEMA_ID } from "../../src/models/semantic-fact";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

// A valid sha256 hex digest of normalized semantic content (mdContentSha).
const SHA = "a".repeat(64);

describe("SemanticFact contract — spec(§6/§12)", () => {
  // ── Frozen field-name set (the spec, hand-authored in __snapshots__) ──────
  it("freezes its top-level field-name set to the spec snapshot", () => {
    expect(fieldSet(emitJsonSchema(SemanticFactSchema, SEMANTIC_FACT_SCHEMA_ID))).toEqual(
      loadFieldSnapshot("semantic-fact"),
    );
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ─
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/semantic-fact.schema.json", import.meta.url),
      emitJsonSchema(SemanticFactSchema, SEMANTIC_FACT_SCHEMA_ID),
    );
  });

  // ── Behaviors: valid fixtures parse ──────────────────────────────────────
  it("accepts a valid page fact (page:<slug> identity)", () => {
    const ok = SemanticFactSchema.safeParse({
      factIdentity: "page:employer-work/acme/auth-redesign",
      factKind: "page",
      workspaceId: "ws-employer",
      mdContentSha: SHA,
      revisionId: "rev-001",
    });
    expect(ok.success).toBe(true);
  });

  it("accepts a valid link fact (link:<src>-><dst>:<field> identity)", () => {
    const ok = SemanticFactSchema.safeParse({
      factIdentity: "link:acme/auth->acme/sessions:relatesTo",
      factKind: "link",
      workspaceId: "ws-employer",
      mdContentSha: SHA,
      revisionId: "rev-002",
    });
    expect(ok.success).toBe(true);
  });

  it("accepts a valid timeline fact (timeline:<page>:<seq> identity)", () => {
    const ok = SemanticFactSchema.safeParse({
      factIdentity: "timeline:acme/auth-redesign:3",
      factKind: "timeline",
      workspaceId: "ws-employer",
      mdContentSha: SHA,
      revisionId: "rev-003",
    });
    expect(ok.success).toBe(true);
  });

  it("accepts a valid tag fact (tag:<page>:<tag> identity)", () => {
    const ok = SemanticFactSchema.safeParse({
      factIdentity: "tag:acme/auth-redesign:security",
      factKind: "tag",
      workspaceId: "ws-employer",
      mdContentSha: SHA,
      revisionId: "rev-004",
    });
    expect(ok.success).toBe(true);
  });

  // frontmatter_value is the 5th factKind, but Appendix A names only 4 identity
  // forms — its identity form is unspecified upstream (arch_gap), so the
  // factKind↔prefix coupling is intentionally NOT enforced for it.
  it("accepts a frontmatter_value fact carrying any valid factIdentity form (uncoupled)", () => {
    const ok = SemanticFactSchema.safeParse({
      factIdentity: "page:employer-work/acme/auth-redesign",
      factKind: "frontmatter_value",
      workspaceId: "ws-employer",
      mdContentSha: SHA,
      revisionId: "rev-005",
    });
    expect(ok.success).toBe(true);
  });

  // ── Behaviors: invalid fixtures are rejected ─────────────────────────────
  it("rejects an unknown top-level key (.strict)", () => {
    const bad = SemanticFactSchema.safeParse({
      factIdentity: "page:acme/auth",
      factKind: "page",
      workspaceId: "ws-employer",
      mdContentSha: SHA,
      revisionId: "rev-001",
      extra: "nope",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a missing required field (mdContentSha)", () => {
    const bad = SemanticFactSchema.safeParse({
      factIdentity: "page:acme/auth",
      factKind: "page",
      workspaceId: "ws-employer",
      revisionId: "rev-001",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty/whitespace workspaceId (branded non-empty)", () => {
    const bad = SemanticFactSchema.safeParse({
      factIdentity: "page:acme/auth",
      factKind: "page",
      workspaceId: "   ",
      mdContentSha: SHA,
      revisionId: "rev-001",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty/whitespace revisionId (branded non-empty)", () => {
    const bad = SemanticFactSchema.safeParse({
      factIdentity: "page:acme/auth",
      factKind: "page",
      workspaceId: "ws-employer",
      mdContentSha: SHA,
      revisionId: "  ",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a factIdentity that matches no known form (content-independence regex)", () => {
    const bad = SemanticFactSchema.safeParse({
      factIdentity: "sha256:deadbeef", // content-derived / unknown prefix → rejected
      factKind: "page",
      workspaceId: "ws-employer",
      mdContentSha: SHA,
      revisionId: "rev-001",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a factKind outside the enum (page|link|timeline|tag|frontmatter_value)", () => {
    const bad = SemanticFactSchema.safeParse({
      factIdentity: "page:acme/auth",
      factKind: "edge", // not a member of FactKind
      workspaceId: "ws-employer",
      mdContentSha: SHA,
      revisionId: "rev-001",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a non-sha256 mdContentSha", () => {
    const bad = SemanticFactSchema.safeParse({
      factIdentity: "page:acme/auth",
      factKind: "page",
      workspaceId: "ws-employer",
      mdContentSha: "not-a-hash",
      revisionId: "rev-001",
    });
    expect(bad.success).toBe(false);
  });

  // ── Conditional invariant: factIdentity prefix must agree with factKind ───
  // Passing direction is covered by the four "accepts a valid <kind> fact"
  // tests above. The two failing directions:
  it("rejects factKind === page WITH a non-page (link) factIdentity (prefix mismatch)", () => {
    const bad = SemanticFactSchema.safeParse({
      factIdentity: "link:a->b:relatesTo", // structurally valid identity, wrong kind
      factKind: "page",
      workspaceId: "ws-employer",
      mdContentSha: SHA,
      revisionId: "rev-001",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects factKind === tag WITH a timeline factIdentity (prefix mismatch)", () => {
    const bad = SemanticFactSchema.safeParse({
      factIdentity: "timeline:acme/auth:1", // structurally valid identity, wrong kind
      factKind: "tag",
      workspaceId: "ws-employer",
      mdContentSha: SHA,
      revisionId: "rev-001",
    });
    expect(bad.success).toBe(false);
  });
});
