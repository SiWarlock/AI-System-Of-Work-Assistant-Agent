// Task 24.130 deposit 2 — the BENIGN-KEYWORD POSTURE DROP on a SHORT, HUMAN-CHOSEN
// IDENTIFIER (a workspace name/slug).
//
// THE DEFECT (`### 24.102`'s accepted-cost note): `apps/worker/src/api/procedures/
// systemHealth.ts`'s `toUiSafeEgressStatus` redacts a workspace's egress-status
// projection by calling `redactString(status.workspaceId)` directly. `redactString`
// re-checks its scrub with `looksUnsafe`, which includes `SENSITIVE_KEYWORD` — a
// `\b`-delimited bare-word net built for PROSE and machine-generated AUDIT REFS.
// A workspace id is neither: it is a short, HUMAN-CHOSEN NAME, and a person can
// legitimately name a workspace `acme-credential-review` (a project about
// credential review) without the name carrying a credential. Five witnesses,
// measured at task 24.102: `client-secret-audit`, `bearer-bonds`,
// `passphrase-team`, `my-api-key-ws`, `acme-credential-review` — none holds a
// secret, all five are dropped WHOLE by the keyword arm today.
//
// THE FIX, same shape as task 24.123's COMMIT-granularity split, applied to a
// THIRD granularity 24.123 never covered: `looksLikeCredentialShape` /
// `redactStructuredIdentifier` drop `SENSITIVE_KEYWORD` and keep only the
// credential-SHAPE nets (`CREDENTIAL_PREFIX`, `URL_USERINFO_CREDENTIAL`) — a real
// leaked key/URL-credential still refuses; a bare word inside a chosen name does
// not.
import { describe, it, expect } from "vitest";
import {
  looksUnsafe,
  looksLikeCredentialShape,
  SENSITIVE_KEYWORD,
  SPAN_PRESERVING_FILLER,
} from "../../src/redaction/redaction-rules";
import { redactStructuredIdentifier } from "../../src/redaction/redact";
import { REDACTED_CREDENTIAL, REDACTED_FIELD } from "@sow/contracts";

// The five witnesses measured at task 24.102, none holding a secret.
const BENIGN_WITNESSES: readonly string[] = [
  "client-secret-audit",
  "bearer-bonds",
  "passphrase-team",
  "my-api-key-ws",
  "acme-credential-review",
];

describe("24.130 deposit 2 — BEFORE: the keyword-inclusive predicate drops every benign witness", () => {
  it("reproduces the accepted-cost note: looksUnsafe trips on all five", () => {
    // Established FIRST as the failing-before-fix baseline — a control that itself
    // never trips would make the fix below vacuous.
    for (const w of BENIGN_WITNESSES) {
      expect(looksUnsafe(w), `looksUnsafe(${JSON.stringify(w)}) expected true (pre-fix baseline)`).toBe(
        true,
      );
    }
  });

  it("DISCRIMINATES: each witness trips because of SENSITIVE_KEYWORD specifically, not a credential shape", () => {
    for (const w of BENIGN_WITNESSES) {
      expect(
        SENSITIVE_KEYWORD.test(w),
        `${JSON.stringify(w)} expected to trip SENSITIVE_KEYWORD — if it doesn't, looksUnsafe's true above has a different cause`,
      ).toBe(true);
    }
  });
});

describe("24.130 deposit 2 — AFTER: looksLikeCredentialShape admits every benign witness", () => {
  it("none of the five benign witnesses trips the shape-only predicate", () => {
    for (const w of BENIGN_WITNESSES) {
      expect(
        looksLikeCredentialShape(w),
        `looksLikeCredentialShape(${JSON.stringify(w)}) expected false`,
      ).toBe(false);
    }
  });

  it("redactStructuredIdentifier passes every benign witness through UNCHANGED", () => {
    for (const w of BENIGN_WITNESSES) {
      expect(redactStructuredIdentifier(w)).toBe(w);
    }
  });
});

describe("24.130 deposit 2 — a genuine credential SHAPE still refuses (the fix must not become a leak)", () => {
  const SHAPES: readonly string[] = [
    "sk-ant-api03-abcdefghijklmnop",
    "AKIA0123456789ABCDEF",
    "//user:realsecret@host",
    "https://user:realsecret@host/path",
    "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----",
  ];

  it("looksLikeCredentialShape still trips on every genuine shape", () => {
    for (const s of SHAPES) {
      expect(looksLikeCredentialShape(s), `expected true for ${JSON.stringify(s)}`).toBe(true);
    }
  });

  it("redactStructuredIdentifier never emits the shape verbatim", () => {
    for (const s of SHAPES) {
      const out = redactStructuredIdentifier(s);
      expect(out).not.toBe(s);
      expect(out === REDACTED_FIELD || out.includes(REDACTED_CREDENTIAL)).toBe(true);
    }
  });

  it("CONTROL: still refuses without the fix in place too — looksUnsafe agrees on direction", () => {
    // Non-vacuity for the SHAPES table itself: if looksUnsafe (the old, wider
    // predicate) did NOT also flag these, the shape list would not be exercising
    // real credential shapes.
    for (const s of SHAPES) {
      expect(looksUnsafe(s), `looksUnsafe(${JSON.stringify(s)}) expected true`).toBe(true);
    }
  });
});

describe("24.130 deposit 2 — marker-filler safety (task 24.129's class, re-derived for the new predicate)", () => {
  it("looksLikeCredentialShape does not trip on the bare span-preserving filler alone", () => {
    expect(looksLikeCredentialShape(SPAN_PRESERVING_FILLER)).toBe(false);
  });

  it("a successfully-scrubbed marker does not get whole-dropped on re-check (idempotency)", () => {
    expect(redactStructuredIdentifier(REDACTED_CREDENTIAL)).toBe(REDACTED_CREDENTIAL);
  });

  it("a marker landing inside a userinfo span does not re-trip via the marker's OWN internal colon (task 24.120's class, re-derived)", () => {
    // Without stripping, the marker literal's own internal colon
    // (`[REDACTED:credential]`) can supply the delimiter URL_USERINFO_CREDENTIAL
    // needs, making an ALREADY-scrubbed value look unsafe again purely because of
    // the marker's own text — the exact failure task 24.120 fixed for `looksUnsafe`,
    // re-derived here because `looksLikeCredentialShape` is a separate predicate
    // with its own stripping call.
    expect(looksLikeCredentialShape(`//user${REDACTED_CREDENTIAL}@host`)).toBe(false);
  });

  it("DISCRIMINATION: a synthetic filler-admitting net would fail the property this suite assumes", () => {
    // Mirrors marker-filler-property.test.ts's own discrimination check — proves
    // the assertion above is not vacuously true for every regex.
    const hypotheticalFutureNet = /\^/;
    expect(hypotheticalFutureNet.test(SPAN_PRESERVING_FILLER)).toBe(true);
  });
});

describe("24.130 deposit 2 — a real credential shape hiding inside an id-charset string is still caught", () => {
  it("an AKIA-shaped value glued into an otherwise id-charset-legal string still refuses", () => {
    // `isSafeStructuredToken`'s id charset ([A-Za-z0-9_:.-]) would ADMIT this
    // string as shape-legal for an id — proving the fix is not merely "if it looks
    // like an id, let it through": the credential-shape nets still run regardless.
    const idShapedButCredential = "ws-AKIA0123456789ABCDEF-prod";
    expect(looksLikeCredentialShape(idShapedButCredential)).toBe(true);
    expect(redactStructuredIdentifier(idShapedButCredential)).not.toBe(idShapedButCredential);
  });
});
