// 1.15 — INVALID seam fixtures (DATA), one per pinned rejection rule. Each is a
// deliberately contract-violating literal carrying a claimed `valid:false` label
// plus the gate tier that rejects it (see `FixtureGate`). PURE DATA — no
// clock/random/I-O.
//
// TWO-TIER GATE (see fixtures.test.ts). The 1.2 ajv `validate()` gate is
// STRUCTURAL-ONLY (zod-to-json-schema drops `.refine()`), so:
//   • "schema_gate" violations (missing required field, extra key under
//     additionalProperties:false, wrong const/enum) are caught by `validate()`.
//   • "refine" violations (cross-field invariants) PASS `validate()` but are
//     caught by the authoritative Zod schema parse.
//   • "no_inference" is caught by the 1.11 `validateNoInference` (no schema).
// The instances are intentionally untyped objects (some omit required fields), so
// they are exported as `unknown`-compatible data, not as the model type.

// ── REFINE-tier: read_only ToolPolicy that admits mutation (allowsMutating:true).
// Structurally a valid ToolPolicy; violates `read_only ⇒ !allowsMutating`.
export const invalidToolPolicyMutatingReadOnly: unknown = {
  mode: "read_only",
  allowedTools: ["delete.file"],
  deniedTools: [],
  allowsMutating: true,
};

// ── REFINE-tier: employerRawEgressAcknowledged=true WITHOUT acknowledgedAt.
// Violates the acknowledgedAt ⇔ acknowledged coupling (audit-trail incomplete).
export const invalidEgressPolicyAckWithoutTimestamp: unknown = {
  workspaceId: "ws-egress-001",
  allowedProcessors: ["proc.openai"],
  rawContentAllowedProcessors: ["proc.openai"],
  employerRawEgressAcknowledged: true,
};

// ── REFINE-tier: KnowledgeMutationPlan with EMPTY sourceRefs (REQ-F-006).
// An unsourced semantic mutation — exactly the "invented fact" the gate forbids.
export const invalidKnowledgeMutationPlanEmptySourceRefs: unknown = {
  planId: "plan-001",
  workspaceId: "ws-001",
  sourceRefs: [],
  creates: [],
  patches: [],
  linkMutations: [],
  frontmatterUpdates: [],
  externalActionProposals: [],
  confidence: 0.5,
  requiresApproval: false,
  provenanceOrigin: "meeting_close",
};

// ── REFINE-tier: ProviderMatrix route referencing a provider OUTSIDE
// allowedProviders (route "openai" ∉ {"claude"}).
export const invalidProviderMatrixRouteNotAllowed: unknown = {
  workspaceId: "ws-001",
  allowedProviders: ["claude"],
  capabilityDefaults: {
    "meeting.close": {
      provider: "openai",
      model: "gpt-4",
      endpoint: "https://api.openai.com",
      egressClass: "cloud",
    },
  },
  rawCloudEgressEnabled: true,
};

// ── SCHEMA_GATE-tier: ProposedAction missing canonicalObjectKey AND idempotencyKey
// (the two required external-write keys, §3/§8 safety rule 3).
export const invalidProposedActionMissingKeys: unknown = {
  actionId: "act-001",
  targetSystem: "todoist",
  payload: {},
  approvalPolicy: "auto",
};

// ── SCHEMA_GATE-tier: GclProjection missing visibilityLevel (required, §6 WS-8).
export const invalidGclProjectionMissingVisibility: unknown = {
  workspaceId: "ws-001",
  projectionType: "calendar_busy",
  sanitizedPayload: {},
  sourceRefs: [],
};

// ── SCHEMA_GATE-tier: ProviderProfile carrying an INLINE secret (extra `apiKey`).
// Rejected by additionalProperties:false (REQ-S-003 — secrets via Keychain only).
export const invalidProviderProfileInlineSecret: unknown = {
  provider: "openai",
  endpoint: "https://api.openai.com",
  model: "gpt-4",
  capabilities: [],
  egressClass: "cloud",
  costCaps: {},
  conformanceStatus: "passing",
  apiKey: "sk-secret-should-not-be-here",
};

// ── SCHEMA_GATE-tier: SignedProvenanceStamp with a non-KnowledgeWriter writerActor
// (violates the writerActor const "KnowledgeWriter" — safety rule 1, one writer).
export const invalidSignedProvenanceStampWrongWriter: unknown = {
  kwRevision: "rev-001",
  originPath: "acme/auth.md",
  mdContentSha: "0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d",
  writerActor: "Attacker",
  sourceEventRef: "meeting:123",
  committedAt: "2026-06-30T12:00:00Z",
  sig: "hmac-forged",
};

// ── SCHEMA_GATE-tier: GbrainReadGrant with generativeCycleEnabled=true
// (violates the const false — the generative cycle must never run on the runtime).
export const invalidGbrainReadGrantGenerationOn: unknown = {
  workspaceId: "ws-001",
  brainId: "brain-acme",
  transport: "http",
  scope: ["read"],
  tokenRef: "keychain:gbrain-token",
  allowedOps: ["search"],
  federationScope: "workspace_only",
  generativeCycleEnabled: true,
  pinnedSha: "0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d0a1b2c3d",
  indexSchemaVersion: 7,
};

// ── NO_INFERENCE-tier (REQ-F-017): meeting-extraction owner/date fields each
// carrying a concrete value with NO evidenceRef — the "invented owner/date" the
// no-inference rule hard-rejects. Represented via the 1.11 ExtractionField shape;
// validated by `validateNoInference`, NOT the schema gate.
export const invalidNoInferenceUnbackedFields: unknown = {
  taskOwner: { value: "Alice" },
  dueDate: { value: "2026-07-15" },
};
