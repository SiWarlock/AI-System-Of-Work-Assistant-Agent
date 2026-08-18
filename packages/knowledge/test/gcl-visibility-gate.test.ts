// spec(§6) — GCL Visibility Gate: single cross-workspace read path; sanitized,
// visibility-validated GclProjections; raw-content / over-visibility HARD reject
// (never downgrade-and-store); direct cross-workspace raw retrieval denied (WS-8).
import { describe, it, expect } from "vitest";
import {
  defaultWorkspace,
  buildSchemaRegistry,
  GCL_PROJECTION_SCHEMA_ID,
  type GclProjection,
  type Workspace,
} from "@sow/contracts";
import type { ProjectionTypeVisibilityTaxonomy, DenialReason } from "@sow/policy";
import {
  admitProjection,
  guardCrossWorkspaceRawRead,
  denialToGateError,
  denialToCrossWorkspaceRawDenial,
  auditOf,
} from "../src/gcl/visibility-gate";
import { isRedactionSafe, type AuditSignal } from "@sow/policy";
import { persistDenialAudit, type GclAuditPersistPort } from "../src/gcl/projection";

// A workspace whose default visibility admits `coordination`-level projections.
function wsWithDefault(level: Workspace["defaultVisibility"]): Workspace {
  return defaultWorkspace({
    id: "ws-001",
    name: "Acme",
    type: "personal_business",
    markdownRepoPath: "/vault/acme",
    gbrainBrainId: "brain-acme",
    defaultVisibility: level,
  });
}

const validCandidate: GclProjection = {
  workspaceId: "ws-001" as GclProjection["workspaceId"],
  visibilityLevel: "coordination",
  projectionType: "calendar_busy",
  sanitizedPayload: { busySlots: 3 },
  sourceRefs: [{ sourceId: "src-001" as GclProjection["sourceRefs"][number]["sourceId"] }],
};

describe("admitProjection — composed candidate-data gate + visibility validation", () => {
  it("admits a sanitized projection within the source default visibility", () => {
    const r = admitProjection(validCandidate, wsWithDefault("sanitized"));
    expect(r.ok).toBe(true);
    if (r.ok) {
      // Echoes the projection unchanged — the gate never mutates it.
      expect(r.value).toEqual(validCandidate);
    }
  });

  it("HARD-rejects a projection carrying a raw-content-shaped key (no downgrade-and-store)", () => {
    const rawBearing = {
      ...validCandidate,
      sanitizedPayload: { body: "raw employer transcript text" },
    };
    const r = admitProjection(rawBearing, wsWithDefault("full"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("raw_content_present");
    }
  });

  it("HARD-rejects a projection whose visibility exceeds the source default (never downgraded)", () => {
    // projection declares `coordination`; source default is the most-restrictive `isolated`.
    const r = admitProjection(validCandidate, wsWithDefault("isolated"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("visibility_exceeds_source");
      if (r.error.code === "visibility_exceeds_source") {
        expect(r.error.declaredLevel).toBe("coordination");
        expect(r.error.sourceDefault).toBe("isolated");
      }
    }
  });

  // task 24.33 (spec §5, §16, safety rule 4): validateProjectionVisibility's PolicyDecision
  // carries a mandatory AuditSignal on every deny — admitProjection built it and dropped it.
  // Pinned through the REAL entry point (not denialToGateError directly) because the defect
  // is specifically that the real call site never threaded decision.audit through.
  it("admit_projection_deny_carries_its_audit_signal: a real policy-decision denial's AuditSignal survives to the caller instead of being dropped", () => {
    const r = admitProjection(validCandidate, wsWithDefault("isolated"));
    expect(r.ok).toBe(false);
    if (!r.ok && "audit" in r.error) {
      expect(r.error.audit).toBeDefined();
      expect(r.error.audit?.denialCode).toBe("VISIBILITY_EXCEEDS_SOURCE");
      // redaction-safe by construction (policy-authored refs/codes only) — sanity, not the gate itself.
      expect(r.error.audit?.refs.length).toBeGreaterThan(0);
    } else {
      expect.fail("expected a policy-decision deny variant carrying an audit field");
    }
  });

  it("rejects at the ajv stage when a top-level unknown field rides the candidate", () => {
    const extra = { ...validCandidate, smuggled: "x" };
    const r = admitProjection(extra, wsWithDefault("full"));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("schema_rejected");
      if (r.error.code === "schema_rejected") expect(r.error.stage).toBe("ajv");
    }
  });

  it("rejects when visibilityLevel is missing (schema gate)", () => {
    const { visibilityLevel: _drop, ...noVis } = validCandidate;
    void _drop;
    const r = admitProjection(noVis, wsWithDefault("full"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("schema_rejected");
  });

  it("rejects when the projection names a different workspace than the source (malformed policy input)", () => {
    const foreign = { ...validCandidate, workspaceId: "ws-999" as GclProjection["workspaceId"] };
    const r = admitProjection(foreign, wsWithDefault("full"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("malformed_policy_input");
  });

  // task 24.18 (WS-1/F14): an INJECTED taxonomy wires the projectionType
  // derivation through the real gate entry point — production's default taxonomy
  // is empty (arch_gap), so these tests inject one to prove the mapping is real,
  // not merely declared.
  it("HARD-rejects a projection whose visibility level is inconsistent with its projectionType's derivation, even when the workspace ceiling would permit it (task 24.18)", () => {
    const taxonomy: ProjectionTypeVisibilityTaxonomy = { calendar_busy: ["isolated"] };
    // validCandidate declares "coordination" for projectionType "calendar_busy";
    // the "full" ceiling would permit it, but the taxonomy caps calendar_busy at
    // "isolated" — the derivation check must independently deny.
    const r = admitProjection(validCandidate, wsWithDefault("full"), undefined, taxonomy);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("visibility_type_mismatch");
      if (r.error.code === "visibility_type_mismatch") {
        expect(r.error.declaredLevel).toBe("coordination");
        expect(r.error.projectionType).toBe("calendar_busy");
      }
    }
  });

  it("an injected taxonomy that does not cover this candidate's projectionType leaves the ceiling as the sole gate (no regression)", () => {
    const taxonomy: ProjectionTypeVisibilityTaxonomy = { "some-other-type": ["isolated"] };
    const r = admitProjection(validCandidate, wsWithDefault("sanitized"), undefined, taxonomy);
    expect(r.ok).toBe(true);
  });
});

// task 24.36 (L134, third instance): admitProjection's DenialReason narrowing was
// an un-guarded if/if/trailing-return — any DenialReason other than the two
// explicit checks silently fell into "malformed_policy_input", contradicting its
// own adjacent comment ("never a default:/trailing-else absorb... avoided here on
// purpose"). Tests target the extracted `denialToGateError` directly (mirroring
// 24.30's `gateReason` extraction) so every one of DenialReason's 12 members is
// exercisable, not only the 3 validateProjectionVisibility can actually emit.
describe("denialToGateError — exhaustive over DenialReason (task 24.36 / L134)", () => {
  it("admit_projection_visibility_exceeds_source_unchanged: VISIBILITY_EXCEEDS_SOURCE maps byte-identically to before", () => {
    const r = denialToGateError("VISIBILITY_EXCEEDS_SOURCE", "exceeds", validCandidate, wsWithDefault("isolated"));
    expect(r).toEqual({
      code: "visibility_exceeds_source",
      declaredLevel: "coordination",
      sourceDefault: "isolated",
      message: "exceeds",
    });
  });

  it("admit_projection_visibility_type_mismatch_unchanged: VISIBILITY_TYPE_MISMATCH maps byte-identically to before", () => {
    const r = denialToGateError("VISIBILITY_TYPE_MISMATCH", "mismatch", validCandidate, wsWithDefault("isolated"));
    expect(r).toEqual({
      code: "visibility_type_mismatch",
      declaredLevel: "coordination",
      projectionType: "calendar_busy",
      message: "mismatch",
    });
  });

  it("admit_projection_malformed_policy_input_still_explicit: MALFORMED_POLICY_INPUT, and every other DenialReason validateProjectionVisibility can never emit, still maps to malformed_policy_input", () => {
    const ws = wsWithDefault("isolated");
    // MALFORMED_POLICY_INPUT: the one this function's real caller actually emits.
    expect(denialToGateError("MALFORMED_POLICY_INPUT", "bad input", validCandidate, ws)).toEqual({
      code: "malformed_policy_input",
      message: "bad input",
    });
    // The other 9 members are genuinely impossible from validateProjectionVisibility
    // (verified by reading its full body) but must still map explicitly, not via a
    // trailing fallthrough — fail-closed to the same reason, per FAIL_CLOSED_DENIAL.
    const impossibleButExhaustivelyHandled: readonly DenialReason[] = [
      "EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED",
      "DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL",
      "UNTRUSTED_CONTENT_MUTATING_TOOL",
      "WRITE_ADAPTER_OUTSIDE_GATEWAY",
      "PROVIDER_NOT_ALLOWED",
      "NO_ROUTE_FOR_CAPABILITY",
      "PROCESSOR_NOT_ALLOWED",
      "LOCAL_ENDPOINT_NOT_CONFIGURED",
      "NON_LOOPBACK_LOCAL_TREATED_AS_EGRESS",
      "APPROVAL_REQUIRED",
      "AUTH_TOKEN_INVALID",
      "ORIGIN_NOT_ALLOWED",
    ];
    for (const reason of impossibleButExhaustivelyHandled) {
      expect(denialToGateError(reason, "n/a", validCandidate, ws)).toEqual({
        code: "malformed_policy_input",
        message: "n/a",
      });
    }
  });

  // admitProjection's own OBSERVABLE behavior is unchanged by the extraction —
  // pinned end-to-end through the real function, not just the extracted helper.
  it("admitProjection's own output is byte-identical after the extraction, for both real deny reasons", () => {
    const exceeds = admitProjection(validCandidate, wsWithDefault("isolated"));
    expect(exceeds.ok).toBe(false);
    if (!exceeds.ok) expect(exceeds.error.code).toBe("visibility_exceeds_source");

    const foreign = { ...validCandidate, workspaceId: "ws-999" as GclProjection["workspaceId"] };
    const malformed = admitProjection(foreign, wsWithDefault("full"));
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe("malformed_policy_input");
  });
});

describe("guardCrossWorkspaceRawRead — the direct cross-brain raw-retrieval denial (WS-8)", () => {
  it("denies a direct cross-workspace raw retrieval with no approved link", () => {
    const r = guardCrossWorkspaceRawRead({ fromWorkspaceId: "ws-a", toWorkspaceId: "ws-b" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("direct_cross_workspace_raw_denied");
  });

  it("permits a same-workspace read (not a cross-workspace request)", () => {
    const r = guardCrossWorkspaceRawRead({ fromWorkspaceId: "ws-a", toWorkspaceId: "ws-a" });
    expect(r.ok).toBe(true);
  });

  it("permits raw retrieval only via a recorded Level-3 owner-approved link", () => {
    const r = guardCrossWorkspaceRawRead({
      fromWorkspaceId: "ws-a",
      toWorkspaceId: "ws-b",
      approvedLink: { level3: true, recordedApprovalRef: "appr-777" },
    });
    expect(r.ok).toBe(true);
  });

  it("fail-closed: denies on malformed (empty) workspace ids", () => {
    const r = guardCrossWorkspaceRawRead({ fromWorkspaceId: "", toWorkspaceId: "ws-b" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("malformed_policy_input");
  });
});

// task 24.38 (L134, fourth instance): guardCrossWorkspaceRawRead's narrowing was
// the SAME un-guarded shape 24.36 just fixed one function above in this file —
// one explicit check against DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL, then a
// trailing return absorbing the other 14 members into malformed_policy_input.
// Mirrors 24.36's denialToGateError extraction for the identical reason:
// denyDirectCrossWorkspaceRaw can only ever emit 2 of the 15 members, so the
// other 13 are otherwise untestable end-to-end.
describe("denialToCrossWorkspaceRawDenial — exhaustive over DenialReason (task 24.38 / L134)", () => {
  it("guard_cross_workspace_raw_read_direct_retrieval_unchanged: DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL maps byte-identically to before", () => {
    expect(denialToCrossWorkspaceRawDenial("DIRECT_CROSS_WORKSPACE_RAW_RETRIEVAL", "denied")).toEqual({
      code: "direct_cross_workspace_raw_denied",
      message: "denied",
    });
  });

  it("guard_cross_workspace_raw_read_malformed_input_unchanged: MALFORMED_POLICY_INPUT maps byte-identically to before", () => {
    expect(denialToCrossWorkspaceRawDenial("MALFORMED_POLICY_INPUT", "bad input")).toEqual({
      code: "malformed_policy_input",
      message: "bad input",
    });
  });

  // Honesty note (matching 24.36's own): a grouped case-list and a trailing
  // fallthrough are output-identical by construction for every one of these —
  // this is a genuine regression pin, not proof of the structural
  // exhaustiveness property (that's the empirical removal-test below).
  it("guard_cross_workspace_raw_read_non_emittable_reasons_fail_closed: every other DenialReason still maps to malformed_policy_input", () => {
    const nonEmittable: readonly DenialReason[] = [
      "EMPLOYER_RAW_EGRESS_UNACKNOWLEDGED",
      "UNTRUSTED_CONTENT_MUTATING_TOOL",
      "WRITE_ADAPTER_OUTSIDE_GATEWAY",
      "PROVIDER_NOT_ALLOWED",
      "NO_ROUTE_FOR_CAPABILITY",
      "PROCESSOR_NOT_ALLOWED",
      "LOCAL_ENDPOINT_NOT_CONFIGURED",
      "NON_LOOPBACK_LOCAL_TREATED_AS_EGRESS",
      "VISIBILITY_EXCEEDS_SOURCE",
      "VISIBILITY_TYPE_MISMATCH",
      "APPROVAL_REQUIRED",
      "AUTH_TOKEN_INVALID",
      "ORIGIN_NOT_ALLOWED",
    ];
    for (const reason of nonEmittable) {
      expect(denialToCrossWorkspaceRawDenial(reason, "n/a")).toEqual({
        code: "malformed_policy_input",
        message: "n/a",
      });
    }
  });

  // guardCrossWorkspaceRawRead's own OBSERVABLE behavior is unchanged by the
  // extraction — pinned end-to-end, not just via the extracted helper.
  it("guardCrossWorkspaceRawRead's own output is byte-identical after the extraction", () => {
    const denied = guardCrossWorkspaceRawRead({ fromWorkspaceId: "ws-a", toWorkspaceId: "ws-b" });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.error.code).toBe("direct_cross_workspace_raw_denied");

    const malformed = guardCrossWorkspaceRawRead({ fromWorkspaceId: "", toWorkspaceId: "ws-b" });
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.error.code).toBe("malformed_policy_input");
  });
});

// ── `### 24.98` — a `schema_rejected` denial PRODUCES a redaction-gated signal ─────────────────
// ⛔ SCOPED CLAIM, and the unqualified form is forbidden: the signal is PRODUCED and REDACTION-GATED;
// NO ADAPTER PERSISTS IT YET (the `GclAuditPersistPort` binding is deferred to Phase 25.2/25.4 —
// `### 24.97`). ⚠ "stops being refused silently" is the END STATE, not what this slice alone
// achieves, and `projection.ts` records that this area has been corrected for that exact overclaim
// twice already. The persist pin below writes to an INJECTED FAKE, never to a bound adapter.
//
// ⛔ THE ORDERING LOOKS CIRCULAR ON THE TRACKER AND IS NOT — carried here from brief 293 because
// this is where the wrong edit would happen (`L187`). `### 24.98` records `Depends: ### 24.84
// landing`, and `24.84` has not landed. ⇒ THAT DEPENDENCY BINDS THE IMPLEMENTATION, NOT THE SHAPE
// DECISION. A reader who "corrects" the ordering re-freezes the chain knowledge → contract.
//
// ⛔⛔ THE OBVIOUS IMPLEMENTATION IS THE DANGEROUS ONE. The reflex fix is "thread the existing
// `issues` into the signal." `GateIssue.message` is VALIDATOR-AUTHORED and some codes echo the row.
// Population predicate — *which rejections, at which stage, embed row-derived text in `message`* —
// measured through `admitProjection` (not against the schema in isolation: `admitProjection` runs
// ajv FIRST, so a code that only Zod can raise is unreachable unless ajv is made permissive):
//   ZOD stage  · `invalid_enum_value` on `visibilityLevel` → "… received 'SENTINEL…'"      ⛔ ECHOES
//   ZOD stage  · `unrecognized_keys` at the ROOT path      → "… in object: 'SENTINEL…'"    ⛔ ECHOES
//   ZOD stage  · workspace-id brand refinement            → fixed brand message            — no echo
//   AJV stage  · enum / additionalProperties / pattern     → fixed ajv message              — no echo
// ⚠ AND A THIRD PATH SHAPE THE FIRST ENUMERATION MISSED (security review): `schema-gate.ts` maps
// `path: e.instancePath || e.schemaPath`, so a ROOT-level ajv rejection yields a SCHEMA path such as
// `#/additionalProperties` — neither one of our field names nor an array index. Still schema-authored
// and safe, but an enumeration that misses a case is what makes the next reader distrust all of it.
// ⚠ NAME THE REGISTRY OR THE STAGE COLUMN IS UNREADABLE: every ZOD row above was taken through the
// PERMISSIVE stand-in registry below. Through the DEFAULT registry those same inputs reject at AJV,
// because the enum and `additionalProperties:false` are pinned in the JSON Schema. Leaving the
// registry to inference is the stage-attribution error this table was corrected for once already.
// ⛔⛔ AND THE CLASS MIGRATES WHEN `### 24.84` LANDS — MEASURED, both schemas read:
//   HEAD  `workspaceId: {"type":"string","minLength":1}`
//   POST  `{"type":"string","minLength":1,"maxLength":64,"pattern":"^[a-z0-9]([a-z0-9-]*[a-z0-9])?$"}`
// ⇒ the slug pattern lands IN THE JSON SCHEMA, so AJV enforces it. After contract lands, a malformed
// workspace id — including `### 24.97` leg (a)'s credential-shaped LEGACY ROW, the case this whole
// task exists for — rejects at **stage `"ajv"`**, not `"zod"`. Measured through the DEFAULT registry
// with the tightened brand live: `code=schema_rejected stage=ajv`, message
// `must match pattern "^[a-z0-9]([a-z0-9-]*[a-z0-9])?$"` — our own schema's pattern, ⭐ NO ECHO.
// ⚠ A READER AFTER THE LANDING MUST NOT TAKE THE ZOD ROWS AS DESCRIBING THE LIVE PATH: the Zod stage
// is where the motivating row lands only in the pre-landing window, and that window is closing.
// ⭐ TWO echoing codes, not one; `unrecognized_keys` is the worse because the echoed text is a key
// the ROW author chose, at the root path, where no field name of ours appears at all.
// ⇒ `message` is excluded CATEGORICALLY. The signal is built from non-row-derived material only:
// the `code`, the closed `stage` literal, issue PATHS, and a COUNT (`L73` — make the unsafe content
// unrepresentable rather than detecting it).
//
// ⚠ THE PATH-SAFETY AND AJV-`params` ARGUMENTS LIVE AT THE SOURCE, NOT HERE — `visibility-gate.ts`'s
// `schemaRejectedSignal` block. Per `L187` an invalidating condition belongs where the wrong edit
// would happen, and three copies is three things to drift. What stays below is genuinely test-local:
// the measurement table, its registry attribution, and the `24.84` stage migration — none of which
// the source explains, and all of which justify the inputs each pin chose.
describe("### 24.98 — a schema_rejected denial carries a redaction-safe AuditSignal", () => {
  // ⛔ CREDENTIAL-SHAPED ON PURPOSE, AND THIS IS WHAT MAKES THE `isRedactionSafe` ASSERTIONS MEAN
  // ANYTHING. With a neutral sentinel they were DECORATIVE: `looksUnsafe` is three credential-shape
  // regexes, not a content allowlist, so a message-derived signal carrying `SENTINEL-hunter2-ECHO`
  // passed the gate, persisted, and the suite went green — the pin could not fail for the reason it
  // exists (code-quality review; `### 24.99`'s shape). `sk-…` matches `CREDENTIAL_PREFIX`, so the
  // dangerous implementation now reds at `isRedactionSafe` AND again at the refusal count.
  // ⚠ Verified that the remedy is not itself decorative: `looksUnsafe` consults ONLY those three
  // regexes (no `SAFE_STRUCTURED_TOKEN` escape hatch), and `stripMarkers` removes three literal
  // markers that cannot defeat an `sk-` prefix.
  const SENTINEL = "sk-hunter2echo";

  // ⛔ THE SCHEMA IS AN INPUT TO THESE ASSERTIONS, DELIBERATELY. `admitProjection` runs ajv first, so
  // the Zod-only rejection classes are unreachable through the DEFAULT registry — the enum and
  // `additionalProperties:false` are both pinned in the JSON Schema and intercept upstream. Supplying
  // a permissive registry puts the rejecting stage under the test's control instead of leaving it to
  // ambient schema state. ⭐ This is also what stops these pins repeating `### 24.84`'s deleted
  // control, whose subject was not an input to its own expression, so no implementation could change
  // its value. Here a wrong implementation changes the result.
  const permissiveAjv = buildSchemaRegistry([{ $id: GCL_PROJECTION_SCHEMA_ID, type: "object" }]);

  /** Every string the signal carries, INCLUDING the two `isRedactionSafe` does not scan. */
  const allFieldsOf = (sig: AuditSignal): string[] => [
    sig.actor,
    sig.event,
    sig.payloadHash,
    sig.beforeSummary,
    sig.afterSummary,
    ...sig.refs,
    sig.denialCode ?? "",
    sig.healthSignalClass ?? "",
  ];

  const rejectedAtZod = (candidate: unknown) => {
    const r = admitProjection(candidate, wsWithDefault("full"), permissiveAjv);
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable: expected a rejection");
    // ⛔ ASSERT THE STAGE, not just the code: without this these pins can silently re-point at the
    // ajv producer, where the sentinel never reaches `message` and the whole test goes vacuous.
    expect(r.error.code).toBe("schema_rejected");
    if (r.error.code === "schema_rejected") expect(r.error.stage).toBe("zod");
    return r.error;
  };

  it("schema_rejected_denial_produces_an_audit_signal", () => {
    const err = rejectedAtZod({ ...validCandidate, visibilityLevel: SENTINEL });
    const sig = auditOf(err);
    expect(sig).toBeDefined();
    expect(sig?.event).toContain("schema_rejected");
  });

  it("schema_rejected_signal_carries_no_row_derived_content_from_an_echoing_enum_rejection", () => {
    // ⛔ THE LOAD-BEARING PIN — it makes "redaction-safe BY CONSTRUCTION" checkable rather than
    // asserted, and it checks the SIGNAL, not the argument for why the signal is safe.
    const err = rejectedAtZod({ ...validCandidate, visibilityLevel: SENTINEL });
    // Non-vacuity: the sentinel really did reach the underlying `message`, so a signal built from
    // `message` WOULD fail this. The pin is discriminating, not trivially true.
    if (err.code === "schema_rejected") {
      expect(err.issues.some((i) => i.message.includes(SENTINEL))).toBe(true);
    }
    const sig = auditOf(err);
    expect(sig).toBeDefined(); // diagnostic clarity: a missing signal reds HERE, not as a TypeError
    for (const field of allFieldsOf(sig as AuditSignal)) {
      expect(field).not.toContain(SENTINEL);
    }
  });

  it("schema_rejected_signal_carries_no_row_AUTHORED_KEY_from_an_unrecognized_key_rejection", () => {
    // ⭐ The second echoing code, found by measurement rather than predicted. The echoed text is a key
    // the ROW author chose and the issue path is the ROOT — so a message-derived signal would leak a
    // name that appears nowhere in our schema.
    const err = rejectedAtZod({ ...validCandidate, [SENTINEL]: "x" });
    if (err.code === "schema_rejected") {
      expect(err.issues.some((i) => i.message.includes(SENTINEL))).toBe(true);
    }
    const sig = auditOf(err);
    expect(sig).toBeDefined(); // diagnostic clarity: a missing signal reds HERE, not as a TypeError
    for (const field of allFieldsOf(sig as AuditSignal)) {
      expect(field).not.toContain(SENTINEL);
    }
  });

  it("schema_rejected_from_a_workspace_id_brand_rejection_carries_a_safe_signal", () => {
    // ⛔⛔ THIS IS THE CLASS THE TASK EXISTS FOR — a row that PASSES structural validation and fails
    // only a Zod-side BRAND refinement, which is exactly what a legacy row becomes under `### 24.84`.
    // A blank id is used because it fails the brand in BOTH states — HEAD's `.refine("empty/whitespace")`
    // and `24.84`'s slug regex — so this pin does not flip behaviour when contract lands.
    // ⚠ AND THAT STABILITY IS GIVEN BY THE PERMISSIVE REGISTRY, NOT BY THE INPUT ALONE: measured,
    // through the DEFAULT registry with the tightened brand live, a blank id rejects at AJV. It
    // reaches the Zod stage here only because `rejectedAtZod` takes ajv out of the way.
    // ⚠ MEASURED, on the input that actually matters, with the tightened brand live in the working
    // tree: a credential-shaped legacy id (`https://u:hunter2@evil.example`) rejects here as
    // `code=schema_rejected stage=zod` with the fixed message "workspace id must be a lowercase
    // alphanumeric slug (`-` separated)" — ⭐ NO ECHO. At HEAD that same row is ADMITTED, which is
    // precisely why `### 24.84` exists; that is why this pin uses the cross-state input instead.
    const err = rejectedAtZod({ ...validCandidate, workspaceId: "   " });
    const sig = auditOf(err);
    expect(sig).toBeDefined();
    // ⛔ HONEST SCOPE — the same caveat the ajv pin carries, which this one was missing (code-quality
    // review). `isRedactionSafe` here is NOT discriminating: a blank id produces a fixed brand message
    // with no credential shape, so a message-derived implementation would pass this line too. Unlike
    // the enum pins, it CANNOT be fixed at HEAD — the input that would trip the heuristic is the
    // credential-shaped id, and that one is ADMITTED pre-`24.84`, which is the whole reason this pin
    // uses the cross-state blank instead. ⭐ It becomes discriminating the moment `24.84` lands.
    // ⇒ what this pin establishes today: the BRAND-refinement class reaches the Zod stage and mints a
    // signal at all — which no other pin covers.
    expect(isRedactionSafe(sig as AuditSignal)).toBe(true);
  });

  it("schema_rejected_signal_passes_the_redaction_gate_and_is_persisted", async () => {
    // ⛔ Proves the fix CLOSES the gap rather than RELOCATING it to a refusal. A signal carrying
    // row-derived content would be refused by `isRedactionSafe` and the record still would not be
    // written — the gap reproducing for exactly the rows this task exists to record, suite green.
    const maybe = auditOf(rejectedAtZod({ ...validCandidate, visibilityLevel: SENTINEL }));
    expect(maybe).toBeDefined();
    const sig = maybe as AuditSignal;
    expect(isRedactionSafe(sig)).toBe(true);

    const calls: { signal: AuditSignal; workspaceId: string }[] = [];
    const refusals: unknown[][] = [];
    const port: GclAuditPersistPort = {
      persistDenial: async (signal, workspaceId) => {
        calls.push({ signal, workspaceId });
      },
      onRefused: (...args: unknown[]) => {
        refusals.push(args);
      },
    };
    await persistDenialAudit(sig, "ws-001", port);
    expect(calls).toHaveLength(1);
    expect(refusals).toHaveLength(0);
  });

  it("schema_rejected_row_is_still_refused_through_the_REAL_registry", () => {
    // The fail-closed refusal is NOT weakened, asserted through the DEFAULT registry (no permissive
    // stand-in) so this pin speaks about production. The stage is ajv here and that is the point:
    // whichever stage refuses, the row stays refused — it merely stops being refused silently.
    const r = admitProjection({ ...validCandidate, visibilityLevel: SENTINEL }, wsWithDefault("full"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe("schema_rejected");
  });

  it("schema_rejected_at_the_AJV_stage_carries_a_safe_signal", () => {
    // ⛔⛔ THE STAGE THE MOTIVATING ROW WILL ACTUALLY TAKE ONCE `### 24.84` LANDS, and the one every
    // other signal pin here misses: they all route through `rejectedAtZod`. Making `audit` REQUIRED
    // on the variant means the compiler forces the AJV construction site to build one too — an
    // otherwise untested construction on a rule-7 surface.
    // ⚠ REAL registry, deliberately: a permissive stand-in would defeat the entire point of this pin.
    // The enum sentinel is used because it fails AJV in BOTH brand states (the enum is untouched by
    // `24.84`), so this pin is stable across the landing for the same reason the Zod one is.
    const r = admitProjection({ ...validCandidate, visibilityLevel: SENTINEL }, wsWithDefault("full"));
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable: expected a rejection");
    expect(r.error.code).toBe("schema_rejected");
    if (r.error.code === "schema_rejected") expect(r.error.stage).toBe("ajv");
    const sig = auditOf(r.error);
    expect(sig).toBeDefined();
    expect(isRedactionSafe(sig as AuditSignal)).toBe(true);
    // ⛔ HONEST SCOPE — THIS ASSERTION IS WEAKER HERE THAN IT LOOKS, AND SAYING SO IS THE POINT.
    // At the Zod stage the no-sentinel check is DISCRIMINATING, because the sentinel provably reaches
    // `issue.message` and a message-derived signal would fail. At the AJV stage it does NOT: ajv's
    // messages are fixed strings and `schema-gate.ts` drops `e.params`, so the sentinel never enters
    // the issue set at all — nothing here could carry it even under a wrong implementation.
    // ⇒ what this pin actually establishes is that a signal IS PRODUCED at the ajv site and is
    // redaction-safe. It becomes discriminating the moment anyone threads `params` into that mapping,
    // which is the named invalidating condition above.
    for (const field of allFieldsOf(sig as AuditSignal)) {
      expect(field).not.toContain(SENTINEL);
    }
  });

  it("a_row_authored_key_cannot_reach_refs_under_a_tightened_stand_in", () => {
    // ⛔⛔ THE INVALIDATING CONDITION, EXECUTED AS A PIN RATHER THAN NAMED IN A COMMENT. The source
    // block used to assert "the pins catch it"; security review ran the condition and produced a real
    // leak — `ref:gcl-issue-path:/sanitizedPayload/Project-Falcon-Q3-codename` — against a fully green
    // suite, because NO pin drove a row-authored key into `sanitizedPayload`. This is that pin.
    // ⚠ TIGHTENED stand-in registry — the mirror of `permissiveAjv`, and the same discipline: the
    // schema is an INPUT, so the future tightening is simulated rather than waited for.
    // ⛔ `isRedactionSafe` would NOT backstop this: `audit-signal.ts` names "an employer project
    // codename" as precisely what its credential-shape heuristic cannot catch — hence this exact value.
    const tightenedPayloadAjv = buildSchemaRegistry([
      {
        $id: GCL_PROJECTION_SCHEMA_ID,
        type: "object",
        properties: { sanitizedPayload: { type: "object", additionalProperties: { type: "string" } } },
      },
    ]);
    const ROW_KEY = "Project-Falcon-Q3-codename";
    const r = admitProjection(
      { ...validCandidate, sanitizedPayload: { [ROW_KEY]: 123 } },
      wsWithDefault("full"),
      tightenedPayloadAjv,
    );
    expect(r.ok).toBe(false);
    if (r.ok) throw new Error("unreachable: expected a rejection");
    expect(r.error.code).toBe("schema_rejected");
    // ⛔ NON-VACUITY, and it is the whole point: the row-authored key really DOES reach `issue.path`.
    // Without `structuralPathOnly` cutting the path at `sanitizedPayload`, it would reach `refs`.
    if (r.error.code === "schema_rejected") {
      expect(r.error.issues.some((i) => i.path.includes(ROW_KEY))).toBe(true);
    }
    const sig = auditOf(r.error);
    expect(sig).toBeDefined();
    for (const field of allFieldsOf(sig as AuditSignal)) {
      expect(field).not.toContain(ROW_KEY);
    }
  });

  it("raw_content_present_still_carries_no_signal", () => {
    // ⛔ Pins the half of the `GclGateError` doc block that stays TRUE, so the rewrite cannot quietly
    // widen. `raw_content_present` still has no `PolicyDecision` behind it and still mints nothing.
    // ⭐ THIS IS ALSO task 24.33's NEGATIVE CONTROL, absorbed rather than duplicated. That control
    // covered BOTH no-audit variants and RED when `schema_rejected` started carrying a signal — the
    // deliberate behaviour change, not a regression. Re-aiming it at `raw_content_present` left it
    // byte-equivalent to this test, and keeping both would have had one of them lying about being
    // needed (code-quality review). ⚠ THE CONTROL IS NOT WEAKENED: its job is proving `auditOf`
    // DISCRIMINATES rather than always returning a signal, and that load is carried here — while the
    // `schema_rejected` half moved up in this block and now asserts the OPPOSITE, at both stages.
    const r = admitProjection(
      { ...validCandidate, sanitizedPayload: { body: "raw employer transcript text" } },
      wsWithDefault("full"),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error.code).toBe("raw_content_present");
      expect(auditOf(r.error)).toBeUndefined();
    }
  });
});
