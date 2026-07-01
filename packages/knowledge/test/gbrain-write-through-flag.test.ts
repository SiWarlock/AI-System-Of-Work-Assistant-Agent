// spec(§6) — WriteThroughEnableFlag (task 4.20, §6/§13; write-through amendment
// invariant (vii) + §13). Per-workspace `writeThroughEnabled` is default OFF
// (read-only/index-only §6 fallback + kill switch); it becomes ACTIVE only when the
// four §12 GO conditions pass LIVE against the pinned SHA + read-token-rejects-write
// + embedding-key GREEN + no cron/autopilot (the 12.22 enablement gate), AND a clean,
// complete latest `ParityReport` proves containment. A dirty/failed/absent ParityReport
// (or a regressed enablement condition) auto-reverts the workspace to
// Markdown-provenanced-only serving. Also proves the typed `config/gbrain.pin`
// re-capture parser round-trips the real file to a contract-valid `GbrainPin`.
import { describe, it, expect } from "vitest";
import type {
  GbrainPin,
  ParityReport,
  WorkspaceId,
  RevisionId,
  AuditId,
} from "@sow/contracts";
import { HealthItemSchema, GbrainPinSchema, ParityReportSchema } from "@sow/contracts";
import {
  evaluateEnablementGate,
  resolveWriteThrough,
  pinValidatedForEnablement,
  parseGbrainPinFile,
  type EnablementConditions,
  type WriteThroughContext,
  type WriteThroughResolveInput,
} from "../src/gbrain/enablement/write-through-flag";

const WS = "ws-employer" as WorkspaceId;
const REV = "rev-current" as RevisionId;

/** All-green enablement conditions (the 12.22 GO gate fully satisfied LIVE). */
function greenConditions(overrides: Partial<EnablementConditions> = {}): EnablementConditions {
  return {
    pinValidated: true,
    pinShaMatchesRunning: true,
    goOneWriter: true,
    goNoLostUpdate: true,
    goParityCatchesDbOnly: true,
    goRoundTripLossless: true,
    readTokenRejectsWrite: true,
    embeddingKeyGreen: true,
    noCronOrAutopilot: true,
    ...overrides,
  };
}

/** A clean, complete ParityReport for WS@REV (containment proven). */
function cleanReport(overrides: Partial<ParityReport> = {}): ParityReport {
  const draft = {
    reportId: "report-1",
    workspaceId: WS as string,
    reconciledAtRevision: REV as string,
    gbrainSchemaVersion: 2,
    canonicalFactCount: 3,
    dbFactCount: 3,
    divergences: [],
    cleanForServing: true,
    coverageComplete: true,
  };
  // Parse to obtain the branded ParityReport (fixture can't drift from the
  // frozen contract), then apply overrides.
  return { ...ParityReportSchema.parse(draft), ...overrides };
}

const ctx: WriteThroughContext = {
  now: () => "2026-07-01T00:00:00.000Z",
  auditRef: "audit-wt-1",
};

function baseInput(overrides: Partial<WriteThroughResolveInput> = {}): WriteThroughResolveInput {
  return {
    workspaceId: WS,
    flagEnabled: true,
    conditions: greenConditions(),
    latestParityReport: cleanReport(),
    ...overrides,
  };
}

describe("evaluateEnablementGate — the 12.22 promotion gate", () => {
  it("all four GO conditions + pin-promoted + read-token + embedding + no-cron ⇒ may promote", () => {
    const r = evaluateEnablementGate(greenConditions());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.allGreen).toBe(true);
  });

  it("a PENDING pin (not promoted) blocks the flip", () => {
    const r = evaluateEnablementGate(greenConditions({ pinValidated: false }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.unmet).toContain("pin_pending_validation");
  });

  it("a SHA mismatch vs the ACTUAL pinned build blocks the flip", () => {
    const r = evaluateEnablementGate(greenConditions({ pinShaMatchesRunning: false }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.unmet).toContain("pin_sha_mismatch");
  });

  it("each unmet §12 GO condition is reported by its own code", () => {
    const r = evaluateEnablementGate(
      greenConditions({
        goOneWriter: false,
        goNoLostUpdate: false,
        goParityCatchesDbOnly: false,
        goRoundTripLossless: false,
      }),
    );
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.unmet).toEqual(
      expect.arrayContaining([
        "go1_one_writer_unproven",
        "go2_lost_update_unproven",
        "go3_parity_unproven",
        "go4_round_trip_unproven",
      ]),
    );
  });

  it("read-token-accepts-write, a noEmbed index, or an installed cron each block the flip", () => {
    const unmetFor = (overrides: Partial<EnablementConditions>): readonly string[] => {
      const r = evaluateEnablementGate(greenConditions(overrides));
      return r.ok ? [] : r.error.unmet;
    };
    expect(unmetFor({ readTokenRejectsWrite: false })).toContain("read_token_accepts_write");
    expect(unmetFor({ embeddingKeyGreen: false })).toContain("embedding_key_not_green");
    expect(unmetFor({ noCronOrAutopilot: false })).toContain("cron_or_autopilot_installed");
  });
});

describe("resolveWriteThrough — default OFF is the fallback + kill switch", () => {
  it("flag default OFF ⇒ read-only/index-only, NOT a fault (no HealthItem), even when everything else is green", () => {
    const r = resolveWriteThrough(baseInput({ flagEnabled: false }), ctx);
    expect(r.active).toBe(false);
    expect(r.mode).toBe("read_only_index_only");
    expect(r.reason).toBe("flag_default_off");
    expect(r.healthItem).toBeUndefined();
  });
});

describe("resolveWriteThrough — enablement flip (all green + clean parity)", () => {
  it("flag ON + gate green + clean/complete ParityReport ⇒ write-through ACTIVE", () => {
    const r = resolveWriteThrough(baseInput(), ctx);
    expect(r.active).toBe(true);
    expect(r.mode).toBe("write_through_enabled");
    expect(r.reason).toBe("enabled_all_green");
    expect(r.healthItem).toBeUndefined();
  });
});

describe("resolveWriteThrough — auto-revert to Markdown-provenanced-only (fail-closed)", () => {
  it("a DIRTY ParityReport (cleanForServing=false) auto-reverts + opens a write_through_failed HealthItem", () => {
    const r = resolveWriteThrough(
      baseInput({ latestParityReport: cleanReport({ cleanForServing: false }) }),
      ctx,
    );
    expect(r.active).toBe(false);
    expect(r.mode).toBe("markdown_provenanced_only");
    expect(r.reason).toBe("parity_dirty");
    expect(r.healthItem?.failureClass).toBe("write_through_failed");
    expect(r.healthItem?.state).toBe("open");
    expect(r.healthItem?.openedAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("an INCOMPLETE ParityReport (coverageComplete=false) auto-reverts", () => {
    const r = resolveWriteThrough(
      baseInput({ latestParityReport: cleanReport({ coverageComplete: false }) }),
      ctx,
    );
    expect(r.active).toBe(false);
    expect(r.mode).toBe("markdown_provenanced_only");
    expect(r.reason).toBe("parity_incomplete");
    expect(r.healthItem).toBeDefined();
  });

  it("an ABSENT ParityReport fails closed (cannot prove containment ⇒ revert)", () => {
    const r = resolveWriteThrough(baseInput({ latestParityReport: undefined }), ctx);
    expect(r.active).toBe(false);
    expect(r.mode).toBe("markdown_provenanced_only");
    expect(r.reason).toBe("parity_report_absent");
    expect(r.healthItem).toBeDefined();
  });

  it("a ParityReport for a DIFFERENT workspace does not count as containment (treated absent)", () => {
    const foreign = cleanReport({ workspaceId: "ws-other" as unknown as WorkspaceId });
    const r = resolveWriteThrough(baseInput({ latestParityReport: foreign }), ctx);
    expect(r.active).toBe(false);
    expect(r.reason).toBe("parity_report_absent");
  });

  it("a REGRESSED enablement condition (with the flag still ON) auto-reverts + reports the unmet set", () => {
    const r = resolveWriteThrough(
      baseInput({ conditions: greenConditions({ pinShaMatchesRunning: false }) }),
      ctx,
    );
    expect(r.active).toBe(false);
    expect(r.mode).toBe("markdown_provenanced_only");
    expect(r.reason).toBe("enablement_conditions_unmet");
    expect(r.unmet).toContain("pin_sha_mismatch");
    expect(r.healthItem?.failureClass).toBe("write_through_failed");
  });

  it("every emitted HealthItem passes the frozen HealthItem contract schema", () => {
    for (const input of [
      baseInput({ latestParityReport: cleanReport({ cleanForServing: false }) }),
      baseInput({ latestParityReport: undefined }),
      baseInput({ conditions: greenConditions({ noCronOrAutopilot: false }) }),
    ]) {
      const r = resolveWriteThrough(input, ctx);
      expect(r.healthItem).toBeDefined();
      expect(() => HealthItemSchema.parse(r.healthItem)).not.toThrow();
    }
  });
});

describe("pinValidatedForEnablement + parseGbrainPinFile (typed config/gbrain.pin re-capture)", () => {
  const PIN_TEXT = [
    "# a comment line",
    "",
    "gbrain_sha            = 3933eb6a7915cb5495b8057b75567e2b1588b5ac",
    "gbrain_tag            = 0.35.1.0",
    "gbrain_repo           = https://github.com/garrytan/gbrain.git",
    "index_schema_ver      = 2",
    "write_through_enabled = false",
    "validated_on          = PENDING_PHASE12",
    "validation_ref        = docs/design/gbrain-write-through-divergence.md",
  ].join("\n");

  it("parses the real config file format into a contract-valid GbrainPin (snake→camel, typed)", () => {
    const r = parseGbrainPinFile(PIN_TEXT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(() => GbrainPinSchema.parse(r.value)).not.toThrow();
    expect(r.value.gbrainSha).toBe("3933eb6a7915cb5495b8057b75567e2b1588b5ac");
    expect(r.value.gbrainTag).toBe("0.35.1.0");
    expect(r.value.indexSchemaVersion).toBe(2);
    expect(r.value.writeThroughEnabled).toBe(false);
    expect(r.value.validatedOn).toBe("PENDING_PHASE12");
  });

  it("the re-captured pin is still PENDING (LIVE validation owed) ⇒ NOT enablement-eligible", () => {
    const r = parseGbrainPinFile(PIN_TEXT);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(pinValidatedForEnablement(r.value)).toBe(false);
  });

  it("a promoted pin (real ISO date) is enablement-eligible on the pin leg", () => {
    const promoted = parseGbrainPinFile(PIN_TEXT.replace("PENDING_PHASE12", "2026-07-01"));
    expect(promoted.ok).toBe(true);
    if (!promoted.ok) return;
    expect(pinValidatedForEnablement(promoted.value)).toBe(true);
  });

  it("a malformed line and an unknown key are typed errors (never a throw, §16)", () => {
    const bad = parseGbrainPinFile("gbrain_sha 3933eb6a");
    expect(bad.ok).toBe(false);
    if (bad.ok) return;
    expect(bad.error.code).toBe("malformed_line");

    const unknown = parseGbrainPinFile("mystery_key = x");
    expect(unknown.ok).toBe(false);
    if (unknown.ok) return;
    expect(unknown.error.code).toBe("unknown_key");
  });

  it("a schema-invalid value (non-40-hex sha) is a typed schema_invalid error, not a throw", () => {
    const r = parseGbrainPinFile(PIN_TEXT.replace(/3933eb6a[0-9a-f]+/, "nothex"));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("schema_invalid");
  });

  it("a GbrainPin whose validatedOn is a sentinel is not enablement-eligible; a real date is", () => {
    const pending: GbrainPin = GbrainPinSchema.parse({
      gbrainSha: "3933eb6a7915cb5495b8057b75567e2b1588b5ac",
      gbrainTag: "0.35.1.0",
      gbrainRepo: "https://github.com/garrytan/gbrain.git",
      indexSchemaVersion: 2,
      validatedOn: "PENDING_LIVE_VALIDATION",
      validationRef: "docs/x.md",
      writeThroughEnabled: false,
    });
    expect(pinValidatedForEnablement(pending)).toBe(false);
    const green: GbrainPin = { ...pending, validatedOn: "2026-07-01" };
    expect(pinValidatedForEnablement(green)).toBe(true);
  });
});
