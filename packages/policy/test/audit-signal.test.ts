// spec(§5) — AuditSignal: clock-free build for allow+deny; redaction-safety guard; toAuditRecordInput passes AuditRecordSchema.parse
import { describe, it, expect } from "vitest";
import { AuditRecordSchema } from "@sow/contracts";
import { looksUnsafe as domainLooksUnsafe } from "@sow/domain";
import {
  buildAuditSignal,
  toAuditRecordInput,
  isRedactionSafe,
  assertRedactionSafe,
  POLICY_DENIAL_HEALTH_CLASS,
  type AuditSignal,
} from "../src/audit-signal";

const base = {
  actor: "policy",
  event: "egress.evaluated",
  refs: ["ref:workspace:ws-1", "sha256:deadbeef"],
  payloadHash: "sha256:cafe",
  beforeSummary: "egress not evaluated",
  afterSummary: "egress allowed to local processor",
};

describe("buildAuditSignal", () => {
  it("produces a clock-free signal for an ALLOW outcome (no denialCode)", () => {
    const sig = buildAuditSignal(base);
    expect(sig.actor).toBe("policy");
    expect(sig.denialCode).toBeUndefined();
    expect("occurredAt" in sig).toBe(false);
    expect("recordedAt" in sig).toBe(false);
  });

  it("produces a signal for a DENY outcome carrying the denialCode + health class", () => {
    const sig = buildAuditSignal({
      ...base,
      event: "egress.denied",
      denialCode: "EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED",
      healthSignalClass: POLICY_DENIAL_HEALTH_CLASS,
    });
    expect(sig.denialCode).toBe("EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED");
    expect(sig.healthSignalClass).toBe(POLICY_DENIAL_HEALTH_CLASS);
  });
});

describe("isRedactionSafe / assertRedactionSafe", () => {
  it("accepts a signal carrying only refs / hashes / codes", () => {
    expect(isRedactionSafe(buildAuditSignal(base))).toBe(true);
    expect(() => assertRedactionSafe(buildAuditSignal(base))).not.toThrow();
  });

  it("rejects a signal whose summary carries raw content", () => {
    const leaky = buildAuditSignal({
      ...base,
      afterSummary: "user said: my password is hunter2 and the deal terms are...",
    });
    expect(isRedactionSafe(leaky)).toBe(false);
  });

  it("rejects a signal carrying a credential-shaped token", () => {
    const leaky = buildAuditSignal({
      ...base,
      refs: ["sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH"],
    });
    expect(isRedactionSafe(leaky)).toBe(false);
  });
});

// task 24.45 — isRedactionSafe is a keyword/prefix/URL-userinfo HEURISTIC, not a
// shape allowlist. These pin what it does and does NOT catch, so the enumeration on
// the function can state something true rather than inherited (`L82`).
describe("isRedactionSafe — the heuristic's stated limits (task 24.45)", () => {
  it("redaction_heuristic_admits_a_sensitive_non_credential_string: a sensitive-but-not-credential-shaped ref PASSES [spec(§16)]", () => {
    const sig = buildAuditSignal({
      ...base,
      refs: ["ref:workspace:ws-employer-projectatlas-acquisition"],
    });
    // GREEN by design, before and after. Documents WHY the remedy is validate-at-the-
    // producer, not a tighter heuristic: a shape allowlist here would invert
    // packages/knowledge secret-scan.ts's contentContainsSecret (`!isRedactionSafe`),
    // which gates the KnowledgeWriter pre-commit scan on the sole-writer path.
    expect(isRedactionSafe(sig)).toBe(true);
  });

  it("redaction_safe_still_admits_the_legitimate_ref_shapes: production templates, markers and sentinels all pass [spec(§16)]", () => {
    const sig = buildAuditSignal({
      ...base,
      refs: [
        "ref:workspace:ws-1",
        "ref:job:job-123",
        "ref:capability:extraction",
        "sha256:deadbeef",
        "policy:visibility-decision",
        "ref:workspace:MISSING",
        "ref:workspace:UNVALIDATED",
        "ref:visibility:isolated",
      ],
    });
    // The over-tight-fix control (`L80`): a change that rejects real production ref
    // shapes would fail closed across every producer in the repo.
    expect(isRedactionSafe(sig)).toBe(true);
  });
});

describe("toAuditRecordInput", () => {
  it("produces an object AuditRecordSchema.parse accepts (impure caller supplies occurredAt)", () => {
    const sig: AuditSignal = buildAuditSignal(base);
    const record = toAuditRecordInput(sig, "2026-01-01T00:00:00.000Z");
    expect(() => AuditRecordSchema.parse(record)).not.toThrow();
    const parsed = AuditRecordSchema.parse(record);
    expect(parsed.timestamps.occurredAt).toBe("2026-01-01T00:00:00.000Z");
    expect(parsed.actor).toBe("policy");
  });
});

// ── task 24.110 — packages/policy's CREDENTIAL_PREFIX lost the `/i` flag ───────
// The local copy was CHARACTER-IDENTICAL to @sow/domain's and differed ONLY in the
// trailing `/i`, so a case-transformed credential shape passed a gate that reaches the
// KnowledgeWriter's BLOCKING pre-commit secret scan (packages/knowledge's
// secret-scan.ts -> writer.ts step 6, production-wired at three composition sites) on
// the sole-writer path — safety rule 7, and rule 1 by reach.
//
// SCOPE (orchestrator ruling, this slice): the `/i` fix ONLY. Delegating this module to
// @sow/domain's `looksUnsafe` is DEFERRED and BLOCKED on task 24.120 — domain's
// `stripMarkers` can DESTROY a match (it substitutes a space, and every
// URL_USERINFO_CREDENTIAL character class excludes whitespace), so delegating would
// newly hand a demonstrated loosening to the one path that made 24.110 urgent.
const refSignal = (value: string): AuditSignal =>
  buildAuditSignal({ ...base, refs: [value] });

// Case-transformed credential shapes: the population the missing `/i` admitted.
// ADMISSIBILITY CONSTRAINT (all three arrays below): a member must have the SAME verdict
// in @sow/domain as here, because `policy_and_domain_agree_on_the_credential_shape_axis`
// iterates all three. A marker-carrying or URL-userinfo value diverges by design (see the
// task 24.120 pin at the end of this block) and MUST NOT be added to these arrays — doing
// so breaks that pin spuriously, and the tempting repair is to weaken it.
const CASE_TRANSFORMED_CREDENTIALS: readonly string[] = [
  "SK-ANT-API03-ABCDEF",
  "XOXB-123456789012",
  "GHP_ABCDEFGHIJKLMNOPQRST",
  "-----Begin Certificate-----",
  "AkiaIOSFODNN7EXAMPLE",
  "SK_LIVE_ABCDEF",
  "EYJHBGCIOIJIUZI1NIIS.",
];

// Shapes packages/policy ALREADY refused before 24.110 — the no-regression population.
const ALREADY_REFUSED: readonly string[] = [
  "sk-ant-api03-abcdefghijklmnop",
  "xoxb-123456789012",
  "ghp_abcdefghijklmnopqrst",
  "AKIAIOSFODNN7EXAMPLE",
  "-----BEGIN RSA PRIVATE KEY-----",
];

// Benign values that MUST stay safe — the non-vacuity control. Deliberately uppercase:
// a `/i` fix that over-reached into "any uppercase token is a credential" would pass
// every refusal pin above and be caught ONLY here.
const BENIGN: readonly string[] = [
  "REF:JOB:JOB-123",
  "SHA256:DEADBEEF",
  "POLICY:VISIBILITY-DECISION",
  // NEAR MISSES — each is ONE character from tripping a specific alternative. Without
  // these the control only catches a net widened to match EVERYTHING; with them it
  // catches a net widened by one character, which is the failure mode this slice risks.
  "RISK ASSESSMENT", // space, not `-` => misses sk-[a-z0-9]
  "sk_prod", // not live|test => misses sk_(live|test)
  "xoxo-party", // `o` not in [baprs] => misses xox[baprs]-
  "GHOST_MODE", // `s` where `_` must be => misses gh[pousr]_
  "AKIA1234", // 4 chars, needs 16 => misses AKIA[0-9A-Z]{16}
  "-----BEG", // truncated => misses -----BEGIN
  "eyJshort.", // 5 chars, needs 10+ => misses eyJ[A-Za-z0-9_-]{10,}\.
];

describe("isRedactionSafe — the credential net is case-insensitive (task 24.110)", () => {
  it("an_uppercase_credential_shape_is_refused: a case-transformed credential prefix is NOT redaction-safe [spec(§16)]", () => {
    for (const v of CASE_TRANSFORMED_CREDENTIALS) {
      expect(
        isRedactionSafe(refSignal(v)),
        `${v}: @sow/domain's credential net is case-INSENSITIVE by deliberate design; packages/policy must not disagree about a safety property`,
      ).toBe(false);
      // WHY it was refused, not a bare falsity (task 24.101): the SAME value with its
      // case normalized is refused too => the refusal is driven by the credential SHAPE,
      // not by the casing, and not by some unrelated field of the fixture.
      expect(
        isRedactionSafe(refSignal(v.toLowerCase())),
        `${v} lowercased must be refused for the SAME reason — otherwise this pin is passing on casing rather than on shape`,
      ).toBe(false);
    }
  });

  it("lowercase_credential_shapes_still_refused: everything policy caught before 24.110 it still catches [spec(§16)]", () => {
    // GREEN ON ARRIVAL — the no-regression control. Its job is to catch a fix that
    // REPLACES coverage instead of widening it.
    for (const v of ALREADY_REFUSED) {
      expect(
        isRedactionSafe(refSignal(v)),
        `${v}: refused before 24.110; a regression here means the fix replaced coverage instead of widening it`,
      ).toBe(false);
    }
  });

  it("a_keyword_only_value_is_still_refused: the keyword net still catches what the prefix net cannot [spec(§16)]", () => {
    // The two mechanisms must stay DISTINGUISHABLE so neither silently absorbs the other.
    // NOTE: lowercase PEM no longer separates them — once `/i` lands the PREFIX net also
    // catches `-----begin rsa private key-----`. (That remains defence-in-depth working
    // as designed, not a gap; it just can no longer carry THIS assertion.) The fixture
    // below carries no credential prefix at all, so only the keyword net can refuse it.
    expect(
      isRedactionSafe(refSignal("rotate the api_key before friday")),
      "a value carrying a sensitive KEYWORD but no credential prefix must still be refused",
    ).toBe(false);
    // WHY: strike the keyword and the same sentence passes => the keyword net is what fired.
    expect(
      isRedactionSafe(refSignal("rotate the widgets before friday")),
      "the same sentence WITHOUT a sensitive keyword must pass — otherwise the refusal above proves nothing about the keyword net",
    ).toBe(true);
  });

  it("a_benign_uppercase_value_is_still_safe: the non-vacuity control [spec(§16)]", () => {
    // Without this, a credential net widened to match EVERYTHING passes every pin above.
    for (const v of BENIGN) {
      expect(
        isRedactionSafe(refSignal(v)),
        `${v}: a legitimate production ref shape must stay safe; an over-reaching /i fix fails closed across every producer in the repo (L80)`,
      ).toBe(true);
    }
  });

  it("policy_and_domain_agree_on_the_credential_shape_axis: the drift itself is what is pinned [spec(§16)]", () => {
    // THE DURABLE PIN. Referential identity would only catch a re-copied CONSTANT; this
    // catches a re-forked COMPOSITION too. Scoped to the credential-shape axis, which is
    // the axis 24.110 is about.
    for (const v of [...CASE_TRANSFORMED_CREDENTIALS, ...ALREADY_REFUSED, ...BENIGN]) {
      expect(
        isRedactionSafe(refSignal(v)),
        `${v}: packages/policy and @sow/domain returned DIFFERENT verdicts on a credential shape — a second hand-maintained copy has re-diverged (task 24.46)`,
      ).toBe(!domainLooksUnsafe(v));
    }
  });

  it("known_false_positives_are_pinned_so_the_class_is_not_INVISIBLE: the missing word boundary [spec(§16)]", () => {
    // ⛔ NOT a passing grade — this pins a COST so it cannot be rediscovered as a surprise.
    // `sk-[a-z0-9]` carries NO word boundary, so any word ending in "sk" followed by `-`
    // and an alphanumeric trips the credential net. That class is PRE-EXISTING in the
    // lowercase direction (`task-123` was refused before this slice) and this slice WIDENS
    // it to every casing. Measured by security-reviewer over 612 repo Markdown files:
    // 236 already rejected before the slice, 9 NEWLY rejected by it.
    //
    // This matters because packages/knowledge's secret-scan.ts is REJECT-NOT-REDACT over
    // the WHOLE rendered file on the sole-writer path: a note containing "TASK-1" does not
    // land. Routed to the lead at Step 9; the durable remedy is a word boundary, which is a
    // domain-parity question (@sow/domain carries the identical unbounded alternative).
    for (const v of ["ref:task:TASK-123", "RISK-001", "Full-Disk-Access"]) {
      expect(
        isRedactionSafe(refSignal(v)),
        `${v}: refused as a KNOWN false positive of the unbounded sk- alternative — if this ever goes green the word boundary was added, and this pin should be retired deliberately`,
      ).toBe(false);
    }
  });

  it("the_url_userinfo_axis_still_diverges_and_that_divergence_is_OWNED: task 24.120 [spec(§16)]", () => {
    // NOT papering over a divergence — pinning a FILED one so it cannot drift unnoticed,
    // and so the test above cannot be mistaken for full equivalence.
    //
    // ⛔ PINNED ON THE MECHANISM THAT ACTUALLY BLOCKS DELEGATION, which is NOT the keyword
    // net. @sow/domain's `stripMarkers` substitutes a SPACE, and every
    // URL_USERINFO_CREDENTIAL character class excludes whitespace — so a frozen marker
    // embedded inside a `//user:pass@host` span BREAKS the span and domain STOPS refusing
    // the value. That is the direction where DOMAIN IS LOOSER, and it is the whole reason
    // delegating this module would hand a loosening to the sole-writer path.
    //
    // (The marker/KEYWORD axis diverges too — `[REDACTED:credential]` is refused here and
    // safe in domain — but there policy is STRICTER, which blocks nothing. Pinning that
    // axis would have documented the deferral with a case that does not justify it.)
    //
    // Filed as task 24.120 against @sow/domain, already inherited by packages/providers'
    // redactor and by domain's own redact.ts. When 24.120 is resolved this pin REDS rather
    // than passing silently: the minimal fix (substituting "" instead of " ") leaves
    // `//u:pq@h`, which still matches URL_USERINFO_CREDENTIAL, so domain flips to unsafe
    // and the second assertion fails. Verified as a regex property, not assumed.
    const markerInsideUserinfo = "//u:p[REDACTED:raw]q@h";
    expect(
      isRedactionSafe(refSignal(markerInsideUserinfo)),
      "packages/policy does NOT strip markers, so the //user:pass@ span survives and is refused — deliberate under task 24.120, not an oversight",
    ).toBe(false);
    expect(
      domainLooksUnsafe(markerInsideUserinfo),
      "@sow/domain strips the marker to a SPACE, breaking the userinfo span, and judges the same value SAFE — the loosening task 24.120 owns, and the reason this module does not delegate",
    ).toBe(false);
  });
});
