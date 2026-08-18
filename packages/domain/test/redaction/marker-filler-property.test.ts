// Task 24.120 — the guard on `stripMarkers`' substitute character.
//
// THE PROPERTY, in one sentence: the filler must behave as ONE OPAQUE TOKEN — it
// must never match where an opaque token would not. A filler that is a member of
// some pattern's alphabet can BRIDGE two fragments into a match that was not
// there; a filler that is whitespace can BREAK a span that was.
//
// It is tested two ways because one way is not enough:
//   P1'  SUBSTITUTION — put the filler where a character of a known match stands.
//   P1'' INSERTION    — put the filler between characters of a known match.
// P1' alone MISSES an optional element whose exemplar omits it: with `apikey` as
// the only exemplar for `api[_-]?key`, no substitution ever produces `api-key`,
// but an insertion does. That hole is why both forms exist.
//
// ⛔ THE BOUND ON THIS GUARD, STATED HERE BECAUSE A CONTROL WITH INVISIBLE LIMITS
// IS THE DEFECT CLASS THIS TASK IS ABOUT: the guard derives POSITIONS from the
// live patterns automatically, but it takes EXEMPLARS FROM A HUMAN. Its
// completeness is therefore bounded by `NET_EXEMPLARS` below. A pattern whose
// exemplars omit an optional element, or omit one of its alternatives entirely, is
// NOT fully covered — and nothing here will say so. Adding a net is caught (the
// completeness test fails until exemplars exist); adding an unexercised
// ALTERNATIVE to an existing net is NOT.
//
// ⛔ WHICH ARM THIS BINDS, AND THE RULE FOR ANY ARM ADDED LATER — stated as a rule
// rather than a list, because a list would need maintaining and this does not:
//
//   IN A DISJUNCTION OF SAFETY CHECKS, ONLY THE ARMS THAT CAN RETURN *SAFE* NEED
//   ALPHABET GUARDING. A fail-safe arm can only ever manufacture extra REFUSALS,
//   so no filler it uses can hide a credential.
//
// `looksUnsafe` today has two arms: the SPAN-PRESERVING one can return SAFE where
// an opaque token would not, so it is guarded here; the legacy space arm cannot
// (a space is a member of `private[_ -]?key`'s alphabet, so it only ever adds
// refusals), so it is not. This suite binds `SPAN_PRESERVING_FILLER` alone.
//
// ⇒ If you add a THIRD arm, decide which kind it is FIRST. If it can return SAFE
// on an input the others refuse, it needs its filler added to this guard — and
// `looksUnsafe`'s monotonicity argument has to be re-derived, because a disjunction
// is only monotone while every arm is additive.
import { describe, it, expect } from "vitest";
import {
  CREDENTIAL_NETS,
  CREDENTIAL_PREFIX,
  SENSITIVE_KEYWORD,
  URL_USERINFO_CREDENTIAL,
  SPAN_PRESERVING_FILLER,
  looksUnsafe,
} from "../../src/redaction/redaction-rules";
import { isRedactionSafe } from "../../src/redaction/redact";
import {
  REDACTED_CREDENTIAL,
  REDACTED_RAW,
  REDACTED_FIELD,
} from "@sow/contracts";

// Two unrelated private-use codepoints. CONSTRUCTED, never written as literals:
// a raw non-ASCII character does not survive every transport into a source file,
// and when it silently becomes "" this whole suite degrades into testing DELETION
// while still producing a discriminating-looking table. Both are asserted below
// before anything depends on them.
const OPAQUE_A = String.fromCharCode(0xe000);
const OPAQUE_B = String.fromCharCode(0xe001);
// U+2028 is whitespace to a JS regex (`\s` matches it), so it is a REJECTED filler
// for the same reason a space is. Constructed for the same reason as above.
const LINE_SEPARATOR = String.fromCharCode(0x2028);

/** Known-matching exemplars per net. See the bound stated in the file header. */
const NET_EXEMPLARS: ReadonlyArray<{
  readonly name: string;
  readonly net: RegExp;
  readonly exemplars: readonly string[];
}> = [
  {
    name: "CREDENTIAL_PREFIX",
    net: CREDENTIAL_PREFIX,
    exemplars: [
      "sk-a",
      "sk_live",
      "sk_test",
      "xoxb-",
      "xoxp-",
      "ghp_",
      "gho_",
      "AKIA0123456789ABCDEF",
      "-----BEGIN",
      "eyJabcdefghij.",
    ],
  },
  {
    name: "SENSITIVE_KEYWORD",
    net: SENSITIVE_KEYWORD,
    exemplars: [
      "password",
      "passwd",
      "secret",
      // `api[_-]?key` and `private[_ -]?key` are given in BOTH forms deliberately:
      // the absent form is what P1'' exists to cover, the present forms are what
      // P1' can see. Dropping either weakens a different half of the guard.
      "apikey",
      "api_key",
      "api-key",
      "bearer",
      "credential",
      "privatekey",
      "private key",
      "private_key",
      "private-key",
      "passphrase",
    ],
  },
  {
    name: "URL_USERINFO_CREDENTIAL",
    net: URL_USERINFO_CREDENTIAL,
    exemplars: ["//u:p@h", "//user:pass@host", "https://user:pass@host/path"],
  },
];

/** True iff an opaque token can occupy this position — i.e. the position is not
 *  governed by a literal or an enumerated alphabet. Two unrelated probes, so a
 *  single unlucky codepoint cannot classify a position by itself. */
function positionIsOpaque(net: RegExp, build: (c: string) => string): boolean {
  return net.test(build(OPAQUE_A)) && net.test(build(OPAQUE_B));
}

/** P1' — positions where `filler` completes a match an opaque token could not. */
function substitutionViolations(net: RegExp, exemplar: string, filler: string): number[] {
  const hits: number[] = [];
  for (let i = 0; i < exemplar.length; i += 1) {
    const build = (c: string): string =>
      exemplar.slice(0, i) + c + exemplar.slice(i + 1);
    if (net.test(build(filler)) && !positionIsOpaque(net, build)) hits.push(i);
  }
  return hits;
}

/** P1'' — positions where inserting `filler` completes a match an opaque token could not. */
function insertionViolations(net: RegExp, exemplar: string, filler: string): number[] {
  const hits: number[] = [];
  for (let i = 0; i <= exemplar.length; i += 1) {
    const build = (c: string): string => exemplar.slice(0, i) + c + exemplar.slice(i);
    if (net.test(build(filler)) && !positionIsOpaque(net, build)) hits.push(i);
  }
  return hits;
}

function violationsFor(filler: string): string[] {
  const found: string[] = [];
  for (const { name, net, exemplars } of NET_EXEMPLARS) {
    for (const exemplar of exemplars) {
      for (const i of substitutionViolations(net, exemplar, filler))
        found.push(`P1' ${name} ${JSON.stringify(exemplar)}@${i}`);
      for (const i of insertionViolations(net, exemplar, filler))
        found.push(`P1'' ${name} ${JSON.stringify(exemplar)}@${i}`);
    }
  }
  return found;
}

describe("constant integrity — asserted BEFORE anything depends on these", () => {
  // Every verdict in this file is a function of these constants. A suite whose
  // constants silently became "" once produced a fully discriminating table that
  // was wrong in both directions, and it reached a ruling. Assert them.
  it("the opaque probes are single, real, and DISTINCT codepoints", () => {
    expect(OPAQUE_A.length).toBe(1);
    expect(OPAQUE_B.length).toBe(1);
    expect(OPAQUE_A).not.toBe(OPAQUE_B);
    expect(OPAQUE_A.codePointAt(0)).toBe(0xe000);
    expect(OPAQUE_B.codePointAt(0)).toBe(0xe001);
  });

  it("the filler under guard is a single character", () => {
    expect(SPAN_PRESERVING_FILLER.length).toBe(1);
  });

  it("the frozen markers are non-empty and distinct", () => {
    for (const m of [REDACTED_CREDENTIAL, REDACTED_RAW, REDACTED_FIELD])
      expect(m.length).toBeGreaterThan(3);
    expect(new Set([REDACTED_CREDENTIAL, REDACTED_RAW, REDACTED_FIELD]).size).toBe(3);
  });

  it("U+2028 is whitespace to these patterns — the reason it is a rejected filler", () => {
    expect(LINE_SEPARATOR.length).toBe(1);
    expect(/\s/.test(LINE_SEPARATOR)).toBe(true);
  });
});

describe("exemplar completeness — a net with no exemplar is a guard with nothing to say", () => {
  it("every net the predicate consults has exemplars here", () => {
    const covered = NET_EXEMPLARS.map((e) => e.net);
    for (const net of CREDENTIAL_NETS)
      expect(covered, `net ${net.source} has no exemplars`).toContain(net);
    expect(NET_EXEMPLARS.length).toBe(CREDENTIAL_NETS.length);
  });

  it("every exemplar actually matches its net", () => {
    for (const { name, net, exemplars } of NET_EXEMPLARS) {
      expect(exemplars.length).toBeGreaterThan(0);
      for (const exemplar of exemplars)
        expect(net.test(exemplar), `${name}: ${JSON.stringify(exemplar)} does not match`).toBe(true);
    }
  });
});

describe("P1' + P1'' — the filler must never match where an opaque token would not", () => {
  it("the shipped filler passes both forms", () => {
    expect(violationsFor(SPAN_PRESERVING_FILLER)).toEqual([]);
  });

  // Non-vacuity: a guard that passes everything on first run is the one to
  // distrust. Each of these is rejected for a DIFFERENT reason.
  it.each([
    ["-", "-"],
    ["_", "_"],
    [".", "."],
    ["A (word character)", "A"],
    ["empty (deleting the marker)", ""],
  ])("rejects %s", (_label, filler) => {
    expect(violationsFor(filler).length).toBeGreaterThan(0);
  });

  it("rejects the INCUMBENT space — it is itself in `private[_ -]?key`'s alphabet", () => {
    // This is the strongest evidence the guard works: it convicts the character
    // that shipped, on a defect nobody had named.
    const violations = violationsFor(" ");
    expect(violations.length).toBeGreaterThan(0);
    expect(violations.some((v) => v.includes("private"))).toBe(true);
  });

  it("P1'' catches what P1' structurally cannot — an optional element the exemplar omits", () => {
    // With `apikey` alone, substitution can never produce `api-key`; insertion can.
    expect(substitutionViolations(SENSITIVE_KEYWORD, "apikey", "-")).toEqual([]);
    expect(insertionViolations(SENSITIVE_KEYWORD, "apikey", "-").length).toBeGreaterThan(0);
  });
});

describe("the fourth marker vocabulary", () => {
  // `packages/providers/src/redaction/provider-log-redaction.ts` and
  // `packages/integrations/src/redaction/gateway-log-redaction.ts` both export
  // `REDACTED = "[REDACTED]"`. It is NOT one of the frozen markers and is never
  // stripped, so it reaches the nets as ordinary content.
  //
  // ⛔ THIS VALUE IS A COPY, AND THE COPY IS FORCED, NOT CHOSEN: `@sow/domain` is
  // the PRODUCER and both owners are CONSUMERS, so importing it here would invert
  // the layer. ⛔ NO MECHANICAL DRIFT CHECK EXISTS — if either owner changes its
  // literal, this test goes on checking a stale value and NOTHING WILL RED. Owning
  // task: `### 24.127`. To verify by hand, read the `REDACTED` const in the two
  // files named above.
  const FOURTH_VOCABULARY = "[REDACTED]";

  it("is inert: it can neither supply a delimiter nor break a permissive span", () => {
    // No colon and no whitespace ⇒ it cannot complete a userinfo span, and it
    // cannot sever one either. That is WHY it needs no stripping.
    expect(FOURTH_VOCABULARY).not.toContain(":");
    expect(/\s/.test(FOURTH_VOCABULARY)).toBe(false);
    expect(looksUnsafe(FOURTH_VOCABULARY)).toBe(false);
    expect(looksUnsafe(`//user${FOURTH_VOCABULARY}@host`)).toBe(false);
    expect(looksUnsafe(`//user:REALSECRET${FOURTH_VOCABULARY}@host`)).toBe(true);
  });
});

describe("24.120 — the destroyed match", () => {
  it("a marker inside a userinfo span no longer hides a real credential", () => {
    expect(isRedactionSafe(`//user:REALSECRET${REDACTED_RAW}@host`)).toBe(false);
    expect(isRedactionSafe(`//u:p${REDACTED_RAW}q@h`)).toBe(false);
  });

  it("holds for EVERY frozen marker, not just the one the task was filed with", () => {
    for (const marker of [REDACTED_CREDENTIAL, REDACTED_RAW, REDACTED_FIELD])
      expect(
        isRedactionSafe(`//user:REALSECRET${marker}@host`),
        `marker ${marker} still destroys the span`,
      ).toBe(false);
  });

  it("CONTROL: the same span with no marker is still refused", () => {
    // Green before and after the fix. It is what proves the pins above are about
    // the MARKER and not merely about the span.
    expect(isRedactionSafe("//user:REALSECRET@host")).toBe(false);
  });

  it("CONTROL: a marker-only string is not newly refused (idempotency)", () => {
    // The trap in the obvious patch: `//user[REDACTED:credential]@host` matches the
    // raw userinfo pattern ONLY because the marker literal supplies its own colon.
    // Testing the unstripped string would make every scrubbed field unredactable.
    expect(isRedactionSafe(`//user${REDACTED_CREDENTIAL}@host`)).toBe(true);
    expect(isRedactionSafe(`//${REDACTED_CREDENTIAL}@host`)).toBe(true);
    expect(isRedactionSafe(REDACTED_CREDENTIAL)).toBe(true);
  });
});

describe("monotonicity — the fix cannot ADMIT anything that was refused before", () => {
  it("keeps the matches the legacy space arm manufactures", () => {
    // `private<marker>key` is refused today only because a space is a member of
    // `private[_ -]?key`'s alphabet. Whether that is a real detection or an
    // artefact is UNMEASURED, so 24.120 preserves it rather than deciding it.
    // The availability candidate is recorded on `### 24.123`.
    expect(looksUnsafe(`private${REDACTED_RAW}key`)).toBe(true);
    expect(looksUnsafe(`my${REDACTED_RAW}password`)).toBe(true);
  });

  it("refuses a superset of the single-arm predicate, for every constructed input", () => {
    const legacyOnly = (s: string): boolean => {
      let probe = s;
      for (const m of [REDACTED_CREDENTIAL, REDACTED_RAW, REDACTED_FIELD])
        probe = probe.split(m).join(" ");
      return CREDENTIAL_NETS.some((net) => net.test(probe));
    };
    const inputs = [
      `//u:p${REDACTED_RAW}q@h`,
      `//user:REALSECRET${REDACTED_RAW}@host`,
      "//user:REALSECRET@host",
      `//user${REDACTED_CREDENTIAL}@host`,
      `private${REDACTED_RAW}key`,
      `my${REDACTED_RAW}password`,
      `pass${REDACTED_RAW}word`,
      `sk-${REDACTED_RAW}abc`,
      REDACTED_CREDENTIAL,
      REDACTED_FIELD,
      "sk-ant-api03-abcdef",
      "hello world",
      "",
    ];
    let witnessed = 0;
    for (const s of inputs) {
      if (legacyOnly(s)) expect(looksUnsafe(s), `regressed on ${JSON.stringify(s)}`).toBe(true);
      if (looksUnsafe(s) && !legacyOnly(s)) witnessed += 1;
    }
    // Applicability: superset-ness is vacuous unless the new arm actually adds
    // something. This is the 24.120 fix showing up in the monotonicity pin.
    expect(witnessed).toBeGreaterThan(0);
  });
});
