// Task 8.2 (b) — PURE UI-safe projection functions (WS-8 / §10 leakage boundary).
//
// THE single boundary where a frozen domain record becomes a renderer-visible
// shape. Each projector maps a domain record → its UI-safe shape by copying ONLY
// the field names enumerated in the checked-in `UI_SAFE_ALLOWLIST` (from
// @sow/contracts — the source of truth). Secrets, Keychain refs, raw
// Employer-Work content, provider prompts, `AgentResult.logs`, and ANY
// non-allowlisted field can NEVER cross: the projector NAMES each output field
// explicitly, so a field that is present on the input but absent from the
// allowlist is simply never read. A `...spread` of the domain record is FORBIDDEN
// here — an adversarially-injected extra key would ride out. This is why the RED
// spec feeds each projector a record carrying an extra sensitive field and
// asserts the projected object has ONLY allowlisted names.
//
// PURE — no @trpc, no I/O, no throw. Deterministic field-copy only.
import type {
  Approval,
  HealthItem,
  WorkflowRunRef,
  UiSafeApproval,
  UiSafeHealthItem,
  UiSafeWorkflowRunRef,
  UiSafeDashboardCard,
} from "@sow/contracts";

/**
 * Copy an OPTIONAL field only when it is defined — so an absent optional field is
 * OMITTED from the projection (no `undefined`-valued key) rather than set to
 * `undefined`. Keeps the projected object minimal and its field set a clean
 * subset of the allowlist. Generic over the target key so the assignment is typed.
 */
function assignIfDefined<T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void {
  if (value !== undefined) {
    target[key] = value;
  }
}

/**
 * Project an {@link Approval} to a {@link UiSafeApproval}. Copies ONLY the
 * allowlisted names (`id`, `actionRef`, `status`, `channel`, `snoozeUntil?`,
 * `expiresAt?`). DROPS `actor` (approving-principal identity) and `payloadHash`
 * (content-derived hash) — and any other field present on the record. Branded
 * ids are narrowed to plain strings for the renderer.
 */
export function toUiSafeApproval(approval: Approval): UiSafeApproval {
  const out: UiSafeApproval = {
    id: approval.id,
    actionRef: approval.actionRef,
    status: approval.status,
    channel: approval.channel,
  };
  assignIfDefined(out, "snoozeUntil", approval.snoozeUntil);
  assignIfDefined(out, "expiresAt", approval.expiresAt);
  return out;
}

/**
 * Project a {@link HealthItem} to a {@link UiSafeHealthItem}. Copies ONLY the
 * allowlisted names (`id`, `failureClass`, `severity`, `state`, `openedAt`,
 * `resolvedAt?`). DROPS `message` (may echo raw content / a secret), `auditRef`,
 * `parityReportRef`, and `factIdentity` (internal refs) — and any other field.
 */
export function toUiSafeHealthItem(item: HealthItem): UiSafeHealthItem {
  const out: UiSafeHealthItem = {
    id: item.id,
    failureClass: item.failureClass,
    severity: item.severity,
    state: item.state,
    openedAt: item.openedAt,
  };
  assignIfDefined(out, "resolvedAt", item.resolvedAt);
  return out;
}

/**
 * Project a {@link WorkflowRunRef} to a {@link UiSafeWorkflowRunRef}. Copies ONLY
 * the allowlisted names (`workflowId`, `trigger`, `state`, `idempotencyKey`).
 * DROPS `auditRefs` (the internal audit trail) — and any other field.
 */
export function toUiSafeWorkflowRunRef(ref: WorkflowRunRef): UiSafeWorkflowRunRef {
  return {
    workflowId: ref.workflowId,
    trigger: ref.trigger,
    state: ref.state,
    idempotencyKey: ref.idempotencyKey,
  };
}

/**
 * Source shape for the dashboard-card projector. There is no frozen
 * `DashboardCard` seam model (§10 read-model cards are a UI construct), so the
 * projector's INPUT is defined here as the superset the worker's read-model layer
 * produces. The projector still copies ONLY the allowlisted names — a broader
 * input (extra keys) is narrowed to the UI-safe shape. Every field on
 * `UiSafeDashboardCard` is UI-safe by construction (no domain secret to drop),
 * but the explicit copy keeps the boundary discipline uniform across projectors.
 */
export interface DashboardCardSource {
  cardId: string;
  kind: string;
  title: string;
  status: string;
  count: number;
  updatedAt: string;
}

/**
 * Project a {@link DashboardCardSource} to a {@link UiSafeDashboardCard}. Copies
 * ONLY the allowlisted names (`cardId`, `kind`, `title`, `status`, `count`,
 * `updatedAt`). Any extra key on the source is not read — nothing else crosses.
 */
export function toUiSafeDashboardCard(card: DashboardCardSource): UiSafeDashboardCard {
  return {
    cardId: card.cardId,
    kind: card.kind,
    title: card.title,
    status: card.status,
    count: card.count,
    updatedAt: card.updatedAt,
  };
}
