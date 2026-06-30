// GbrainReadGrant contract test (task WT, §6/§7). RED-first schema-snapshot
// freeze + behavior + literal-invariant coverage. The grant is "typed proof no
// write/admin token reaches the runtime": a read-only, workspace-scoped,
// generation-disabled HTTP serve grant. PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import {
  GbrainReadGrantSchema,
  GbrainServePolicySchema,
  GBRAIN_READ_GRANT_SCHEMA_ID,
} from "../../src/models/gbrain-read-grant";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

// A canonical valid grant reused across the rejection tests (each clones + breaks
// exactly one field, so a rejection is attributable to that field alone).
const VALID = {
  workspaceId: "ws-employer",
  brainId: "brain-employer",
  transport: "http",
  scope: ["read"],
  tokenRef: "keychain://gbrain/employer/read-token",
  allowedOps: ["search", "graph", "timeline", "schema_read", "health", "contained_synthesis"],
  federationScope: "workspace_only",
  generativeCycleEnabled: false,
  pinnedSha: "a".repeat(40),
  indexSchemaVersion: 3,
} as const;

describe("GbrainReadGrant contract — spec(§6/§7)", () => {
  // ── Frozen field-name set (the spec, hand-authored in __snapshots__) ──────
  it("freezes its top-level field-name set to the spec snapshot", () => {
    expect(fieldSet(emitJsonSchema(GbrainReadGrantSchema, GBRAIN_READ_GRANT_SCHEMA_ID))).toEqual(
      loadFieldSnapshot("gbrain-read-grant"),
    );
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ─
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/gbrain-read-grant.schema.json", import.meta.url),
      emitJsonSchema(GbrainReadGrantSchema, GBRAIN_READ_GRANT_SCHEMA_ID),
    );
  });

  // ── Aliasing: GbrainServePolicy IS GbrainReadGrant (Appendix A pairs them) ──
  it("exposes GbrainServePolicySchema as the same schema object (alias)", () => {
    expect(GbrainServePolicySchema).toBe(GbrainReadGrantSchema);
  });

  // ── Behaviors ────────────────────────────────────────────────────────────
  it("accepts a valid read-only, workspace-scoped, generation-disabled grant", () => {
    expect(GbrainReadGrantSchema.safeParse(VALID).success).toBe(true);
  });

  it("accepts a minimal allowedOps list (single op)", () => {
    expect(GbrainReadGrantSchema.safeParse({ ...VALID, allowedOps: ["search"] }).success).toBe(
      true,
    );
  });

  it("rejects an unknown top-level key (.strict)", () => {
    const bad = GbrainReadGrantSchema.safeParse({ ...VALID, extra: "nope" });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty/whitespace workspaceId (branded non-empty)", () => {
    const bad = GbrainReadGrantSchema.safeParse({ ...VALID, workspaceId: "   " });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty/whitespace brainId (branded non-empty)", () => {
    const bad = GbrainReadGrantSchema.safeParse({ ...VALID, brainId: "" });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty tokenRef (non-empty string)", () => {
    const bad = GbrainReadGrantSchema.safeParse({ ...VALID, tokenRef: "" });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty pinnedSha (non-empty string)", () => {
    const bad = GbrainReadGrantSchema.safeParse({ ...VALID, pinnedSha: "" });
    expect(bad.success).toBe(false);
  });

  it("rejects a non-number indexSchemaVersion", () => {
    const bad = GbrainReadGrantSchema.safeParse({ ...VALID, indexSchemaVersion: "3" });
    expect(bad.success).toBe(false);
  });

  it("rejects a missing required field (tokenRef)", () => {
    const { tokenRef: _omit, ...rest } = VALID;
    const bad = GbrainReadGrantSchema.safeParse(rest);
    expect(bad.success).toBe(false);
  });

  // ── Literal invariants (the "no write/admin reaches the runtime" proof) ────
  // transport === 'http'
  it("rejects a transport other than 'http' (literal)", () => {
    const bad = GbrainReadGrantSchema.safeParse({ ...VALID, transport: "ws" });
    expect(bad.success).toBe(false);
  });

  // scope === ['read']: any non-'read' scope element is rejected (no write/admin)
  it("rejects a scope element other than 'read' (literal)", () => {
    const bad = GbrainReadGrantSchema.safeParse({ ...VALID, scope: ["write"] });
    expect(bad.success).toBe(false);
  });

  // federationScope === 'workspace_only': no cross-workspace federation
  it("rejects a federationScope other than 'workspace_only' (literal)", () => {
    const bad = GbrainReadGrantSchema.safeParse({ ...VALID, federationScope: "cross_workspace" });
    expect(bad.success).toBe(false);
  });

  // generativeCycleEnabled === false: the generative cycle is hard-off
  it("rejects generativeCycleEnabled === true (literal false)", () => {
    const bad = GbrainReadGrantSchema.safeParse({ ...VALID, generativeCycleEnabled: true });
    expect(bad.success).toBe(false);
  });

  // allowedOps ⊆ {search,graph,timeline,schema_read,health,contained_synthesis}
  it("rejects an allowedOps value outside the read-op set", () => {
    const bad = GbrainReadGrantSchema.safeParse({ ...VALID, allowedOps: ["write"] });
    expect(bad.success).toBe(false);
  });
});
