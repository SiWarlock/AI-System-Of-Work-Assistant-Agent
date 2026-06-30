// SignedProvenanceStamp contract test (task 1.7(WT), §6/§12). RED-first
// schema-snapshot freeze + behavior coverage. The frontmatter sub-shape KW
// writes at the atomic commit (§6 invariant (iii) "signed provenance"); the
// load-bearing invariant is writerActor === the literal "KnowledgeWriter"
// (safety rule 1 — one writer / no hidden brain). Modeled on the EgressPolicy
// canonical template. PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import {
  SignedProvenanceStampSchema,
  SIGNED_PROVENANCE_STAMP_SCHEMA_ID,
} from "../../src/models/signed-provenance-stamp";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

// A valid 64-char lowercase-hex sha256 (MdContentShaSchema's branded format).
const VALID_SHA = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

// A canonical valid stamp; behavior tests clone + mutate this.
const valid = {
  kwRevision: "rev-000123",
  originPath: "employer-work/acme/auth.md#region:decisions",
  mdContentSha: VALID_SHA,
  writerActor: "KnowledgeWriter",
  sourceEventRef: "meeting:2026-06-30T10:00:00.000Z",
  committedAt: "2026-06-30T12:00:00.000Z",
  // sig is an open non-empty string (HMAC hex by convention, format not pinned).
  sig: "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
} as const;

describe("SignedProvenanceStamp contract — spec(§6/§12)", () => {
  // ── Frozen field-name set (the spec, hand-authored in __snapshots__) ──────
  it("freezes its top-level field-name set to the spec snapshot", () => {
    expect(
      fieldSet(emitJsonSchema(SignedProvenanceStampSchema, SIGNED_PROVENANCE_STAMP_SCHEMA_ID)),
    ).toEqual(loadFieldSnapshot("signed-provenance-stamp"));
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ─
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/signed-provenance-stamp.schema.json", import.meta.url),
      emitJsonSchema(SignedProvenanceStampSchema, SIGNED_PROVENANCE_STAMP_SCHEMA_ID),
    );
  });

  // ── Behaviors ────────────────────────────────────────────────────────────
  it("accepts a fully-formed valid stamp", () => {
    expect(SignedProvenanceStampSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an unknown top-level key (.strict)", () => {
    const bad = SignedProvenanceStampSchema.safeParse({ ...valid, extra: "nope" });
    expect(bad.success).toBe(false);
  });

  // ── Invariant: writerActor is EXACTLY the literal "KnowledgeWriter" ────────
  // The one-writer / no-hidden-brain invariant (safety rule 1) at the contract
  // surface. Passing case is the valid fixture above; the failing direction:
  it("rejects writerActor that is any value other than 'KnowledgeWriter'", () => {
    const bad = SignedProvenanceStampSchema.safeParse({ ...valid, writerActor: "GBrain" });
    expect(bad.success).toBe(false);
  });

  it("rejects a missing writerActor", () => {
    const { writerActor: _omit, ...rest } = valid;
    expect(SignedProvenanceStampSchema.safeParse(rest).success).toBe(false);
  });

  // ── Branded-field rejections ──────────────────────────────────────────────
  it("rejects an empty/whitespace kwRevision (branded non-empty)", () => {
    expect(SignedProvenanceStampSchema.safeParse({ ...valid, kwRevision: "   " }).success).toBe(
      false,
    );
  });

  it("rejects a non-hex / wrong-length mdContentSha (branded sha256 hex)", () => {
    expect(
      SignedProvenanceStampSchema.safeParse({ ...valid, mdContentSha: "not-a-sha" }).success,
    ).toBe(false);
  });

  // ── Open-string field rejections (non-empty) ──────────────────────────────
  it("rejects an empty originPath", () => {
    expect(SignedProvenanceStampSchema.safeParse({ ...valid, originPath: "" }).success).toBe(false);
  });

  it("rejects an empty sourceEventRef", () => {
    expect(SignedProvenanceStampSchema.safeParse({ ...valid, sourceEventRef: "" }).success).toBe(
      false,
    );
  });

  it("rejects an empty sig (HMAC hex is an open but non-empty string)", () => {
    expect(SignedProvenanceStampSchema.safeParse({ ...valid, sig: "" }).success).toBe(false);
  });

  // ── Datetime + missing-required rejections ────────────────────────────────
  it("rejects a non-datetime committedAt", () => {
    expect(
      SignedProvenanceStampSchema.safeParse({ ...valid, committedAt: "yesterday" }).success,
    ).toBe(false);
  });

  it("rejects a missing required field (mdContentSha)", () => {
    const { mdContentSha: _omit, ...rest } = valid;
    expect(SignedProvenanceStampSchema.safeParse(rest).success).toBe(false);
  });
});
