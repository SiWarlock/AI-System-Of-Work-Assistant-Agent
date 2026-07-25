// spec(§12 · REQ-F-017 · MTG-4) — task 12.16 (no-inference VALIDATOR leg).
//
// §12 DoD proof-spine, the DETERMINISTIC no-inference guarantee. Certifies
// REQ-F-017 — extraction NEVER invents a task owner/date: an unstated value is
// emitted as the `TBD` sentinel (or routed to clarification), and any concrete
// claim MUST cite evidence — as a HARD-REJECT over the 23-entry labeled
// meeting-closeout corpus (12.2), with NO live model. It exercises the EXISTING
// `@sow/domain` oracle `validateNoInference()` directly (the provider-free
// boundary) — a well-behaved run's gold extraction PASSES, and the fabricated
// "invented owner/date" variant REQ-F-017 forbids is REJECTED.
//
// Provider-free + read-only (ING-7 posture): the suite imports NO provider /
// runtime / model, calls nothing external, and never mutates the corpus — it only
// reads the gold labels. Pure + deterministic (no clock/network/random): identical
// input ⇒ identical verdict set (replay-safe).
//
// Scope (12.16 split): this is the validator leg ONLY. The sibling meeting-closeout
// 1:1 acceptance e2e leg (`meeting-closeout-e2e.test.ts`) needs a live conformant
// provider ⇒ deferred / owner-gated; 12.16 stays `[~]` until it lands. It is NOT
// scored through the criteria-registry runner: "no-inference" is not one of the 19
// §20.1 acceptance rows (it is folded into MEETING_CLOSEOUT_REPLAY, which is
// requiresRealIntegration=true / the deferred e2e leg) — so this deterministic leg
// asserts its HARD 100% floor directly, not via a soft registry threshold.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isOk } from "@sow/contracts";
import { validateNoInference, TBD } from "@sow/domain";
import type { ExtractionField } from "@sow/domain";
import { loadCorpus, type CorpusManifest } from "../../src/harness/corpus-loader";
import { CORPUS_FLOORS, type MeetingCorpusEntry } from "../../src/harness/corpus-schemas";

// ---------------------------------------------------------------------------
// Corpus load — through the REAL verified loader (12.1). A tampered / unversioned
// / hash-mismatched / below-floor corpus surfaces the loader's typed error HERE,
// so every assertion below runs over a vouched-for 23-entry set.
// ---------------------------------------------------------------------------
const CORPORA = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "corpora");

function loadMeetingCorpus(): readonly MeetingCorpusEntry[] {
  const dir = resolve(CORPORA, "meeting-closeout");
  const manifest = JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8")) as CorpusManifest;
  const entries = JSON.parse(readFileSync(resolve(dir, "entries.json"), "utf8")) as MeetingCorpusEntry[];
  const r = loadCorpus<MeetingCorpusEntry>(manifest, entries, {
    expectedFloor: CORPUS_FLOORS.meetingCloseout,
  });
  expect(
    isOk(r),
    isOk(r) ? "" : `meeting-closeout corpus failed to load: ${JSON.stringify((r as { error: unknown }).error)}`,
  ).toBe(true);
  return entries;
}

const ENTRIES = loadMeetingCorpus();
const NO_INFERENCE_ENTRIES = ENTRIES.filter((e) => e.noInference);

// ---------------------------------------------------------------------------
// Corpus gold → the abstract evidence-backed ExtractionField shape the oracle
// checks. Each gold task contributes an `owner` + a `due` field: an unstated value
// is the `TBD` sentinel; a concrete value carries the task's evidence-ref. This is
// the COMPLIANT extraction — what a well-behaved run emits — so it MUST pass.
// ---------------------------------------------------------------------------
function goldFields(entry: MeetingCorpusEntry): Record<string, ExtractionField<unknown>> {
  const fields: Record<string, ExtractionField<unknown>> = {};
  entry.gold.tasks.forEach((t, i) => {
    fields[`task${i}_owner`] =
      t.owner === TBD ? { value: TBD } : { value: t.owner, evidenceRef: t.evidenceRef };
    fields[`task${i}_due`] =
      t.due === TBD ? { value: TBD } : { value: t.due, evidenceRef: t.evidenceRef };
  });
  return fields;
}

// FABRICATE the invented-value variant REQ-F-017 forbids: replace every unstated
// (`TBD`) owner/date with a concrete value the transcript never stated AND supply
// NO evidence slot — exactly the "invented owner/date" a model must never emit.
// Grounded (stated) fields are left compliant. Returns the field names fabricated
// (each MUST be rejected as `inferred_owner_or_date`).
function fabricatedFields(entry: MeetingCorpusEntry): {
  fields: Record<string, ExtractionField<unknown>>;
  invented: readonly string[];
} {
  const fields: Record<string, ExtractionField<unknown>> = {};
  const invented: string[] = [];
  entry.gold.tasks.forEach((t, i) => {
    const ownerField = `task${i}_owner`;
    const dueField = `task${i}_due`;
    if (t.owner === TBD) {
      fields[ownerField] = { value: "Alice" }; // invented owner, no evidenceRef
      invented.push(ownerField);
    } else {
      fields[ownerField] = { value: t.owner, evidenceRef: t.evidenceRef };
    }
    if (t.due === TBD) {
      fields[dueField] = { value: "2026-07-31" }; // invented date, no evidenceRef
      invented.push(dueField);
    } else {
      fields[dueField] = { value: t.due, evidenceRef: t.evidenceRef };
    }
  });
  return { fields, invented };
}

// ===========================================================================
// (1) corpus loads at floor — the §12 corpus-floor DoD precondition
// ===========================================================================
describe("§12 — the no-inference suite runs over the verified ≥20 meeting-closeout corpus", () => {
  it("loads the labeled corpus through the real loader at the ≥20 floor", () => {
    // spec(§12): the corpus-floor DoD — below-floor / unverifiable ⇒ typed load error.
    expect(ENTRIES.length).toBeGreaterThanOrEqual(CORPUS_FLOORS.meetingCloseout);
  });

  it("carries both no-inference (TBD) fixtures AND grounded fixtures to exercise both controls", () => {
    expect(NO_INFERENCE_ENTRIES.length).toBeGreaterThan(0);
    expect(ENTRIES.filter((e) => !e.noInference).length).toBeGreaterThan(0);
  });
});

// ===========================================================================
// (2) invented owner/date REJECTS (REQ-F-017)
// ===========================================================================
describe("REQ-F-017 — an invented (unstated) owner/date is REJECTED, never fabricated", () => {
  for (const entry of NO_INFERENCE_ENTRIES) {
    it(`${entry.id}: fabricating each unstated owner/date rejects as inferred_owner_or_date`, () => {
      // spec(REQ-F-017): a concrete owner/date presented with NO backing → hard reject.
      const { fields, invented } = fabricatedFields(entry);
      expect(invented.length, `${entry.id}: a noInference fixture must carry a TBD to fabricate`).toBeGreaterThan(0);
      const r = validateNoInference(fields);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        const byField = new Map(r.error.map((x) => [x.field, x.code]));
        for (const f of invented) {
          expect(byField.get(f), `${entry.id}: invented ${f} must be rejected`).toBe("inferred_owner_or_date");
        }
      }
    });
  }

  it("a concrete owner/date with an empty evidence slot is rejected as missing_evidence (sibling code)", () => {
    // spec(REQ-F-017): a claim that gestures at backing but supplies none is still a reject.
    const entry = NO_INFERENCE_ENTRIES[0]!;
    const fields: Record<string, ExtractionField<unknown>> = {};
    const invented: string[] = [];
    entry.gold.tasks.forEach((t, i) => {
      if (t.owner === TBD) {
        fields[`task${i}_owner`] = { value: "Alice", evidenceRef: "   " };
        invented.push(`task${i}_owner`);
      }
      if (t.due === TBD) {
        fields[`task${i}_due`] = { value: "2026-07-31", evidenceRef: "" };
        invented.push(`task${i}_due`);
      }
    });
    expect(invented.length).toBeGreaterThan(0);
    const r = validateNoInference(fields);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      const byField = new Map(r.error.map((x) => [x.field, x.code]));
      for (const f of invented) expect(byField.get(f)).toBe("missing_evidence");
    }
  });
});

// ===========================================================================
// (3) grounded / TBD gold extraction PASSES (REQ-F-017 — no false reject)
// ===========================================================================
// Depends on the corpus-grounding invariant (every CONCRETE gold owner/date carries
// a non-empty evidenceRef) — owned + asserted by `test/corpora/corpora-floors.test.ts`.
// If a concrete gold task were ever ungrounded, this block would fail with a
// `missing_evidence` reject; that is a corpus-integrity defect, caught there.
describe("REQ-F-017 — the evidence-grounded / TBD gold extraction PASSES (no false reject)", () => {
  for (const entry of ENTRIES) {
    it(`${entry.id}: the compliant gold owner/date extraction passes validateNoInference`, () => {
      // spec(REQ-F-017): a stated (evidence-backed) value is preserved, NOT forced to TBD;
      // an unstated value is allowed as the TBD sentinel — the oracle must not over-reject.
      const r = validateNoInference(goldFields(entry));
      expect(r.ok, entry.id).toBe(true);
      if (r.ok) {
        // a concrete (stated) owner/date is preserved verbatim, never coerced to TBD.
        entry.gold.tasks.forEach((t, i) => {
          if (t.owner !== TBD) expect(r.value[`task${i}_owner`]?.value).toBe(t.owner);
          if (t.due !== TBD) expect(r.value[`task${i}_due`]?.value).toBe(t.due);
        });
      }
    });
  }
});

// ===========================================================================
// (4) HARD 100% floor — a safety invariant, not a soft recall bar
// ===========================================================================
describe("REQ-F-017 — no-inference scores at a HARD 100% floor (safety invariant)", () => {
  it("100% of invented values reject AND 100% of gold extractions pass — one leak fails the suite", () => {
    // spec(REQ-F-017): no-inference is a hard-reject invariant. A soft ≥0.9 recall bar
    // would let a fabricated owner/date slip through — the floor here is exactly 1.0.
    let totalInvented = 0;
    let rejectedInvented = 0;
    let goldPassed = 0;
    for (const entry of ENTRIES) {
      if (validateNoInference(goldFields(entry)).ok) goldPassed += 1;
      const { fields, invented } = fabricatedFields(entry);
      if (invented.length === 0) continue;
      totalInvented += invented.length;
      const r = validateNoInference(fields);
      if (!r.ok) {
        const rejected = new Set(r.error.map((x) => x.field));
        rejectedInvented += invented.filter((f) => rejected.has(f)).length;
      }
    }
    expect(goldPassed).toBe(ENTRIES.length); // every compliant extraction passes
    expect(totalInvented).toBeGreaterThan(0);
    expect(rejectedInvented).toBe(totalInvented); // every fabricated value rejected — no exceptions
    expect(rejectedInvented / totalInvented).toBe(1); // exactly 1.0, NOT a soft >= 0.9 bar
  });
});

// ===========================================================================
// (5) provider-free + read-only (ING-7 / candidate-data)
// ===========================================================================
describe("ING-7 — the suite is provider-free, pure, and read-only over the corpus", () => {
  it("the oracle is deterministic (replay-safe) and never mutates the loaded corpus", () => {
    // spec(REQ-S-006/ING-7): no model/provider call, no clock/network/random; the
    // untrusted transcript + gold labels are read-only — validating touches nothing.
    const before = JSON.stringify(ENTRIES);
    const sample = ENTRIES[0]!;
    const first = validateNoInference(goldFields(sample));
    const second = validateNoInference(goldFields(sample));
    expect(first).toEqual(second); // identical input ⇒ identical verdict
    expect(JSON.stringify(ENTRIES)).toBe(before); // corpus untouched (read-only posture)
  });
});
