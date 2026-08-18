// Task 24.120, precondition slice — `looksUnsafe` now iterates `CREDENTIAL_NETS`
// instead of making three hardcoded `.test()` calls, so the marker-filler property
// guard can REFLECT over the net list and cannot go stale when a net is added.
//
// This file pins three things:
//   1. MONOTONICITY — `looksUnsafe` refuses a SUPERSET of the pre-24.120
//      predicate, which is kept below as a reference implementation and compared
//      over the whole Markdown corpus. Nothing refused before may be admitted now.
//      ⚠ This test previously asserted EQUALITY, which proved the net-list
//      refactor was behaviour-preserving; that proof was performed and recorded at
//      commit `65524874` (mutation-proven, restored byte-identical). The 24.120
//      fix then changed behaviour DELIBERATELY, so equality no longer holds and
//      superset-ness is the invariant that survives. The reference implementation
//      is retained rather than deleted — comparing the predicate to a copy of
//      itself would be tautological.
//   2. IMMUTABILITY — the exported array is a rule-7 surface (see the fence at its
//      declaration): a mutable one would let any importer disable a credential net.
//   3. NON-GLOBAL — `.test()` on a `/g` regex advances `lastIndex`, which would
//      make the predicate call-count-dependent and fail intermittently.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import {
  CREDENTIAL_NETS,
  CREDENTIAL_PREFIX,
  SENSITIVE_KEYWORD,
  URL_USERINFO_CREDENTIAL,
  looksUnsafe,
} from "../../src/redaction/redaction-rules";
import {
  REDACTED_CREDENTIAL,
  REDACTED_RAW,
  REDACTED_FIELD,
} from "@sow/contracts";

// The expression `looksUnsafe` used BEFORE the net-list refactor, verbatim.
// Kept as the differential reference — deleting it would leave the equality
// assertion below with nothing to compare against.
const MARKERS: readonly string[] = [
  REDACTED_CREDENTIAL,
  REDACTED_RAW,
  REDACTED_FIELD,
];
function stripMarkersReference(s: string): string {
  let out = s;
  for (const m of MARKERS) out = out.split(m).join(" ");
  return out;
}
function looksUnsafeReference(s: string): boolean {
  const probe = stripMarkersReference(s);
  return (
    CREDENTIAL_PREFIX.test(probe) ||
    SENSITIVE_KEYWORD.test(probe) ||
    URL_USERINFO_CREDENTIAL.test(probe)
  );
}

const REPO_ROOT = new URL("../../../..", import.meta.url).pathname;

/** Constructed inputs that exercise the marker/net interaction directly. */
const CONSTRUCTED: readonly string[] = [
  `//u:p${REDACTED_RAW}q@h`,
  `//user:REALSECRET${REDACTED_RAW}@host`,
  "//user:REALSECRET@host",
  `//user${REDACTED_CREDENTIAL}@host`,
  `//${REDACTED_CREDENTIAL}@host`,
  REDACTED_CREDENTIAL,
  REDACTED_FIELD,
  `private${REDACTED_RAW}key`,
  `my${REDACTED_RAW}password`,
  `pass${REDACTED_RAW}word`,
  `sk-${REDACTED_RAW}abc`,
  `-----BE${REDACTED_FIELD}GIN`,
  "sk-ant-api03-abcdef",
  "the password is here",
  "hello world, nothing to see",
  "",
];

describe("CREDENTIAL_NETS — the net list `looksUnsafe` iterates", () => {
  it("is non-empty and holds every net the predicate is documented to consult", () => {
    // Non-vacuity: every assertion below is meaningless over an empty list.
    expect(CREDENTIAL_NETS.length).toBe(3);
    expect(CREDENTIAL_NETS).toContain(CREDENTIAL_PREFIX);
    expect(CREDENTIAL_NETS).toContain(SENSITIVE_KEYWORD);
    expect(CREDENTIAL_NETS).toContain(URL_USERINFO_CREDENTIAL);
  });

  it("every net is non-global, so `.test()` carries no `lastIndex` state", () => {
    // A `/g` net would make `looksUnsafe` alternate across calls on the same input.
    for (const net of CREDENTIAL_NETS) {
      expect(net.global, `net ${net.source} must not be global`).toBe(false);
      expect(net.sticky, `net ${net.source} must not be sticky`).toBe(false);
    }
  });

  it("cannot be mutated — a disabled net is a rule-7 exposure, not untidiness", () => {
    expect(Object.isFrozen(CREDENTIAL_NETS)).toBe(true);
    const probe = "sk-ant-api03-abcdef";
    expect(looksUnsafe(probe)).toBe(true);
    // Attempt to empty the list the way an importer could; it must not take effect
    // and must not change the verdict.
    expect(() => {
      (CREDENTIAL_NETS as RegExp[]).length = 0;
    }).toThrow();
    expect(CREDENTIAL_NETS.length).toBe(3);
    expect(looksUnsafe(probe)).toBe(true);
  });
});

describe("monotonicity vs the pre-24.120 predicate (differential)", () => {
  it("admits nothing the pre-change predicate refused, on constructed inputs", () => {
    let witnessed = 0;
    for (const s of CONSTRUCTED) {
      if (looksUnsafeReference(s))
        expect(looksUnsafe(s), `newly ADMITTED: ${JSON.stringify(s)}`).toBe(true);
      if (looksUnsafe(s) && !looksUnsafeReference(s)) witnessed += 1;
    }
    // Applicability: superset-ness is vacuous unless the span-preserving arm
    // actually adds refusals. This is the 24.120 fix, seen from the pin.
    expect(witnessed).toBeGreaterThan(0);
  });

  it("admits nothing the pre-change predicate refused, on every line of every tracked Markdown file", () => {
    const files = execSync("git ls-files '*.md'", {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    // Non-vacuity: a corpus that failed to resolve would pass this suite silently.
    expect(files.length).toBeGreaterThan(100);

    let lines = 0;
    let unsafe = 0;
    let newlyRefused = 0;
    for (const rel of files) {
      let body: string;
      try {
        body = readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
      } catch {
        continue;
      }
      for (const line of body.split("\n")) {
        lines += 1;
        const now = looksUnsafe(line);
        const before = looksUnsafeReference(line);
        if (now) unsafe += 1;
        if (before && !now) {
          throw new Error(
            `24.120 newly ADMITTED a line that was refused before, in ${rel}: ${JSON.stringify(line.slice(0, 120))}`,
          );
        }
        if (now && !before) newlyRefused += 1;
      }
    }
    // Applicability: the corpus must exercise BOTH verdicts, or agreement is
    // agreement about nothing.
    expect(lines).toBeGreaterThan(1000);
    expect(unsafe).toBeGreaterThan(0);
    expect(unsafe).toBeLessThan(lines);
    // The corpus is SELF-REFERENTIAL here — the lines the fix newly refuses are
    // the documents describing this defect — so this is recorded as a witness that
    // the arm fires at corpus scale, NOT as a base rate for any vault.
    expect(newlyRefused).toBeGreaterThan(0);
  });
});
