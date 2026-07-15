// SourceEnvelope contract test (task 1.8, §3/§8/§9). RED-first schema-snapshot
// freeze + behavior coverage. Mirrors the EgressPolicy canonical template. PURE
// — no app/adapter imports. Pins the ingestion source-register seam: a source is
// scoped-before-durable (workspaceId required, REQ-F-002) and dedupe-keyed (a
// deterministic non-empty contentHash, Flow 4 dedupe-hit).
import { describe, expect, it } from "vitest";
import { SourceEnvelopeSchema, SOURCE_ENVELOPE_SCHEMA_ID } from "../../src/models/source-envelope";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";
import { UiSafeIngestionItemSchema, UI_SAFE_ALLOWLIST } from "../../src/api/ui-safe";

// Canonical valid fixture (first source adapter is YouTube — OQ-011). Reused and
// spread-overridden by the negative cases so each test perturbs ONE field.
const VALID = {
  sourceId: "src-yt-abc123",
  workspaceId: "ws-personal",
  origin: "https://www.youtube.com/watch?v=abc123",
  contentHash: "sha256:deadbeefcafe",
  type: "youtube_video",
  sensitivity: "public",
  routingHints: { workspaceHint: "personal-business", projectHint: "sow" },
} as const;

describe("SourceEnvelope contract — spec(§3/§8/§9)", () => {
  // ── Frozen field-name set (the spec, hand-authored in __snapshots__) ──────
  it("freezes its top-level field-name set to the spec snapshot", () => {
    expect(fieldSet(emitJsonSchema(SourceEnvelopeSchema, SOURCE_ENVELOPE_SCHEMA_ID))).toEqual(
      loadFieldSnapshot("source-envelope"),
    );
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ─
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/source-envelope.schema.json", import.meta.url),
      emitJsonSchema(SourceEnvelopeSchema, SOURCE_ENVELOPE_SCHEMA_ID),
    );
  });

  // ── Behaviors ────────────────────────────────────────────────────────────
  it("accepts a fully-populated valid envelope", () => {
    expect(SourceEnvelopeSchema.safeParse(VALID).success).toBe(true);
  });

  it("accepts an empty routingHints record (open record, boundary)", () => {
    expect(SourceEnvelopeSchema.safeParse({ ...VALID, routingHints: {} }).success).toBe(true);
  });

  it("accepts arbitrary nested values in routingHints (open record, arch_gap)", () => {
    const ok = SourceEnvelopeSchema.safeParse({
      ...VALID,
      routingHints: { nested: { a: 1 }, list: [1, 2, 3], flag: true },
    });
    expect(ok.success).toBe(true);
  });

  it("rejects an unknown top-level key (.strict)", () => {
    expect(SourceEnvelopeSchema.safeParse({ ...VALID, extra: "nope" }).success).toBe(false);
  });

  // ── REQ-F-002: scoped-before-durable — workspaceId is required + non-empty ──
  it("rejects a missing workspaceId (REQ-F-002 scoped-before-durable)", () => {
    const { workspaceId: _omit, ...noWorkspace } = VALID;
    expect(SourceEnvelopeSchema.safeParse(noWorkspace).success).toBe(false);
  });

  it("rejects an empty/whitespace workspaceId (branded non-empty)", () => {
    expect(SourceEnvelopeSchema.safeParse({ ...VALID, workspaceId: "   " }).success).toBe(false);
  });

  it("rejects an empty/whitespace sourceId (branded non-empty)", () => {
    expect(SourceEnvelopeSchema.safeParse({ ...VALID, sourceId: "" }).success).toBe(false);
  });

  // ── Dedupe key (Flow 4): contentHash must be a non-empty deterministic string ─
  it("rejects an empty contentHash (dedupe key must be non-empty)", () => {
    expect(SourceEnvelopeSchema.safeParse({ ...VALID, contentHash: "" }).success).toBe(false);
  });

  it("rejects a non-string contentHash", () => {
    expect(SourceEnvelopeSchema.safeParse({ ...VALID, contentHash: 12345 }).success).toBe(false);
  });

  it("rejects an empty origin (uri/source must be non-empty)", () => {
    expect(SourceEnvelopeSchema.safeParse({ ...VALID, origin: "" }).success).toBe(false);
  });

  it("rejects an empty type (open string, but non-empty)", () => {
    expect(SourceEnvelopeSchema.safeParse({ ...VALID, type: "" }).success).toBe(false);
  });

  it("rejects an empty sensitivity (open string, but non-empty)", () => {
    expect(SourceEnvelopeSchema.safeParse({ ...VALID, sensitivity: "" }).success).toBe(false);
  });

  it("rejects a non-object routingHints (open record, but must be an object)", () => {
    expect(SourceEnvelopeSchema.safeParse({ ...VALID, routingHints: "personal" }).success).toBe(
      false,
    );
  });

  it("rejects a missing required field (contentHash)", () => {
    const { contentHash: _omit, ...noHash } = VALID;
    expect(SourceEnvelopeSchema.safeParse(noHash).success).toBe(false);
  });

  it("rejects a missing required field (routingHints)", () => {
    const { routingHints: _omit, ...noHints } = VALID;
    expect(SourceEnvelopeSchema.safeParse(noHints).success).toBe(false);
  });

  // ── 15.2 — additive `body` field (candidate extracted source text) ─────────
  // Threads the real source content past registration so 15.3's note projection
  // builds a real note body from the validated extraction (vs the "source
  // ingestion (C1)" placeholder). OPTIONAL + additive (Lesson 15 — a required
  // field would drop every existing source; nothing emits body yet), gate-
  // validated (candidate data: a string if present, never trusted-through), and
  // format-OPAQUE (the producer / 15.3 defines any constraint — avoid a re-freeze).
  describe("15.2 — additive `body` field — spec(§19.2/§8)", () => {
    it("accepts an optional body (candidate extracted text) — spec(§19.2)", () => {
      const parsed = SourceEnvelopeSchema.safeParse({
        ...VALID,
        body: "line one\nline two — extracted transcript text",
      });
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.body).toBe("line one\nline two — extracted transcript text");
      }
    });

    it("accepts an empty-string body (opaque format — an empty extraction is representable)", () => {
      expect(SourceEnvelopeSchema.safeParse({ ...VALID, body: "" }).success).toBe(true);
    });

    it("validates WITHOUT body — additive/optional, no existing source dropped (Lesson 15)", () => {
      // VALID carries no `body`; it must still parse (with body === undefined on
      // the output), and `body` must NOT appear in the generated schema's
      // `required` set — a required body would drop every source registered
      // before a producer threads it.
      const parsed = SourceEnvelopeSchema.safeParse(VALID);
      expect(parsed.success).toBe(true);
      if (parsed.success) expect(parsed.data.body).toBeUndefined();
      const schema = emitJsonSchema(SourceEnvelopeSchema, SOURCE_ENVELOPE_SCHEMA_ID);
      expect(schema["required"]).not.toContain("body");
    });

    it("freezes body into the snapshot field-set (deliberate ADR-008 add — Lesson 2)", () => {
      expect(loadFieldSnapshot("source-envelope")).toContain("body");
      expect(fieldSet(emitJsonSchema(SourceEnvelopeSchema, SOURCE_ENVELOPE_SCHEMA_ID))).toContain(
        "body",
      );
    });

    it("does NOT leak body through the UiSafeIngestionItem embedder (explicit field-PICK — Lesson 15)", () => {
      // The §9.7 ingestion-inbox projection is an INDEPENDENT hand-authored
      // .strict() field-PICK (sourceId/type/sensitivity/summary) — NOT a spread
      // of SourceEnvelopeSchema — so adding body upstream cannot surface it here.
      expect(UI_SAFE_ALLOWLIST.ingestion).not.toContain("body");
      const uiSafeRow = {
        sourceId: "src-yt-abc123",
        type: "youtube_video",
        sensitivity: "public",
        summary: "A parked source",
      };
      expect(UiSafeIngestionItemSchema.safeParse(uiSafeRow).success).toBe(true);
      expect(UiSafeIngestionItemSchema.safeParse({ ...uiSafeRow, body: "raw text" }).success).toBe(
        false,
      );
    });

    it("gate-validates body as a string — a non-string body is rejected, not trusted-through", () => {
      expect(SourceEnvelopeSchema.safeParse({ ...VALID, body: 12345 }).success).toBe(false);
      expect(SourceEnvelopeSchema.safeParse({ ...VALID, body: { text: "x" } }).success).toBe(false);
    });
  });

  // ── No conditional cross-field invariant ──────────────────────────────────
  // Appendix A specifies SourceEnvelope as seven flat required fields with no
  // IFF/coupling between them, so the model carries NO `.refine()` — there is no
  // conditional-invariant pass/fail pair to assert (vacuously satisfied).
});
