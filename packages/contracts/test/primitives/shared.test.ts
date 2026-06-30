import { describe, it, expect, expectTypeOf } from "vitest";
import {
  WorkspaceIdSchema,
  AgentJobIdSchema,
  ActionIdSchema,
  PlanIdSchema,
  SourceIdSchema,
  ApprovalIdSchema,
  WorkflowIdSchema,
  AuditIdSchema,
  ProcessorIdSchema,
  ToolIdSchema,
  CapabilitySchema,
  RevisionIdSchema,
  ProposalIdSchema,
  ReportIdSchema,
  BrainIdSchema,
  FactIdentitySchema,
  MdContentShaSchema,
  factIdentity,
} from "../../src/primitives/zod-brands";
import type {
  Capability,
  RevisionId,
  FactIdentity,
  MdContentSha,
} from "../../src/primitives/zod-brands";
import type {
  WorkspaceId,
  AgentJobId,
} from "../../src/primitives/ids";
import {
  WorkspaceTypeSchema,
  DataOwnerSchema,
  VisibilityLevelSchema,
  EgressClassSchema,
  ProviderIdSchema,
  provenanceOriginSchema,
  targetSystemSchema,
  approvalStatusSchema,
  channelSchema,
  conformanceStatusSchema,
  healthStateSchema,
  failureClassSchema,
  factKindSchema,
  factProvenanceOriginSchema,
  gbrainLinkSourceSchema,
  generatedBySchema,
  divergenceClassSchema,
  severityFloorSchema,
  remediationSchema,
  remediationStateSchema,
  trustLevelSchema,
  gbrainAllowedOpSchema,
} from "../../src/models/shared-enums";
import { emitJsonSchema } from "../../src/schema/emit";
import { z } from "zod";

const plainBrandSchemas = [
  ["WorkspaceId", WorkspaceIdSchema],
  ["AgentJobId", AgentJobIdSchema],
  ["ActionId", ActionIdSchema],
  ["PlanId", PlanIdSchema],
  ["SourceId", SourceIdSchema],
  ["ApprovalId", ApprovalIdSchema],
  ["WorkflowId", WorkflowIdSchema],
  ["AuditId", AuditIdSchema],
  ["ProcessorId", ProcessorIdSchema],
  ["ToolId", ToolIdSchema],
  ["Capability", CapabilitySchema],
  ["RevisionId", RevisionIdSchema],
  ["ProposalId", ProposalIdSchema],
  ["ReportId", ReportIdSchema],
  ["BrainId", BrainIdSchema],
] as const;

describe("branded-id Zod schemas (1.x shared brands)", () => {
  it("accept a non-empty string and pass it through unchanged", () => {
    for (const [, schema] of plainBrandSchemas) {
      expect(schema.parse("x-1")).toBe("x-1");
    }
  });

  it("reject empty and whitespace-only strings", () => {
    for (const [name, schema] of plainBrandSchemas) {
      expect(schema.safeParse(""), `${name} empty`).toMatchObject({ success: false });
      expect(schema.safeParse("   "), `${name} spaces`).toMatchObject({ success: false });
      expect(schema.safeParse("\t\n"), `${name} tabs`).toMatchObject({ success: false });
    }
  });

  it("infer the existing Branded<> types from ids.ts", () => {
    expectTypeOf<z.infer<typeof WorkspaceIdSchema>>().toEqualTypeOf<WorkspaceId>();
    expectTypeOf<z.infer<typeof AgentJobIdSchema>>().toEqualTypeOf<AgentJobId>();
  });

  it("infer fresh Branded<> types for the new brands", () => {
    expectTypeOf<z.infer<typeof CapabilitySchema>>().toEqualTypeOf<Capability>();
    expectTypeOf<z.infer<typeof RevisionIdSchema>>().toEqualTypeOf<RevisionId>();
    expectTypeOf<z.infer<typeof FactIdentitySchema>>().toEqualTypeOf<FactIdentity>();
    expectTypeOf<z.infer<typeof MdContentShaSchema>>().toEqualTypeOf<MdContentSha>();
  });

  it("emit a clean { type:'string', minLength:1 } JSON Schema (no $ref)", () => {
    const js = emitJsonSchema(z.object({ w: WorkspaceIdSchema }).strict(), "sow:_probe");
    const props = js["properties"] as Record<string, unknown>;
    expect(props["w"]).toMatchObject({ type: "string", minLength: 1 });
    expect(JSON.stringify(js)).not.toContain("$ref");
  });
});

describe("FactIdentitySchema (content-INDEPENDENT structured string)", () => {
  it("accepts the four canonical forms", () => {
    expect(FactIdentitySchema.parse("page:projects/acme")).toBe("page:projects/acme");
    expect(FactIdentitySchema.parse("link:a/b->c/d:references")).toBe(
      "link:a/b->c/d:references",
    );
    expect(FactIdentitySchema.parse("timeline:meetings/standup:7")).toBe(
      "timeline:meetings/standup:7",
    );
    expect(FactIdentitySchema.parse("tag:notes/x:urgent")).toBe("tag:notes/x:urgent");
  });

  it("rejects unstructured / empty / wrong-kind strings", () => {
    expect(FactIdentitySchema.safeParse("")).toMatchObject({ success: false });
    expect(FactIdentitySchema.safeParse("page:")).toMatchObject({ success: false });
    expect(FactIdentitySchema.safeParse("frob:nope")).toMatchObject({ success: false });
    expect(FactIdentitySchema.safeParse("link:a:b")).toMatchObject({ success: false });
    expect(FactIdentitySchema.safeParse("timeline:onlyone")).toMatchObject({ success: false });
  });

  it("the factIdentity builder produces parseable identities", () => {
    expect(factIdentity({ kind: "page", slug: "projects/acme" })).toBe("page:projects/acme");
    expect(factIdentity({ kind: "link", src: "a", dst: "b", field: "rel" })).toBe(
      "link:a->b:rel",
    );
    expect(factIdentity({ kind: "timeline", page: "p", seq: 3 })).toBe("timeline:p:3");
    expect(factIdentity({ kind: "tag", page: "p", tag: "t" })).toBe("tag:p:t");
    expect(FactIdentitySchema.parse(factIdentity({ kind: "tag", page: "p", tag: "t" }))).toBe(
      "tag:p:t",
    );
  });
});

describe("MdContentShaSchema (sha256 hex)", () => {
  const hex = "a".repeat(64);
  it("accepts 64-char hex (case-insensitive)", () => {
    expect(MdContentShaSchema.parse(hex)).toBe(hex);
    expect(MdContentShaSchema.parse("A".repeat(64))).toBe("A".repeat(64));
  });
  it("rejects wrong length / non-hex", () => {
    expect(MdContentShaSchema.safeParse("a".repeat(63))).toMatchObject({ success: false });
    expect(MdContentShaSchema.safeParse("g".repeat(64))).toMatchObject({ success: false });
    expect(MdContentShaSchema.safeParse("")).toMatchObject({ success: false });
  });
});

describe("shared enum schemas — exact membership", () => {
  const cases: Array<[ReturnType<typeof z.enum>, readonly string[]]> = [
    [WorkspaceTypeSchema, ["employer_work", "personal_business", "personal_life"]],
    [DataOwnerSchema, ["employer", "user", "client"]],
    [VisibilityLevelSchema, ["isolated", "coordination", "sanitized", "full"]],
    [EgressClassSchema, ["local", "cloud"]],
    [ProviderIdSchema, ["claude", "openai", "openrouter", "ollama", "lm_studio"]],
    [provenanceOriginSchema, [
      "human", "meeting_close", "ingestion", "gbrain_proposal", "parity_remediation",
    ]],
    [targetSystemSchema, [
      "calendar", "todoist", "linear", "asana", "drive", "github", "telegram",
    ]],
    [approvalStatusSchema, [
      "pending", "approved", "edited", "rejected", "deferred", "expired",
    ]],
    [channelSchema, ["mac", "telegram"]],
    [conformanceStatusSchema, ["unknown", "passing", "failing", "disabled"]],
    [healthStateSchema, ["open", "acknowledged", "resolved"]],
    [failureClassSchema, [
      "connector_unreachable", "write_through_failed", "budget_breach",
      "missed_or_late_schedule", "schema_rejection", "worker_down",
      "parity_defect", "conflict_review", "sync_lagging", "rebuild_divergence",
    ]],
    [factKindSchema, ["page", "link", "timeline", "tag", "frontmatter_value"]],
    [factProvenanceOriginSchema, [
      "markdown", "frontmatter", "db_only", "generative_unmaterialized",
    ]],
    [gbrainLinkSourceSchema, ["markdown", "frontmatter", "manual"]],
    [generatedBySchema, ["synthesis", "dream", "patterns", "minion"]],
    [divergenceClassSchema, [
      "db_only", "unstamped", "content_mismatch", "md_only",
      "edge_db_only", "edge_md_only", "stale_revision",
    ]],
    [severityFloorSchema, ["hard", "soft"]],
    [remediationSchema, ["resync", "materialize", "purge", "review"]],
    [remediationStateSchema, [
      "pending", "materializing", "materialized", "purged", "dismissed",
    ]],
    [trustLevelSchema, ["trusted", "untrusted"]],
    [gbrainAllowedOpSchema, [
      "search", "graph", "timeline", "schema_read", "health", "contained_synthesis",
    ]],
  ];

  it("each enum lists exactly its declared members", () => {
    for (const [schema, members] of cases) {
      expect([...schema.options]).toEqual(members);
      for (const m of members) expect(schema.safeParse(m).success).toBe(true);
      expect(schema.safeParse("definitely-not-a-member").success).toBe(false);
    }
  });
});
