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
import { readFileSync } from "node:fs";
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
// task 24.135 — `SPAN_PRESERVING_FILLER` is declared in `redaction-rules.ts` but the
// barrel re-export block in `redact.ts` (which `src/index.ts` re-exports wholesale)
// omitted it, so the package's own PUBLIC surface — the one every OTHER package
// imports through (`@sow/domain`) — could not name the filler this whole file binds.
// Imported from the barrel under a distinct alias (never the internal module path
// above) so a regression here is a genuine barrel omission, not a naming collision.
import { SPAN_PRESERVING_FILLER as SPAN_PRESERVING_FILLER_FROM_BARREL } from "../../src/index";

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

describe("24.135 — SPAN_PRESERVING_FILLER is reachable from the package barrel", () => {
  it("the barrel export equals the internal module's value — one filler, one home", () => {
    expect(SPAN_PRESERVING_FILLER_FROM_BARREL).toBe("^");
    expect(SPAN_PRESERVING_FILLER_FROM_BARREL).toBe(SPAN_PRESERVING_FILLER);
  });
});

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

// task 24.129 — `redact.ts`'s `redactString` scrubs a value, then RE-CHECKS the
// scrubbed result with `looksUnsafe` (idempotency / fail-safe). `looksUnsafe`
// strips every frozen marker to `SPAN_PRESERVING_FILLER` before testing, so if a
// net's OWN value class admits the bare filler character, a successfully-scrubbed
// `REDACTED_CREDENTIAL` marker re-trips that net on the re-check pass and
// `redactString` drops the whole field to `REDACTED_FIELD` — DESTROYING its own
// successfully-scrubbed output. ⚠ THE DIRECTION IS AVAILABILITY, NOT LEAK: no
// secret is exposed by this failure mode — strictly MORE content is dropped than
// necessary. See `SPAN_PRESERVING_FILLER`'s own comment in `redaction-rules.ts`
// for the full constraint this pin enforces: no net whose value class admits `^`
// may ever be promoted into `CREDENTIAL_NETS`.
describe("24.129 — no net may have a value class that admits the bare span-preserving filler", () => {
  it("no net in the canonical CREDENTIAL_NETS list matches the bare filler", () => {
    // Sharper than the P1'/P1'' suite above: it reds the MOMENT a violating net is
    // added to `CREDENTIAL_NETS`, with zero exemplar authoring required — the
    // P1'/P1'' suite only exercises a net once someone has written its exemplars
    // into `NET_EXEMPLARS`.
    for (const net of CREDENTIAL_NETS) {
      expect(
        net.test(SPAN_PRESERVING_FILLER),
        `${net.source} matches the bare span-preserving filler "${SPAN_PRESERVING_FILLER}" — a net whose value class admits this character must NOT be promoted into @sow/domain's CREDENTIAL_NETS (AVAILABILITY-direction hazard: see SPAN_PRESERVING_FILLER's comment in redaction-rules.ts)`,
      ).toBe(false);
    }
  });

  it("a synthetic filler-admitting net fails this pin's own predicate — the discrimination check", () => {
    // Never trust a preventive pin that has never been observed to fail
    // (contracts L90 / this project's own positive-control discipline). This
    // asserts the DISCRIMINATION directly (the same predicate the pin above runs,
    // applied to a net that DOES admit the filler) rather than merely trusting the
    // pin reads correctly — a standing-in synthetic net, never added to the real
    // `CREDENTIAL_NETS`. The pin above was additionally hand-verified during
    // authoring by temporarily inserting this exact net into the real loop and
    // observing it RED, then reverting (recorded in the task's commit, not kept as
    // a permanent test — a mutated `CREDENTIAL_NETS` has no place in a unit test).
    const hypotheticalFutureNet = /\^/;
    expect(
      hypotheticalFutureNet.test(SPAN_PRESERVING_FILLER),
      "the synthetic net must itself admit the filler, or this discrimination check proves nothing",
    ).toBe(true);
  });
});

describe("the fourth marker vocabulary", () => {
  // `packages/providers/src/redaction/provider-log-redaction.ts` and
  // `packages/integrations/src/redaction/gateway-log-redaction.ts` both export
  // `REDACTED = "[REDACTED]"`. It is NOT one of the frozen markers and is never
  // stripped, so it reaches the nets as ordinary content.
  //
  // ⛔ THIS VALUE IS A COPY, AND THE COPY IS FORCED, NOT CHOSEN: `@sow/domain` is
  // the PRODUCER and both owners are CONSUMERS, so a real TypeScript `import` of
  // either package HERE would invert the §2.5 layer (verified: `@sow/domain`'s own
  // `test/boundary/pure-root.test.ts` pins that its `package.json` devDependencies
  // must carry NO `@sow/*` package at all — Q3, a devDep-only test import, is a
  // REJECTED option there, not an oversight; adding `@sow/providers`/
  // `@sow/integrations` as devDependencies to enable a real import would red that
  // pin immediately). ⭐ MECHANICAL DRIFT CHECK, task 24.127 — closed WITHOUT an
  // import: `node:fs` reads the two files' SOURCE TEXT (a file read is not an
  // import — it creates no dependency edge and is exactly the mechanism this
  // package's own "the two pure-root-scan.ts copies do not diverge" test already
  // uses for the identical cross-package-comparison-without-a-dependency-edge
  // problem, immediately below in this suite's sibling file). If either owner's
  // literal changes, the extraction below changes with it and this test REDS.
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

  describe("24.127 — mechanical drift check against @sow/providers and @sow/integrations", () => {
    // Both files declare the identical form: `export const REDACTED = "..." as const;`.
    // Extracted by TEXT, not by import — see the block comment above for why an
    // import is architecturally unavailable here.
    const REDACTED_DECL_RE = /export const REDACTED = "([^"]*)" as const;/;

    function extractRedactedLiteral(fileContent: string): string | undefined {
      return fileContent.match(REDACTED_DECL_RE)?.[1];
    }

    // Non-vacuity / discrimination proof FIRST, on SYNTHETIC content — never on
    // the real shared files (a temporary on-disk mutation of a file two other
    // areas' packages depend on is a live-tree hazard this project's own lessons
    // warn against; the extractor's correctness is provable without touching
    // them). Proves the extractor genuinely READS the value rather than being
    // hardcoded to always return "[REDACTED]".
    it("the extractor reads the declared value, not a hardcoded expectation", () => {
      expect(
        extractRedactedLiteral('export const REDACTED = "[REDACTED]" as const;'),
      ).toBe("[REDACTED]");
      expect(
        extractRedactedLiteral('export const REDACTED = "[SOMETHING_ELSE]" as const;'),
      ).toBe("[SOMETHING_ELSE]");
      expect(
        extractRedactedLiteral("export const NOT_REDACTED = 1;"),
        "a file with no matching declaration must extract to undefined, not silently pass",
      ).toBeUndefined();
    });

    it("packages/providers' REDACTED literal matches FOURTH_VOCABULARY", () => {
      const content = readFileSync(
        new URL(
          "../../../providers/src/redaction/provider-log-redaction.ts",
          import.meta.url,
        ),
        "utf8",
      );
      const extracted = extractRedactedLiteral(content);
      expect(
        extracted,
        "could not find `export const REDACTED = \"...\" as const;` in packages/providers/src/redaction/provider-log-redaction.ts — the declaration form changed; re-derive the extraction pattern, do not weaken this to pass",
      ).toBeDefined();
      expect(extracted).toBe(FOURTH_VOCABULARY);
    });

    it("packages/integrations' REDACTED literal matches FOURTH_VOCABULARY", () => {
      const content = readFileSync(
        new URL(
          "../../../integrations/src/redaction/gateway-log-redaction.ts",
          import.meta.url,
        ),
        "utf8",
      );
      const extracted = extractRedactedLiteral(content);
      expect(
        extracted,
        "could not find `export const REDACTED = \"...\" as const;` in packages/integrations/src/redaction/gateway-log-redaction.ts — the declaration form changed; re-derive the extraction pattern, do not weaken this to pass",
      ).toBeDefined();
      expect(extracted).toBe(FOURTH_VOCABULARY);
    });

    // Areas that must move TOGETHER if the literal ever changes, named so a
    // future editor of any ONE of them knows the other two exist:
    //   1. @sow/providers  — packages/providers/src/redaction/provider-log-redaction.ts
    //   2. @sow/integrations — packages/integrations/src/redaction/gateway-log-redaction.ts
    //   3. @sow/domain (this file) — `FOURTH_VOCABULARY` above, the reference value
    //      this describe block checks BOTH producers against.
    // A change to any one WITHOUT the other two reds exactly one of the two
    // extraction tests above, naming which file drifted.
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
