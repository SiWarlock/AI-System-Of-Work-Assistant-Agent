// 10.2 — error-handling convention: typed-Result failure taxonomy +
// nothing-fails-silently routing (§16 error convention). `routeFailure` is a
// PURE, TOTAL function over the FROZEN 7-member `FailureVariantKind` set: every
// variant routes to retry AND/OR the write-outbox (operational store, P2)
// AND/OR a `FailureClass` System-Health item (task 10.3). The load-bearing
// invariant is TOTALITY: no variant routes to nowhere. These tests are the RED
// surface — exhaustive over all 7 kinds, the totality assertion, and the
// variant→FailureClass mapping pinned against the frozen enums.
import { describe, it, expect } from "vitest";
import {
  FailureVariantKind,
  FailureClass,
  failure,
  failureClassSchema,
} from "@sow/contracts";
import type { FailureVariant } from "@sow/contracts";
import { routeFailure } from "../../src/error-routing/route-failure";
import type { FailureRoute } from "../../src/error-routing/route-failure";

// A tiny helper: build a minimal valid variant of a given kind.
const variantOf = (kind: (typeof FailureVariantKind)[number]): FailureVariant =>
  failure(kind, `synthetic ${kind}`);

describe("routeFailure — per-variant destinations (exhaustive over the frozen 7)", () => {
  it("validation_rejected → not retryable, not outbox, health=schema_rejection", () => {
    const r = routeFailure(variantOf("validation_rejected"));
    expect(r.retryable).toBe(false);
    expect(r.toOutbox).toBe(false);
    expect(r.healthClass).toBe("schema_rejection");
  });

  it("provider_failed → retryable, not outbox, no health class (retry-only)", () => {
    const r = routeFailure(variantOf("provider_failed"));
    expect(r.retryable).toBe(true);
    expect(r.toOutbox).toBe(false);
    expect(r.healthClass).toBeUndefined();
  });

  it("budget_exceeded → not retryable, not outbox, health=budget_breach", () => {
    const r = routeFailure(variantOf("budget_exceeded"));
    expect(r.retryable).toBe(false);
    expect(r.toOutbox).toBe(false);
    expect(r.healthClass).toBe("budget_breach");
  });

  it("connector_unreachable → retryable, outbox, health=connector_unreachable", () => {
    const r = routeFailure(variantOf("connector_unreachable"));
    expect(r.retryable).toBe(true);
    expect(r.toOutbox).toBe(true);
    expect(r.healthClass).toBe("connector_unreachable");
  });

  it("write_conflict → retryable, outbox, no health class (retry/outbox-only)", () => {
    const r = routeFailure(variantOf("write_conflict"));
    expect(r.retryable).toBe(true);
    expect(r.toOutbox).toBe(true);
    expect(r.healthClass).toBeUndefined();
  });

  it("schema_rejected → not retryable, not outbox, health=schema_rejection", () => {
    const r = routeFailure(variantOf("schema_rejected"));
    expect(r.retryable).toBe(false);
    expect(r.toOutbox).toBe(false);
    expect(r.healthClass).toBe("schema_rejection");
  });

  it("degraded_unavailable → retryable, not outbox, health=worker_down", () => {
    const r = routeFailure(variantOf("degraded_unavailable"));
    expect(r.retryable).toBe(true);
    expect(r.toOutbox).toBe(false);
    expect(r.healthClass).toBe("worker_down");
  });
});

describe("routeFailure — totality invariant (nothing fails silently)", () => {
  it("routes a defined destination for EVERY frozen FailureVariantKind", () => {
    // Exhaustive coverage: every kind in the frozen tuple gets a route.
    for (const kind of FailureVariantKind) {
      const r = routeFailure(variantOf(kind));
      expect(r).toBeDefined();
    }
  });

  it("no variant routes to nowhere: each is retryable OR outbox OR a health item", () => {
    for (const kind of FailureVariantKind) {
      const r = routeFailure(variantOf(kind));
      const surfacesSomewhere =
        r.retryable === true || r.toOutbox === true || r.healthClass !== undefined;
      expect(surfacesSomewhere).toBe(true);
    }
  });

  it("covers the frozen 7-member kind set exactly (no drift in the tuple)", () => {
    expect([...FailureVariantKind].sort()).toEqual(
      [
        "budget_exceeded",
        "connector_unreachable",
        "degraded_unavailable",
        "provider_failed",
        "schema_rejected",
        "validation_rejected",
        "write_conflict",
      ].sort(),
    );
  });
});

describe("routeFailure — variant→FailureClass mapping matches the frozen enums", () => {
  it("every emitted healthClass is a member of the frozen FailureClass enum", () => {
    for (const kind of FailureVariantKind) {
      const r = routeFailure(variantOf(kind));
      if (r.healthClass !== undefined) {
        // Frozen-enum membership: parse must accept it.
        expect(failureClassSchema.safeParse(r.healthClass).success).toBe(true);
        expect(FailureClass).toContain(r.healthClass);
      }
    }
  });

  it("pins the exact variant→health mapping (in sync with the taxonomies)", () => {
    const mapping: Record<
      (typeof FailureVariantKind)[number],
      FailureRoute["healthClass"]
    > = {
      validation_rejected: "schema_rejection",
      provider_failed: undefined,
      budget_exceeded: "budget_breach",
      connector_unreachable: "connector_unreachable",
      write_conflict: undefined,
      schema_rejected: "schema_rejection",
      degraded_unavailable: "worker_down",
    };
    for (const kind of FailureVariantKind) {
      expect(routeFailure(variantOf(kind)).healthClass).toBe(mapping[kind]);
    }
  });

  it("the two retry/outbox-only variants carry no health class but still route somewhere", () => {
    for (const kind of ["provider_failed", "write_conflict"] as const) {
      const r = routeFailure(variantOf(kind));
      expect(r.healthClass).toBeUndefined();
      expect(r.retryable === true || r.toOutbox === true).toBe(true);
    }
  });
});

describe("routeFailure — determinism (pure, replay-safe)", () => {
  it("identical input yields identical route (no clock/random/I-O)", () => {
    for (const kind of FailureVariantKind) {
      const v = variantOf(kind);
      expect(routeFailure(v)).toEqual(routeFailure(v));
    }
  });

  it("routes solely on `kind` — message/cause/retryable-on-the-variant are ignored", () => {
    const a = failure("connector_unreachable", "one", { retryable: false });
    const b = failure("connector_unreachable", "two different message", {
      retryable: true,
      cause: { code: "SOCKET_TIMEOUT" },
    });
    expect(routeFailure(a)).toEqual(routeFailure(b));
  });
});
