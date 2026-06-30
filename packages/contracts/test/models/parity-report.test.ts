// ParityReport contract test (task WT, §6/§12/§16). RED-first schema-snapshot
// freeze + behavior + conditional-invariant coverage. ParityReport is the
// revision-scoped OPERATIONAL record the ParityReconciler emits each pass: the
// canonical-Markdown-vs-DB fact-count reconciliation plus the per-fact
// Divergence[] it classified, with cleanForServing / coverageComplete gating
// GBrain serving. Embeds the REAL Divergence schema. PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import { ParityReportSchema, PARITY_REPORT_SCHEMA_ID } from "../../src/models/parity-report";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

// A clean, valid base report (no divergences, fully covered). Fixtures spread +
// override a single field so each invalid case is invalid for exactly one reason.
const validReport = {
  reportId: "report-2026-06-30-001",
  workspaceId: "ws-employer",
  reconciledAtRevision: "rev-42",
  gbrainSchemaVersion: 35,
  canonicalFactCount: 128,
  dbFactCount: 128,
  divergences: [],
  cleanForServing: true,
  coverageComplete: true,
} as const;

// A VALID Divergence with a HARD severity floor (db_only parity defect) — valid
// per the embedded Divergence schema's own refine; used to exercise THIS model's
// cleanForServing ↔ hard-floor invariant.
const hardDivergence = {
  factIdentity: "page:employer-work/acme/auth-redesign",
  divergenceClass: "db_only",
  severityFloor: "hard",
  dbContentHash: "deadbeef",
  remediation: "purge",
} as const;

// A VALID benign Divergence (md_only, SOFT floor) — does not block serving.
const softDivergence = {
  factIdentity: "page:personal/notes/x",
  divergenceClass: "md_only",
  severityFloor: "soft",
  remediation: "review",
} as const;

describe("ParityReport contract — spec(§6/§12/§16)", () => {
  // ── Frozen field-name set (the spec, hand-authored in __snapshots__) ──────
  it("freezes its top-level field-name set to the spec snapshot", () => {
    expect(fieldSet(emitJsonSchema(ParityReportSchema, PARITY_REPORT_SCHEMA_ID))).toEqual(
      loadFieldSnapshot("parity-report"),
    );
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ─
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/parity-report.schema.json", import.meta.url),
      emitJsonSchema(ParityReportSchema, PARITY_REPORT_SCHEMA_ID),
    );
  });

  // ── Behaviors ────────────────────────────────────────────────────────────
  it("accepts a clean report with no divergences and oracleFactCount omitted", () => {
    expect(ParityReportSchema.safeParse(validReport).success).toBe(true);
  });

  it("accepts a report with oracleFactCount and a benign (soft) divergence while clean", () => {
    // cleanForServing and coverageComplete are INDEPENDENT report facts: a report
    // can be clean of serving-blocking defects yet not have fully covered the set.
    const ok = ParityReportSchema.safeParse({
      ...validReport,
      dbFactCount: 129,
      oracleFactCount: 128,
      divergences: [softDivergence],
      cleanForServing: true,
      coverageComplete: false,
    });
    expect(ok.success).toBe(true);
  });

  it("accepts counts of zero (nonnegative)", () => {
    expect(
      ParityReportSchema.safeParse({ ...validReport, canonicalFactCount: 0, dbFactCount: 0 })
        .success,
    ).toBe(true);
  });

  it("rejects an unknown top-level key (.strict)", () => {
    expect(ParityReportSchema.safeParse({ ...validReport, extra: "nope" }).success).toBe(false);
  });

  it("rejects an empty/whitespace reportId (branded non-empty)", () => {
    expect(ParityReportSchema.safeParse({ ...validReport, reportId: "   " }).success).toBe(false);
  });

  it("rejects an empty workspaceId (branded non-empty)", () => {
    expect(ParityReportSchema.safeParse({ ...validReport, workspaceId: "" }).success).toBe(false);
  });

  it("rejects an empty/whitespace reconciledAtRevision (branded non-empty)", () => {
    expect(
      ParityReportSchema.safeParse({ ...validReport, reconciledAtRevision: " " }).success,
    ).toBe(false);
  });

  it("rejects a negative count", () => {
    expect(
      ParityReportSchema.safeParse({ ...validReport, canonicalFactCount: -1 }).success,
    ).toBe(false);
  });

  it("rejects a non-integer count", () => {
    expect(ParityReportSchema.safeParse({ ...validReport, dbFactCount: 1.5 }).success).toBe(false);
  });

  it("rejects a negative oracleFactCount when present", () => {
    expect(
      ParityReportSchema.safeParse({ ...validReport, oracleFactCount: -3 }).success,
    ).toBe(false);
  });

  it("rejects a non-number gbrainSchemaVersion", () => {
    expect(
      ParityReportSchema.safeParse({ ...validReport, gbrainSchemaVersion: "35" }).success,
    ).toBe(false);
  });

  it("rejects a non-boolean cleanForServing", () => {
    expect(
      ParityReportSchema.safeParse({ ...validReport, cleanForServing: "yes" }).success,
    ).toBe(false);
  });

  it("rejects a missing required field (coverageComplete)", () => {
    const bad = ParityReportSchema.safeParse({
      reportId: "report-1",
      workspaceId: "ws-employer",
      reconciledAtRevision: "rev-1",
      gbrainSchemaVersion: 35,
      canonicalFactCount: 1,
      dbFactCount: 1,
      divergences: [],
      cleanForServing: true,
    });
    expect(bad.success).toBe(false);
  });

  // ── Embedded REAL Divergence schema (not a free-form object) ───────────────
  it("rejects a divergence with an out-of-lattice divergenceClass (real Divergence embedded)", () => {
    const bad = ParityReportSchema.safeParse({
      ...validReport,
      divergences: [{ ...softDivergence, divergenceClass: "totally_made_up" }],
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a db_only divergence with a SOFT floor (embedded Divergence refine fires)", () => {
    const bad = ParityReportSchema.safeParse({
      ...validReport,
      cleanForServing: false,
      divergences: [{ ...hardDivergence, severityFloor: "soft" }],
    });
    expect(bad.success).toBe(false);
  });

  // ── Conditional invariant: cleanForServing ⇒ no HARD-floor divergence ──────
  // A report carrying a db_only/unstamped (HARD floor) parity defect is "dirty"
  // and degrades the workspace to Markdown-provenanced-only (§12 fail-closed); it
  // cannot simultaneously claim cleanForServing. Passing direction (clean WITH a
  // soft divergence) is covered by the oracle/soft-divergence behavior above.
  it("accepts cleanForServing === false alongside a HARD-floor divergence (refine, passing)", () => {
    const ok = ParityReportSchema.safeParse({
      ...validReport,
      divergences: [hardDivergence],
      cleanForServing: false,
    });
    expect(ok.success).toBe(true);
  });

  it("rejects cleanForServing === true while a HARD-floor divergence is present (refine, failing)", () => {
    const bad = ParityReportSchema.safeParse({
      ...validReport,
      divergences: [hardDivergence],
      cleanForServing: true,
    });
    expect(bad.success).toBe(false);
  });
});
