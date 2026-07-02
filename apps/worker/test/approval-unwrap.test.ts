// Worker composition SAFETY: the gateway `requireApproval` seam fails CLOSED. It
// unwraps the @sow/policy requiresApproval PolicyDecision as `isAllow ? d.value :
// { requiresApproval: true }` — so a policy DENY (a structurally-unusable action the
// predicate cannot classify) NEVER auto-applies; the verdict is requiresApproval=true
// (safety rule 2 / REQ-F-012). A normal non-private action also requires approval.
import { describe, it, expect } from "vitest";
import { workspaceId, actionId } from "@sow/contracts";
import type { ProposedAction } from "@sow/contracts";
import type { ResolvedWorkspacePolicy } from "@sow/policy";
import { makeRequireApproval } from "../src/composition/backends";

const WS = workspaceId("ws-1");

// A minimal resolved posture: employer-owned, non-isolated → nothing auto-allows.
const resolved: ResolvedWorkspacePolicy = {
  workspaceId: String(WS),
  type: "employer_work",
  dataOwner: "employer",
  defaultVisibility: "coordination",
  egressPolicy: {
    workspaceId: WS,
    allowedProcessors: [],
    rawContentAllowedProcessors: [],
    employerRawEgressAcknowledged: false,
  },
  providerMatrix: {
    workspaceId: WS,
    allowedProviders: ["ollama"],
    capabilityDefaults: {},
    rawCloudEgressEnabled: false,
  },
};

const wellFormedAction: ProposedAction = {
  actionId: actionId("act-1"),
  targetSystem: "todoist",
  canonicalObjectKey: "obj:1",
  payload: { title: "x" },
  approvalPolicy: "auto",
  idempotencyKey: "idem:1",
};

describe("makeRequireApproval — fail-closed sync unwrap over @sow/policy", () => {
  it("a policy DENY (structurally-unusable action) FAILS CLOSED to requiresApproval=true", () => {
    const requireApproval = makeRequireApproval(resolved);
    // A null/malformed action makes requiresApproval() return a DENY. The unwrap must
    // NOT read a value off a deny — it fails closed.
    const verdict = requireApproval(null as unknown as ProposedAction);
    expect(verdict.requiresApproval).toBe(true);
  });

  it("a well-formed employer action requires approval (fail-closed default; no auto-apply)", () => {
    const requireApproval = makeRequireApproval(resolved);
    const verdict = requireApproval(wellFormedAction);
    expect(verdict.requiresApproval).toBe(true);
  });
});
