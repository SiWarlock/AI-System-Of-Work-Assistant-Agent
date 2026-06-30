// QuarantineRecord contract test (task WT, §6/§16). RED-first schema-snapshot
// freeze + behavior + field-level invariant coverage. Mirrors the canonical
// EgressPolicy template. QuarantineRecord is OPERATIONAL TRUTH — the durable
// record of a quarantined parity defect (a DB-only semantic fact, per safety
// rule 1). It REFERENCES a Divergence by id (divergenceRef) and does NOT embed
// the Divergence object; its factIdentity is content-INDEPENDENT.
// PURE — no app/adapter imports.
import { describe, expect, it } from "vitest";
import {
  QuarantineRecordSchema,
  QUARANTINE_RECORD_SCHEMA_ID,
} from "../../src/models/quarantine-record";
import { fieldSet } from "../../src/schema/field-set";
import { emitJsonSchema } from "../../src/schema/emit";
import { loadFieldSnapshot, freezeGenerated } from "../_helpers/freeze";

// A canonical, structurally-valid base record (all required fields present).
const BASE = {
  factIdentity: "page:employer-work/acme/auth-redesign",
  workspaceId: "ws-employer",
  divergenceRef: "div-7f3a",
  divergenceClass: "db_only",
  capturedDbDigest: "sha256:abc123def456",
  remediationState: "pending",
  healthItemId: "health-001",
  auditRef: "audit-001",
} as const;

describe("QuarantineRecord contract — spec(§6/§16)", () => {
  // ── Frozen field-name set (the spec, hand-authored in __snapshots__) ──────
  it("freezes its top-level field-name set to the spec snapshot", () => {
    expect(
      fieldSet(emitJsonSchema(QuarantineRecordSchema, QUARANTINE_RECORD_SCHEMA_ID)),
    ).toEqual(loadFieldSnapshot("quarantine-record"));
  });

  // ── Generated JSON Schema drift guard (first run writes; later runs assert) ─
  it("freezes its generated JSON Schema", () => {
    freezeGenerated(
      new URL("../../schemas/quarantine-record.schema.json", import.meta.url),
      emitJsonSchema(QuarantineRecordSchema, QUARANTINE_RECORD_SCHEMA_ID),
    );
  });

  // ── Behaviors: valid fixtures parse ──────────────────────────────────────
  it("accepts a valid quarantine record WITHOUT the optional planId", () => {
    const ok = QuarantineRecordSchema.safeParse({ ...BASE });
    expect(ok.success).toBe(true);
  });

  it("accepts a valid quarantine record WITH the optional planId", () => {
    const ok = QuarantineRecordSchema.safeParse({
      ...BASE,
      remediationState: "materializing",
      planId: "plan-001",
    });
    expect(ok.success).toBe(true);
  });

  // remediationState lifecycle — every spec-named state is accepted (no
  // cross-field coupling: divergenceClass and remediationState are independent
  // dimensions; see the model's design note + the session flags).
  it.each(["pending", "materializing", "materialized", "purged", "dismissed"])(
    "accepts remediationState === %s",
    (remediationState) => {
      const ok = QuarantineRecordSchema.safeParse({ ...BASE, remediationState });
      expect(ok.success).toBe(true);
    },
  );

  // every spec-named divergenceClass is accepted (mirrors Divergence's enum).
  it.each([
    "db_only",
    "unstamped",
    "content_mismatch",
    "md_only",
    "edge_db_only",
    "edge_md_only",
    "stale_revision",
  ])("accepts divergenceClass === %s", (divergenceClass) => {
    const ok = QuarantineRecordSchema.safeParse({ ...BASE, divergenceClass });
    expect(ok.success).toBe(true);
  });

  // ── Behaviors: invalid fixtures are rejected ─────────────────────────────
  it("rejects an unknown top-level key (.strict)", () => {
    const bad = QuarantineRecordSchema.safeParse({ ...BASE, extra: "nope" });
    expect(bad.success).toBe(false);
  });

  it("rejects a missing required field (capturedDbDigest)", () => {
    const { capturedDbDigest: _omit, ...rest } = BASE;
    const bad = QuarantineRecordSchema.safeParse(rest);
    expect(bad.success).toBe(false);
  });

  it("rejects a missing required field (healthItemId)", () => {
    const { healthItemId: _omit, ...rest } = BASE;
    const bad = QuarantineRecordSchema.safeParse(rest);
    expect(bad.success).toBe(false);
  });

  it("rejects an empty/whitespace workspaceId (branded non-empty)", () => {
    const bad = QuarantineRecordSchema.safeParse({ ...BASE, workspaceId: "   " });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty/whitespace auditRef (branded non-empty)", () => {
    const bad = QuarantineRecordSchema.safeParse({ ...BASE, auditRef: "" });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty divergenceRef (non-empty string)", () => {
    const bad = QuarantineRecordSchema.safeParse({ ...BASE, divergenceRef: "" });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty capturedDbDigest (non-empty string)", () => {
    const bad = QuarantineRecordSchema.safeParse({ ...BASE, capturedDbDigest: "" });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty healthItemId (non-empty string)", () => {
    const bad = QuarantineRecordSchema.safeParse({ ...BASE, healthItemId: "" });
    expect(bad.success).toBe(false);
  });

  it("rejects an empty/whitespace planId when present (branded optional)", () => {
    const bad = QuarantineRecordSchema.safeParse({ ...BASE, planId: "   " });
    expect(bad.success).toBe(false);
  });

  // ── Invariant: remediationState ∈ pending|materializing|materialized|purged|dismissed ─
  // Passing direction covered by the it.each above; the failing direction:
  it("rejects a remediationState outside the enum", () => {
    const bad = QuarantineRecordSchema.safeParse({
      ...BASE,
      remediationState: "ignored", // not a member of RemediationState
    });
    expect(bad.success).toBe(false);
  });

  it("rejects a divergenceClass outside the enum", () => {
    const bad = QuarantineRecordSchema.safeParse({
      ...BASE,
      divergenceClass: "totally_diverged", // not a member of DivergenceClass
    });
    expect(bad.success).toBe(false);
  });

  // ── Invariant: factIdentity is content-INDEPENDENT (structured identity) ───
  // Passing direction covered by BASE (page:<slug>) + the divergenceClass loop;
  // a content-derived identity (sha of content) matches no known form → rejected.
  it("rejects a content-derived factIdentity (content-independence regex)", () => {
    const bad = QuarantineRecordSchema.safeParse({
      ...BASE,
      factIdentity: "sha256:deadbeefcafe", // content hash, not a location form
    });
    expect(bad.success).toBe(false);
  });

  it("accepts a link-form factIdentity (edge fact location)", () => {
    const ok = QuarantineRecordSchema.safeParse({
      ...BASE,
      factIdentity: "link:acme/auth->acme/sessions:relatesTo",
      divergenceClass: "edge_db_only",
    });
    expect(ok.success).toBe(true);
  });

  // ── Invariant: references a Divergence by id; does NOT embed the object ─────
  // divergenceRef is an id STRING. Passing direction covered by BASE; embedding
  // the Divergence object instead of its id is rejected (it is not a string).
  it("rejects an EMBEDDED Divergence object in divergenceRef (must be an id string)", () => {
    const bad = QuarantineRecordSchema.safeParse({
      ...BASE,
      divergenceRef: {
        factIdentity: "page:employer-work/acme/auth-redesign",
        divergenceClass: "db_only",
        remediation: "resync",
      },
    });
    expect(bad.success).toBe(false);
  });
});
