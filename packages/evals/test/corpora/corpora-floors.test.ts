// spec(§12/§18.1/§5.4 · tasks 12.2/12.3) — EVAL-1 corpora integrity + floors.
//
// Loads every checked-in corpus through the REAL `loadCorpus` (task 12.1) — so a
// tampered entry, an unversioned/hash-mismatched manifest, or a below-floor
// corpus fails here — and pins the corpus-specific DoD invariants:
//   • meeting-closeout ≥20, incl. no-inference/TBD fixtures (REQ-F-017): a `"TBD"`
//     owner/due ⟺ requiresClarification, and every noInference entry has a TBD.
//   • retrieval ≥30, every query has ≥1 gold doc.
//   • injection: all 5 PRD §16.1 vectors + the cross-workspace exfil vector.
//   • leakage ≥15, every case is Employer-Work-sourced with gold 0 leaked.
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { isOk } from "@sow/contracts";
import { loadCorpus, type CorpusManifest } from "../../src/harness/corpus-loader";
import {
  CORPUS_FLOORS,
  type MeetingCorpusEntry,
  type RetrievalCorpusEntry,
  type InjectionCorpusEntry,
  type LeakageCorpusEntry,
  type InjectionVector,
} from "../../src/harness/corpus-schemas";

const CORPORA = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "corpora");

function load<E>(kind: string, expectedFloor: number): readonly E[] {
  const dir = resolve(CORPORA, kind);
  const manifest = JSON.parse(readFileSync(resolve(dir, "manifest.json"), "utf8")) as CorpusManifest;
  const entries = JSON.parse(readFileSync(resolve(dir, "entries.json"), "utf8")) as E[];
  const r = loadCorpus<E>(manifest, entries, { expectedFloor });
  // A hash/version/count/floor failure surfaces the loader's typed error here.
  expect(isOk(r), isOk(r) ? "" : `corpus ${kind} failed to load: ${JSON.stringify((r as { error: unknown }).error)}`).toBe(
    true,
  );
  return entries;
}

describe("meeting-closeout corpus (≥20, no-inference/TBD)", () => {
  const entries = load<MeetingCorpusEntry>("meeting-closeout", CORPUS_FLOORS.meetingCloseout);

  it("meets the ≥20 floor via a verified load", () => {
    expect(entries.length).toBeGreaterThanOrEqual(CORPUS_FLOORS.meetingCloseout);
  });

  it("includes no-inference/TBD fixtures (REQ-F-017)", () => {
    const noInf = entries.filter((e) => e.noInference);
    expect(noInf.length).toBeGreaterThan(0);
    const withTbd = entries.filter((e) => e.gold.tasks.some((t) => t.owner === "TBD" || t.due === "TBD"));
    expect(withTbd.length).toBeGreaterThan(0);
  });

  it("holds the TBD ⟺ requiresClarification invariant (never invents an unstated value)", () => {
    for (const e of entries) {
      const hasTbd = e.gold.tasks.some((t) => t.owner === "TBD" || t.due === "TBD");
      expect(e.gold.requiresClarification, `${e.id}: requiresClarification must equal has-TBD`).toBe(hasTbd);
      if (e.noInference) {
        expect(hasTbd, `${e.id}: noInference fixture must carry a TBD`).toBe(true);
      }
    }
  });

  it("tags every entry to a real workspace and grounds every task with an evidence-ref", () => {
    const workspaces = new Set(["employer-work", "personal-business", "personal-life"]);
    for (const e of entries) {
      expect(workspaces.has(e.gold.workspace)).toBe(true);
      for (const t of e.gold.tasks) expect(t.evidenceRef.length).toBeGreaterThan(0);
    }
  });
});

describe("retrieval corpus (≥30, gold-cited)", () => {
  const entries = load<RetrievalCorpusEntry>("retrieval", CORPUS_FLOORS.retrieval);

  it("meets the ≥30 floor via a verified load", () => {
    expect(entries.length).toBeGreaterThanOrEqual(CORPUS_FLOORS.retrieval);
  });

  it("gives every query ≥1 gold doc", () => {
    for (const e of entries) expect(e.goldDocIds.length).toBeGreaterThanOrEqual(1);
  });
});

describe("injection corpus (5 vectors + cross-workspace exfil)", () => {
  const entries = load<InjectionCorpusEntry>("injection", CORPUS_FLOORS.injection);

  it("covers all six §16.1 vectors", () => {
    const required: InjectionVector[] = [
      "transcript",
      "calendar_description",
      "web_docs",
      "notebooklm_drive",
      "markdown_note",
      "cross_workspace_exfil",
    ];
    const present = new Set(entries.map((e) => e.vector));
    for (const v of required) expect(present.has(v), `missing injection vector: ${v}`).toBe(true);
  });

  it("declares a concrete attack + expected governance outcome per entry (negative-control discipline)", () => {
    const outcomes = new Set(["rejected_at_admission", "read_only_no_side_effect", "plan_only_no_autoapply"]);
    for (const e of entries) {
      expect(e.payload.length).toBeGreaterThan(0);
      expect(e.declaredAttempt.length).toBeGreaterThan(0);
      expect(outcomes.has(e.expectedOutcome)).toBe(true);
    }
  });
});

describe("leakage corpus (≥15, Employer-Work-sourced, gold 0 leaked)", () => {
  const entries = load<LeakageCorpusEntry>("leakage", CORPUS_FLOORS.leakage);

  it("meets the ≥15 floor via a verified load", () => {
    expect(entries.length).toBeGreaterThanOrEqual(CORPUS_FLOORS.leakage);
  });

  it("is Employer-Work-sourced with gold 0 leaked sentences (WS-4/WS-7)", () => {
    for (const e of entries) {
      expect(e.sourceWorkspace).toBe("employer-work");
      expect(e.expectedLeakedSentences).toBe(0);
      expect(e.rawEmployerContent.length).toBeGreaterThan(0);
      expect(e.probe.length).toBeGreaterThan(0);
    }
  });
});
