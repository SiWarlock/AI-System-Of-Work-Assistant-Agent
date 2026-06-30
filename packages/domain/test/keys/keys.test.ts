// 1.10 — canonical-object-key + idempotency-key builders (PURE, replay-stable).
// These keys are the §8 envelope's identity: canonicalObjectKey gates the
// pre-write existence check (match-by-canonical-key), idempotencyKey gates the
// §20.1 replay dedupe (REQ-NF-006). The load-bearing properties under test:
// deterministic (same logical input -> same key across runs/processes),
// order-independent over identity entries, normalized (trim + field-name case),
// distinct for distinct inputs, opaque + URL/filesystem-safe, and PURE
// (no clock/random/env: repeated calls are byte-identical).
import { describe, it, expect } from "vitest";
import { buildCanonicalObjectKey } from "../../src/keys/canonical-key";
import { buildIdempotencyKey } from "../../src/keys/idempotency-key";
import type { TargetSystem } from "@sow/contracts";

const SAFE = /^[a-z0-9_]+$/; // url + filesystem safe charset (no `:`, `/`, space)

describe("buildCanonicalObjectKey (1.10, §8 pre-write existence check)", () => {
  const ts: TargetSystem = "calendar";

  it("is deterministic: same input -> same key", () => {
    const a = buildCanonicalObjectKey({ targetSystem: ts, identity: { id: "evt-1" } });
    const b = buildCanonicalObjectKey({ targetSystem: ts, identity: { id: "evt-1" } });
    expect(a).toBe(b);
  });

  it("is order-independent over identity entries (sorted keys)", () => {
    const a = buildCanonicalObjectKey({
      targetSystem: ts,
      identity: { calendarId: "cal-9", eventId: "evt-1", attendee: "me" },
    });
    const b = buildCanonicalObjectKey({
      targetSystem: ts,
      identity: { attendee: "me", eventId: "evt-1", calendarId: "cal-9" },
    });
    expect(a).toBe(b);
  });

  it("trims surrounding whitespace on identity keys and values", () => {
    const a = buildCanonicalObjectKey({ targetSystem: ts, identity: { id: "evt-1" } });
    const b = buildCanonicalObjectKey({ targetSystem: ts, identity: { "  id  ": "  evt-1  " } });
    expect(a).toBe(b);
  });

  it("treats identity field NAMES case-insensitively (labels are lowercased)", () => {
    const a = buildCanonicalObjectKey({ targetSystem: ts, identity: { Id: "evt-1" } });
    const b = buildCanonicalObjectKey({ targetSystem: ts, identity: { id: "evt-1" } });
    expect(a).toBe(b);
  });

  it("preserves identity VALUE case (distinct objects stay distinct)", () => {
    const a = buildCanonicalObjectKey({ targetSystem: ts, identity: { id: "Evt-1" } });
    const b = buildCanonicalObjectKey({ targetSystem: ts, identity: { id: "evt-1" } });
    expect(a).not.toBe(b);
  });

  it("differs across targetSystem for the same identity", () => {
    const a = buildCanonicalObjectKey({ targetSystem: "calendar", identity: { id: "x" } });
    const b = buildCanonicalObjectKey({ targetSystem: "github", identity: { id: "x" } });
    expect(a).not.toBe(b);
  });

  it("differs when an identity value changes", () => {
    const a = buildCanonicalObjectKey({ targetSystem: ts, identity: { id: "x" } });
    const b = buildCanonicalObjectKey({ targetSystem: ts, identity: { id: "y" } });
    expect(a).not.toBe(b);
  });

  it("differs when an identity field is added", () => {
    const a = buildCanonicalObjectKey({ targetSystem: ts, identity: { id: "x" } });
    const b = buildCanonicalObjectKey({ targetSystem: ts, identity: { id: "x", repo: "r" } });
    expect(a).not.toBe(b);
  });

  it("has no delimiter-collision ambiguity between entries", () => {
    // {ab:"c"} and {a:"bc"} must NOT collide under the encoding.
    const a = buildCanonicalObjectKey({ targetSystem: ts, identity: { ab: "c" } });
    const b = buildCanonicalObjectKey({ targetSystem: ts, identity: { a: "bc" } });
    expect(a).not.toBe(b);
  });

  it("emits an opaque, url/filesystem-safe key (hostile value chars are absorbed)", () => {
    const key = buildCanonicalObjectKey({
      targetSystem: ts,
      identity: { path: "a/b c:d?e", note: "héllo 漢字 \n\t" },
    });
    expect(key).toMatch(SAFE);
    expect(key.startsWith("cok_")).toBe(true);
    expect(key.length).toBeGreaterThan("cok_".length + 10);
  });
});

describe("buildIdempotencyKey (1.10, §20.1 replay gate, REQ-NF-006)", () => {
  it("is deterministic: a replayed step yields the same key", () => {
    const a = buildIdempotencyKey({ operation: "calendar.create", identity: { id: "evt-1" } });
    const b = buildIdempotencyKey({ operation: "calendar.create", identity: { id: "evt-1" } });
    expect(a).toBe(b);
  });

  it("is order-independent over identity entries", () => {
    const a = buildIdempotencyKey({
      operation: "calendar.create",
      identity: { a: "1", b: "2" },
    });
    const b = buildIdempotencyKey({
      operation: "calendar.create",
      identity: { b: "2", a: "1" },
    });
    expect(a).toBe(b);
  });

  it("normalizes operation (trim + case) and identity field names", () => {
    const a = buildIdempotencyKey({ operation: "  Calendar.Create ", identity: { Id: "x" } });
    const b = buildIdempotencyKey({ operation: "calendar.create", identity: { id: "x" } });
    expect(a).toBe(b);
  });

  it("collides ONLY for a genuinely-identical operation — different op -> different key", () => {
    const a = buildIdempotencyKey({ operation: "calendar.create", identity: { id: "x" } });
    const b = buildIdempotencyKey({ operation: "calendar.update", identity: { id: "x" } });
    expect(a).not.toBe(b);
  });

  it("differs when the operation identity changes", () => {
    const a = buildIdempotencyKey({ operation: "calendar.create", identity: { id: "x" } });
    const b = buildIdempotencyKey({ operation: "calendar.create", identity: { id: "y" } });
    expect(a).not.toBe(b);
  });

  it("emits an opaque, url/filesystem-safe key", () => {
    const key = buildIdempotencyKey({
      operation: "drive.upsert",
      identity: { path: "a/b c:d", x: "漢 \n" },
    });
    expect(key).toMatch(SAFE);
    expect(key.startsWith("idem_")).toBe(true);
    expect(key.length).toBeGreaterThan("idem_".length + 10);
  });
});

describe("cross-builder + purity invariants (1.10)", () => {
  it("canonical and idempotency keys never collide (distinct domains)", () => {
    const c = buildCanonicalObjectKey({ targetSystem: "calendar", identity: { id: "x" } });
    const i = buildIdempotencyKey({ operation: "calendar", identity: { id: "x" } });
    expect(c).not.toBe(i);
  });

  it("is PURE: repeated calls are byte-identical (no clock/random/env entropy)", () => {
    // Cross-"process" stability proxy: a pure builder gives the same output on
    // every invocation. Any hidden Date.now()/Math.random()/env read would
    // surface as drift across these repeated calls.
    const cok = () => buildCanonicalObjectKey({ targetSystem: "github", identity: { repo: "o/r", n: "1" } });
    const idem = () => buildIdempotencyKey({ operation: "github.issue.create", identity: { repo: "o/r", n: "1" } });
    const cokRuns = new Set(Array.from({ length: 5 }, cok));
    const idemRuns = new Set(Array.from({ length: 5 }, idem));
    expect(cokRuns.size).toBe(1);
    expect(idemRuns.size).toBe(1);
  });
});
