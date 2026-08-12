/**
 * 24.37 half B — `auditPersist` REQUIRED at consumption, not merely complete at construction.
 *
 * These are TYPE-LEVEL pins. Their RED is a `@ts-expect-error` going UNUSED (TS2578) under
 * `tsc --noEmit`, not a failing runtime assertion — see contracts L87 for the precedent. The
 * runtime `expect`s below exist so the file is a real suite; the load-bearing assertions are
 * the directives themselves, which only the typecheck evaluates.
 *
 * ⚠ SCOPE (L100): these pin the guarantee for `auditPersist` ONLY. They do NOT close the general
 * class (a hand-built deps literal dropping a factory's later-added OPTIONAL field) — that stays
 * a convention: make safety-relevant deps fields required.
 */
import { describe, expect, it } from "vitest";

import type { AuditPersistPort } from "../../../src/api/procedures/copilot.js";
import type {
  AuditPersisting,
  CopilotDeps,
  GovernedCopilotSynthesisDeps,
} from "../../../src/api/procedures/copilot.js";

const stubAuditPersist: AuditPersistPort = {
  persistDenial: async (): Promise<void> => undefined,
};

// A structurally-complete bundle EXCEPT for `auditPersist`. Every field below is required on
// `GovernedCopilotSynthesisDeps`, so this value's ONLY deficiency is the audit port — which is
// what makes the negative pin below discriminate that one field rather than general malformity.
const withoutAuditPersist = {
  synthesis: {} as GovernedCopilotSynthesisDeps["synthesis"],
  workspacePosture: {} as GovernedCopilotSynthesisDeps["workspacePosture"],
  routeSelector: {} as GovernedCopilotSynthesisDeps["routeSelector"],
} satisfies Omit<GovernedCopilotSynthesisDeps, "auditPersist">;

describe("24.37 — auditPersist is required on the production-path deps type", () => {
  it("production_path_cannot_construct_synthesis_deps_without_audit_persist", () => {
    // @ts-expect-error 24.37 — a production-path bundle CANNOT omit `auditPersist`. If the
    // narrowing is weakened this assignment succeeds, the directive becomes UNUSED, and tsc
    // fails the file with TS2578. That is this pin's RED.
    const missing: AuditPersisting<GovernedCopilotSynthesisDeps> = withoutAuditPersist;
    expect(missing).toBeDefined();
  });

  it("production_path_accepts_the_bundle_once_audit_persist_is_present", () => {
    // The ALLOW-side control (L80): differs from the deny fixture in EXACTLY the field the
    // guarantee is about. Without this, a narrowing that rejected EVERYTHING would also pass.
    const present: AuditPersisting<GovernedCopilotSynthesisDeps> = {
      ...withoutAuditPersist,
      auditPersist: stubAuditPersist,
    };
    expect(present.auditPersist).toBe(stubAuditPersist);
  });

  it("test_fixtures_may_still_omit_audit_persist", () => {
    // The permissive shape stays permissive — deleting the optionality is NOT the fix. 14 fixture
    // sites across 8 files legitimately omit it (measured 2026-08-12 from tsc output, not grep).
    const fixture: GovernedCopilotSynthesisDeps = withoutAuditPersist;
    expect(fixture.auditPersist).toBeUndefined();

    const fixtureDeps: CopilotDeps = {
      ...withoutAuditPersist,
      retrieval: {} as CopilotDeps["retrieval"],
    };
    expect(fixtureDeps.auditPersist).toBeUndefined();
  });
});
