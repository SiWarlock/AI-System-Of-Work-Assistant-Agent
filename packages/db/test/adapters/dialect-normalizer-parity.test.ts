// @sow/db — the two dialect adapters must apply the SAME row-normalizers the SAME number of times.
//
// ⛔ THE DEFECT THIS EXISTS FOR, and it is a MEASURED one rather than a hypothetical (`### 24.146`).
// Task `7.19` added `toSourceDisposition` (DB `null` → absent `workspaceId`) and wired it into
// `getBySourceId`, `getByDispositionKey` and `listByWorkspace` on BOTH dialects and into SQLite's
// `recordDisposition` — and left Postgres's `recordDisposition` returning
// `updated[0] as SourceDispositionRow` straight off `.returning()`.
//
// ⭐⭐ WHY NOTHING CAUGHT IT, and each layer is worth stating because each looks like coverage:
//   • `tsc` — the `as` cast ASSERTS the contract shape instead of producing it, so the compiler had
//     nothing to say. A cast is precisely the construct that silences the type system here.
//   • the dual-dialect contract suite — it RAN both dialects, but the `recordDisposition` case
//     asserted three fields INDIVIDUALLY, so a FOURTH field arriving as `null` was outside what it
//     could see. The suite was thorough for the shape it was written against (`contracts L79`).
//   • review — the two bodies are ~40 lines apart in different files and read as siblings.
//
// ⭐ THE PROPERTY THIS ASSERTS IS DELIBERATELY CRUDE AND THAT IS WHY IT WORKS: not "the adapters are
// equivalent" (undecidable) but "every row-normalizer is INVOKED the same number of times in both."
// A dialect that forgets one call goes RED, which is exactly the shape above.
//
// ⛔ PROVEN TO DISCRIMINATE, not assumed: run against the pre-fix commit `bdce8ca9`, this census
// reports `toSourceDisposition` sqlite=5 / postgres=4. At HEAD it is 5/5. The instrument caught the
// real defect on the real history before it was trusted with a clean result (`contracts L160`: a
// correct answer from an unproven instrument is worse than a wrong one, because the method gets
// reused).
//
// ⚠ WHAT IT IS NOT: a proof of dialect equivalence. It counts CALLS, not behaviour — two adapters
// could invoke the same normalizer the same number of times and still diverge. It closes ONE
// measured class. Stated so nobody reads a green here as "the dialects agree" (`contracts L151`).
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const PKG = resolve(__dirname, "..", "..");
const SQLITE = resolve(PKG, "src/adapters/sqlite/index.ts");
const POSTGRES = resolve(PKG, "src/adapters/postgres/index.ts");

/**
 * Row-normalizer / row-parser helpers, by naming convention. Both adapters use the same two shapes:
 * `to<Model>(row)` for a plain re-shape and `parse<Model>(row)` for a schema re-gate.
 */
const HELPER_RE = /\b(to[A-Z][A-Za-z0-9]*|parse[A-Z][A-Za-z0-9]*)\s*\(/g;

/**
 * A normalizer legitimately applied a DIFFERENT number of times in one dialect goes here, WITH a
 * reason. ⛔ It is empty today and that is the point: a future divergence must be DECLARED, not
 * discovered. Adding an entry is a deliberate act with a written justification; leaving one silent
 * is the defect this file exists to catch (`contracts L232` — discharging a completeness guard is
 * what USING it looks like, but the discharge must be visible in the diff).
 */
const DECLARED_ASYMMETRIES: ReadonlyMap<string, string> = new Map();

const countCalls = (src: string, helper: string): number =>
  src.match(new RegExp(`\\b${helper}\\s*\\(`, "g"))?.length ?? 0;

describe("dialect normalizer parity — a normalizer applied in one adapter and skipped in the other (24.146)", () => {
  const sqlite = readFileSync(SQLITE, "utf8");
  const postgres = readFileSync(POSTGRES, "utf8");

  const helpers = [
    ...new Set([...sqlite.matchAll(HELPER_RE), ...postgres.matchAll(HELPER_RE)].map((m) => m[1]!)),
  ].sort();

  it("NON-VACUITY: both adapters were actually read, and the helper discovery found the known members", () => {
    // ⛔ Without this, a moved file or a broken regex yields an EMPTY helper set and the parity
    // assertion below passes over nothing — the single most likely way this guard rots into a
    // decoration (`contracts L90`: delete the feature and ask whether the guard still passes).
    expect(sqlite.length).toBeGreaterThan(10_000);
    expect(postgres.length).toBeGreaterThan(10_000);
    expect(helpers.length).toBeGreaterThan(10);
    // The specific member whose asymmetry WAS the defect, plus a `parse*`-shaped one, so a regex
    // that silently stopped matching one of the two naming shapes is caught.
    expect(helpers).toContain("toSourceDisposition");
    expect(helpers).toContain("parseStoredWorkspace");
  });

  it("every row-normalizer is invoked the SAME number of times in both dialect adapters", () => {
    const asymmetric: string[] = [];
    for (const helper of helpers) {
      const s = countCalls(sqlite, helper);
      const p = countCalls(postgres, helper);
      if (s === p) continue;
      if (DECLARED_ASYMMETRIES.has(helper)) continue;
      asymmetric.push(`${helper}: sqlite=${s} postgres=${p}`);
    }
    // The message names the offenders, because "expected 1 to be 0" would send the next reader
    // hunting through 50 methods.
    expect(asymmetric, `undeclared dialect normalizer asymmetry — one adapter skips a normalizer the other applies:\n  ${asymmetric.join("\n  ")}`).toEqual([]);
  });

  it("the CALL-COUNT proxy is stated honestly: equal counts do NOT prove equal behaviour", () => {
    // A documentation assertion with a real subject: the exemption map must stay empty-or-explained,
    // so a future engineer cannot silence a real divergence by adding a bare key.
    for (const [helper, reason] of DECLARED_ASYMMETRIES) {
      expect(reason.length, `declared asymmetry for ${helper} must carry a reason`).toBeGreaterThan(20);
    }
  });
});
