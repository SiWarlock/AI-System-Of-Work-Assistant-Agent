// spec(§5) — AuditSignal: clock-free build for allow+deny; redaction-safety guard; toAuditRecordInput passes AuditRecordSchema.parse
import { describe, it, expect } from "vitest";
import { AuditRecordSchema, REDACTED_CREDENTIAL, REDACTED_RAW } from "@sow/contracts";
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
// SCOPE (orchestrator ruling, the 24.110 slice): the `/i` fix ONLY. Delegating this module
// to @sow/domain's `looksUnsafe` is still DEFERRED — but NOT for the reason first recorded
// here, and the difference decides whether a future reader thinks the gate has opened.
// THE ORIGINAL BLOCKER WAS task 24.120: domain's `stripMarkers` substituted a SPACE, every
// URL_USERINFO_CREDENTIAL character class excludes whitespace, so a marker inside a
// `//user:pass@host` span BROKE the span and domain stopped refusing the value. THAT AXIS
// CLOSED on 2026-08-18 (24.120) — the filler is now a span-preserving `^`, with the space
// retained as a second fail-safe arm.
// ⛔ THE CURRENT BLOCKER IS task 24.110's deliberately-UNRULED second axis: delegating makes
// policy START STRIPPING, so it STOPS refusing already-redacted content — a loosening on the
// sole-writer path that nobody has ruled on. See the pin at the end of this block.
const refSignal = (value: string): AuditSignal =>
  buildAuditSignal({ ...base, refs: [value] });

// Case-transformed credential shapes: the population the missing `/i` admitted.
// ADMISSIBILITY CONSTRAINT (all three arrays below): a member must have the SAME verdict
// in @sow/domain as here, because `policy_and_domain_agree_on_the_credential_shape_axis`
// iterates all three. A MARKER-CARRYING value diverges by design — see
// `the_marker_axis_still_diverges_and_that_divergence_is_OWNED` at the end of this block —
// and MUST NOT be added to these arrays, because doing so breaks that pin spuriously and the
// tempting repair is to weaken it.
// ⚠ URL-USERINFO VALUES NO LONGER DIVERGE. task 24.120 closed that axis, so they are now
// ADMISSIBLE here. This constraint previously named them alongside markers; leaving that in
// place would have suppressed exactly the cross-module coverage the closure makes possible.
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

  it("the_marker_axis_still_diverges_and_that_divergence_is_OWNED: task 24.110 [spec(§16)]", () => {
    // NOT papering over a divergence — pinning a FILED one so it cannot drift unnoticed, and
    // so `policy_and_domain_agree_on_the_credential_shape_axis` cannot be mistaken for full
    // equivalence between the two modules.
    //
    // NAMED FOR task 24.110, NOT for the narrowing task that last edited it: the name should
    // resolve to the entry that OWNS the divergence and can still change it. 24.128 narrowed
    // this pin and closes with that edit; greping its number later lands a reader on finished
    // work.
    //
    // HISTORY, RETAINED IN PAST TENSE BECAUSE THE REASONING IS STILL LOAD-BEARING AND ONLY
    // THE STATE EXPIRED (L195: striking a block does not tense-shift the sentences inside it).
    // This pin ORIGINALLY asserted the URL-USERINFO axis: @sow/domain's `stripMarkers`
    // substituted a SPACE, every URL_USERINFO_CREDENTIAL character class excludes whitespace,
    // so a frozen marker inside a `//user:pass@host` span BROKE the span and domain STOPPED
    // refusing the value. That was the direction where DOMAIN WAS LOOSER, and it was the whole
    // reason delegating this module would have handed a loosening to the sole-writer path.
    //
    // THAT AXIS CLOSED on 2026-08-18 (task 24.120, commits 65524874 + 8b2b53ac + bf442753):
    // domain now strips to a SPAN-PRESERVING "^" and retains the space substitution as a
    // second, fail-safe arm. `//u:p[REDACTED:raw]q@h` is refused by BOTH modules today, so the
    // old assertion asserted a falsehood and was removed. The pin is NARROWED, not deleted.
    //
    // WHAT THIS PIN GOT RIGHT, AND IT IS THE REASON THE PIN WAS NARROWED RATHER THAN
    // REWRITTEN: it predicted the WRONG REMEDY — its comment said the minimal fix would be
    // substituting "" instead of " " — and the shipped fix was "^" plus a RETAINED space arm.
    // It caught the change anyway, because its MECHANISM prediction held.
    //
    // THE SURVIVING DIVERGENCE, AND WHY IT IS PINNED NOW WHEN IT DELIBERATELY WAS NOT BEFORE:
    // the earlier comment declined to pin the marker/keyword axis because "policy is STRICTER,
    // which blocks nothing" — correct WHEN THE URL AXIS EXISTED, because the pin's job then was
    // to justify a DEFERRAL and a stricter-here case cannot do that. That reason has expired
    // twice over. (1) It is now the only marker divergence, so it is no longer being asked to
    // justify a deferral — it is being asked to keep a real difference from going silent.
    // (2) Task 24.110's lead ruling of 2026-08-18 makes this axis the ACTIVE blocker of the
    // delegation: policy delegating to domain would start STRIPPING and therefore STOP refusing
    // already-redacted content, a LOOSENING on the sole-writer path that nobody has ruled on.
    // A divergence that blocks nothing while two copies coexist becomes the whole behaviour
    // change the moment one delegates to the other.
    //
    // OWNER OF THE SURVIVING DIVERGENCE: task 24.110's deliberately-UNRULED second axis.
    // Stated precisely because "policy stricter blocks nothing today" is exactly the kind of
    // fact that goes stale silently. It is NOT owned by task 24.123 — 24.123 changes the
    // GRANULARITY or the DECISION of the knowledge-side whole-file scan, and neither of those
    // two remedy shapes changes the MARKER pair asserted immediately below.
    //
    // ⛔ THAT SCOPING IS DELIBERATE — IT COVERS THE MARKER PAIR ONLY, AND THE CONTROL PAIR IS
    // A KNOWN EXCEPTION RATHER THAN AN OVERSIGHT. task 24.123 also carries a THIRD item, routed
    // to it from 24.120 by lead ruling: dropping the `private[_ -]?key` matches that exist ONLY
    // because the legacy SPACE is a member of that alternative's alphabet. Under THAT remedy
    // the control pair's domain verdict flips and this test REDS — intended, because the
    // control is a deliberate 24.123 tripwire.
    //
    // ⛔⛔ AND A (C')-SHAPED DELEGATION REDS THIS TEST TOO. READ THIS BEFORE "REPAIRING" THAT
    // RED. (C') is `domain.looksUnsafe(s) || policy_today(s)`. It is monotone in the REFUSAL
    // direction, so every value refused today stays refused — but THIS BLOCK ALSO ASSERTS A
    // *SAFE* VERDICT, AND (C') FLIPS IT: policy would inherit domain's refusal of
    // `private[REDACTED:raw]key`, so the control's `.toBe(true)` fails. THAT RED IS CORRECT AND
    // MUST NOT BE WEAKENED — it is this pin reporting a real behaviour change, which is the
    // entire reason it exists. "Monotone by construction" is a claim about LEAKS and is SILENT
    // about AVAILABILITY: on the reject-not-redact sole-writer path, a note carrying an
    // already-redacted `private[REDACTED:raw]key` would newly have its ENTIRE COMMIT rejected.
    const marker = REDACTED_CREDENTIAL;

    // NON-VACUITY: name the mechanism rather than assume it. policy's SENSITIVE_KEYWORD net
    // fires on the literal word inside the marker; domain never sees it because it strips the
    // marker first.
    // ⚠ WHAT THIS GUARD IS ACTUALLY FOR, because the obvious reading of it is wrong: if the
    // marker lost its keyword ENTIRELY, policy would judge it SAFE and the first assertion
    // below would RED on its own, loudly. The case that would otherwise pass SILENTLY is a swap
    // to a DIFFERENT SENSITIVE_KEYWORD member (say `[REDACTED:secret]`), where both assertions
    // still hold for a reason that is no longer the one documented here.
    expect(
      /\bcredential\b/i.test(marker),
      "the frozen credential marker no longer carries the keyword this divergence rests on — if it swapped to another SENSITIVE_KEYWORD member the assertions below would still pass for a DIFFERENT reason, which is the case this guard exists to catch",
    ).toBe(true);

    expect(
      isRedactionSafe(refSignal(marker)),
      "packages/policy does NOT strip frozen markers, so the marker's own keyword trips SENSITIVE_KEYWORD and already-redacted content is refused — deliberate under task 24.110, not an oversight",
    ).toBe(false);
    expect(
      domainLooksUnsafe(marker),
      "@sow/domain strips the frozen marker before testing, so it judges already-redacted content SAFE — POLICY IS STRICTER on this axis, and that is the behaviour change a delegation would make",
    ).toBe(false);

    // THE CONTROL, AND IT IS THE POINT OF THIS BLOCK: the two predicates could have disagreed
    // in the OTHER direction, and on this fixture they do. Domain's retained legacy-space arm
    // rewrites `private[REDACTED:raw]key` to `private key`, which matches SENSITIVE_KEYWORD's
    // `private[_ -]?key` alternative; policy, which does not strip, sees a 14-character gap and
    // no alternative matches. So DOMAIN is stricter here while POLICY is stricter above.
    // Without this, "policy is stricter" would be one measurement written twice — a direction
    // asserted from a fixture chosen to show it. Recorded on task 24.110 (commit 40bbf578) and
    // stated by redaction-rules.ts about itself.
    //
    // ⚠ GAP, STATED RATHER THAN COVERED: this pair has NO local non-vacuity guard, and it is
    // the pair that needs one more, because its mechanism is scheduled for possible removal by
    // 24.123. It isolates the LEGACY-SPACE arm only while domain's span-preserving filler is
    // NOT a member of `private[_ -]?key`'s alphabet; were that filler ever to become `_` or
    // `-`, the span arm would match on its own and this assertion would keep passing while the
    // tripwire retired SILENTLY. A local guard would need `SPAN_PRESERVING_FILLER` exported
    // from `@sow/domain`, which it is NOT (measured) — adding it is contract territory.
    // What DOES cover it today is cross-package, in `@sow/domain`'s own
    // `test/redaction/marker-filler-property.test.ts`, which rejects `-`, `_` and `.` as
    // fillers. ⛔ That is a real guard in another package, NOT coverage this file provides.
    const spaceManufactured = `private${REDACTED_RAW}key`;
    expect(
      isRedactionSafe(refSignal(spaceManufactured)),
      "packages/policy does not strip, so no alternative spans the marker and the value is SAFE here",
    ).toBe(true);
    expect(
      domainLooksUnsafe(spaceManufactured),
      "@sow/domain's legacy-space arm collapses the marker to a space and matches private[_ -]?key — DOMAIN IS STRICTER on this axis, which is why the divergence is not one-directional",
    ).toBe(true);
  });
});
