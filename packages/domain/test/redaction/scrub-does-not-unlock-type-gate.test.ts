// Task 24.132 — a partial success must not be consumed as a full pass.
//
// `redactAllowlistedValue` returned early whenever `redactString` changed
// ANYTHING, so scrubbing ONE recognized secret waived `isSafeFieldValue` for the
// ENTIRE remaining value. Measured leak: a credential plus companion PII and an
// employer project codename emitted the companion text verbatim (rules 5 and 7).
//
// ⛔ THE TRIGGER IS `sk-`, NOT `AIza`, AND THAT IS DELIBERATE. `### 24.118` step 1
// (which would make `AIza` a recognized shape) is HELD BEHIND THIS SLICE, so at
// HEAD an `AIza` fixture is never scrubbed, the early return never fires, and
// every pin below would pass FOR THE WRONG REASON — green by construction, the
// decorative-assertion class. `sk-aaaaaaaa` reproduces the bypass at HEAD.
//
// ⛔ ONE ASSERTION PER TEST WHERE A MUTATION MUST BE ATTRIBUTABLE (`L237`): the
// runner aborts at the first failing assertion, so a mutation over a
// multi-assertion block proves only the first one.
import { describe, it, expect } from "vitest";
import { redactRecord } from "../../src/redaction/redact";
import { REDACTED_CREDENTIAL, REDACTED_RAW, REDACTED_FIELD } from "@sow/contracts";

// A credential the CURRENT scrub already recognizes — independent of 24.118.
const SK = "sk-abcdefghij";
const PII = "alice@acme.com";
const CODENAME = "FALCON";
/** A credential riding alongside content the scrub never examines. */
const CARRIER = `sync failed for ${PII} on Project ${CODENAME} key=${SK}`;
/** The same line with the credential removed — the attribution control. */
const CARRIER_NO_SECRET = `sync failed for ${PII} on Project ${CODENAME} key=`;

const one = (key: string, value: unknown): string =>
  String(redactRecord({ [key]: value })[key]);

describe("24.132 — a scrub does not waive the field type gate", () => {
  it("the_companion_PII_does_not_survive_a_scrub_under_an_id_field", () => {
    expect(one("correlationId", CARRIER)).not.toContain(PII);
  });

  it("the_companion_CODENAME_does_not_survive_a_scrub_under_an_id_field", () => {
    // Separate test, not a second assertion: rule 5 and rule 7 fail independently
    // and a mutation must be able to red exactly one of them.
    expect(one("correlationId", CARRIER)).not.toContain(CODENAME);
  });

  it("a_second_id_field_behaves_identically_it_is_not_one_field_s_quirk", () => {
    expect(one("sourceId", CARRIER)).not.toContain(PII);
  });

  it("the_credential_itself_never_survives_either_way", () => {
    expect(one("correlationId", CARRIER)).not.toContain(SK);
  });
});

describe("24.132 — THE RESIDUAL: a leak that is OPEN BY OWNER DECISION", () => {
  // ⛔⛔ THIS PIN ASSERTS THAT SENSITIVE CONTENT SURVIVES. THAT IS ITS PURPOSE.
  // It is uncomfortable to read, and that is the function: if someone later
  // "fixes" this, the pin REDS and they learn it was A DECISION, not an oversight.
  //
  // ⭐ STATE: DECIDED-AND-UNBUILT, which is NOT the same as unruled-and-unbuilt.
  // The owner was given the measurement and the options and chose to keep today's
  // behaviour on `errorMessage` / `errorStack` (2026-08-18, recorded on the
  // tracker). A future reader must not close this as an obvious improvement.
  //
  // WHY (the reason travels with the decision, because a decision without its
  // reason cannot be re-decided): error diagnostics are load-bearing during a
  // build, and NOTHING IS ARMED, so the exposure is LOCAL LOGS rather than EGRESS.
  // ⛔⛔ BOTH HALVES ARE TIME-BOUND AND NEITHER SURVIVES GO-LIVE BY ITSELF.
  //
  // ⛔ WHERE THE EXPIRY LIVES IS **NOT HERE**: it is recorded at the head of the
  // arming-ledger section, so every future crossing walks past the question "does
  // this arming change where errorMessage/errorStack content can travel?" This
  // comment POINTS at that; it is deliberately not the only copy, because a note
  // on a task is invisible from the place a decision expires.
  //
  // ⛔ THE STRUCTURAL REASON THE TYPE GATE CANNOT HELP HERE: `errorMessage` and
  // `errorStack` have NO vocabulary at all — `isSafeFieldValue` returns false for
  // EVERY possible value — so enforcing it would not tighten anything, it would
  // delete the field. That is why this is a trade and not a bug.
  //
  // ⛔ THE THIRD OPTION IS REFUSED-FOR-NOW, WITH PROVENANCE, AND IS NOT A FALLBACK:
  // giving these fields a real raw-content-shape predicate was attempted TWICE and
  // REFUTED BOTH TIMES — the module header records v0 (a length/multiline
  // heuristic) and v1 (a syntactic token-shape gate) and why each failed.
  const CARRIER = `sync failed for ${PII} on Project ${CODENAME} key=${SK}`;

  it("OPEN BY DECISION — companion PII survives under `errorMessage`", () => {
    // The credential is still removed; it is the COMPANION content that survives.
    expect(one("errorMessage", CARRIER)).toContain(PII);
  });

  it("OPEN BY DECISION — the employer codename survives under `errorMessage`", () => {
    // Separate assertion: this is the rule-5 half and it must be attributable
    // independently of the rule-7 half above.
    expect(one("errorMessage", CARRIER)).toContain(CODENAME);
  });

  it("the credential ITSELF is still removed — the decision is scoped, not a blanket", () => {
    expect(one("errorMessage", CARRIER)).not.toContain(SK);
  });

  it("SCOPE CONTROL — the same carrier under a VOCABULARY field does NOT leak", () => {
    // Without this, the pins above read as "redaction is broken." They are not:
    // the waiver is confined to the vocabulary-less fields, and 24.132 closed it
    // everywhere else. This is what makes the residual legible as a boundary.
    expect(one("correlationId", CARRIER)).not.toContain(PII);
  });
});

describe("24.132 — the controls, without which the above is an anecdote", () => {
  it("CONTROL_the_same_line_with_no_credential_is_unchanged_by_this_fix", () => {
    // Identical either side of the change: it already dropped, and must keep
    // dropping for the same reason. Proves the CREDENTIAL is what moved the
    // outcome, not the companion text.
    expect(one("correlationId", CARRIER_NO_SECRET)).toBe(REDACTED_RAW);
  });

  it("CONTROL_a_credential_ALONE_is_still_scrubbed_rather_than_dropped", () => {
    // The genuine gain must survive the fix. Under an id-named key a bare
    // scrubbed marker is not a valid id, so the honest expectation is the
    // fail-safe drop — pinned so a regression here is visible rather than
    // discovered.
    expect(one("correlationId", SK)).not.toContain(SK);
  });

  it("CONTROL_a_legitimate_id_with_NO_secret_is_completely_unaffected", () => {
    // ⛔ `L239`'s enforcement turned on the remedy: check the path the fix exists
    // to SERVE, not only the one it closes. A clean id is not touched by the
    // scrub, so it must reach the gate exactly as it does today and pass.
    expect(one("correlationId", "corr-12345")).toBe("corr-12345");
  });

  it("CONTROL_a_benign_prose_value_with_no_secret_is_unchanged", () => {
    expect(one("correlationId", "nothing sensitive here")).toBe(REDACTED_RAW);
  });

  it("CONTROL_an_unredactable_value_still_drops_to_the_FIELD_marker", () => {
    // The `REDACTED_FIELD` arm must stay distinguishable from `REDACTED_RAW`:
    // "could not be made safe" and "not provably safe by type" are different
    // facts and collapsing them loses the distinction.
    expect(one("correlationId", "the password is hunter2")).toBe(REDACTED_FIELD);
  });

  it("CONTROL_a_non_allowlisted_field_is_still_dropped_value_unseen", () => {
    expect(one("randomField", CARRIER)).toBe(REDACTED_FIELD);
  });
});
