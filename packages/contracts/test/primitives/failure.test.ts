// FailureVariant taxonomy contract test (task 10.2 contract portion, §16 error
// convention). RED-first: pins the exact 7-member kind set, the schema round-
// trip + unknown-kind rejection, the `failure()` constructor, and the CRITICAL
// redaction-safety property — a FailureVariant carries NO raw-content-shaped
// field (only kind/message/retryable + an OPTIONAL cause.code). PURE — no
// app/adapter imports.
import { describe, it, expect, expectTypeOf } from "vitest";
import { z } from "zod";
import {
  FailureVariantKind,
  failureVariantKindSchema,
  failureVariantSchema,
  failure,
} from "../../src/primitives/failure";
import type { FailureVariant, FailureVariantKind as FailureVariantKindType } from "../../src/primitives/failure";

// The frozen 7-member operation-result taxonomy (§16). Cross-subsystem
// consumers can't drift this set — every subsystem returns one of these inside
// a Result<T, FailureVariant>.
const EXPECTED_KINDS = [
  "validation_rejected",
  "provider_failed",
  "budget_exceeded",
  "connector_unreachable",
  "write_conflict",
  "schema_rejected",
  "degraded_unavailable",
] as const;

describe("FailureVariantKind — exact 7-member taxonomy (§16)", () => {
  it("lists exactly its declared members, in order", () => {
    expect([...FailureVariantKind]).toEqual(EXPECTED_KINDS);
    expect([...failureVariantKindSchema.options]).toEqual(EXPECTED_KINDS);
  });

  it("accepts every declared kind and rejects an unknown kind", () => {
    for (const k of EXPECTED_KINDS) {
      expect(failureVariantKindSchema.safeParse(k).success, `kind ${k} should parse`).toBe(true);
    }
    expect(failureVariantKindSchema.safeParse("meltdown").success).toBe(false);
    expect(failureVariantKindSchema.safeParse("").success).toBe(false);
  });

  it("infers a union type equal to the tuple members", () => {
    expectTypeOf<FailureVariantKindType>().toEqualTypeOf<(typeof EXPECTED_KINDS)[number]>();
  });
});

describe("failureVariantSchema — round-trip + rejection", () => {
  const validNoCause = {
    kind: "provider_failed",
    message: "provider timed out",
    retryable: true,
  } as const;

  const validWithCause = {
    kind: "schema_rejected",
    message: "candidate failed the schema gate",
    retryable: false,
    cause: { code: "AJV_ADDITIONAL_PROPERTIES" },
  } as const;

  it("round-trips a valid variant WITHOUT a cause", () => {
    const parsed = failureVariantSchema.parse(validNoCause);
    expect(parsed).toEqual(validNoCause);
  });

  it("round-trips a valid variant WITH cause.code", () => {
    const parsed = failureVariantSchema.parse(validWithCause);
    expect(parsed).toEqual(validWithCause);
  });

  it("rejects an unknown kind", () => {
    expect(
      failureVariantSchema.safeParse({ ...validNoCause, kind: "meltdown" }).success,
    ).toBe(false);
  });

  it("rejects a missing required field (message)", () => {
    const { message: _omit, ...noMessage } = validNoCause;
    expect(failureVariantSchema.safeParse(noMessage).success).toBe(false);
  });

  it("rejects an empty/whitespace message (non-empty)", () => {
    expect(failureVariantSchema.safeParse({ ...validNoCause, message: "" }).success).toBe(false);
    expect(failureVariantSchema.safeParse({ ...validNoCause, message: "   " }).success).toBe(false);
  });

  it("rejects a non-boolean retryable", () => {
    expect(
      failureVariantSchema.safeParse({ ...validNoCause, retryable: "yes" }).success,
    ).toBe(false);
  });

  it("rejects an empty cause.code", () => {
    expect(
      failureVariantSchema.safeParse({ ...validWithCause, cause: { code: "" } }).success,
    ).toBe(false);
  });
});

// CRITICAL — redaction safety. FailureVariant must carry NO raw error object,
// NO stack trace, NO prompt, NO raw content: only kind/message/retryable and an
// OPTIONAL cause whose ONLY member is a stable `code` string. `.strict()`
// enforces this at runtime; the type-level assertions pin it at compile time.
describe("FailureVariant — redaction-safety (no raw-content-shaped field)", () => {
  const valid = {
    kind: "connector_unreachable",
    message: "connector unreachable",
    retryable: true,
  } as const;

  it("rejects an unknown top-level key (.strict — no raw-content smuggling)", () => {
    // Each of these is a raw-content-shaped field a naive error type would leak.
    for (const leak of [
      { stack: "Error: boom\n    at foo (bar.ts:1:1)" },
      { error: new Error("boom") },
      { prompt: "You are a helpful assistant..." },
      { rawContent: "secret employer material" },
      { content: "multi\nline\nraw\ncontent" },
      { cause: { code: "E", stack: "leak" } }, // cause is .strict too — only code
    ]) {
      expect(
        failureVariantSchema.safeParse({ ...valid, ...leak }).success,
        `must reject leak field ${Object.keys(leak).join(",")}`,
      ).toBe(false);
    }
  });

  it("the FailureVariant TYPE has exactly kind/message/retryable/cause? and cause has only code", () => {
    expectTypeOf<FailureVariant>().toEqualTypeOf<{
      kind: FailureVariantKindType;
      message: string;
      retryable: boolean;
      cause?: { code: string };
    }>();
    // cause carries a stable code string ONLY — never a raw Error.
    expectTypeOf<NonNullable<FailureVariant["cause"]>>().toEqualTypeOf<{ code: string }>();
  });
});

describe("failure() constructor", () => {
  it("builds a schema-valid variant from (kind, message) with retryable defaulting to false", () => {
    const f = failure("budget_exceeded", "COST-1 cap hit");
    expect(f).toEqual({ kind: "budget_exceeded", message: "COST-1 cap hit", retryable: false });
    expect(failureVariantSchema.parse(f)).toEqual(f);
  });

  it("threads retryable + cause.code through opts", () => {
    const f = failure("write_conflict", "revision mismatch", {
      retryable: true,
      cause: { code: "REVISION_STALE" },
    });
    expect(f).toEqual({
      kind: "write_conflict",
      message: "revision mismatch",
      retryable: true,
      cause: { code: "REVISION_STALE" },
    });
    expect(failureVariantSchema.parse(f)).toEqual(f);
  });

  it("returns a value assignable to FailureVariant (typed surface)", () => {
    const f: FailureVariant = failure("degraded_unavailable", "feature degraded");
    expectTypeOf(f).toEqualTypeOf<FailureVariant>();
  });

  it("omits cause entirely when not supplied (no undefined-cause key)", () => {
    const f = failure("validation_rejected", "no-inference: owner is TBD");
    expect(Object.prototype.hasOwnProperty.call(f, "cause")).toBe(false);
  });
});
