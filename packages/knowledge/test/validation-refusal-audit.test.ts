// spec(§16) — `### 24.103`: the shared issue-carrying refusal SHAPE.
//
// Four candidate-data gates each minted their own `{code, stage, issues}` refusal on their own
// local union, with no `AuditSignal`. `### 24.98` made `audit` REQUIRED on the GCL union, so the
// compiler enumerated that union's construction sites — and stopped dead at the union boundary.
// This slice merges the SHAPE, not the unions: one issue-carrying type that REQUIRES an `audit`,
// with each union keeping its own `code`/`stage` vocabulary. The compiler then enumerates the
// whole population (measured: 10 construction sites across 4 channels).
//
// ⛔ THE HAZARD IS BUILD-TIME, NOT A RUNTIME LEAK (`### 24.105` traced it and found none). The risk
// is that whoever adds the missing signal REACHES FOR `issues`, because that is what is sitting
// there — and `issues[].message` is validator-authored and MEASURED to echo row content. A shared
// type that requires an `audit` makes that reach impossible at all four sites at once.
import { describe, it, expect } from "vitest";
import {
  ok,
  isErr,
  validKnowledgeMutationPlan,
  KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
  GBRAIN_PROPOSED_FACT_SCHEMA_ID,
  SIGNED_PROVENANCE_STAMP_SCHEMA_ID,
} from "@sow/contracts";
import { buildSchemaRegistry } from "@sow/contracts/schema/registry";
import type { WorkflowRunRef, Workspace, MdContentSha } from "@sow/contracts";
import { isRedactionSafe, type AuditSignal } from "@sow/policy";
import { applyPlan, type KnowledgeWriteCommand, type KnowledgeWriterDeps } from "../src/knowledge-writer/writer";
import { computeRevisionId } from "../src/knowledge-writer/revision";
import { routeRemediation, type RemediationRequest } from "../src/gbrain/remediation/router";
import { intakeGenerativeProposal, type GenerativeIntakeDeps, type RawGenerativeCandidate } from "../src/gbrain/remediation/generative-proposal-intake";
import { stampProvenance, type StampInputs, type StamperDeps } from "../src/knowledge-writer/provenance-stamp";
import { admitProjection, auditOf } from "../src/gcl/visibility-gate";
import {
  FREE_FORM_KEY_REGIONS,
  structuralPathOnly,
  buildRefusalSignal,
  MAXIMAL_CUT,
  type CandidateSchemaId,
  type IssueCarryingRefusal,
} from "../src/audit/validation-refusal";
import { MemoryAuditRepo, MemoryRevisionStore, MemoryVaultFs } from "./helpers";

// ── fixtures ──────────────────────────────────────────────────────────────────────────────────

// ⛔ CREDENTIAL-SHAPED ON PURPOSE (`L192`). A neutral sentinel makes pin 4 DECORATIVE — it would
// assert that a detector failed to detect something it was never going to detect, which is exactly
// the defect three `isRedactionSafe` assertions carried last round. `sk-ant-api03-` matches
// `audit-signal.ts`'s CREDENTIAL_PREFIX, so `isRedactionSafe` genuinely reds if this reaches a field.
const CREDENTIAL_SENTINEL = "sk-ant-api03-LEAKED-BY-A-VALIDATOR-MESSAGE";
// ⛔ A row-authored KEY, not a value — the other half. Deliberately NOT credential-shaped, because
// `audit-signal.ts` names "an employer project codename" as exactly what its heuristic CANNOT catch:
// the cut has to make this unrepresentable, since detection provably will not.
const ROW_AUTHORED_KEY = "Project-Falcon-Q3-codename";

const wf: WorkflowRunRef = {
  workflowId: "wf-24103" as WorkflowRunRef["workflowId"],
  trigger: "manual",
  state: "running",
  idempotencyKey: "idem-24103",
  auditRefs: [],
};

function writerDeps(registry?: ReturnType<typeof buildSchemaRegistry>): KnowledgeWriterDeps {
  return {
    vault: new MemoryVaultFs(),
    revisions: new MemoryRevisionStore(),
    audit: new MemoryAuditRepo(),
    now: () => "2026-08-18T00:00:00.000Z",
    workspacePathCheck: () => ok(undefined),
    ...(registry === undefined ? {} : { registry }),
  };
}

function writerCmd(plan: unknown): KnowledgeWriteCommand {
  return {
    plan,
    expectedBaseRevision: computeRevisionId(new Map()),
    actor: "KnowledgeWriter",
    idempotencyKey: "idem-24103",
    workflowRunRef: wf,
  } as KnowledgeWriteCommand;
}

const WS = "ws-employer";

function materializePlan(over: Record<string, unknown> = {}): unknown {
  return {
    planId: "plan-24103",
    workspaceId: WS,
    sourceRefs: [{ sourceId: "src-1", span: "L1" }],
    creates: [{ path: "notes/x.md", body: "body" }],
    patches: [],
    linkMutations: [],
    frontmatterUpdates: [],
    externalActionProposals: [],
    confidence: 0.9,
    requiresApproval: true,
    provenanceOrigin: "parity_remediation",
    ...over,
  };
}

function routerReq(plan: unknown): RemediationRequest {
  return {
    divergence: {
      factIdentity: "page:orphan",
      divergenceClass: "db_only",
      severityFloor: "hard",
      remediation: "review",
    },
    workspaceId: WS,
    decision: { action: "materialize", plan },
  } as unknown as RemediationRequest;
}

function intakeDeps(registry?: ReturnType<typeof buildSchemaRegistry>): GenerativeIntakeDeps {
  return {
    isEvidenceAdmissible: () => true,
    newPlanId: () => "plan-intake-24103",
    ...(registry === undefined ? {} : { registry }),
  } as unknown as GenerativeIntakeDeps;
}

function intakeCandidate(over: Record<string, unknown> = {}): RawGenerativeCandidate {
  return {
    proposal: {
      proposalId: "prop-1",
      workspaceId: WS,
      factKind: "page",
      proposedContent: { path: "notes/idea.md", body: "body", title: "Idea" },
      evidenceRefs: [{ kind: "markdown", ref: "notes/source.md", span: "L1-L5" }],
      confidence: 0.8,
      generatedBy: "synthesis",
      ...over,
    },
    scratchOrigin: "scratch:brain/tmp-1#L9",
    containedContext: true,
  } as RawGenerativeCandidate;
}

/**
 * Every string a signal can carry — ⛔ INCLUDING `denialCode` and `healthSignalClass`, WHICH
 * `isRedactionSafe` DELIBERATELY DOES NOT SCAN. Asserting only over the scanned fields would make
 * every leak pin below a restatement of `isRedactionSafe` rather than an independent check, and the
 * two unscanned fields are exactly where a leak would survive the heuristic. (Convention borrowed
 * from `gcl-visibility-gate.test.ts`, which had already worked this out.)
 */
function allFieldsOf(signal: AuditSignal): readonly string[] {
  return [
    signal.actor,
    signal.event,
    signal.payloadHash,
    signal.beforeSummary,
    signal.afterSummary,
    ...signal.refs,
    signal.denialCode ?? "",
    signal.healthSignalClass ?? "",
  ];
}

// ⛔ PERMISSIVE AJV STAND-INS. The Zod stage is only REACHABLE when ajv passes first, and the real
// ajv schemas catch most malformed candidates before Zod ever runs — which is precisely why the
// non-vacuity guards below fired on the first RED: the credential sentinel never reached `message`
// because the ajv stage rejected first, and every leak pin would have passed VACUOUSLY against any
// implementation. Same mirror-of-the-tightened-registry discipline `### 24.98` used.
const permissiveKmp = buildSchemaRegistry([{ $id: KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID, type: "object" }]);
const permissiveProposedFact = buildSchemaRegistry([{ $id: GBRAIN_PROPOSED_FACT_SCHEMA_ID, type: "object" }]);

// ── 1. the enumeration property itself ────────────────────────────────────────────────────────

describe("the shared shape makes a signal-less issue-carrying refusal unrepresentable", () => {
  it("a_construction_site_omitting_audit_is_a_compile_error", () => {
    // ⛔ THIS IS THE WHOLE REMEDY, ASSERTED AT THE ONLY LEVEL IT EXISTS AT. `@ts-expect-error`
    // FAILS THE BUILD if the construction becomes legal — so this pin reds the moment the shared
    // shape stops requiring `audit`, which no runtime assertion can detect.
    // ⭐ It is also the pin that generalizes: it is expressed against the SHARED type, so a FIFTH
    // union adopting the shape inherits the guarantee without a fifth test.
    // @ts-expect-error — `audit` is required; omitting it must not compile.
    const shapeless: IssueCarryingRefusal = { issues: [{ path: "a", message: "b" }] };
    expect(shapeless).toBeDefined();
  });

  it("the_derived_region_table_covers_every_candidate_schema_in_the_population", () => {
    // ⛔ NOT A SPELLING CHECK — this pins that the cut is derived PER CANDIDATE SCHEMA rather than
    // copied. `### 24.98`'s cut targets `sanitizedPayload`, a GCL-projection field that appears in
    // NONE of the four uncovered channels: a copied regex compiles, reviews clean, runs on every
    // rejection and cuts NOTHING. Each entry below was derived from its own schema on BOTH
    // validator surfaces (ajv JSON Schema walk + Zod `_def` walk); see the module block comment.
    expect(FREE_FORM_KEY_REGIONS[KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID]).toEqual(["frontmatter", "payload"]);
    expect(FREE_FORM_KEY_REGIONS[GBRAIN_PROPOSED_FACT_SCHEMA_ID]).toEqual(["proposedContent"]);
    // ⛔ EMPTY IS A MEASURED RESULT, NOT AN OVERSIGHT: `SignedProvenanceStamp` has no free-form-key
    // region on either surface, so there is nothing to cut and no row-key pin is possible for it.
    // Recorded rather than faked — a synthetic region to keep a green test is forbidden.
    expect(FREE_FORM_KEY_REGIONS[SIGNED_PROVENANCE_STAMP_SCHEMA_ID]).toEqual([]);
  });

  it("the_cut_stops_at_the_region_and_does_not_over_cut_a_similarly_named_sibling", () => {
    // Both path dialects, deliberately: ajv emits `/a/b`, Zod emits `a.b`.
    const kmp = KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID;
    expect(structuralPathOnly(`/creates/0/frontmatter/${ROW_AUTHORED_KEY}`, kmp)).toBe("/creates/0/frontmatter");
    expect(structuralPathOnly(`creates.0.frontmatter.${ROW_AUTHORED_KEY}`, kmp)).toBe("creates.0.frontmatter");
    expect(structuralPathOnly(`/externalActionProposals/0/payload/${ROW_AUTHORED_KEY}`, kmp)).toBe("/externalActionProposals/0/payload");
    // ⛔ THE OVER-CUT BOUNDARY. `frontmatterUpdates` is a REAL structural field of the same schema and
    // is NOT a free-form-key region (measured: `additionalProperties:false`; its row-authored key is a
    // VALUE, never a path segment). A cut that swallowed it would silently degrade every reported path
    // under it — a reporting loss that no safety pin would ever catch.
    expect(structuralPathOnly("frontmatterUpdates.0.key", kmp)).toBe("frontmatterUpdates.0.key");
  });

  it("an_unknown_schema_id_fails_closed_rather_than_silently_not_cutting", () => {
    // ⛔⛔ THE REMEDY'S OWN DEFECT CLASS, POINTED AT ITSELF. The compiler forces the `audit` FIELD;
    // nothing forces a correct REGION SET. A 5th channel — or a 5th candidate schema on an existing
    // channel — could land with an `audit` that compiles and a cut that does nothing, and the
    // row-authored key would reach the signal silently. Same hazard as the copied `sanitizedPayload`
    // regex, reached by OMISSION instead of by copying.
    //
    // ⭐ DEFENCE 1 — COMPILE-TIME, and it is the same instrument the whole task rests on: the region
    // table is keyed by a closed union of candidate schema ids, so an unlisted id is a type error at
    // the call site rather than an empty lookup at runtime.
    // @ts-expect-error — `sow:task` is not a candidate schema in this population; it must not compile.
    structuralPathOnly("a.b", "sow:task");

    // ⭐ DEFENCE 2 — RUNTIME, for an id that arrives WIDENED through a cast or an `unknown` boundary,
    // where defence 1 cannot see it. It must CUT MAXIMALLY, never return the path uncut.
    // ⛔ IT MUST NOT THROW, AND THAT IS A MEASURED SAFETY CONSTRAINT RATHER THAN A STYLE CHOICE:
    // `writer.ts` documents that `applyPlan` contains NO `try` ANYWHERE, so a throw from here would
    // escape uncaught on the SOLE-WRITER PATH (safety rule 1) — converting a silent-refusal defect
    // into an uncaught throw at the §16 never-throw boundary, which is strictly worse than the bug
    // this task exists to fix. Fail closed by discarding the path, not by raising.
    const widened = "sow:some-future-schema" as CandidateSchemaId;
    const cut = structuralPathOnly(`/creates/0/frontmatter/${ROW_AUTHORED_KEY}`, widened);
    expect(cut).toBe(MAXIMAL_CUT);
    expect(cut).not.toContain(ROW_AUTHORED_KEY);
    // ⛔ THE ANTI-FAIL-OPEN ASSERTION, stated separately because it is the one that reds on the
    // tempting implementation (`return path` when the lookup misses).
    expect(cut).not.toContain("creates");
  });
});

// ── 2. per-channel: a refusal now produces a signal ───────────────────────────────────────────

describe("writer.ts — SchemaRejected (⛔ LIVE, safety rule 1: the sole-writer path)", () => {
  it("writer_schema_rejection_produces_an_audit_signal_at_the_ajv_stage", async () => {
    const r = await applyPlan(writerCmd({ planId: "p" }), writerDeps());
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    // ⛔ NEVER A BARE FALSITY (`### 24.101`) — assert WHY it failed, so the pin cannot pass for the
    // wrong reason (a fixture that fails a DIFFERENT gate would satisfy `isErr` alone).
    expect(r.error.code).toBe("schema_rejected");
    if (r.error.code !== "schema_rejected") return;
    expect(r.error.stage).toBe("ajv");
    expect(r.error.audit).toBeDefined();
    expect(r.error.audit.event).toContain("schema_rejected");
    expect(isRedactionSafe(r.error.audit)).toBe(true);
  });

  it("writer_schema_rejection_produces_an_audit_signal_at_the_zod_stage", async () => {
    const r = await applyPlan(
      writerCmd({ ...validKnowledgeMutationPlan, confidence: "not-a-number" }),
      writerDeps(permissiveKmp),
    );
    expect(isErr(r)).toBe(true);
    if (!isErr(r) || r.error.code !== "schema_rejected") return expect(isErr(r) && r.error.code).toBe("schema_rejected");
    // ⛔ ASSERT THE STAGE, NOT JUST THE CODE — without it this pin silently re-points at the ajv
    // producer and stops testing what its name says.
    expect(r.error.stage).toBe("zod");
    expect(r.error.audit).toBeDefined();
    expect(isRedactionSafe(r.error.audit)).toBe(true);
  });

  it("writer_scoped_stage_signal_is_built_for_the_stage_that_cannot_be_driven_end_to_end", () => {
    // ⛔⛔ MEASURED, AND IT CONTRADICTS THE BRIEF'S ACCEPTANCE BULLET — REPORTED, NOT PAPERED OVER.
    // `runGate`'s third stage is UNREACHABLE through `applyPlan`: `ruleScopedMutation` refuses on
    // exactly two conditions (`workspaceId` present, `sourceRefs` non-empty) and the Zod model
    // enforces a SUPERSET of both, so every candidate that stage (c) would reject is already
    // rejected at stage (b). Probed directly — empty `sourceRefs`, empty and whitespace
    // `workspaceId` — all three rejected at `zod`. A permissive ajv stand-in does not help: it
    // loosens ajv, and the blocker is Zod.
    // ⛔ THEREFORE NO END-TO-END PIN EXISTS FOR IT, AND I AM NOT SYNTHESISING ONE. Driving it would
    // need a loosened Zod model injected purely to make a test go green — proving only that my
    // fixture can reach my fixture. The construction site is still covered where it actually
    // matters: the COMPILER forces it to supply an `audit` (it was one of the 10 enumerated), and
    // the signal's shape for a scoped-stage refusal is pinned directly here.
    // ⚠ THE STAGE IS NOT DEAD CODE AND MUST NOT BE DELETED ON THIS FINDING — it is a fail-closed
    // layer that fires if the Zod model ever loosens, which is exactly the "unreachable is not a
    // licence to delete" case. Flagged at Step 9; disposition is not mine to make here.
    const signal = buildRefusalSignal({
      actor: "knowledge:kw-gate",
      event: "knowledge.writer.schema_rejected.scoped",
      refPrefix: "kw-issue-path",
      payloadHash: "knowledge:kw-schema-rejection",
      beforeSummary: "knowledge mutation plan candidate refused at the scoped schema stage",
      schemaId: KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
      issues: [{ path: "sourceRefs", message: "unscoped_mutation" }],
    });
    expect(signal.event).toContain("scoped");
    expect(isRedactionSafe(signal)).toBe(true);
  });

  it("writer_signal_carries_no_row_derived_content", async () => {
    // Zod's `invalid_enum_value` EMBEDS THE RECEIVED VALUE in `message` — measured by `### 24.98`,
    // and re-measured here: the message reads `… received 'sk-ant-api03-LEAKED-…'`.
    const r = await applyPlan(
      writerCmd({ ...validKnowledgeMutationPlan, provenanceOrigin: CREDENTIAL_SENTINEL }),
      writerDeps(permissiveKmp),
    );
    expect(isErr(r)).toBe(true);
    if (!isErr(r) || r.error.code !== "schema_rejected") return expect(isErr(r) && r.error.code).toBe("schema_rejected");
    // ⛔ NON-VACUITY GUARD — without this the pin passes against a message-derived implementation
    // simply because the sentinel never arrived. It asserts the leak vector is genuinely LOADED.
    expect(r.error.issues.some((i) => i.message.includes(CREDENTIAL_SENTINEL))).toBe(true);
    for (const field of allFieldsOf(r.error.audit)) expect(field).not.toContain(CREDENTIAL_SENTINEL);
    // ⭐ And the heuristic genuinely discriminates on this fixture: it would return false if the
    // sentinel reached any scanned field, which is what makes this assertion non-decorative.
    expect(isRedactionSafe(r.error.audit)).toBe(true);
  });

  it("writer_row_authored_key_cannot_reach_the_signal", async () => {
    // ⛔ THE LOAD-BEARING PIN, and it needs a TIGHTENED STAND-IN because the region accepts anything
    // today (`additionalProperties:{}` / `z.record(z.unknown())`) so no per-entry issue can be raised.
    // The schema is an INPUT — the future tightening is simulated rather than waited for, exactly as
    // `### 24.98` did. MEASURED path shape under it: `/creates/0/frontmatter/<ROW-AUTHORED-KEY>`.
    const tightened = buildSchemaRegistry([
      {
        $id: KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
        type: "object",
        properties: {
          creates: {
            type: "array",
            items: { type: "object", properties: { frontmatter: { type: "object", additionalProperties: { type: "string" } } } },
          },
        },
      },
    ]);
    const r = await applyPlan(
      writerCmd({ ...validKnowledgeMutationPlan, creates: [{ path: "notes/a.md", body: "b", frontmatter: { [ROW_AUTHORED_KEY]: 123 } }] }),
      writerDeps(tightened),
    );
    expect(isErr(r)).toBe(true);
    if (!isErr(r) || r.error.code !== "schema_rejected") return expect(isErr(r) && r.error.code).toBe("schema_rejected");
    // NON-VACUITY: the row-authored key really DOES reach `issue.path`.
    expect(r.error.issues.some((i) => i.path.includes(ROW_AUTHORED_KEY))).toBe(true);
    for (const field of allFieldsOf(r.error.audit)) expect(field).not.toContain(ROW_AUTHORED_KEY);
  });

  it("writer_candidate_is_still_refused_with_the_same_code_and_stage", async () => {
    // The fail-closed behaviour is UNCHANGED by this slice — it stops being refused SILENTLY, it does
    // not stop being refused. Pinned per channel so a signal cannot be bought with a weakened gate.
    const d = writerDeps();
    const r = await applyPlan(writerCmd({ ...validKnowledgeMutationPlan, sourceRefs: [] }), d);
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(r.error.code).toBe("schema_rejected");
    expect((d.vault as MemoryVaultFs).snapshot()).toEqual({});
    expect((d.audit as MemoryAuditRepo).records).toHaveLength(0);
  });
});

describe("router.ts — RemediationError.plan_invalid", () => {
  it("router_plan_invalid_produces_an_audit_signal_at_both_reachable_stages", () => {
    // ⚠ TWO stages, not three, and the omission is measured rather than an oversight: `materialize`
    // runs the SAME `ruleScopedMutation` after the SAME Zod model as `writer.ts`, so its `scoped`
    // stage is unreachable for the identical reason (see the writer pin above). Its construction
    // site is still compiler-forced to carry an `audit`.
    for (const [plan, stage, registry] of [
      [materializePlan({ confidence: "nope" }), "ajv", undefined],
      [materializePlan({ confidence: "nope" }), "zod", permissiveKmp],
    ] as const) {
      const r = routeRemediation(routerReq(plan), registry === undefined ? {} : { registry });
      expect(isErr(r)).toBe(true);
      if (!isErr(r) || r.error.code !== "plan_invalid") return expect(isErr(r) && r.error.code).toBe("plan_invalid");
      expect(r.error.stage).toBe(stage);
      expect(r.error.audit).toBeDefined();
      expect(isRedactionSafe(r.error.audit)).toBe(true);
    }
  });

  it("router_signal_carries_no_row_derived_content", () => {
    const r = routeRemediation(routerReq(materializePlan({ provenanceOrigin: CREDENTIAL_SENTINEL })), {
      registry: permissiveKmp,
    });
    expect(isErr(r)).toBe(true);
    if (!isErr(r) || r.error.code !== "plan_invalid") return expect(isErr(r) && r.error.code).toBe("plan_invalid");
    expect(r.error.issues.some((i) => i.message.includes(CREDENTIAL_SENTINEL))).toBe(true);
    for (const field of allFieldsOf(r.error.audit)) expect(field).not.toContain(CREDENTIAL_SENTINEL);
    expect(isRedactionSafe(r.error.audit)).toBe(true);
  });

  it("router_row_authored_key_cannot_reach_the_signal", () => {
    const tightened = buildSchemaRegistry([
      {
        $id: KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
        type: "object",
        properties: {
          creates: {
            type: "array",
            items: { type: "object", properties: { frontmatter: { type: "object", additionalProperties: { type: "string" } } } },
          },
        },
      },
    ]);
    const r = routeRemediation(
      routerReq(materializePlan({ creates: [{ path: "notes/x.md", body: "b", frontmatter: { [ROW_AUTHORED_KEY]: 1 } }] })),
      { registry: tightened },
    );
    expect(isErr(r)).toBe(true);
    if (!isErr(r) || r.error.code !== "plan_invalid") return expect(isErr(r) && r.error.code).toBe("plan_invalid");
    expect(r.error.issues.some((i) => i.path.includes(ROW_AUTHORED_KEY))).toBe(true);
    for (const field of allFieldsOf(r.error.audit)) expect(field).not.toContain(ROW_AUTHORED_KEY);
  });

  it("router_candidate_is_still_refused_with_the_same_code", () => {
    const r = routeRemediation(routerReq(materializePlan({ sourceRefs: [] })));
    expect(isErr(r)).toBe(true);
    if (isErr(r)) expect(r.error.code).toBe("plan_invalid");
  });

  it("router_scoped_stage_signal_is_built_for_the_stage_that_cannot_be_driven_end_to_end", () => {
    // Same measured unreachability as the writer's third stage, same refusal to synthesise a driver.
    const signal = buildRefusalSignal({
      actor: "knowledge:remediation-router",
      event: "knowledge.remediation.plan_invalid.scoped",
      refPrefix: "remediation-issue-path",
      payloadHash: "knowledge:remediation-plan-rejection",
      beforeSummary: "remediation plan candidate refused at the scoped schema stage",
      schemaId: KNOWLEDGE_MUTATION_PLAN_SCHEMA_ID,
      issues: [{ path: "sourceRefs", message: "unscoped_mutation" }],
    });
    expect(signal.event).toContain("scoped");
    expect(isRedactionSafe(signal)).toBe(true);
  });
});

describe("generative-proposal-intake.ts — IntakeError (`### 24.103`'s named target — DORMANT)", () => {
  it("intake_schema_rejection_produces_an_audit_signal_at_both_stages", () => {
    for (const [over, stage, registry] of [
      [{ proposalId: 42 }, "ajv", undefined],
      [{ confidence: 5 }, "zod", permissiveProposedFact],
    ] as const) {
      const r = intakeGenerativeProposal(
        intakeCandidate(over as Record<string, unknown>),
        intakeDeps(registry === undefined ? undefined : registry),
      );
      expect(isErr(r)).toBe(true);
      if (!isErr(r) || r.error.code !== "schema_rejected") return expect(isErr(r) && r.error.code).toBe("schema_rejected");
      expect(r.error.stage).toBe(stage);
      expect(r.error.audit).toBeDefined();
      expect(isRedactionSafe(r.error.audit)).toBe(true);
    }
  });

  it("intake_plan_invalid_produces_an_audit_signal", () => {
    // ⛔ THE SECOND ECHOING MEMBER `### 24.103`'s ENTRY NEVER NAMED. It is a distinct construction
    // site on a distinct candidate type (the derived KnowledgeMutationPlan, not the proposal), so
    // covering `schema_rejected` alone would leave this one silent — the partial fix wearing a
    // completion badge, on the member nobody had listed.
    const r = intakeGenerativeProposal(intakeCandidate({ factKind: "page", proposedContent: {} }), intakeDeps());
    expect(isErr(r)).toBe(true);
    if (!isErr(r)) return;
    expect(["plan_invalid", "proposed_content_incomplete"]).toContain(r.error.code);
    if (r.error.code !== "plan_invalid") return;
    expect(r.error.audit).toBeDefined();
    expect(isRedactionSafe(r.error.audit)).toBe(true);
  });

  it("intake_signal_carries_no_row_derived_content", () => {
    const r = intakeGenerativeProposal(
      intakeCandidate({ generatedBy: CREDENTIAL_SENTINEL }),
      intakeDeps(permissiveProposedFact),
    );
    expect(isErr(r)).toBe(true);
    if (!isErr(r) || r.error.code !== "schema_rejected") return expect(isErr(r) && r.error.code).toBe("schema_rejected");
    expect(r.error.issues.some((i) => i.message.includes(CREDENTIAL_SENTINEL))).toBe(true);
    for (const field of allFieldsOf(r.error.audit)) expect(field).not.toContain(CREDENTIAL_SENTINEL);
    expect(isRedactionSafe(r.error.audit)).toBe(true);
  });

  it("intake_row_authored_key_cannot_reach_the_signal", () => {
    // ⛔ A DIFFERENT REGION FROM THE OTHER THREE CHANNELS — `proposedContent`, derived from THIS
    // channel's own candidate schema (`sow:gbrain-proposed-fact`). This is the pin that would red
    // if `### 24.98`'s `sanitizedPayload` cut had been copied across: that token does not occur
    // anywhere in this schema, so the copied regex would cut nothing and the key would reach `refs`.
    const tightened = buildSchemaRegistry([
      {
        $id: GBRAIN_PROPOSED_FACT_SCHEMA_ID,
        type: "object",
        properties: { proposedContent: { type: "object", additionalProperties: { type: "string" } } },
      },
    ]);
    const r = intakeGenerativeProposal(
      intakeCandidate({ proposedContent: { path: "notes/i.md", body: "b", [ROW_AUTHORED_KEY]: 123 } }),
      intakeDeps(tightened),
    );
    expect(isErr(r)).toBe(true);
    if (!isErr(r) || r.error.code !== "schema_rejected") return expect(isErr(r) && r.error.code).toBe("schema_rejected");
    expect(r.error.issues.some((i) => i.path.includes(ROW_AUTHORED_KEY))).toBe(true);
    for (const field of allFieldsOf(r.error.audit)) expect(field).not.toContain(ROW_AUTHORED_KEY);
  });

  it("intake_candidate_is_still_refused_with_the_same_code_and_stage", () => {
    const r = intakeGenerativeProposal(intakeCandidate({ proposalId: 42 }), intakeDeps());
    expect(isErr(r)).toBe(true);
    if (!isErr(r) || r.error.code !== "schema_rejected") return;
    expect(r.error.stage).toBe("ajv");
  });
});

describe("provenance-stamp.ts — StampError.stamp_invalid", () => {
  const secrets: StamperDeps = {
    secrets: { resolveSigningKey: async () => ok("signing-key-material") },
    signingKeyRef: "kw-provenance-signing-key",
  } as unknown as StamperDeps;

  it("stamp_invalid_produces_an_audit_signal", async () => {
    // ⚠ SCOPED HONESTLY: this member refuses INTERNALLY-MINTED data (a contract-drift bug), not row
    // candidate data — its docblock says "should be unreachable". It is in the population because it
    // carries the same issue-holding shape, which is what makes `issues` reachable-for by the next
    // author; the shape requirement is the point, not a claim that a row can reach it.
    // All inputs present so the HMAC preimage is well-formed and the call REACHES the frozen
    // contract gate; `mdContentSha` is the one field shaped wrong, so the minted stamp is what fails.
    const bad = {
      workspaceId: "personal-life",
      factIdentity: "page:x",
      originPath: "notes/x.md",
      mdContentSha: "not-a-sha256-hex" as MdContentSha,
      kwRevision: "rev-1",
      sourceEventRef: "evt-1",
      committedAt: "2026-08-18T00:00:00.000Z",
    } as unknown as StampInputs;
    const r = await stampProvenance(bad, secrets);
    expect(isErr(r)).toBe(true);
    if (!isErr(r) || r.error.code !== "stamp_invalid") return expect(isErr(r) && r.error.code).toBe("stamp_invalid");
    expect(r.error.audit).toBeDefined();
    expect(isRedactionSafe(r.error.audit)).toBe(true);
  });

  // ⛔ NO `stamp_row_authored_key_cannot_reach_the_signal` PIN, AND THE ABSENCE IS DELIBERATE AND
  // REPORTED: `SignedProvenanceStamp` has ZERO free-form-key regions on BOTH validator surfaces
  // (measured — ajv walk and Zod `_def` walk both return the empty set), so there is no cut to make
  // and no mutation that could red such a pin. Inventing a synthetic region to keep a symmetric-
  // looking test is exactly the "adjust the fixture until it passes" move the brief forbids.
});

// ── 3. the control ────────────────────────────────────────────────────────────────────────────

describe("the GCL control still discriminates after re-expression", () => {
  it("gcl_control_signal_is_byte_identical_after_re_expression", () => {
    // ⛔ THE PIN THAT PROVES THE CONTROL SURVIVED BEING TOUCHED. `GclGateError` is the DISCRIMINATING
    // control for the whole census — it is the one channel that already resolves `audit=true`, so a
    // selector that cannot separate it from the other four is measuring nothing. Re-expressing it in
    // terms of the shared shape must therefore change NOTHING observable.
    // ⭐ THESE VALUES WERE CAPTURED FROM HEAD *BEFORE* THE RE-EXPRESSION, not derived from it — an
    // expectation written after the change would only pin the change to itself.
    const ws = { workspaceId: "personal-life", type: "personal_life", defaultVisibility: "full" } as unknown as Workspace;
    const r = admitProjection({ nope: 1 }, ws);
    expect(r.ok).toBe(false);
    if (r.ok || r.error.code !== "schema_rejected") return expect(!r.ok && r.error.code).toBe("schema_rejected");
    expect(r.error.stage).toBe("ajv");
    expect(auditOf(r.error)).toEqual({
      actor: "knowledge:gcl-gate",
      event: "gcl.projection.schema_rejected.ajv",
      refs: ["ref:gcl-issue-path:#/required", "ref:gcl-issue-path:#/additionalProperties"],
      payloadHash: "knowledge:gcl-schema-rejection",
      beforeSummary: "gcl projection candidate refused at the ajv schema stage",
      afterSummary: "6 issue(s), 2 distinct path(s); nothing admitted",
    });
  });
});
