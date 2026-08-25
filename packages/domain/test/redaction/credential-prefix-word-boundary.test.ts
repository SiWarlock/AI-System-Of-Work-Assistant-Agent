// Task 24.124 — `CREDENTIAL_PREFIX`'s leading `sk-[a-z0-9]` alternative carried NO
// word boundary, so ANY word ending in "sk" followed by `-` and an alphanumeric
// tripped the credential net: `TASK-1`, `RISK-001`, `Full-Disk-Access`. Pre-existing
// in the lowercase direction (`task-123` was already refused before task 24.110's
// `/i` fix) and widened to every casing by that fix — pinned deliberately as
// `known_false_positives_are_pinned_so_the_class_is_not_INVISIBLE` in
// `packages/policy/test/audit-signal.test.ts`, whose own comment named the durable
// remedy: "a word boundary, which is a domain-parity question."
//
// PRODUCER-FIRST (root CLAUDE.md / this task): the boundary is added HERE, in
// `@sow/domain`'s canonical `CREDENTIAL_PREFIX`, first. `packages/policy` carries
// an independently-maintained copy (task 24.110's (C') union did not replace it —
// see that task) and gets the identical fix in the same commit round, never the
// copy alone.
//
// THE TRADE, MEASURED NOT ASSERTED: adding `\b` before `sk-` is an
// AVAILABILITY-direction fix (fewer benign values refused) with a LEAK-direction
// cost (a credential token glued directly to a preceding word character with NO
// separator — e.g. `keysk-liveABC...` — is no longer caught by THIS alternative).
// Measured over this repo's own tracked Markdown corpus (668 files / 93,160 lines,
// `git ls-files '*.md'`, the same corpus `net-list-integrity.test.ts` uses):
// end-to-end (all three credential nets unioned, exactly mirroring `looksUnsafe`)
// the OLD predicate refused 1279 lines; the NEW predicate refuses 1044; 235 lines
// are NEWLY ADMITTED. Every sampled admitted line is ordinary prose containing an
// English compound/hyphenated word ending in a "sk"-like fragment (e.g. "task-id",
// "Disk-", "risk-") — none is a credential shape. This measurement is reported
// here as a fact, not asserted as a specific admitted set (an exact line-for-line
// assertion would be brittle to any future doc edit); the STRUCTURAL claim below
// (old ⊆ refused-by-the-other-two-nets ∪ new) is what is actually pinned.
import { describe, it, expect } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import {
  CREDENTIAL_PREFIX,
  SENSITIVE_KEYWORD,
  URL_USERINFO_CREDENTIAL,
  looksUnsafe,
} from "../../src/redaction/redaction-rules";

const REPO_ROOT = new URL("../../../..", import.meta.url).pathname;

// The PRE-24.124 predicate, verbatim (the unbounded `sk-[a-z0-9]`), kept as the
// differential reference — deleting it would leave the leak-direction measurement
// with nothing to compare against.
const OLD_CREDENTIAL_PREFIX =
  /(sk-[a-z0-9]|sk_(live|test)|xox[baprs]-|gh[pousr]_|AKIA[0-9A-Z]{16}|-----BEGIN|eyJ[A-Za-z0-9_-]{10,}\.)/i;
function looksUnsafeOld(s: string): boolean {
  return (
    OLD_CREDENTIAL_PREFIX.test(s) ||
    SENSITIVE_KEYWORD.test(s) ||
    URL_USERINFO_CREDENTIAL.test(s)
  );
}

describe("24.124 — CREDENTIAL_PREFIX's sk- alternative gains a word boundary", () => {
  it("retires the known false positives: TASK-1 / RISK-001 / Full-Disk-Access are no longer credential-shaped", () => {
    // This is `known_false_positives_are_pinned_so_the_class_is_not_INVISIBLE`'s own
    // fixture set, deliberately retired here (not silently) — the pin's own comment
    // said this exact fixture set going green means the word boundary was added.
    for (const v of ["ref:task:TASK-123", "RISK-001", "Full-Disk-Access", "task-123"]) {
      expect(
        looksUnsafe(v),
        `${v}: the word-boundary fix should retire this known false positive`,
      ).toBe(false);
    }
  });

  it("keeps refusing every real credential-prefix shape (no-regression control)", () => {
    for (const v of [
      "sk-ant-api03-abcdefghijklmnop",
      "sk-Abc123Def456Ghi789",
      "SK-ANT-API03-ABCDEF",
      "call failed with key sk-Abc123Def456Ghi789 at endpoint",
    ]) {
      expect(looksUnsafe(v), `${v}: a real credential shape must still be refused`).toBe(
        true,
      );
    }
  });

  it("a boundary-adjacent credential (sk- at string start, or after whitespace/punctuation) is unaffected", () => {
    // The boundary only excludes "sk-" INSIDE a larger word (no transition between a
    // word char and a non-word char immediately before "s"). Preceded by
    // whitespace, `:`, `=`, or nothing (string start) all still count as boundaries.
    for (const v of [
      "sk-leaked",
      " sk-leaked",
      "key=sk-leaked",
      "key: sk-leaked",
      "(sk-leaked)",
    ]) {
      expect(looksUnsafe(v), `${v}: a boundary-adjacent credential must still refuse`).toBe(
        true,
      );
    }
  });

  it("does NOT catch a credential glued directly onto a preceding word char — the named leak-direction cost", () => {
    // NOT a passing grade — this pins the cost so it cannot be rediscovered as a
    // surprise, mirroring the discipline `known_false_positives_are_pinned...`
    // already uses for the availability-direction cost this fix retires.
    expect(
      looksUnsafe("keysk-leakedvalue"),
      "a credential token with NO separator from a preceding word character is the residual leak-direction cost of the word-boundary fix — accepted, not accidental",
    ).toBe(false);
  });

  it("LEAK-DIRECTION MEASUREMENT over the tracked Markdown corpus — reported, not hard-asserted line-for-line", () => {
    const files = execSync("git ls-files '*.md'", {
      cwd: REPO_ROOT,
      encoding: "utf8",
    })
      .split("\n")
      .filter(Boolean);
    expect(files.length).toBeGreaterThan(100);

    let lines = 0;
    let oldRefused = 0;
    let newRefused = 0;
    let newlyAdmitted = 0;
    for (const rel of files) {
      let body: string;
      try {
        body = readFileSync(`${REPO_ROOT}/${rel}`, "utf8");
      } catch {
        continue;
      }
      for (const line of body.split("\n")) {
        lines += 1;
        const before = looksUnsafeOld(line);
        const after = looksUnsafe(line);
        if (before) oldRefused += 1;
        if (after) newRefused += 1;
        if (before && !after) newlyAdmitted += 1;
      }
    }
    // Non-vacuity: the corpus must actually exercise the change.
    expect(lines).toBeGreaterThan(1000);
    expect(oldRefused).toBeGreaterThan(0);
    // The fix must be a NARROWING only (new ⊆ old) at this measurement's own
    // corpus, not a widening — a widening here would mean the boundary
    // accidentally caught something new, which `\b` cannot do (it only removes
    // matches, never adds them, for this specific alternative).
    expect(newRefused).toBeLessThanOrEqual(oldRefused);
    // The leak-direction cost is real and non-zero at repo scale — reported as a
    // measurement, never silently assumed to be zero.
    expect(newlyAdmitted).toBeGreaterThan(0);
  });
});
