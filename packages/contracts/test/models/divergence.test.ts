// Divergence contract test (task WT, §6/§12). RED-first schema-snapshot freeze +
// behavior + conditional-invariant coverage. A Divergence is the per-fact unit of
// GBrain write-through parity reconciliation (embedded in `ParityReport.divergences[]`,
// referenced by `QuarantineRecord.divergenceRef`). PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import { DivergenceSchema, DIVERGENCE_SCHEMA_ID } from "../../src/models/divergence";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

const SHA = "a".repeat(64); // valid sha256 hex (64 chars)

describe("Divergence contract — spec(§6/§12)", () => {
  // ── Frozen field-name set (the spec, hand-authored in __snapshots__) ────────
  it("freezes its top-level field-name set to the spec snapshot", () => {
    expect(fieldSet(emitJsonSchema(DivergenceSchema, DIVERGENCE_SCHEMA_ID))).toEqual(
      loadFieldSnapshot("divergence"),
    );
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ─
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/divergence.schema.json", import.meta.url),
      emitJsonSchema(DivergenceSchema, DIVERGENCE_SCHEMA_ID),
    );
  });

  // ── Behaviors ──────────────────────────────────────────────────────────────
  it("accepts a valid db_only divergence (HARD floor, db digest only)", () => {
    const ok = DivergenceSchema.safeParse({
      factIdentity: "page:employer-work/acme/auth-redesign",
      divergenceClass: "db_only",
      severityFloor: "hard",
      dbContentHash: "sha256:deadbeefcafe",
      remediation: "materialize",
    });
    expect(ok.success).toBe(true);
  });

  it("accepts a valid content_mismatch divergence (SOFT floor, both digests)", () => {
    const ok = DivergenceSchema.safeParse({
      factIdentity: "link:page-a->page-b:owner",
      divergenceClass: "content_mismatch",
      severityFloor: "soft",
      mdContentSha: SHA,
      dbContentHash: "sha256:deadbeefcafe",
      remediation: "resync",
    });
    expect(ok.success).toBe(true);
  });

  it("rejects an unknown top-level key (.strict())", () => {
    const bad = DivergenceSchema.safeParse({
      factIdentity: "page:p",
      divergenceClass: "md_only",
      severityFloor: "soft",
      remediation: "review",
      extra: true,
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a factIdentity that violates the identity grammar", () => {
    const bad = DivergenceSchema.safeParse({
      factIdentity: "not-a-valid-identity",
      divergenceClass: "md_only",
      severityFloor: "soft",
      remediation: "review",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a divergenceClass outside the closed set", () => {
    const bad = DivergenceSchema.safeParse({
      factIdentity: "page:p",
      divergenceClass: "totally_made_up",
      severityFloor: "soft",
      remediation: "review",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a severityFloor outside {hard,soft}", () => {
    const bad = DivergenceSchema.safeParse({
      factIdentity: "page:p",
      divergenceClass: "md_only",
      severityFloor: "critical",
      remediation: "review",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a remediation outside the closed set", () => {
    const bad = DivergenceSchema.safeParse({
      factIdentity: "page:p",
      divergenceClass: "md_only",
      severityFloor: "soft",
      remediation: "ignore",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a non-sha256 mdContentSha when present", () => {
    const bad = DivergenceSchema.safeParse({
      factIdentity: "page:p",
      divergenceClass: "content_mismatch",
      severityFloor: "soft",
      mdContentSha: "nothex",
      remediation: "resync",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty dbContentHash when present", () => {
    const bad = DivergenceSchema.safeParse({
      factIdentity: "page:p",
      divergenceClass: "md_only",
      severityFloor: "soft",
      dbContentHash: "",
      remediation: "review",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a missing required field (remediation)", () => {
    const bad = DivergenceSchema.safeParse({
      factIdentity: "page:p",
      divergenceClass: "md_only",
      severityFloor: "soft",
    });
    expect(bad.success).toBe(false);
  });

  // ── Conditional invariant: divergenceClass ∈ {db_only,unstamped} ⇒ HARD floor ─
  // The passing direction (antecedent true + hard) is covered by the valid
  // db_only fixture above, and the antecedent-false case by the soft fixture.
  // Both failing directions of the implication are pinned below.
  it("rejects db_only with a soft severityFloor (HARD floor non-downgradable)", () => {
    const bad = DivergenceSchema.safeParse({
      factIdentity: "page:p",
      divergenceClass: "db_only",
      severityFloor: "soft",
      dbContentHash: "sha256:deadbeefcafe",
      remediation: "materialize",
    });
    expect(bad.success).toBe(false);
  });

  it("rejects unstamped with a soft severityFloor (HARD floor non-downgradable)", () => {
    const bad = DivergenceSchema.safeParse({
      factIdentity: "page:p",
      divergenceClass: "unstamped",
      severityFloor: "soft",
      remediation: "resync",
    });
    expect(bad.success).toBe(false);
  });

  it("accepts unstamped with a hard severityFloor (refine satisfied)", () => {
    const ok = DivergenceSchema.safeParse({
      factIdentity: "tag:page-x:reviewed",
      divergenceClass: "unstamped",
      severityFloor: "hard",
      remediation: "resync",
    });
    expect(ok.success).toBe(true);
  });
});
