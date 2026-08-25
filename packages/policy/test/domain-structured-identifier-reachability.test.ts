// DEPOSIT-2 WIRING (task 24.130 deposit 2 follow-up) — the MECHANISM landed in
// `@sow/domain` (`looksLikeCredentialShape` + `redactStructuredIdentifier`,
// exhaustively unit-tested in `packages/domain/test/redaction/
// identifier-benign-keyword.test.ts` via RELATIVE imports into `src/`), but no
// test anywhere in the monorepo reaches either symbol through the PACKAGE
// BOUNDARY (`from "@sow/domain"`) the way a real cross-package consumer must.
//
// THAT IS A DISTINCT PROPERTY FROM CORRECTNESS, AND IT HAS ALREADY REGRESSED
// ONCE: `redact.ts`'s own comment (task 24.135) records that `SPAN_PRESERVING_
// FILLER` and `CREDENTIAL_NETS` were fully implemented and unit-tested inside
// `redaction-rules.ts` while OMITTED from `redact.ts`'s re-export block — so
// `@sow/domain`'s public barrel (`src/index.ts`, which is `export * from
// "./redaction/redact"`) could not name them, and nothing red until a
// cross-package consumer went looking. A relative-import unit test cannot
// catch that class of defect by construction: it never crosses the boundary
// the omission breaks.
//
// This file is the reachability pin for the SAME class, for the two symbols
// this deposit lands. It belongs HERE (not inside `packages/domain/test/`)
// because a package cannot prove its own export surface by importing itself —
// `packages/domain/node_modules/@sow/` holds no self-symlink (measured; only
// `contracts` is linked, domain's actual dependency), and no test anywhere in
// this monorepo imports a package's own alias from inside that package's own
// test suite. `packages/policy` is a REAL, already-wired consumer of
// `@sow/domain` (`delegation-cost-measurement.test.ts`, `audit-signal.ts`
// itself), so importing from `"@sow/domain"` here exercises the actual
// resolution path a consumer uses.
//
// ⛔ NOT A CORRECTNESS RE-TEST: the assertions below are a SUBSET of
// `identifier-benign-keyword.test.ts`'s, kept just large enough to prove both
// symbols are live and non-trivial through the real barrel — not to
// re-establish behavior already pinned exhaustively at the unit level.
//
// KNOWN CONSUMER THIS UNBLOCKS, NOT WIRED HERE (cross-territory —
// `packages/knowledge`, not `packages/policy`/`packages/domain`):
// `packages/knowledge/src/gcl/projection.ts:120` calls
// `auditFieldContainsSecret(workspaceId)` — the KEYWORD-INCLUSIVE predicate —
// directly on a bare `workspaceId`, which is exactly the class task 24.102
// filed against `systemHealth.ts`'s `toUiSafeEgressStatus`. Adopting
// `looksLikeCredentialShape`/`redactStructuredIdentifier` there is a
// `packages/knowledge` edit and is out of scope for this file.
import { describe, it, expect } from "vitest";
import { looksLikeCredentialShape, redactStructuredIdentifier } from "@sow/domain";
import { REDACTED_CREDENTIAL, REDACTED_FIELD } from "@sow/contracts";

describe("DEPOSIT-2 wiring — looksLikeCredentialShape / redactStructuredIdentifier reach @sow/domain's public barrel", () => {
  it("both symbols are live functions when imported via the package specifier, not merely inside src/", () => {
    expect(typeof looksLikeCredentialShape).toBe("function");
    expect(typeof redactStructuredIdentifier).toBe("function");
  });

  it("a benign, human-chosen identifier (task 24.102's witnesses) is admitted through the real barrel", () => {
    // Same five witnesses `identifier-benign-keyword.test.ts` measured at
    // 24.102: short workspace names that legitimately contain a credential-ish
    // WORD without carrying a credential.
    for (const w of [
      "client-secret-audit",
      "bearer-bonds",
      "passphrase-team",
      "my-api-key-ws",
      "acme-credential-review",
    ]) {
      expect(looksLikeCredentialShape(w), `looksLikeCredentialShape(${JSON.stringify(w)})`).toBe(
        false,
      );
      expect(redactStructuredIdentifier(w)).toBe(w);
    }
  });

  it("a genuine credential SHAPE still refuses through the real barrel (the reachability pin must not become a leak)", () => {
    for (const s of ["sk-ant-api03-abcdefghijklmnop", "//user:realsecret@host"]) {
      expect(looksLikeCredentialShape(s), `looksLikeCredentialShape(${JSON.stringify(s)})`).toBe(
        true,
      );
      const out = redactStructuredIdentifier(s);
      expect(out).not.toBe(s);
      expect(out === REDACTED_FIELD || out.includes(REDACTED_CREDENTIAL)).toBe(true);
    }
  });

  it("DISCRIMINATION: the pin is not vacuous — a barrel omission (relative-only export) would fail this suite", () => {
    // If `looksLikeCredentialShape`/`redactStructuredIdentifier` were removed
    // from `redact.ts`'s re-export block (24.135's exact regression shape),
    // the two imports above would be `undefined` at the top of this module and
    // EVERY test in this file would fail at the `typeof` assertion, not silently
    // pass. Stated rather than left implicit, per this repo's own discipline
    // that a control which cannot fail is not a control.
    expect(looksLikeCredentialShape).toBeDefined();
    expect(redactStructuredIdentifier).toBeDefined();
  });
});
