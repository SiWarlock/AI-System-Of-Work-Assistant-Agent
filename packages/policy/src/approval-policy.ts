// §5 approval-policy predicate (REQ-F-012). Decides whether a ProposedAction
// must surface on the §9 approval inbox before it can take effect — and, when it
// must, emits the card params §9 renders (channels, visibility, deferred
// defaults). This is a DECISION predicate, not the Approval state machine: it
// NEVER mutates Approval state (the idempotent approve/edit/reject/defer/expire
// transition is §9's job) — it only classifies + emits card params.
//
// PURE + deterministic: same (action, resolved) → same decision; no clock,
// network, or randomness. FAIL-CLOSED: under ANY uncertainty — missing/ambiguous
// policy, employer/client ownership, cross-workspace visibility, an
// external-message target — the verdict is requiresApproval=true (NEVER
// auto-apply). Only a PRIVATE, policy-allowed PERSONAL action may be auto-allowed
// (pins Flow 3: auto-create-private-only). A structurally unusable action is a
// genuine malformed input ⇒ fail-closed DENY. REDACTION-SAFE: the decision + its
// audit signal carry refs / hashes / codes ONLY — never the raw payload.
import type { ProposedAction, VisibilityLevel } from "@sow/contracts";
import { isVisibilityLevel } from "@sow/contracts";
import type { ResolvedWorkspacePolicy } from "./workspace-policy";
import { allowDecision, denyDecision, type PolicyDecision } from "./decision";
import { buildAuditSignal, type AuditSignal } from "./audit-signal";

const APPROVAL_ACTOR = "policy:approval" as const;

// A payloadHash-shaped decision marker (policy is pure and has no hasher outside
// session-auth). Redaction-safe: a fixed decision-kind constant; the action /
// workspace identity rides the refs — the raw payload NEVER does.
const APPROVAL_PAYLOAD_MARKER = "policy:approval-decision" as const;

// The SOLE approvalPolicy token that makes an action auto-eligible. The
// approvalPolicy taxonomy is deferred upstream (arch_gap on ProposedAction), so
// this is a closed recognized token: anything else is treated as
// "requires approval" (fail-closed under uncertainty).
const AUTO_PRIVATE_POLICY = "auto_private" as const;

// Auto-allow is an ALLOW-LIST, not a deny-list. Only a target that can host a
// genuinely PRIVATE, PERSONAL action is auto-eligible; §9 Flow 6 sanctions
// exactly one — "auto-create a private personal CALENDAR event if policy allows."
// Every OTHER target is a shared/external write that ALWAYS requires approval:
// github/linear/asana/drive are collaborator surfaces, telegram is an
// external-message surface, todoist/etc. are not spec-sanctioned for auto-create.
// (Prior deny-list `{telegram}` fail-OPENed: it auto-allowed external writes to
// github/linear/asana/drive — the REQ-F-012 §9 approval-gate bypass.)
// arch_gap: the auto-eligible set may widen when the approvalPolicy taxonomy + an
// explicit shared/private action flag are pinned upstream (ProposedAction.
// approvalPolicy is an open string today); until then this stays fail-closed to
// the single spec-named surface, and never trusts a candidate-settable policy
// string alone to auto-authorize an external write.
const AUTO_ALLOW_ELIGIBLE_TARGETS: ReadonlySet<string> = new Set<string>(["calendar"]);

// §9 deferred defaults for the approval card.
const DEFAULT_SNOOZE_HOURS = 24 as const;
const DEFAULT_AUTO_EXPIRE_DAYS = 7 as const;

// Most-restrictive visibility, used as the fail-closed card default when the
// resolved workspace posture is missing / malformed.
const MOST_RESTRICTIVE_VISIBILITY: VisibilityLevel = "isolated";

/**
 * Card params the §9 approval inbox renders. Emitted ONLY when approval is
 * required. `channels` are the surfaces the card must appear on; `visibilityLevel`
 * echoes the action's workspace visibility posture; the deferred defaults pin the
 * snooze re-surface window (24h) + auto-expire window (7d).
 */
export interface ApprovalCardParams {
  readonly channels: ("mac" | "telegram")[];
  readonly visibilityLevel: VisibilityLevel;
  readonly snoozeDefaultHours: number;
  readonly autoExpireDefaultDays: number;
}

/** The verdict value: whether approval is required + (when so) the card params. */
export interface ApprovalVerdict {
  readonly requiresApproval: boolean;
  readonly card?: ApprovalCardParams;
}

/** True iff `action` is a usable object carrying the fields the predicate reads.
 * Reads through an untyped view so the fail-closed guards hold even when a caller
 * passes a value the static `ProposedAction` type would forbid (null / malformed). */
function isUsableAction(action: ProposedAction): boolean {
  const a = action as unknown as {
    actionId?: unknown;
    targetSystem?: unknown;
  } | null;
  return (
    a != null &&
    typeof a === "object" &&
    typeof a.actionId === "string" &&
    a.actionId !== "" &&
    typeof a.targetSystem === "string" &&
    a.targetSystem !== ""
  );
}

/** Build the §9 card params. Channels always include the local Mac inbox; an
 * external-message target additionally routes to that channel. Visibility is the
 * resolved workspace default, or the most-restrictive level when unavailable. */
function buildCard(
  targetSystem: string,
  visibilityLevel: VisibilityLevel,
): ApprovalCardParams {
  const channels: ("mac" | "telegram")[] = ["mac"];
  if (targetSystem === "telegram") channels.push("telegram");
  return {
    channels,
    visibilityLevel,
    snoozeDefaultHours: DEFAULT_SNOOZE_HOURS,
    autoExpireDefaultDays: DEFAULT_AUTO_EXPIRE_DAYS,
  };
}

/**
 * Approval-required predicate (REQ-F-012). PURE + deterministic. Returns:
 *  - DENY(MALFORMED_POLICY_INPUT) when `action` is structurally unusable (null /
 *    non-object / missing identity) — a genuine fail-closed refusal.
 *  - ALLOW({ requiresApproval: false }) ONLY for a PRIVATE, policy-allowed
 *    PERSONAL action: dataOwner 'user', approvalPolicy 'auto_private', a
 *    non-external-message target, and an isolated (non-cross-workspace-visible)
 *    workspace default. This is the sole auto-create-private path (Flow 3).
 *  - ALLOW({ requiresApproval: true, card }) for EVERYTHING else — employer/client
 *    ownership, cross-workspace visibility, external-message targets, and any
 *    ambiguous/unrecognized/missing policy (fail-closed: NEVER auto-apply).
 *
 * The decision does NOT mutate Approval state and carries no raw payload.
 */
export function requiresApproval(
  action: ProposedAction,
  resolved: ResolvedWorkspacePolicy,
): PolicyDecision<ApprovalVerdict> {
  // Fail-closed DENY: a structurally unusable action cannot be classified.
  if (!isUsableAction(action)) {
    const audit: AuditSignal = buildAuditSignal({
      actor: APPROVAL_ACTOR,
      event: "approval.classify.malformed",
      refs: ["ref:action:MISSING"],
      payloadHash: APPROVAL_PAYLOAD_MARKER,
      beforeSummary: "proposed action not classified for approval",
      afterSummary: "proposed action is structurally unusable (null / non-object / missing identity)",
      denialCode: "MALFORMED_POLICY_INPUT",
    });
    return denyDecision(
      "MALFORMED_POLICY_INPUT",
      "proposed action is structurally unusable — cannot classify approval requirement",
      audit,
    );
  }

  const targetSystem: string = action.targetSystem;
  const dataOwner: unknown = resolved?.dataOwner;
  const rawVisibility: unknown = resolved?.defaultVisibility;
  const resolvedOk =
    resolved != null &&
    typeof dataOwner === "string" &&
    isVisibilityLevel(rawVisibility);

  const cardVisibility: VisibilityLevel = resolvedOk
    ? (rawVisibility as VisibilityLevel)
    : MOST_RESTRICTIVE_VISIBILITY;

  const workspaceRef = resolvedOk
    ? `ref:workspace:${resolved.workspaceId}`
    : "ref:workspace:MISSING";
  const refs: readonly string[] = [
    `ref:action:${action.actionId}`,
    `ref:target:${targetSystem}`,
    workspaceRef,
  ];

  // The narrow auto-allow: PRIVATE + policy-allowed + PERSONAL.
  //  - resolved posture is well-formed (else uncertainty ⇒ approval);
  //  - dataOwner is the user (employer/client owned ⇒ approval);
  //  - approvalPolicy is the sole auto-eligible token (ambiguous ⇒ approval);
  //  - target is on the auto-allow-ELIGIBLE allow-list (private personal surface);
  //  - workspace default visibility is isolated (cross-workspace-visible ⇒ approval).
  const autoAllowed =
    resolvedOk &&
    dataOwner === "user" &&
    action.approvalPolicy === AUTO_PRIVATE_POLICY &&
    AUTO_ALLOW_ELIGIBLE_TARGETS.has(targetSystem) &&
    (rawVisibility as VisibilityLevel) === "isolated";

  if (autoAllowed) {
    const audit: AuditSignal = buildAuditSignal({
      actor: APPROVAL_ACTOR,
      event: "approval.auto_allowed",
      refs,
      payloadHash: APPROVAL_PAYLOAD_MARKER,
      beforeSummary: "proposed action not classified for approval",
      afterSummary: "auto-allowed: private, policy-allowed personal action (Flow 3)",
    });
    return allowDecision({ requiresApproval: false }, audit);
  }

  // Fail-closed default: approval required. Emit the §9 card params.
  const card = buildCard(targetSystem, cardVisibility);
  const audit: AuditSignal = buildAuditSignal({
    actor: APPROVAL_ACTOR,
    event: "approval.required",
    refs,
    payloadHash: APPROVAL_PAYLOAD_MARKER,
    beforeSummary: "proposed action not classified for approval",
    afterSummary: "approval required: action is not a private, policy-allowed personal action",
  });
  return allowDecision({ requiresApproval: true, card }, audit);
}
