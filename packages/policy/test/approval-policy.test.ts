// spec(§5) — approval policy predicate (REQ-F-012): PRIVATE-PERSONAL auto-allow
// is a strict subset of everything-else-requires-approval; fail-closed under
// uncertainty (missing/ambiguous policy ⇒ requiresApproval=true, NEVER
// auto-apply); decision is redaction-safe (carries refs/codes, never the raw
// payload). PURE + deterministic.
import { describe, it, expect } from "vitest";
import { requiresApproval } from "../src/approval-policy";
import type { ApprovalCardParams } from "../src/approval-policy";
import { isAllow, isDeny } from "../src/decision";
import { isRedactionSafe } from "../src/audit-signal";
import type { ProposedAction } from "@sow/contracts";
import type { ResolvedWorkspacePolicy } from "../src/workspace-policy";

const RAW_TITLE = "SECRET personal errand";
const RAW_NOTE = "buy milk and eggs";

function action(over: Partial<ProposedAction> = {}): ProposedAction {
  return {
    actionId: "act-1" as ProposedAction["actionId"],
    // `calendar` is the sole auto-allow-ELIGIBLE target (§9 Flow 6: auto-create a
    // private personal calendar event). Non-calendar external writes always
    // require approval — see adversarial-regressions.test.ts #3.
    targetSystem: "calendar",
    canonicalObjectKey: "calendar:event:home-1",
    payload: { title: RAW_TITLE, note: RAW_NOTE },
    approvalPolicy: "auto_private",
    idempotencyKey: "act-1-key",
    ...over,
  } as ProposedAction;
}

function resolved(over: Partial<ResolvedWorkspacePolicy> = {}): ResolvedWorkspacePolicy {
  return {
    workspaceId: "ws-personal-life",
    type: "personal_life",
    dataOwner: "user",
    defaultVisibility: "isolated",
    egressPolicy: {} as ResolvedWorkspacePolicy["egressPolicy"],
    providerMatrix: {} as ResolvedWorkspacePolicy["providerMatrix"],
    ...over,
  } as ResolvedWorkspacePolicy;
}

describe("requiresApproval — auto-allow is private-personal ONLY (Flow 3)", () => {
  it("auto-allows a private, policy-allowed PERSONAL action (requiresApproval=false, no card)", () => {
    const d = requiresApproval(action(), resolved());
    expect(isAllow(d)).toBe(true);
    if (isAllow(d)) {
      expect(d.value.requiresApproval).toBe(false);
      expect(d.value.card).toBeUndefined();
      expect(isRedactionSafe(d.audit)).toBe(true);
    }
  });

  it("requires approval for an EMPLOYER-owned action even under auto_private policy", () => {
    const d = requiresApproval(
      action(),
      resolved({ dataOwner: "employer", type: "employer_work" }),
    );
    expect(isAllow(d)).toBe(true);
    if (isAllow(d)) {
      expect(d.value.requiresApproval).toBe(true);
      expect(d.value.card).toBeDefined();
    }
  });

  it("requires approval for a CLIENT-owned action even under auto_private policy", () => {
    const d = requiresApproval(action(), resolved({ dataOwner: "client" }));
    expect(isAllow(d)).toBe(true);
    if (isAllow(d)) expect(d.value.requiresApproval).toBe(true);
  });

  it("requires approval for a cross-workspace-VISIBLE action (default visibility above isolated)", () => {
    const d = requiresApproval(action(), resolved({ defaultVisibility: "full" }));
    expect(isAllow(d)).toBe(true);
    if (isAllow(d)) expect(d.value.requiresApproval).toBe(true);
  });
});

describe("requiresApproval — shared / invite / external always require approval", () => {
  it("requires approval + emits a card for a SHARED/INVITE policy action", () => {
    const d = requiresApproval(action({ approvalPolicy: "invite" }), resolved());
    expect(isAllow(d)).toBe(true);
    if (isAllow(d)) {
      expect(d.value.requiresApproval).toBe(true);
      const card = d.value.card as ApprovalCardParams;
      expect(card).toBeDefined();
      expect(card.channels).toContain("mac");
    }
  });

  it("requires approval for an EXTERNAL-MESSAGE (telegram) action + routes the card to the telegram channel", () => {
    const d = requiresApproval(action({ targetSystem: "telegram" }), resolved());
    expect(isAllow(d)).toBe(true);
    if (isAllow(d)) {
      expect(d.value.requiresApproval).toBe(true);
      const card = d.value.card as ApprovalCardParams;
      expect(card.channels).toContain("mac");
      expect(card.channels).toContain("telegram");
    }
  });
});

describe("requiresApproval — fail-closed under uncertainty (NEVER auto-apply)", () => {
  it("requires approval for an AMBIGUOUS / unrecognized approvalPolicy", () => {
    const d = requiresApproval(action({ approvalPolicy: "mystery_token" }), resolved());
    expect(isAllow(d)).toBe(true);
    if (isAllow(d)) expect(d.value.requiresApproval).toBe(true);
  });

  it("requires approval when the resolved workspace policy is MISSING", () => {
    const d = requiresApproval(
      action(),
      null as unknown as ResolvedWorkspacePolicy,
    );
    expect(isAllow(d)).toBe(true);
    if (isAllow(d)) {
      expect(d.value.requiresApproval).toBe(true);
      const card = d.value.card as ApprovalCardParams;
      // Fail-closed: card falls back to the most-restrictive visibility.
      expect(card.visibilityLevel).toBe("isolated");
    }
  });

  it("DENIES a structurally unusable (null/non-object) action with MALFORMED_POLICY_INPUT", () => {
    const d = requiresApproval(null as unknown as ProposedAction, resolved());
    expect(isDeny(d)).toBe(true);
    if (isDeny(d)) {
      expect(d.reason).toBe("MALFORMED_POLICY_INPUT");
      expect(isRedactionSafe(d.audit)).toBe(true);
    }
  });
});

describe("requiresApproval — card params (§9) + purity + redaction", () => {
  it("emits the §9 deferred defaults: snooze 24h, auto-expire 7d", () => {
    const d = requiresApproval(action({ approvalPolicy: "invite" }), resolved());
    expect(isAllow(d)).toBe(true);
    if (isAllow(d)) {
      const card = d.value.card as ApprovalCardParams;
      expect(card.snoozeDefaultHours).toBe(24);
      expect(card.autoExpireDefaultDays).toBe(7);
      expect(card.visibilityLevel).toBe("isolated");
    }
  });

  it("carries the workspace visibility level into the card", () => {
    const d = requiresApproval(
      action({ approvalPolicy: "invite" }),
      resolved({ defaultVisibility: "coordination" }),
    );
    if (isAllow(d)) {
      const card = d.value.card as ApprovalCardParams;
      expect(card.visibilityLevel).toBe("coordination");
    }
  });

  it("NEVER leaks the raw payload into the decision or its audit signal (redaction-safe)", () => {
    const d = requiresApproval(action({ approvalPolicy: "invite" }), resolved());
    const serialized = JSON.stringify(d);
    expect(serialized).not.toContain(RAW_TITLE);
    expect(serialized).not.toContain(RAW_NOTE);
    if (isAllow(d)) expect(isRedactionSafe(d.audit)).toBe(true);
  });

  it("is deterministic: same (action, resolved) → deep-equal decision", () => {
    const a = action({ approvalPolicy: "invite" });
    const r = resolved();
    expect(requiresApproval(a, r)).toEqual(requiresApproval(a, r));
  });
});
