// spec(§5) — AuditSignal: clock-free build for allow+deny; redaction-safety guard; toAuditRecordInput passes AuditRecordSchema.parse
import { describe, it, expect } from "vitest";
import { AuditRecordSchema, REDACTED_CREDENTIAL, REDACTED_RAW } from "@sow/contracts";
import {
  looksUnsafe as domainLooksUnsafe,
  SPAN_PRESERVING_FILLER,
  CREDENTIAL_NETS,
  CREDENTIAL_PREFIX as DOMAIN_CREDENTIAL_PREFIX,
  SENSITIVE_KEYWORD as DOMAIN_SENSITIVE_KEYWORD,
  URL_USERINFO_CREDENTIAL as DOMAIN_URL_USERINFO_CREDENTIAL,
} from "@sow/domain";
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
    // producer, not a tighter heuristic.
    // ⛔ REASON CORRECTED (24.123): this used to say a shape allowlist here would invert
    // `contentContainsSecret` on the sole-writer path. That stopped being true at
    // `19802240` — the granularity split moved the pre-commit scan onto the two
    // credential-SHAPE nets and off `isRedactionSafe` entirely. The live consumer of an
    // allowlist here is `auditFieldContainsSecret` (audit granularity, keyword arm
    // retained), reached from `apps/worker/src/boot.ts:945`. The assertion below is
    // unchanged and was never wrong — only the reason attached to it was.
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

  // task 24.133 — `policy_and_domain_agree_on_the_credential_shape_axis` above only iterates
  // three HAND-PICKED fixture arrays. A net present in `CREDENTIAL_NETS` (domain's canonical,
  // frozen list, exported task 24.135) but never represented in a hand-picked fixture is
  // INVISIBLE to that pin — it could agree or disagree and nobody would know, because nothing
  // derives the corpus FROM the net list itself. This block closes that: it iterates
  // `CREDENTIAL_NETS` directly, so a net ADDED there without a matching exemplar HERE reds —
  // the identical "exemplar completeness" shape `@sow/domain`'s own
  // `test/redaction/marker-filler-property.test.ts` already uses, for the same reason.
  describe("task 24.133 — the parity corpus is DERIVED from the canonical net list, not a hand-maintained copy", () => {
    const CANONICAL_NET_EXEMPLARS: ReadonlyArray<{
      readonly name: string;
      readonly net: RegExp;
      readonly exemplar: string;
    }> = [
      {
        name: "CREDENTIAL_PREFIX",
        net: DOMAIN_CREDENTIAL_PREFIX,
        exemplar: "sk-ant-api03-abcdefghijklmnop",
      },
      {
        name: "SENSITIVE_KEYWORD",
        net: DOMAIN_SENSITIVE_KEYWORD,
        exemplar: "rotate the api_key before friday",
      },
      {
        name: "URL_USERINFO_CREDENTIAL",
        net: DOMAIN_URL_USERINFO_CREDENTIAL,
        exemplar: "//user:pass@host",
      },
    ];

    it("every net in the canonical CREDENTIAL_NETS list has an exemplar here — non-vacuity against a net added there and not here", () => {
      const covered = CANONICAL_NET_EXEMPLARS.map((e) => e.net);
      for (const net of CREDENTIAL_NETS) {
        expect(
          covered,
          `CREDENTIAL_NETS grew a net (${net.source}) with no exemplar in this corpus — task 24.133's whole point is that this must be VISIBLE, not silently invisible`,
        ).toContain(net);
      }
      expect(CANONICAL_NET_EXEMPLARS.length).toBe(CREDENTIAL_NETS.length);
    });

    it("policy agrees with domain on every canonical net's exemplar — derived from the net list, not re-typed by hand", () => {
      for (const { name, net, exemplar } of CANONICAL_NET_EXEMPLARS) {
        expect(
          net.test(exemplar),
          `${name}: exemplar ${JSON.stringify(exemplar)} does not even match its own net`,
        ).toBe(true);
        expect(
          isRedactionSafe(refSignal(exemplar)),
          `${name}: ${JSON.stringify(exemplar)} — policy and domain must agree on a value derived from the CANONICAL net list`,
        ).toBe(!domainLooksUnsafe(exemplar));
      }
    });
  });

  // task 24.133 — the derived corpus above is bounded by EXACTLY the three nets
  // `CREDENTIAL_NETS` contains. It cannot, by construction, surface a credential SHAPE that
  // no net in the list recognizes at all — the blind spot is invisible to a corpus that is
  // itself derived from the thing that has the blind spot. This block supplies an
  // OUT-OF-CORPUS probe: a real, structurally valid credential shape recognized by a FOURTH
  // net that exists elsewhere in this codebase (packages/integrations'
  // gateway-log-redaction.ts `GOOGLE_API_KEY` / `CREDENTIAL_TOKEN`) but by NONE of the three
  // nets `@sow/domain` or `packages/policy` know about.
  describe("24.133 — an AIza-shaped probe outside every net in the derived corpus", () => {
    // A syntactically valid Google API key shape: `AIza` + 35 base64url-ish characters —
    // the exact shape `packages/integrations/src/redaction/gateway-log-redaction.ts`'s
    // `GOOGLE_API_KEY = /AIza[0-9A-Za-z_-]{10,}/` recognizes. Fabricated, never a real key.
    const AIZA_SHAPED_KEY = "AIzaSyDaGmWKa4JsXZ-HjGw7ISLn_3namBGewQe";

    it("matches NO net in the canonical list — the census that makes the gap explicit rather than assumed", () => {
      for (const net of CREDENTIAL_NETS) {
        expect(
          net.test(AIZA_SHAPED_KEY),
          `${net.source} unexpectedly matched an AIza-shaped key — the gap this block documents has closed; the disposition test below needs re-deriving, not re-greening`,
        ).toBe(false);
      }
    });

    it("known_gap_AIza_shaped_credentials_are_not_refused_by_domain_or_policy: pinned so the class is not invisible, held by task 24.118 [spec(§16 / rule 1 / rule 7)]", () => {
      // ⛔ NOT A PASSING GRADE. This pins a REAL leak-direction gap. An AIza-shaped Google API
      // key riding in this signal's refs/summaries is judged SAFE by BOTH @sow/domain and
      // packages/policy, so it does NOT trip the KnowledgeWriter's BLOCKING pre-commit secret
      // scan (packages/knowledge secret-scan.ts's `contentContainsSecret`, which since
      // `19802240` runs `CREDENTIAL_PREFIX` + `URL_USERINFO_CREDENTIAL` directly rather
      // than `!isRedactionSafe` — the CONCLUSION is unchanged, since `CREDENTIAL_PREFIX`
      // is the very net that carries no AIza alternative, but the derivation was stale)
      // and does NOT trip this signal's own redaction-safety guard — on the sole-writer path
      // (rule 1 by reach) and the secret-redaction floor (rule 7).
      //
      // WHY IT IS NOT SILENTLY "FIXED" HERE, AND WHY THAT IS NOT A DODGE: promoting AIza
      // detection into @sow/domain is task 24.118, and 24.118 is EXPLICITLY HELD BY LEAD
      // RULING pending a specific cmp-verified backup — the first promotion attempt silently
      // dropped two reviewer-mandated comment fixes above the extraction boundary while
      // staying green (`L251`), and the only artifact that catches that class of loss (an
      // occurrence-count reconciliation against a verified backup) does not exist for a
      // policy-local patch invented here. Adding a FOURTH, policy-local-only AIza net would
      // not be a tidy-up — it is exactly the "second [now fourth] hand-maintained net"
      // divergence this whole task exists to stop, made unilaterally, by the one module least
      // positioned to own the decision (this signal's job is to gate an audit trail, not to
      // be the place a new credential-shape net is first designed).
      //
      // THE TRADE, NAMED SO IT CANNOT BE REDISCOVERED AS A SURPRISE: closing this gap is a
      // LEAK-direction fix with an unmeasured AVAILABILITY cost. `AIza` is a fixed, distinctive
      // 4-character prefix — a narrower collision surface than `sk-`'s bare two-character
      // alternative EVER carried, and `sk-` itself gained a word boundary at task 24.124 (see
      // that task's tests, below and in `@sow/domain`) — but the charset that follows AIza's
      // prefix (`[0-9A-Za-z_-]{10,}`) is unbounded on the high end and could still trip on an
      // opaque non-secret token of the right shape. That measurement is 24.118's to run, not
      // this task's — this pin exists so the gap is VISIBLE and OWNED, not so it is closed.
      expect(
        isRedactionSafe(refSignal(AIZA_SHAPED_KEY)),
        "AIza-shaped Google API key: currently judged SAFE by packages/policy — this is the measured blind spot, held open by task 24.118, not a passing grade",
      ).toBe(true);
      expect(
        domainLooksUnsafe(AIZA_SHAPED_KEY),
        "@sow/domain does not recognize the AIza shape either — the gap is NOT policy-specific, so a policy-local fix would create a FOURTH divergent copy rather than closing the real one",
      ).toBe(false);
    });
  });

  it("RETIRED task 24.124 — the word boundary landed: the former false positives are now correctly safe [spec(§16)]", () => {
    // ⛔ RETIRED DELIBERATELY, NOT SILENTLY GREEN — history retained in past tense
    // (L195: striking a block does not tense-shift the sentences inside it).
    //
    // WHAT THIS TEST USED TO PIN: `sk-[a-z0-9]` carried NO word boundary, so any
    // word ending in "sk" followed by `-` and an alphanumeric tripped the
    // credential net. That class was PRE-EXISTING in the lowercase direction
    // (`task-123` was refused before task 24.110) and 24.110's `/i` fix widened it
    // to every casing. Measured by security-reviewer over 612 repo Markdown files
    // at 24.110: 236 already rejected before that slice, 9 newly rejected by it.
    // This mattered because packages/knowledge's secret-scan.ts is
    // REJECT-NOT-REDACT over the WHOLE rendered file on the sole-writer path: a
    // note containing "TASK-1" did not land.
    //
    // WHAT CLOSED IT: task 24.124 added `\b` before `sk-` in BOTH `@sow/domain`'s
    // `CREDENTIAL_PREFIX` and this module's own copy, in the same commit round
    // (producer-first — see `@sow/domain`'s `CREDENTIAL_PREFIX` comment for the
    // full leak-direction measurement: 235 lines of this repo's Markdown corpus
    // newly admitted end-to-end, an accepted trade, not an oversight). The
    // fixture set below is the SAME ONE this test used to assert `false` (refused)
    // for — this test's own retired comment said "if this ever goes green the
    // word boundary was added, and this pin should be retired deliberately." It
    // did; this is that retirement, not an accident.
    for (const v of ["ref:task:TASK-123", "RISK-001", "Full-Disk-Access"]) {
      expect(
        isRedactionSafe(refSignal(v)),
        `${v}: task 24.124 retired this false positive — if this ever REDS again the word-boundary fix was reverted, and that is a regression to investigate, not a pin to re-loosen`,
      ).toBe(true);
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
    // A KNOWN EXCEPTION RATHER THAN AN OVERSIGHT — SEE "THE CONTROL PAIR, UPDATED" BELOW FOR
    // WHAT THAT EXCEPTION MEANS NOW THAT (C') HAS LANDED. task 24.123 also carries a THIRD
    // item, routed to it from 24.120 by lead ruling: dropping the `private[_ -]?key` matches
    // that exist ONLY because the legacy SPACE is a member of that alternative's alphabet.
    // Under THAT remedy the control pair's domain verdict flips and this test REDS —
    // intended, because the control is a deliberate 24.123 tripwire.
    //
    // ⛔⛔ (C') LANDED (task 24.110, this commit). RETAINED IN PAST TENSE BECAUSE THE
    // REASONING IS STILL LOAD-BEARING (L195). (C') is `domain.looksUnsafe(s) ||
    // policy_today(s)`, wired into `packages/policy/src/audit-signal.ts`'s `looksUnsafe`. It
    // is monotone in the REFUSAL direction, so every value refused before stays refused — but
    // THIS BLOCK ALSO ASSERTED A *SAFE* VERDICT for `private[REDACTED:raw]key`, AND (C')
    // FLIPPED IT: policy now inherits domain's refusal of that value, so the control's
    // `.toBe(true)` reds — measured, not merely predicted (this commit's own test run). That
    // RED WAS CORRECT and is not "repaired" by restoring the old expectation; the control pair
    // below is REWRITTEN to assert the new, measured verdict instead. "Monotone by
    // construction" is a claim about LEAKS and is SILENT about AVAILABILITY: on the
    // reject-not-redact sole-writer path, a note carrying an already-redacted
    // `private[REDACTED:raw]key` NOW has its ENTIRE COMMIT rejected, where it did not before —
    // an AVAILABILITY cost, recorded here rather than hidden by a quietly-adjusted assertion.
    //
    // ⭐ WHAT (C') DID AND DID NOT MOOT, MEASURED RATHER THAN ASSUMED: it moots exactly the
    // direction where POLICY WAS LOOSER THAN DOMAIN (this file's `spaceManufactured` pair,
    // below) — policy now agrees with domain and refuses. It does NOT moot the direction where
    // POLICY IS STRICTER THAN DOMAIN (the `marker` pair immediately below): domain strips the
    // marker before testing and judges it safe; (C') ORs domain's "safe" with policy's
    // un-stripped nets, and OR cannot turn an existing "unsafe" into "safe" — so policy still
    // refuses `marker` on its own keyword, exactly as before. The marker axis THEREFORE STILL
    // DIVERGES (the describe block's name stays accurate), just in one direction rather than
    // two — and closing that remaining direction is NOT this task's scope: it would mean
    // making policy STOP refusing something domain calls safe, which is the (B)-wholesale
    // hazard 24.110's header still names as blocked.
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

    // THE CONTROL, UPDATED FOR (C') — HISTORY RETAINED IN PAST TENSE (L195). Before (C'),
    // this fixture showed the two predicates disagreeing in the OTHER direction from `marker`
    // above: domain's retained legacy-space arm rewrote `private[REDACTED:raw]key` to
    // `private key`, matching SENSITIVE_KEYWORD's `private[_ -]?key` alternative; policy,
    // which does not strip, saw a 14-character gap and no alternative matched — DOMAIN was
    // stricter here while POLICY was stricter on `marker` above, so "policy is stricter" was
    // never one measurement written twice, it was a direction asserted from a fixture chosen
    // to show it did not hold everywhere. Recorded on task 24.110 (commit 40bbf578) and stated
    // by redaction-rules.ts about itself.
    //
    // ⛔ THAT DISAGREEMENT IS NOW CLOSED, MEASURED BY THIS COMMIT'S TEST RUN: (C')'s union arm
    // makes policy inherit domain's legacy-space refusal directly, so BOTH predicates now
    // refuse `spaceManufactured` — the assertions below assert the NEW verdict, not the old
    // one. This is the ONE fixture in this describe block whose expected value changed; it is
    // not a weakened test, it is the pin doing its job (`L230`: a test's proposition can move
    // while its name and pass-state stay put, and that must be said, not left implicit — this
    // comment is that statement).
    //
    // ⚠ GAP CLOSED (task 24.135): this pair had NO local non-vacuity guard — it isolates the
    // LEGACY-SPACE arm only while domain's span-preserving filler is NOT a member of
    // `private[_ -]?key`'s alphabet, and were that filler ever to become `_` or `-`, the span
    // arm would match on its own and the tripwire below would keep passing while the mechanism
    // it names retired SILENTLY. A local guard needed `SPAN_PRESERVING_FILLER` exported from
    // `@sow/domain`; 24.135 added it to the barrel (it was declared but omitted), which is what
    // makes the assertion immediately below possible. The reasoning that made this a real gap is
    // retained rather than deleted (striking a block does not tense-shift the sentences inside
    // it) — only the STATE changed: cross-package coverage in `@sow/domain`'s own
    // `test/redaction/marker-filler-property.test.ts` (which rejects `-`, `_` and `.` as fillers)
    // still exists and is still not coverage THIS file provides on its own; this file now ALSO
    // carries a local tripwire so a reader of this pin does not have to trust another package's
    // suite to know the mechanism is still intact.
    expect(
      /^[_ -]$/.test(SPAN_PRESERVING_FILLER),
      "SPAN_PRESERVING_FILLER became a member of `private[_ -]?key`'s alphabet — the span-preserving arm now matches this fixture on its own, so the isolation the assertions below claim (\"only the LEGACY-SPACE arm produces this refusal\") is FALSE. This does not mean the fixture is wrong; it means the comment above and the 24.123 removal-candidate framing need re-deriving, not re-greening.",
    ).toBe(false);
    const spaceManufactured = `private${REDACTED_RAW}key`;
    expect(
      isRedactionSafe(refSignal(spaceManufactured)),
      "MEASURED POST-(C') (task 24.110): policy's own nets still see no span across the marker, but the union arm now also runs domain's looksUnsafe over the SAME un-stripped string, and domain's legacy-space arm refuses it — so this module inherits that refusal and is no longer SAFE here. Before (C') this was `true`; if it goes back to passing as `true` without domainLooksUnsafe having changed, the union arm was removed and this pin must be re-examined, not re-greened.",
    ).toBe(false);
    expect(
      domainLooksUnsafe(spaceManufactured),
      "@sow/domain's legacy-space arm collapses the marker to a space and matches private[_ -]?key — unchanged by (C'), which only adds domain's verdict to policy's union, never the reverse",
    ).toBe(true);
  });
});
