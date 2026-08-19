// Task 24.132 — the per-field vocabulary is ONE table, and `hasFieldVocabulary`
// is DERIVED from it rather than declared beside it.
//
// WHY THE TABLE EXISTS: `redactAllowlistedValue` must enforce the field type gate
// exactly where the gate can judge, and waive it where the gate is vacuous. That
// needs a "does this key have a vocabulary?" predicate. A hand-written key list
// answering it would be A SECOND HAND-MAINTAINED SET GUARDING THE FIRST — the
// defect class of `### 24.133` (a parity guard only as wide as its hand-kept
// fixture list). So `isSafeFieldValue` and `hasFieldVocabulary` read the SAME
// `FIELD_VOCABULARY` map plus the SAME two predicates, and cannot disagree.
//
// ⭐ THE REFACTOR THAT INTRODUCED THE TABLE (a `switch` becoming a Map) WAS PROVEN
// BEHAVIOUR-IDENTICAL, NOT ASSERTED: the matrix below was run against BOTH
// implementations — the pre-refactor `switch` restored from HEAD, and the table —
// and produced an IDENTICAL fingerprint (3943871851) and an identical true-count
// (409 of 1156 cells). That control was built, used, and deleted; this file keeps
// the matrix as a forward regression pin.
import { describe, it, expect } from "vitest";
import {
  isSafeFieldValue,
  hasFieldVocabulary,
  SAFE_FIELD_ALLOWLIST,
} from "../../src/redaction/redaction-rules";

/** A deliberately mixed probe set: enum members, ids, timestamps, codes, prose,
 *  markers, an over-length value, and values that are valid for SOME field. */
const VALUES: readonly string[] = [
  "", "info", "warn", "debug", "worker_down", "schema_rejection", "ok", "degraded",
  "unreachable", "note", "workflow.status", "job.started", "meeting.close",
  "REVISION_STALE", "AUTH_DENIED", "anthropic", "openai", "asana", "todoist", "http",
  "corr-12345", "employer-work", "2026-08-18T00:00:00Z", "2026-08-18", "824193",
  "ACME", "sk-Abc123Def456", "[REDACTED:credential]", "[REDACTED:raw]",
  "a".repeat(200), "has space", "Mixed_Case-1", "true", "42",
];

const KEYS: readonly string[] = [...SAFE_FIELD_ALLOWLIST].sort();

function verdictCells(): string {
  let sig = "";
  for (const k of KEYS) for (const v of VALUES) sig += isSafeFieldValue(k, v) ? "1" : "0";
  return sig;
}

describe("the verdict matrix — a forward regression pin on every allowlisted field", () => {
  it("the matrix is non-degenerate — both verdicts are well represented", () => {
    // Applicability FIRST: a fingerprint over an all-false matrix would match
    // itself forever and pin nothing.
    const sig = verdictCells();
    const trues = [...sig].filter((c) => c === "1").length;
    expect(sig.length).toBe(KEYS.length * VALUES.length);
    expect(trues).toBeGreaterThan(100);
    expect(trues).toBeLessThan(sig.length - 100);
  });

  it("the verdict fingerprint is unchanged", () => {
    // ⚠ A LITERAL, ON PURPOSE — same reason as the net-count literal in
    // `net-list-integrity.test.ts`: a value derived from the thing it checks would
    // match anything. If this reds, a field's vocabulary changed; that may be
    // correct, but it must be DELIBERATE. The representative cells below exist so
    // a red here is diagnosable rather than opaque.
    const sig = verdictCells();
    let h = 0;
    for (let i = 0; i < sig.length; i += 1) h = (h * 31 + sig.charCodeAt(i)) >>> 0;
    expect(h).toBe(3943871851);
  });

  it("representative cells — so a fingerprint red can be located", () => {
    expect(isSafeFieldValue("level", "info")).toBe(true);
    expect(isSafeFieldValue("level", "ACME")).toBe(false);
    expect(isSafeFieldValue("correlationId", "corr-12345")).toBe(true);
    expect(isSafeFieldValue("ts", "2026-08-18T00:00:00Z")).toBe(true);
    // ⚠ MEASURED, NOT ASSUMED: the ISO rule ALSO accepts a date-only form. Pinned
    // as the fact it is — an earlier draft of this pin asserted `false` here from
    // assumption and was wrong.
    expect(isSafeFieldValue("ts", "2026-08-18")).toBe(true);
    expect(isSafeFieldValue("errorMessage", "anything at all")).toBe(false);
  });

  it("PRECEDENCE — a dedicated vocabulary beats the id-named rule (the load-bearing order)", () => {
    // `providerId` ends in `Id` AND has an enum. If the id-named rule ran first,
    // the `Id` suffix would silently defeat the enum and let a raw codename or an
    // opaque token pass. This is the one ordering the switch's comment called out,
    // and the Map rewrite is where it could have been lost.
    // Demonstrated WITHOUT depending on which members the enum holds: the SAME
    // value is accepted under a plain id-named key and REJECTED under an id-named
    // key that also has an enum. If the id rule ran first, both would accept.
    expect(isSafeFieldValue("correlationId", "corr-12345")).toBe(true);
    expect(isSafeFieldValue("providerId", "corr-12345")).toBe(false);
    // and the enum arm does accept a real member, so the rejection above is
    // precedence rather than the key being broken.
    expect(isSafeFieldValue("providerId", "claude")).toBe(true);
  });
});

describe("hasFieldVocabulary is DERIVED — it cannot drift from isSafeFieldValue", () => {
  it("a key it calls VOCABULARY-LESS is one no value can satisfy", () => {
    // The necessary condition, checked against the whole probe set rather than
    // asserted. If a field gains a vocabulary and `hasFieldVocabulary` did not
    // follow, this reds — which is the silent-leak direction, because
    // `redactAllowlistedValue` would keep waiving the gate for it.
    for (const k of KEYS) {
      if (hasFieldVocabulary(k)) continue;
      for (const v of VALUES)
        expect(isSafeFieldValue(k, v), `${k} is vocabulary-less but accepted ${JSON.stringify(v)}`).toBe(false);
    }
  });

  it("both answers are actually represented — neither branch is empty", () => {
    // Non-vacuity: if every key had a vocabulary the loop above would be a no-op.
    const withVocab = KEYS.filter((k) => hasFieldVocabulary(k));
    const without = KEYS.filter((k) => !hasFieldVocabulary(k));
    expect(withVocab.length).toBeGreaterThan(0);
    expect(without.length).toBeGreaterThan(0);
  });

  it("the vocabulary-less set is ENUMERATED — it is 24.132's routed residual", () => {
    // ⛔ NAMED, NOT COUNTED, because WHICH fields these are IS the open residual:
    // `redactAllowlistedValue` waives the type gate for exactly this set, so the
    // measured leak survives on them. If this set GROWS, the residual grew with it
    // and this pin is the only thing that would say so.
    //
    // ⚠ MEASURED — AND IT IS EIGHT, NOT THE TWO PROSE FIELDS. Two kinds sit here
    // and they carry different risk:
    //   • `errorMessage`, `errorStack` — genuinely free-form prose. The type gate
    //     is vacuous for them by design, and the measured leak lives here.
    //   • `attempt`, `count`, `durationMs`, `retryable`, `timestampMs`, `fields` —
    //     NUMERIC / BOOLEAN / CONTAINER fields. Their normal values never reach the
    //     string branch at all (they pass by TYPE earlier), so they land here only
    //     when a caller passes a STRING under them — a wrong-typed value, which is
    //     exactly when the waiver is least deserved.
    expect(KEYS.filter((k) => !hasFieldVocabulary(k)).sort()).toEqual([
      "attempt", "count", "durationMs", "errorMessage", "errorStack",
      "fields", "retryable", "timestampMs",
    ]);
  });
});
