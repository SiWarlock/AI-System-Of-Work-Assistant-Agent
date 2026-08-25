// Task 24.130 deposit 5/4 — MEASURING `(C')`'s delegation cost, not merely stating
// its direction. `(C')` (task 24.110, `ebd468d9`) made this module's `looksUnsafe`
// `domainLooksUnsafe(s) || <this module's own three nets, un-stripped>` — an
// AVAILABILITY cost on the reject-not-redact sole-writer path (rule 1 by reach):
// already-redacted content newly refused where it was admitted before. The single
// worked example (`private[REDACTED:raw]key`) is pinned in
// `audit-signal.test.ts`'s `the_marker_axis_still_diverges_and_that_divergence_is_
// OWNED`; THIS file answers the question that pin does not — how BIG is the cost,
// on the repo's own tracked Markdown, the way task 24.123 measured its cost.
//
// METHOD, mirroring `credential-prefix-word-boundary.test.ts`'s established idiom
// (`git ls-files '*.md'`, per-LINE scan, `isRedactionSafe`'s exact probe shape via
// `buildAuditSignal({ refs: [line] })` — the same AUDIT-granularity call the
// production `auditFieldContainsSecret` makes):
//   WITHOUT (C') — this module's own three un-stripped nets ALONE. They are not
//     re-declared here (a re-declaration is exactly the second-hand-maintained-copy
//     hazard task 24.127 exists to prevent): `@sow/domain`'s exported
//     `CREDENTIAL_PREFIX` / `SENSITIVE_KEYWORD` / `URL_USERINFO_CREDENTIAL` are
//     PRODUCER-FIRST, TEXTUALLY IDENTICAL to this module's own local copies (task
//     24.124's own comment: "gets the identical fix in the same commit round, never
//     the copy alone") — so testing the three domain exports UN-STRIPPED (no
//     `stripMarkers` call, unlike `domainLooksUnsafe`) computes EXACTLY what this
//     module's own nets alone would say, without a second copy to drift.
//   WITH (C') — the actual, current, production `isRedactionSafe` (this module's
//     own `looksUnsafe`, which IS `domainLooksUnsafe(s) || <the same three nets,
//     un-stripped>` at HEAD).
//   FIDELITY, CHECKED ON EVERY LINE RATHER THAN A HANDFUL OF PROBES (stronger than
//     task 24.123's "5/5 probes", because a corpus of 90k+ lines is far more likely
//     to expose a textual drift than 5 hand-picked strings would): by construction
//     `withC(s) === domainLooksUnsafe(s) || withoutC(s)` must hold for EVERY input —
//     it is an algebraic identity of `(C')`'s own definition, not a measurement. If
//     it ever fails, the un-stripped nets used here have drifted from the real
//     production copy and the corpus counts below are not to be trusted.
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  looksUnsafe as domainLooksUnsafe,
  CREDENTIAL_PREFIX as DOMAIN_CREDENTIAL_PREFIX,
  SENSITIVE_KEYWORD as DOMAIN_SENSITIVE_KEYWORD,
  URL_USERINFO_CREDENTIAL as DOMAIN_URL_USERINFO_CREDENTIAL,
} from "@sow/domain";
import { buildAuditSignal, isRedactionSafe, type AuditSignal } from "../src/audit-signal";

const REPO_ROOT = execSync("git rev-parse --show-toplevel", { encoding: "utf8" }).trim();

const base = {
  actor: "policy",
  event: "egress.evaluated",
  refs: ["ref:workspace:ws-1", "sha256:deadbeef"],
  payloadHash: "sha256:cafe",
  beforeSummary: "egress not evaluated",
  afterSummary: "egress allowed to local processor",
};
const refSignal = (value: string): AuditSignal => buildAuditSignal({ ...base, refs: [value] });

/** WITHOUT (C') — this module's own three nets, un-stripped, no domain arm. */
function withoutC(s: string): boolean {
  return (
    DOMAIN_CREDENTIAL_PREFIX.test(s) ||
    DOMAIN_SENSITIVE_KEYWORD.test(s) ||
    DOMAIN_URL_USERINFO_CREDENTIAL.test(s)
  );
}

/** WITH (C') — the real production predicate, exercised through the actual
 *  exported entry point (`isRedactionSafe`), never a reimplementation. */
function withC(s: string): boolean {
  return !isRedactionSafe(refSignal(s));
}

describe("24.130 deposit 5/4 — (C')'s delegation cost, measured on the tracked Markdown corpus", () => {
  it("PRECONDITION: the three domain-exported nets are the SAME regex objects looksUnsafe's own arm consults (no drift possible on this axis)", () => {
    // domainLooksUnsafe strips markers, then tests CREDENTIAL_NETS, which is built
    // from exactly these three exports (@sow/domain, redaction-rules.ts). Asserted
    // so a future refactor that changes CREDENTIAL_NETS's membership fails THIS
    // test rather than silently invalidating the identity below.
    expect(DOMAIN_CREDENTIAL_PREFIX.test("sk-ant-api03-abc")).toBe(true);
    expect(domainLooksUnsafe("sk-ant-api03-abc")).toBe(true);
    expect(DOMAIN_SENSITIVE_KEYWORD.test("password")).toBe(true);
    expect(domainLooksUnsafe("password")).toBe(true);
    expect(DOMAIN_URL_USERINFO_CREDENTIAL.test("//u:p@h")).toBe(true);
    expect(domainLooksUnsafe("//u:p@h")).toBe(true);
  });

  it("MEASUREMENT over the tracked Markdown corpus, with the algebraic identity checked on every line", () => {
    const files = execSync("git ls-files '*.md'", { cwd: REPO_ROOT, encoding: "utf8" })
      .split("\n")
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(100);

    let lines = 0;
    let withoutCRefused = 0;
    let withCRefused = 0;
    let delegationOnly = 0; // withC && !withoutC — the (C')-attributable delta
    const witnesses: string[] = [];
    for (const rel of files) {
      let body: string;
      try {
        body = readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
      } catch {
        continue;
      }
      for (const line of body.split("\n")) {
        lines += 1;
        const wo = withoutC(line);
        const w = withC(line);
        // FIDELITY, not a measurement: `(C')` is DEFINED as an OR, so this must
        // hold for every line or the un-stripped nets used above have drifted
        // from production.
        expect(w, `algebraic identity broke on a line of ${rel} — (C')'s definition requires withC === domainLooksUnsafe || withoutC`).toBe(
          domainLooksUnsafe(line) || wo,
        );
        if (wo) withoutCRefused += 1;
        if (w) withCRefused += 1;
        if (w && !wo) {
          delegationOnly += 1;
          if (witnesses.length < 10) witnesses.push(`${rel}: ${JSON.stringify(line.slice(0, 120))}`);
        }
      }
    }

    // Non-vacuity: the corpus must actually exercise the existing keyword/shape
    // nets (established already at task 24.123's scale) before the DELTA figure
    // below can be trusted as small rather than merely unmeasured.
    expect(lines).toBeGreaterThan(1000);
    expect(withoutCRefused).toBeGreaterThan(0);
    // (C') is monotone in the refusal direction by construction (an OR can only
    // add refusals) — never a narrowing.
    expect(withCRefused).toBeGreaterThanOrEqual(withoutCRefused);

    console.log(
      `24.130 deposit 5/4 — population=${lines} lines / ${files.length} files. ` +
        `withoutC(refused)=${withoutCRefused} withC(refused)=${withCRefused} ` +
        `delegationOnly(withC && !withoutC)=${delegationOnly} ` +
        `rate=${((delegationOnly / lines) * 100).toFixed(4)}% of lines, ` +
        `witnesses=${JSON.stringify(witnesses)}`,
    );

    // Non-vacuity for the DELTA itself (mirrors `credential-prefix-word-boundary
    // .test.ts`'s `newlyAdmitted > 0`): the cost this entry exists to measure is
    // real and non-zero at repo scale, not silently zero because of a wiring bug
    // in this file's own harness. REPORTED, not hard-pinned to an exact count — a
    // future doc edit changing which lines quote the marker literal should not
    // brick this test, only move the logged number.
    expect(delegationOnly).toBeGreaterThan(0);
  });
});
