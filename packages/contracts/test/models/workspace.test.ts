// Workspace contract test (task 1.5, §3/§6). RED-first schema-snapshot freeze +
// behavior + referential-invariant + safe-default-factory coverage. Mirrors the
// canonical egress-policy.test.ts template. PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import {
  WorkspaceSchema,
  WORKSPACE_SCHEMA_ID,
  defaultWorkspace,
} from "../../src/models/workspace";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

// A fully-formed, valid workspace input (workspaceIds aligned across the
// embedded EgressPolicy + ProviderMatrix → referential pin satisfied).
const validWorkspace = {
  id: "ws-acme",
  name: "Acme Employer Work",
  type: "employer_work",
  dataOwner: "employer",
  markdownRepoPath: "/Users/me/vaults/acme",
  gbrainBrainId: "brain-acme",
  defaultVisibility: "isolated",
  egressPolicy: {
    workspaceId: "ws-acme",
    allowedProcessors: ["claude-cloud"],
    rawContentAllowedProcessors: [],
    employerRawEgressAcknowledged: false,
  },
  providerMatrix: {
    workspaceId: "ws-acme",
    allowedProviders: ["claude", "ollama"],
    capabilityDefaults: {},
    rawCloudEgressEnabled: false,
  },
} as const;

describe("Workspace contract — spec(§3/§6)", () => {
  // ── Frozen field-name set (the spec, hand-authored in __snapshots__) ──────
  it("freezes its top-level field-name set to the spec snapshot", () => {
    expect(fieldSet(emitJsonSchema(WorkspaceSchema, WORKSPACE_SCHEMA_ID))).toEqual(
      loadFieldSnapshot("workspace"),
    );
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ─
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/workspace.schema.json", import.meta.url),
      emitJsonSchema(WorkspaceSchema, WORKSPACE_SCHEMA_ID),
    );
  });

  // ── Behaviors ────────────────────────────────────────────────────────────
  it("accepts a valid workspace with aligned embedded workspaceIds", () => {
    expect(WorkspaceSchema.safeParse(validWorkspace).success).toBe(true);
  });

  it("rejects an unknown top-level key (.strict)", () => {
    const bad = WorkspaceSchema.safeParse({ ...validWorkspace, extra: "nope" });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty/whitespace id (branded non-empty)", () => {
    const bad = WorkspaceSchema.safeParse({
      ...validWorkspace,
      id: "   ",
      egressPolicy: { ...validWorkspace.egressPolicy, workspaceId: "   " },
      providerMatrix: { ...validWorkspace.providerMatrix, workspaceId: "   " },
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty name", () => {
    const bad = WorkspaceSchema.safeParse({ ...validWorkspace, name: "" });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty markdownRepoPath", () => {
    const bad = WorkspaceSchema.safeParse({ ...validWorkspace, markdownRepoPath: "" });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty/whitespace gbrainBrainId (branded non-empty)", () => {
    const bad = WorkspaceSchema.safeParse({ ...validWorkspace, gbrainBrainId: "  " });
    expect(bad.success).toBe(false);
  });

  it("rejects an out-of-set type", () => {
    const bad = WorkspaceSchema.safeParse({ ...validWorkspace, type: "freelance" });
    expect(bad.success).toBe(false);
  });

  it("rejects an out-of-set dataOwner", () => {
    const bad = WorkspaceSchema.safeParse({ ...validWorkspace, dataOwner: "nobody" });
    expect(bad.success).toBe(false);
  });

  it("rejects an out-of-set defaultVisibility", () => {
    const bad = WorkspaceSchema.safeParse({ ...validWorkspace, defaultVisibility: "public" });
    expect(bad.success).toBe(false);
  });

  it("rejects a missing required field (egressPolicy)", () => {
    const { egressPolicy: _omit, ...rest } = validWorkspace;
    const bad = WorkspaceSchema.safeParse(rest);
    expect(bad.success).toBe(false);
  });

  it("rejects an embedded EgressPolicy that violates its own invariant (acknowledged true, no acknowledgedAt)", () => {
    const bad = WorkspaceSchema.safeParse({
      ...validWorkspace,
      egressPolicy: {
        ...validWorkspace.egressPolicy,
        employerRawEgressAcknowledged: true,
      },
    });
    expect(bad.success).toBe(false);
  });

  it("rejects an embedded ProviderMatrix that violates its own invariant (route provider not in allowedProviders)", () => {
    const bad = WorkspaceSchema.safeParse({
      ...validWorkspace,
      providerMatrix: {
        ...validWorkspace.providerMatrix,
        allowedProviders: ["claude"],
        capabilityDefaults: {
          summarize: {
            provider: "openai",
            model: "gpt-x",
            endpoint: "https://api.openai.com",
            egressClass: "cloud",
          },
        },
      },
    });
    expect(bad.success).toBe(false);
  });

  // ── Referential pin: id === egressPolicy.workspaceId === providerMatrix.workspaceId ─
  it("accepts when id matches both embedded workspaceIds (refine, passing)", () => {
    expect(WorkspaceSchema.safeParse(validWorkspace).success).toBe(true);
  });

  it("rejects when id !== egressPolicy.workspaceId (refine, failing)", () => {
    const bad = WorkspaceSchema.safeParse({
      ...validWorkspace,
      egressPolicy: { ...validWorkspace.egressPolicy, workspaceId: "ws-other" },
    });
    expect(bad.success).toBe(false);
  });

  it("rejects when id !== providerMatrix.workspaceId (refine, failing)", () => {
    const bad = WorkspaceSchema.safeParse({
      ...validWorkspace,
      providerMatrix: { ...validWorkspace.providerMatrix, workspaceId: "ws-other" },
    });
    expect(bad.success).toBe(false);
  });

  // ── Safe-default factory ─────────────────────────────────────────────────
  it("defaultWorkspace(employer_work) defaults dataOwner='employer' and egress closed", () => {
    const ws = defaultWorkspace({
      id: "ws-emp",
      name: "Employer",
      type: "employer_work",
      markdownRepoPath: "/vaults/emp",
      gbrainBrainId: "brain-emp",
    });
    expect(ws.dataOwner).toBe("employer");
    expect(ws.egressPolicy.employerRawEgressAcknowledged).toBe(false);
    expect(ws.egressPolicy.rawContentAllowedProcessors).toEqual([]);
  });

  it("defaultWorkspace wires the workspaceId into both embeds (referential pin holds → re-parses)", () => {
    const ws = defaultWorkspace({
      id: "ws-emp",
      name: "Employer",
      type: "employer_work",
      markdownRepoPath: "/vaults/emp",
      gbrainBrainId: "brain-emp",
    });
    expect(ws.egressPolicy.workspaceId).toBe("ws-emp");
    expect(ws.providerMatrix.workspaceId).toBe("ws-emp");
    // The factory output is a fully valid Workspace.
    expect(WorkspaceSchema.safeParse(ws).success).toBe(true);
  });

  it("defaultWorkspace(personal_business) defaults dataOwner='user'", () => {
    const ws = defaultWorkspace({
      id: "ws-side",
      name: "Side Project",
      type: "personal_business",
      markdownRepoPath: "/vaults/side",
      gbrainBrainId: "brain-side",
    });
    expect(ws.dataOwner).toBe("user");
  });

  it("defaultWorkspace honors an explicit dataOwner override", () => {
    const ws = defaultWorkspace({
      id: "ws-c",
      name: "Client Work",
      type: "employer_work",
      markdownRepoPath: "/vaults/c",
      gbrainBrainId: "brain-c",
      dataOwner: "client",
    });
    expect(ws.dataOwner).toBe("client");
  });
});
