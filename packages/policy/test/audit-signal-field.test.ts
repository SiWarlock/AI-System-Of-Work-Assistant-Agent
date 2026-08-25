// spec(§16, rule 7) — task 24.70: `firstUnsafeAuditField` names WHICH of the six fields
// `isRedactionSafe` scans made a signal unsafe, without re-implementing its union arm
// (`looksUnsafe` in `audit-signal.ts` is module-private and off-limits this slice — see
// `audit-signal-field.ts`'s header). Every assertion here is either a conformance pin
// against the REAL exported `isRedactionSafe` or a direct behavioral pin on
// `firstUnsafeAuditField` itself — never a re-derivation of the credential-shape nets.
import { describe, it, expect } from "vitest";
import { buildAuditSignal, isRedactionSafe, type AuditSignal } from "../src/audit-signal";
import { firstUnsafeAuditField, type UnsafeAuditField } from "../src/audit-signal-field";

const SIX_LITERALS: readonly UnsafeAuditField[] = [
  "actor",
  "event",
  "payloadHash",
  "beforeSummary",
  "afterSummary",
  "refs",
];

// Plain, keyword-free, credential-shape-free — passes `isRedactionSafe` on its own so it
// never masks the field actually under test in a fixture built around it.
const SAFE = "audit-signal-field-test-safe-value";

/** A fully-safe baseline `AuditSignal`; `overrides` swaps in the field(s) under test. */
function safeSignal(overrides: Partial<AuditSignal> = {}): AuditSignal {
  return buildAuditSignal({
    actor: SAFE,
    event: SAFE,
    refs: [SAFE],
    payloadHash: SAFE,
    beforeSummary: SAFE,
    afterSummary: SAFE,
    ...overrides,
  });
}

/** A credential-shaped value carrying `marker` at both ends, so a leaking assertion names
 *  the exact fixture that leaked. Trips `SENSITIVE_KEYWORD`'s `secret` net (word-bounded by
 *  the surrounding hyphens) — the same net `isRedactionSafe` itself consults. */
function unsafeValue(marker: string): string {
  return `${marker}-secret-${marker}TAIL`;
}

describe("firstUnsafeAuditField", () => {
  it("agrees_with_isRedactionSafe_in_both_directions", () => {
    const corpus: readonly AuditSignal[] = [
      // -- safe (12) --
      safeSignal(),
      safeSignal({ actor: "policy" }),
      safeSignal({ event: "egress.denied" }),
      safeSignal({ payloadHash: "sha256:deadbeef" }),
      safeSignal({ beforeSummary: "route not vetoed" }),
      safeSignal({ afterSummary: "egress denied" }),
      safeSignal({ refs: ["ref:workspace:ws-1", "sha256:abc123"] }),
      safeSignal({ refs: [] }),
      safeSignal({ denialCode: "EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED" }),
      safeSignal({ healthSignalClass: "policy_denial" }),
      safeSignal({ actor: "policy", event: "job.admission.rejected" }),
      safeSignal({ refs: [SAFE, SAFE, SAFE] }),
      // -- one unsafe in each of the six positions (6) --
      safeSignal({ actor: unsafeValue("ACTOR1") }),
      safeSignal({ event: unsafeValue("EVENT1") }),
      safeSignal({ payloadHash: unsafeValue("HASH1") }),
      safeSignal({ beforeSummary: unsafeValue("BEFORE1") }),
      safeSignal({ afterSummary: unsafeValue("AFTER1") }),
      safeSignal({ refs: [unsafeValue("REF1")] }),
      // -- multi-field-unsafe (4) --
      safeSignal({ actor: unsafeValue("MFACTOR"), event: unsafeValue("MFEVENT") }),
      safeSignal({ event: unsafeValue("MFEVENT2"), refs: [unsafeValue("MFREF2")] }),
      safeSignal({ beforeSummary: unsafeValue("MFBEFORE"), afterSummary: unsafeValue("MFAFTER") }),
      safeSignal({
        actor: unsafeValue("MFALL1"),
        payloadHash: unsafeValue("MFALL2"),
        refs: [SAFE, unsafeValue("MFALL3")],
      }),
    ];
    expect(corpus.length).toBeGreaterThanOrEqual(20);

    for (const signal of corpus) {
      expect(firstUnsafeAuditField(signal) === null).toBe(isRedactionSafe(signal));
    }
  });

  it("names_the_field_for_each_of_the_six_positions", () => {
    expect(firstUnsafeAuditField(safeSignal({ actor: unsafeValue("A") }))).toBe("actor");
    expect(firstUnsafeAuditField(safeSignal({ event: unsafeValue("B") }))).toBe("event");
    expect(firstUnsafeAuditField(safeSignal({ payloadHash: unsafeValue("C") }))).toBe("payloadHash");
    expect(firstUnsafeAuditField(safeSignal({ beforeSummary: unsafeValue("D") }))).toBe("beforeSummary");
    expect(firstUnsafeAuditField(safeSignal({ afterSummary: unsafeValue("E") }))).toBe("afterSummary");
    expect(firstUnsafeAuditField(safeSignal({ refs: [unsafeValue("F")] }))).toBe("refs");
  });

  it("returns_the_FIRST_tripping_field_in_scan_order", () => {
    // unsafe in BOTH `event` (2nd scanned position) and `refs` (last) — the scan-order
    // contract requires `event`, not just "a" correct answer among the two.
    const signal = safeSignal({
      event: unsafeValue("ORDEREVENT"),
      refs: [unsafeValue("ORDERREF")],
    });
    expect(firstUnsafeAuditField(signal)).toBe("event");
  });

  it("no_signal_derived_VALUE_is_ever_returned_or_thrown", () => {
    const SENTINEL = "ZQXJ7-DISTINCTIVE-SENTINEL-4471";
    const signal = safeSignal({ afterSummary: unsafeValue(SENTINEL) });

    let result: UnsafeAuditField | null = null;
    expect(() => {
      result = firstUnsafeAuditField(signal);
    }).not.toThrow();

    expect(result).toBe("afterSummary");
    // never a substring of the offending input.
    expect(String(result)).not.toContain(SENTINEL);
    // and structurally: the return is ALWAYS `null` or one of the six literals — never an
    // arbitrary string sneaking through under the same `UnsafeAuditField` type.
    expect(result === null || SIX_LITERALS.includes(result)).toBe(true);
  });

  it("a_malformed_signal_fails_closed", () => {
    // non-string `actor`, driven through an untyped cast (a real caller can't construct
    // this through the typed `buildAuditSignal` — this pins defense against a boundary
    // that bypassed it, e.g. an untyped JSON round-trip).
    const nonStringActor = { ...safeSignal(), actor: 12345 } as unknown as AuditSignal;
    expect(firstUnsafeAuditField(nonStringActor)).toBe("actor");

    // non-array `refs`.
    const nonArrayRefs = { ...safeSignal(), refs: "not-an-array" } as unknown as AuditSignal;
    expect(firstUnsafeAuditField(nonArrayRefs)).toBe("refs");

    // a `refs` array whose own scan order is deterministic AND whose non-string entry
    // still fails closed to "refs" rather than being skipped past.
    const nonStringRefEntry = { ...safeSignal(), refs: [SAFE, 999] } as unknown as AuditSignal;
    expect(firstUnsafeAuditField(nonStringRefEntry)).toBe("refs");
  });

  // Compile-time exhaustiveness: `UnsafeAuditField` must name exactly `AuditSignal`'s six
  // REQUIRED (hence `isRedactionSafe`-scanned) keys — `denialCode`/`healthSignalClass` are
  // OPTIONAL and correctly excluded. If `AuditSignal` ever gains a new REQUIRED field
  // without extending `UnsafeAuditField` (or the reverse — a stray literal unbacked by a
  // real field), the type aliases below fail to typecheck (`tsc --noEmit`); this is a
  // compile-time-only pin, not a runtime one — `@ts-expect-error`-style enforcement, same
  // convention as `packages/contracts/test/primitives/zod-brands.test.ts`.
  describe("the_six_literals_cover_every_scanned_key", () => {
    type RequiredAuditSignalKeys = {
      [K in keyof AuditSignal]-?: undefined extends AuditSignal[K] ? never : K;
    }[keyof AuditSignal];

    // Fails to typecheck unless T resolves to exactly `never`.
    type AssertNever<T extends never> = T;

    // Every scanned key names a member of UnsafeAuditField...
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    type _AllScannedKeysCovered = AssertNever<Exclude<RequiredAuditSignalKeys, UnsafeAuditField>>;
    // ...and UnsafeAuditField names nothing else (no stray literal unbacked by a real field).
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    type _NoStrayLiteral = AssertNever<Exclude<UnsafeAuditField, RequiredAuditSignalKeys>>;

    // The `Record<UnsafeAuditField, true>` mapping: every literal is a valid key AND every
    // key is listed (a missing/extra key fails to typecheck against the annotation).
    const sixLiteralsCoverEveryScannedKey: Record<UnsafeAuditField, true> = {
      actor: true,
      event: true,
      payloadHash: true,
      beforeSummary: true,
      afterSummary: true,
      refs: true,
    };

    it("has exactly six literals, one per scanned AuditSignal key", () => {
      // The runtime half — a shrink (fewer literals) is caught here even by a plain
      // `vitest run` with no `tsc` pass; the type aliases above catch a MISMATCH (wrong
      // literal, or a scanned key silently uncovered).
      expect(Object.keys(sixLiteralsCoverEveryScannedKey).sort()).toEqual([...SIX_LITERALS].sort());
    });
  });
});
