// Task 9.8 (worker leg) — `toUiSafeApproval`'s §9.8 optional enrichment. The CONTRACT half already
// landed (`packages/contracts/src/api/ui-safe.ts:150-153` declares `targetSystem?: TargetSystem` and
// `workspaceId?: string` on `UiSafeApproval`); this pins the WORKER projector half, which previously
// built only `{id, subjectKind, status, channel}` + `assignIfDefined`'d `actionRef`/`snoozeUntil`/
// `expiresAt` — `targetSystem` and `workspaceId` never crossed at all. RED-first: before this slice
// neither field appeared on ANY projected card.
//
// `targetSystem` is caller-supplied (the projector takes only `Approval`, which carries `actionRef`
// — a ref — not the `ProposedAction` record the ref points to, so the projector cannot resolve the
// target itself); `workspaceId` is the Approval's OWN server-set attribution field, copied through
// unconditionally.
import { describe, it, expect } from "vitest";
import type { Approval, TargetSystem } from "@sow/contracts";
import { toUiSafeApproval } from "../../../src/api/projections/uiSafe";

const EXTERNAL: Approval = {
  id: "appr_1" as Approval["id"],
  actionRef: "act_1" as Approval["actionRef"],
  subjectKind: "external_action",
  workspaceId: "ws-a" as Approval["workspaceId"],
  status: "pending",
  actor: "user:cody",
  channel: "mac",
  payloadHash: "sha256:x",
};

const SEMANTIC: Approval = {
  id: "appr_2" as Approval["id"],
  planRef: "plan_1" as Approval["planRef"],
  subjectKind: "semantic_mutation",
  workspaceId: "ws-a" as Approval["workspaceId"],
  status: "pending",
  actor: "user:cody",
  channel: "mac",
  payloadHash: "sha256:y",
};

describe("toUiSafeApproval — §9.8 targetSystem + workspaceId", () => {
  it("an external_action card CARRIES targetSystem when the caller supplies it (resolved from the bound ProposedAction)", () => {
    const out = toUiSafeApproval(EXTERNAL, "calendar" as TargetSystem);
    expect(out.targetSystem).toBe("calendar");
  });

  it("a semantic_mutation card OMITS targetSystem — there is no ProposedAction to resolve one from, even if a caller wrongly supplies one", () => {
    // Adversarial: the caller passes a value anyway. The projector must drop it — the guarantee is
    // structural (gated on subjectKind), not merely "callers happen not to pass one."
    const out = toUiSafeApproval(SEMANTIC, "calendar" as TargetSystem);
    expect("targetSystem" in out).toBe(false);
  });

  it("an external_action card whose caller supplies NO targetSystem also omits it (additive-optional — existing single-arg callers stay valid)", () => {
    const out = toUiSafeApproval(EXTERNAL);
    expect("targetSystem" in out).toBe(false);
  });

  it("workspaceId is ALWAYS the Approval's own server-set workspaceId, unconditionally, for both subject kinds", () => {
    expect(toUiSafeApproval(EXTERNAL).workspaceId).toBe("ws-a");
    expect(toUiSafeApproval(SEMANTIC).workspaceId).toBe("ws-a");
  });

  it("the allowlist discipline is unchanged — actor / payloadHash / planRef stay dropped, the projection is a strict subset", () => {
    const out = toUiSafeApproval(SEMANTIC, "calendar" as TargetSystem) as unknown as Record<string, unknown>;
    expect(out["actor"]).toBeUndefined();
    expect(out["payloadHash"]).toBeUndefined();
    expect(out["planRef"]).toBeUndefined();
    // Full key-set check — structural, not a single sampled field.
    expect(Object.keys(out).sort()).toEqual(["id", "status", "subjectKind", "channel", "workspaceId"].sort());
  });

  it("an external_action card's full key set includes targetSystem + actionRef when both are present", () => {
    const out = toUiSafeApproval(EXTERNAL, "calendar" as TargetSystem) as unknown as Record<string, unknown>;
    expect(Object.keys(out).sort()).toEqual(
      ["id", "actionRef", "subjectKind", "status", "channel", "workspaceId", "targetSystem"].sort(),
    );
  });
});
