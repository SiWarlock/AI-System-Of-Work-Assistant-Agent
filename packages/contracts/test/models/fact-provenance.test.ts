// FactProvenance contract test (task WT, §6/§12). RED-first schema-snapshot
// freeze + behavior coverage. Copies the canonical EgressPolicy template. PURE —
// no app/adapter imports.
//
// FactProvenance is a DESCRIPTIVE, observational provenance record — it must be
// able to REPRESENT defect/adversarial states the §6/§12 parity layer is required
// to DETECT (the §12 #3 "borrowed-stamp" case is a `db_only` fact that CARRIES a
// stampSig; the `unstamped` divergence is a `markdown` fact LACKING one). So there
// is NO cross-field coupling refine — a stamp⟹materialized invariant would make
// those states unrepresentable and is therefore intentionally absent. Coverage
// below is field-level: required `origin`, the tristate nullable `gbrainLinkSource`
// (value | null | absent), and the optionality of every other field.
import { describe, expect, it } from "vitest";
import { FactProvenanceSchema, FACT_PROVENANCE_SCHEMA_ID } from "../../src/models/fact-provenance";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

const SHA = "a".repeat(64); // valid sha256 hex

describe("FactProvenance contract — spec(§6/§12)", () => {
  // ── Frozen field-name set (the spec, hand-authored in __snapshots__) ──────
  it("freezes its top-level field-name set to the spec snapshot", () => {
    expect(fieldSet(emitJsonSchema(FactProvenanceSchema, FACT_PROVENANCE_SCHEMA_ID))).toEqual(
      loadFieldSnapshot("fact-provenance"),
    );
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ─
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/fact-provenance.schema.json", import.meta.url),
      emitJsonSchema(FactProvenanceSchema, FACT_PROVENANCE_SCHEMA_ID),
    );
  });

  // ── Behaviors ────────────────────────────────────────────────────────────
  it("accepts a fully-populated materialized provenance record", () => {
    const ok = FactProvenanceSchema.safeParse({
      origin: "markdown",
      kwRevision: "rev-42",
      originPath: "employer-work/acme-api/auth-redesign.md",
      mdContentSha: SHA,
      stampSig: "hmac-sig-deadbeef",
      gbrainLinkSource: "markdown",
    });
    expect(ok.success).toBe(true);
  });

  it("accepts a minimal record carrying ONLY origin (all else optional)", () => {
    const ok = FactProvenanceSchema.safeParse({ origin: "db_only" });
    expect(ok.success).toBe(true);
  });

  it("accepts gbrainLinkSource === null (explicit null is distinct from absent)", () => {
    const ok = FactProvenanceSchema.safeParse({
      origin: "frontmatter",
      gbrainLinkSource: null,
    });
    expect(ok.success).toBe(true);
  });

  it("accepts each gbrainLinkSource enum value (markdown|frontmatter|manual)", () => {
    for (const src of ["markdown", "frontmatter", "manual"] as const) {
      const ok = FactProvenanceSchema.safeParse({ origin: "markdown", gbrainLinkSource: src });
      expect(ok.success).toBe(true);
    }
  });

  it("accepts each origin enum value (markdown|frontmatter|db_only|generative_unmaterialized)", () => {
    for (const origin of [
      "markdown",
      "frontmatter",
      "db_only",
      "generative_unmaterialized",
    ] as const) {
      const ok = FactProvenanceSchema.safeParse({ origin });
      expect(ok.success).toBe(true);
    }
  });

  // ── DEFECT/ADVERSARIAL representability (§6 iv / §12 #3) ───────────────────
  // The schema must NOT reject these — the parity layer detects them downstream.
  it("REPRESENTS the borrowed-stamp adversarial state (db_only WITH a stampSig)", () => {
    const ok = FactProvenanceSchema.safeParse({
      origin: "db_only",
      stampSig: "borrowed-or-forged-sig",
      mdContentSha: SHA,
    });
    expect(ok.success).toBe(true);
  });

  it("REPRESENTS the unstamped divergence state (markdown WITHOUT a stampSig)", () => {
    const ok = FactProvenanceSchema.safeParse({
      origin: "markdown",
      originPath: "personal-life/journal.md",
    });
    expect(ok.success).toBe(true);
  });

  // ── Rejections ────────────────────────────────────────────────────────────
  it("rejects an unknown top-level key (.strict)", () => {
    const bad = FactProvenanceSchema.safeParse({ origin: "markdown", extra: "nope" });
    expect(bad.success).toBe(false);
  });

  it("rejects a missing required origin", () => {
    const bad = FactProvenanceSchema.safeParse({ originPath: "x.md" });
    expect(bad.success).toBe(false);
  });

  it("rejects an origin outside the enum", () => {
    const bad = FactProvenanceSchema.safeParse({ origin: "scratch" });
    expect(bad.success).toBe(false);
  });

  it("rejects a gbrainLinkSource outside the enum", () => {
    const bad = FactProvenanceSchema.safeParse({ origin: "markdown", gbrainLinkSource: "auto" });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty/whitespace kwRevision (branded non-empty)", () => {
    const bad = FactProvenanceSchema.safeParse({ origin: "markdown", kwRevision: "   " });
    expect(bad.success).toBe(false);
  });

  it("rejects a non-sha256 mdContentSha (branded hex format)", () => {
    const bad = FactProvenanceSchema.safeParse({ origin: "markdown", mdContentSha: "not-a-sha" });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty originPath (optional but non-empty when present)", () => {
    const bad = FactProvenanceSchema.safeParse({ origin: "markdown", originPath: "" });
    expect(bad.success).toBe(false);
  });

  it("rejects a non-string stampSig (optional string)", () => {
    const bad = FactProvenanceSchema.safeParse({ origin: "markdown", stampSig: 123 });
    expect(bad.success).toBe(false);
  });
});
