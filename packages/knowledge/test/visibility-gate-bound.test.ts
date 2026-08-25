// task 24.31 — `visibility_type_mismatch`'s `projectionType` is a producer-declared
// OPEN string: packages/contracts/src/models/gcl-projection.ts pins it at
// `z.string().min(1)` only — no max length, no newline ban (wave 1 owns that file;
// not touched here). Bound it AT THE MINT SITE in
// packages/knowledge/src/gcl/visibility-gate.ts so no future consumer (none exists
// yet — this variant is still consumer-less) inherits an unbounded producer string.
// Drives the real gate end to end (never hand-builds the error), mirroring the
// fixture shape `gcl-visibility-gate.test.ts` already uses for this same path.
import { describe, it, expect } from "vitest";
import { defaultWorkspace, type GclProjection, type Workspace } from "@sow/contracts";
import type { ProjectionTypeVisibilityTaxonomy } from "@sow/policy";
import { admitProjection } from "../src/gcl/visibility-gate";

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

const baseCandidate: Pick<GclProjection, "workspaceId" | "sanitizedPayload" | "sourceRefs"> = {
  workspaceId: "ws-001" as GclProjection["workspaceId"],
  sanitizedPayload: { busySlots: 3 },
  sourceRefs: [{ sourceId: "src-001" as GclProjection["sourceRefs"][number]["sourceId"] }],
};

describe("visibility_type_mismatch — projectionType bounded at the mint site (task 24.31)", () => {
  it("visibility_type_mismatch_projectionType_is_bounded_and_single_line", () => {
    // Long + carries embedded CR/LF — exactly the shape an unbounded producer
    // string could smuggle into a downstream renderer/log if left un-mirrored.
    const hostile = "deadlines" + "a".repeat(4096) + "\nsmuggled\r\npayload";
    const candidate: GclProjection = {
      ...baseCandidate,
      visibilityLevel: "coordination",
      projectionType: hostile,
    };
    // Taxonomy keyed on the RAW producer string — the derivation lookup reads
    // `projection.projectionType` directly (policy/visibility.ts), before any
    // bounding, so this mismatch is real and not an artifact of a bound key
    // colliding with (or failing to collide with) the taxonomy.
    const taxonomy: ProjectionTypeVisibilityTaxonomy = { [hostile]: ["isolated"] };
    const r = admitProjection(candidate, wsWithDefault("full"), undefined, taxonomy);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("visibility_type_mismatch");
    if (r.error.code !== "visibility_type_mismatch") return;
    expect(r.error.projectionType.length).toBeLessThanOrEqual(256);
    expect(/[\r\n]/.test(r.error.projectionType)).toBe(false);
    // The diagnostic value must survive the bound, not be lobotomised by it.
    expect(r.error.projectionType.startsWith("deadlines")).toBe(true);
  });

  // Isolates the newline-COLLAPSE step from the length cap: this string never
  // reaches 256 chars, so a bound that only truncated (never collapsed) would
  // still pass every assertion in the test above (its newlines sit past
  // position 4105, long truncated away) — this pins collapse independently.
  it("visibility_type_mismatch_projectionType_collapses_embedded_newline_below_the_cap", () => {
    const hostile = "deadlines\r\nsmuggled";
    const candidate: GclProjection = {
      ...baseCandidate,
      visibilityLevel: "coordination",
      projectionType: hostile,
    };
    const taxonomy: ProjectionTypeVisibilityTaxonomy = { [hostile]: ["isolated"] };
    const r = admitProjection(candidate, wsWithDefault("full"), undefined, taxonomy);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("visibility_type_mismatch");
    if (r.error.code !== "visibility_type_mismatch") return;
    expect(r.error.projectionType).toBe("deadlines smuggled");
  });

  it("benign_projectionType_passes_through_byte_identical", () => {
    const candidate: GclProjection = {
      ...baseCandidate,
      visibilityLevel: "coordination",
      projectionType: "deadlines",
    };
    const taxonomy: ProjectionTypeVisibilityTaxonomy = { deadlines: ["isolated"] };
    const r = admitProjection(candidate, wsWithDefault("full"), undefined, taxonomy);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe("visibility_type_mismatch");
    if (r.error.code !== "visibility_type_mismatch") return;
    expect(r.error.projectionType).toBe("deadlines");
  });
});
